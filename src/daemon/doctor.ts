import { accessSync, constants } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTERS,
  hookInstaller,
  ingests,
  newestTranscript,
  preferredSurface,
  realHost,
  type Adapter,
  type HostEnv,
  type InstalledHook,
  type McpEntry,
} from '../adapters/index.js';
import { resolveModel, type Config, WORKER_TASKS } from '../core/config.js';
import { getProvider } from '../workers/providers/index.js';
import { providerIsLocal } from '../workers/providers/types.js';
import { MCP_SERVER_NAME, servesProject } from '../ops/install.js';
import { isOurHookCommand, resolveCommand } from '../ops/self.js';
import type { ContextManager } from './manager.js';
import { staleReferences } from './stale.js';
import { buildDrift, packageRootOf, scriptBehind } from './drift.js';

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

export interface DiagnoseOptions {
  /** The machine to inspect. Tests pass a temp home and no `which`. */
  host?: HostEnv;
  /** Window for "is memory being pulled". */
  pullWindowDays?: number;
  /** Package root of the contextd running this check; defaults to this file's. */
  checkoutRoot?: string | null;
}

export function diagnose(manager: ContextManager, opts: DiagnoseOptions = {}): Check[] {
  const checks: Check[] = [];
  const { config } = manager;
  const host = opts.host ?? realHost(manager.projectRoot);
  const wiring = inspectWiring(manager, host);

  checks.push(...storageChecks(manager));
  checks.push(...adapterChecks(manager, host, wiring));
  checks.push(...mcpChecks(host, wiring));
  const checkoutRoot = opts.checkoutRoot !== undefined ? opts.checkoutRoot : packageRootOf(fileURLToPath(import.meta.url));
  checks.push(...buildChecks(host, wiring, checkoutRoot));
  checks.push(...providerChecks(config));
  checks.push(...budgetChecks(config));
  checks.push(...latencyChecks(manager));
  checks.push(...integrityChecks(manager));
  checks.push(...embeddingChecks(manager));
  checks.push(...referenceChecks(manager));
  checks.push(...pullChecks(manager, wiring, opts.pullWindowDays ?? PULL_WINDOW_DAYS));

  return checks;
}

/** What is wired where, gathered once: several checks ask the same questions. */
interface Wiring {
  hooks: Map<string, { ours: InstalledHook[]; all: InstalledHook[] }>;
  transcripts: Map<string, { path: string; mtime: number } | null>;
  mcp: Map<string, { serving: McpEntry[]; elsewhere: McpEntry[] }>;
}

function inspectWiring(manager: ContextManager, host: HostEnv): Wiring {
  const recorded = manager.installedHookCommand();
  const wiring: Wiring = { hooks: new Map(), transcripts: new Map(), mcp: new Map() };
  for (const adapter of Object.values(ADAPTERS)) {
    const installer = hookInstaller(adapter);
    if (installer) {
      const all = installer.installed(host);
      // A hand-written `contextd hook` (no -C) still counts for "is it wired"; uninstall is stricter.
      const ours = all.filter(
        (h) => isOurHookCommand(h.command, manager.projectRoot, recorded) || /\bcontextd\b.*\bhook\s*$/.test(h.command),
      );
      wiring.hooks.set(adapter.name, { ours, all });
    }
    if (adapter.surfaces.some((s) => s.locate)) {
      wiring.transcripts.set(adapter.name, newestTranscript(adapter, manager.projectRoot, host.home));
    }
    if (adapter.mcp) {
      const entries = adapter.mcp.get(host, MCP_SERVER_NAME);
      wiring.mcp.set(adapter.name, {
        serving: entries.filter((e) => servesProject(adapter, e, manager.projectRoot)),
        elsewhere: entries.filter((e) => !servesProject(adapter, e, manager.projectRoot)),
      });
    }
  }
  return wiring;
}

/**
 * Hooks or a transcript are proof of use; an agent contextd cannot observe is judged by its
 * config directory (`detect`), since it leaves nothing else behind.
 */
function agentInUse(adapter: Adapter, wiring: Wiring, host: HostEnv): boolean {
  return (
    (wiring.hooks.get(adapter.name)?.ours.length ?? 0) > 0 ||
    wiring.transcripts.get(adapter.name) != null ||
    (!ingests(adapter) && adapter.detect?.(host) === true)
  );
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

function adapterChecks(manager: ContextManager, host: HostEnv, wiring: Wiring): Check[] {
  const out: Check[] = [];

  for (const adapter of Object.values(ADAPTERS)) {
    const surface = preferredSurface(adapter);
    if (!surface) continue;

    if (surface.kind === 'hook') {
      out.push(...hookChecks(adapter, host, wiring));
    }

    // Not a failure and nothing to fix, but worth one line where the agent is used: its sessions
    // leave no trace in memory, which otherwise looks like a broken ingestion.
    if (surface.kind === 'none' && agentInUse(adapter, wiring, host)) {
      out.push({
        name: `${adapter.name}: ingestion`,
        status: 'skip',
        detail: `${adapter.agent} has no ingestion surface; memory reaches it through MCP and \`contextd mirror\`, nothing it does is recorded`,
      });
    }

    // Report the transcript surface too: it is the fallback when hooks are not installed.
    if (wiring.transcripts.has(adapter.name)) {
      const found = wiring.transcripts.get(adapter.name) ?? null;
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

/**
 * Whether hooks are wired - and whether the command they run can still start. `init` records the
 * exact command, typically `node <checkout>/dist/cli/index.js -C <root> hook`; a rebuild elsewhere
 * or a moved checkout leaves the hook pointing at nothing, and Claude Code reports a failing hook
 * so quietly that ingestion simply stops.
 */
function hookChecks(adapter: Adapter, host: HostEnv, wiring: Wiring): Check[] {
  const name = `${adapter.name}: hooks`;
  const ours = wiring.hooks.get(adapter.name)?.ours ?? [];
  if (ours.length === 0) {
    return [
      {
        name,
        status: 'warn',
        detail: 'not installed; ingestion depends on `contextd attach`',
        fix: 'run `contextd init`',
      },
    ];
  }
  const first = ours[0]!;
  const out: Check[] = [{ name, status: 'ok', detail: `${first.events.length} events wired in ${first.path}` }];
  for (const command of new Set(ours.map((h) => h.command))) {
    const r = resolveCommand(command, host);
    out.push({
      name: `${adapter.name}: hook command`,
      status: r.problem ? 'fail' : 'ok',
      detail: r.problem
        ? `\`${command}\` cannot start: ${r.problem}; every hook fails silently`
        : `${r.script ?? r.binaryPath ?? r.binary} resolves`,
      ...(r.problem ? { fix: 'rebuild (`npm run build`), or re-run `contextd init` from the current install' } : {}),
    });
  }
  return out;
}

/** The MCP server is how an agent pulls memory; hooks alone only push the bootstrap. */
function mcpChecks(host: HostEnv, wiring: Wiring): Check[] {
  const out: Check[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const reg = wiring.mcp.get(adapter.name);
    if (!reg) continue;
    // An agent that has never been run here gets no line at all: three "not used" rows for agents
    // someone does not have is noise in the one command meant to show what is wrong.
    const used = agentInUse(adapter, wiring, host);
    if (!ingests(adapter) && !used && reg.serving.length === 0 && reg.elsewhere.length === 0) continue;
    const name = `${adapter.name}: mcp`;
    const fix = `run \`contextd mcp install --adapter ${adapter.name}\``;
    if (reg.serving.length === 0) {
      const other = reg.elsewhere.find((e) => e.managed);
      if (other) {
        out.push({
          name,
          status: 'warn',
          detail: `registered in ${other.where} (${other.scope}) for another project: \`${[other.command, ...other.args].join(' ')}\``,
          fix,
        });
      } else if (reg.elsewhere.some((e) => !e.managed)) {
        out.push({ name, status: 'warn', detail: `a "${MCP_SERVER_NAME}" entry contextd did not write is in the way`, fix: 'inspect it with `contextd mcp status`' });
      } else if (used) {
        // For an agent contextd cannot observe, "used" only means its config dir exists on this
        // machine - not that anyone runs it in this project. A warning there would keep the
        // dashboard's health pill amber for every editor someone merely has installed.
        out.push({ name, status: ingests(adapter) ? 'warn' : 'skip', detail: `not registered; ${adapter.agent} cannot query memory`, fix });
      } else {
        out.push({ name, status: 'skip', detail: `${adapter.agent} not used in this project` });
      }
      continue;
    }
    for (const entry of reg.serving) {
      const r = resolveCommand(entry, host);
      out.push({
        name,
        status: r.problem ? 'fail' : 'ok',
        detail: r.problem
          ? `registered (${entry.scope}) but cannot start: ${r.problem}`
          : `registered, scope ${entry.scope}, in ${entry.where}`,
        ...(r.problem ? { fix: `${fix} --scope ${entry.scope} --force` } : {}),
      });
    }
  }
  return out;
}

/**
 * The build the hooks and MCP entries run, against the source it came from. A checkout edited
 * and not rebuilt leaves every agent on the old code, silently: the tests pass on the new code
 * while the agent keeps running the old.
 */
function buildChecks(host: HostEnv, wiring: Wiring, checkoutRoot: string | null): Check[] {
  const users = new Map<string, Set<string>>();
  const note = (script: string | null, who: string) => {
    if (script) users.set(script, (users.get(script) ?? new Set()).add(who));
  };
  for (const [name, hooks] of wiring.hooks) {
    for (const h of hooks.ours) note(scriptBehind(resolveCommand(h.command, host)), `${name} hooks`);
  }
  for (const [name, reg] of wiring.mcp) {
    for (const e of reg.serving) if (e.managed) note(scriptBehind(resolveCommand(e, host)), `${name} mcp`);
  }
  const out: Check[] = [];
  for (const [script, who] of users) {
    const drift = buildDrift(script, checkoutRoot);
    // A missing script is the hook or MCP check's failure to report, not a drift.
    if (!drift) continue;
    const by = [...who].join(', ');
    const problems: string[] = [];
    if (drift.newerSource) {
      const rel = drift.packageRoot ? relative(drift.packageRoot, drift.newerSource.path) : drift.newerSource.path;
      problems.push(`${rel} is ${describeSpan(drift.newerSource.aheadMs)} newer than the build`);
    }
    if (drift.versionMismatch) {
      problems.push(`it is v${drift.versionMismatch.installed}, this checkout is v${drift.versionMismatch.checkout}`);
    }
    out.push({
      name: 'build',
      status: problems.length > 0 ? 'warn' : 'ok',
      detail:
        problems.length > 0
          ? `${script} (run by ${by}) is out of date: ${problems.join('; ')}`
          : `${script} (run by ${by}) is current${drift.version ? `, v${drift.version}` : ''}`,
      ...(problems.length > 0
        ? { fix: `rebuild: npm run build${drift.packageRoot ? ` (in ${drift.packageRoot})` : ''}` }
        : {}),
    });
  }
  return out;
}

function describeSpan(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (mins < 120) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Semantic retrieval quietly degrades to keyword-only for every item the index lacks. */
function embeddingChecks(manager: ContextManager): Check[] {
  const index = manager.embeddings;
  if (!index.enabled) return [];
  const active = manager.store.allItems(false).filter((i) => i.status === 'active').length;
  // `stale` reads SQL and hashes text; it never calls the embedding provider.
  const missing = index.stale(Number.MAX_SAFE_INTEGER).length;
  return [
    {
      name: 'embedding index',
      status: missing === 0 ? 'ok' : 'warn',
      detail:
        missing === 0
          ? `covers all ${active} active items (model ${index.model})`
          : `${missing} of ${active} active items not embedded with ${index.model}; semantic search cannot find them`,
      ...(missing === 0 ? {} : { fix: 'run `contextd embed --all`' }),
    },
  ];
}

/**
 * Memory naming files that are gone. Maintenance already marks an unprotected item stale, so what
 * is left to report is what code may not settle: a protected item only the user can retire, and
 * unprotected ones maintenance has not reached yet. Read-only - a stat per path, no patch.
 */
function referenceChecks(manager: ContextManager): Check[] {
  const report = staleReferences(manager.store, manager.projectRoot);
  if (report.checked === 0) return [];
  const live = report.stale.filter((f) => manager.store.getItem(f.id)?.status === 'active');
  if (live.length === 0) {
    return [{ name: 'file references', status: 'ok', detail: `${report.checked} items name files that exist` }];
  }
  const protectedOnes = live.filter((f) => f.protected);
  const list = (fs: typeof live) =>
    fs.slice(0, 3).map((f) => `${f.id} (${[...f.missing, ...f.appeared].join(', ')})`).join('; ');
  return [
    {
      name: 'file references',
      status: 'warn',
      detail: `${live.length} active item(s) name files that no longer exist: ${list(live)}`,
      fix:
        protectedOnes.length > 0
          ? `protected, so only you can retire them: contextd forget ${protectedOnes.map((f) => f.id).join(' ')} --reason "file removed"`
          : 'maintenance marks them stale during the next agent session; `contextd forget <id> --reason "file removed"` retires one now',
    },
  ];
}

const PULL_WINDOW_DAYS = 7;

/**
 * Wired is not used. Hooks can be installed and the MCP server registered while no session ever
 * reads the memory - a SessionStart hook whose output is dropped, a server that fails to start.
 * The retrieval log is the evidence: agent sessions with nothing served means memory is a cost
 * with no return.
 */
function pullChecks(manager: ContextManager, wiring: Wiring, days: number): Check[] {
  const wired =
    [...wiring.hooks.values()].some((h) => h.ours.length > 0) ||
    [...wiring.mcp.values()].some((m) => m.serving.length > 0);
  if (!wired) return [];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const activity = manager.store.sessionsActiveSince(since);
  const served = manager.store.retrievalsSince(since);
  if (activity.sessions === 0) {
    return [{ name: 'memory pulled', status: 'skip', detail: `no agent sessions in the last ${days} days` }];
  }
  const total = served.bootstraps + served.queries;
  if (total === 0) {
    return [
      {
        name: 'memory pulled',
        status: 'warn',
        detail: `${activity.sessions} session${activity.sessions === 1 ? '' : 's'} in the last ${days} days, and no bootstrap or query was served`,
        fix: 'check that SessionStart reaches `contextd hook` and that `contextd mcp status` shows a working server',
      },
    ];
  }
  return [
    {
      name: 'memory pulled',
      status: 'ok',
      detail:
        `${served.bootstraps} bootstrap${served.bootstraps === 1 ? '' : 's'} and ${served.queries} quer${served.queries === 1 ? 'y' : 'ies'} ` +
        `served across ${activity.sessions} session${activity.sessions === 1 ? '' : 's'} in the last ${days} days`,
    },
  ];
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
