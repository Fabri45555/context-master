import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ADAPTERS,
  newestTranscript,
  preferredSurface,
  type Adapter,
} from '../adapters/index.js';
import { resolveModel, type Config, WORKER_TASKS } from '../core/config.js';
import { getProvider } from '../workers/providers/index.js';
import { providerIsLocal } from '../workers/providers/types.js';
import type { ContextManager } from './manager.js';

/**
 * Health check for the wiring.
 *
 * PRD 6 calls the system "agent agnostic", which hides the fact that each agent has exactly
 * one good ingestion surface. This reports, per agent, whether that surface is actually
 * connected - otherwise a silently unwired hook looks identical to an idle project.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export function diagnose(manager: ContextManager): Check[] {
  const checks: Check[] = [];
  const { config } = manager;

  checks.push(...storageChecks(manager));
  checks.push(...adapterChecks(manager));
  checks.push(...providerChecks(config));
  checks.push(...budgetChecks(config));
  checks.push(...latencyChecks(manager));
  checks.push(...integrityChecks(manager));

  return checks;
}

function storageChecks(manager: ContextManager): Check[] {
  const out: Check[] = [];
  out.push({
    name: 'config',
    status: manager.loaded.path ? 'ok' : 'warn',
    detail: manager.loaded.path ?? 'using defaults, no config file found',
    ...(manager.loaded.path ? {} : { fix: 'run `contextd init`' }),
  });

  try {
    accessSync(manager.storageDir, constants.W_OK);
    out.push({ name: 'storage', status: 'ok', detail: manager.storageDir });
  } catch {
    out.push({
      name: 'storage',
      status: 'fail',
      detail: `${manager.storageDir} is not writable`,
      fix: 'check directory permissions',
    });
  }
  return out;
}

function adapterChecks(manager: ContextManager): Check[] {
  const out: Check[] = [];
  const home = homedir();

  for (const adapter of Object.values(ADAPTERS)) {
    const surface = preferredSurface(adapter);
    if (!surface) continue;

    if (surface.kind === 'hook') {
      out.push(hookCheck(adapter, manager));
    }

    // Report the transcript surface too: it is the fallback when hooks are not installed.
    const hasTranscriptSurface = adapter.surfaces.some((s) => s.locate);
    if (hasTranscriptSurface) {
      const found = newestTranscript(adapter, manager.projectRoot, home);
      out.push({
        name: `${adapter.name}: transcript`,
        status: found ? 'ok' : 'skip',
        detail: found
          ? `${found.path} (${describeAge(found.mtime)})`
          : `no transcript for this project yet`,
        ...(found ? {} : { fix: `run ${adapter.agent} in this directory first` }),
      });
    }
  }
  return out;
}

function hookCheck(adapter: Adapter, manager: ContextManager): Check {
  const name = `${adapter.name}: hooks`;
  // `init` records the exact command it installed. Grepping for the word "contextd" instead
  // would miss an install that runs `node <path>/dist/cli/index.js`, which is the normal
  // case before the package is linked.
  const installed = manager.installedHookCommand();

  for (const dir of [join(manager.projectRoot, '.claude'), join(homedir(), '.claude')]) {
    for (const file of ['settings.json', 'settings.local.json']) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      let hooks: string;
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> };
        hooks = JSON.stringify(raw.hooks ?? {});
      } catch {
        return { name, status: 'warn', detail: `${path} is not valid JSON` };
      }
      const matched = installed ? hooks.includes(installed) : /contextd|contextd hook/.test(hooks);
      if (matched) {
        const events = Object.keys(
          (JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {},
        );
        return { name, status: 'ok', detail: `${events.length} events wired in ${path}` };
      }
    }
  }
  return {
    name,
    status: 'warn',
    detail: 'not installed; ingestion depends on `contextd attach`',
    fix: 'run `contextd init`',
  };
}

function providerChecks(config: Config): Check[] {
  const out: Check[] = [];
  const seen = new Set<string>();

  for (const task of WORKER_TASKS) {
    const spec = resolveModel(config, task);
    const key = `${spec.provider}:${spec.model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let provider;
    try {
      provider = getProvider(spec.provider);
    } catch (err) {
      out.push({ name: `provider ${key}`, status: 'fail', detail: (err as Error).message });
      continue;
    }

    const local = providerIsLocal(provider, spec);
    if (config.privacy.local_only && !local) {
      out.push({
        name: `provider ${key}`,
        status: 'fail',
        detail: provider.isLocal
          ? `local_only is set but ${spec.model} is proxied off this machine; workers will never run`
          : 'local_only is set but this provider is remote; workers will never run',
        fix: 'point this tier at a local model or noop, or unset privacy.local_only',
      });
      continue;
    }

    const env = spec.api_key_env;
    if (env && !local && !process.env[env]) {
      out.push({
        name: `provider ${key}`,
        status: 'warn',
        detail: `${env} is not set; workers will fail and events will stay queued`,
        fix: `export ${env}=...`,
      });
      continue;
    }

    out.push({
      name: `provider ${key}`,
      status: 'ok',
      // Says remote for an ollama *-cloud model, which is local only in the sense that the
      // daemon is: the prompt still leaves the machine.
      detail: local ? 'local' : 'remote',
    });
  }
  return out;
}

function budgetChecks(config: Config): Check[] {
  const out: Check[] = [];
  const cb = config.context_budget;
  const sections = Object.values(cb.sections).reduce((a, b) => a + b, 0);

  if (cb.reserve_for_retrieval >= cb.total_tokens) {
    out.push({
      name: 'context budget',
      status: 'fail',
      detail: `reserve_for_retrieval (${cb.reserve_for_retrieval}) leaves nothing for the bootstrap`,
      fix: 'lower reserve_for_retrieval below context_budget.total_tokens',
    });
  } else if (sections > cb.total_tokens - cb.reserve_for_retrieval) {
    out.push({
      name: 'context budget',
      status: 'warn',
      detail: `section allowances total ${sections}, above the ${cb.total_tokens - cb.reserve_for_retrieval} left for the bootstrap; sections will be truncated`,
    });
  } else {
    out.push({
      name: 'context budget',
      status: 'ok',
      detail: `${cb.total_tokens} tokens, ${cb.reserve_for_retrieval} reserved for retrieval`,
    });
  }
  return out;
}

function latencyChecks(manager: ContextManager): Check[] {
  const stats = manager.store.latencyStats('hook');
  const budget = manager.config.limits.hook_latency_ms;
  if (!stats) {
    return [{ name: 'hook latency', status: 'skip', detail: 'no hook invocations measured yet' }];
  }
  const within = stats.p95 <= budget;
  return [
    {
      name: 'hook latency',
      status: within ? 'ok' : 'warn',
      detail: `p50 ${stats.p50.toFixed(0)}ms, p95 ${stats.p95.toFixed(0)}ms against a ${budget}ms budget (n=${stats.count})`,
      ...(within ? {} : { fix: 'raise limits.hook_latency_ms, or reduce what the hook ingests' }),
    },
  ];
}

function integrityChecks(manager: ContextManager): Check[] {
  const out: Check[] = [];
  try {
    const folded = manager.store.replay();
    const live = manager.store.currentState(true);
    const consistent =
      folded.version === live.version &&
      folded.items.length === live.items.length &&
      folded.items.every((i, n) => i.id === live.items[n]?.id);
    out.push({
      name: 'patch log',
      status: consistent ? 'ok' : 'fail',
      detail: consistent
        ? `replays cleanly to v${live.version} (${live.items.length} items)`
        : `fold gives v${folded.version}/${folded.items.length} items, materialized is v${live.version}/${live.items.length}`,
      ...(consistent ? {} : { fix: 'run `contextd replay --verify` and report the divergence' }),
    });
  } catch (err) {
    out.push({ name: 'patch log', status: 'fail', detail: (err as Error).message });
  }

  // PRD 24 - the question is not only whether memory is consistent but whether it would
  // survive the agent compacting right now.
  const pressure = manager.pressure(null);
  const hard = manager.hardCompactions(null);
  out.push({
    name: 'compaction ladder',
    status: pressure.recovery_ready ? 'ok' : pressure.stage === 'steady' ? 'warn' : 'fail',
    detail:
      `stage ${pressure.stage}` +
      (pressure.ratio == null
        ? ', occupancy unobserved'
        : `, agent at ${(pressure.ratio * 100).toFixed(0)}% of ${pressure.window_tokens} tokens`) +
      (hard > 0 ? `, ${hard} hard compaction${hard === 1 ? '' : 's'} observed` : '') +
      (pressure.recovery_ready ? '' : ` - ${pressure.recovery_blockers.join('; ')}`),
    ...(pressure.recovery_ready ? {} : { fix: 'run `contextd lifecycle --act`' }),
  });

  // A model that returns an empty patch every time drains the queue and reports `ok`.
  const empty = manager.store.emptyRunStreak();
  if (empty.streak >= 2) {
    out.push({
      name: 'worker output',
      status: empty.streak >= 3 ? 'fail' : 'warn',
      detail:
        `the last ${empty.streak} worker runs read events and recorded nothing` +
        (empty.lastModel ? ` (model ${empty.lastModel})` : ''),
      fix: 'check that the routed model follows the JSON patch contract; try a larger tier',
    });
  }

  const working = manager.store.workingMemory();
  if (working.current_task) {
    const since = manager.store.userMessagesSince(working.updated_at);
    out.push({
      name: 'current task',
      status: since >= STALE_TASK_USER_MESSAGES ? 'warn' : 'ok',
      detail:
        `"${working.current_task.slice(0, 60)}" (${working.task_status})` +
        (since > 0 ? `, ${since} user message${since === 1 ? '' : 's'} since it was recorded` : ''),
      ...(since >= STALE_TASK_USER_MESSAGES
        ? { fix: 'run `contextd compact`, or set it: `contextd task "<task>" --status in_progress`' }
        : {}),
    });
  }

  const pending = manager.store.pendingSummary(null);
  if (pending.count > 0) {
    out.push({
      name: 'pending queue',
      status: pending.count > 1000 ? 'warn' : 'ok',
      detail: `${pending.count} events awaiting a worker (${pending.tokens} est. tokens)`,
      ...(pending.count > 1000 ? { fix: 'run `contextd compact`' } : {}),
    });
  }
  return out;
}

/** The user has moved on this many times without the task changing: it is probably not current. */
const STALE_TASK_USER_MESSAGES = 5;

function describeAge(mtime: number): string {
  const mins = Math.round((Date.now() - mtime) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };

export function formatChecks(checks: Check[]): string {
  const lines: string[] = ['contextd doctor', ''];
  const width = Math.min(44, Math.max(18, ...checks.map((c) => c.name.length)));
  for (const c of checks) {
    lines.push(`${GLYPH[c.status]} ${c.name.padEnd(width)} ${c.detail}`);
    if (c.fix) lines.push(`  ${''.padEnd(width)} -> ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(fails > 0 ? `${fails} failing, ${warns} warning` : warns > 0 ? `${warns} warning` : 'all good');
  return lines.join('\n');
}

export function worstStatus(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}
