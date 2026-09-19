#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADAPTER_NAMES,
  ADAPTERS,
  getAdapter,
  newestTranscript,
  preferredSurface,
  sessionIdFromFilename,
} from '../adapters/index.js';
import { installHooks } from '../adapters/claude/hooks.js';
import { MEMORY_CATEGORIES, type MemoryCategory } from '../core/state.js';
import { StatePatchSchema } from '../core/patch.js';
import { CONFIG_FILENAMES, findConfigFile, type WorkerTask } from '../core/config.js';
import { ContextManager } from '../daemon/manager.js';
import { formatMetrics, formatPressure } from '../metrics/index.js';
import { benchmark, formatBench } from '../bench/index.js';
import { runMcpStdio } from '../mcp/server.js';
import { startUi } from '../ui/server.js';
import { RetrievalEngine } from '../store/retrieval.js';
import { diagnose, formatChecks, worstStatus } from '../daemon/doctor.js';

const program = new Command();

program
  .name('contextd')
  .description('Continuous Context Manager for AI coding agents')
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'project directory', process.cwd());

function manager(cmd: Command): ContextManager {
  const cwd = resolve((cmd.optsWithGlobals().cwd as string) ?? process.cwd());
  return new ContextManager({ cwd });
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

// `contextd memory | head` closes the pipe early. That is the reader being done, not an error,
// and a stack trace for it buries the output that was asked for.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', rej);
  });
}

function parseJsonl(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      // A malformed line is data we cannot use, not a reason to lose the rest.
    }
  }
  return records;
}

// ------------------------------------------------------------------ init

program
  .command('init')
  .description('create a config file and wire up the agent hooks')
  .option('--agent <name>', 'agent to wire up (claude)', 'claude')
  .option('--global', 'install hooks in ~/.claude instead of ./.claude', false)
  .option('--no-hooks', 'write the config only')
  .action((opts, cmd) => {
    const cwd = resolve((cmd.optsWithGlobals().cwd as string) ?? process.cwd());
    const existing = findConfigFile(cwd);
    const configPath = existing ?? join(cwd, CONFIG_FILENAMES[0]!);
    if (!existing) {
      const template = {
        project: { name: cwd.split('/').filter(Boolean).pop() },
        triggers: { event_count: 40, token_threshold: 6000, interval_seconds: 300 },
        budget: { max_tokens_per_hour: 120000, max_cost_per_session_usd: 0.5 },
        privacy: { redact_secrets: true, local_only: false },
      };
      writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
      out(`wrote ${configPath}`);
    } else {
      out(`config already present at ${existing}`);
    }

    const m = new ContextManager({ cwd });
    out(`storage at ${m.storageDir}`);
    m.close();

    if (opts.hooks === false) return;
    if (opts.agent !== 'claude') {
      out(`no hook installer for agent "${opts.agent}" yet; use "contextd attach" or "contextd ingest"`);
      return;
    }
    const settingsDir = opts.global ? join(homedir(), '.claude') : join(cwd, '.claude');
    const hookCommand = `${resolveSelfCommand()} -C ${cwd} hook`;
    const res = installHooks(settingsDir, { command: hookCommand });
    const recorder = new ContextManager({ cwd });
    recorder.noteInstalledHookCommand(hookCommand);
    recorder.close();
    out(`${res.created ? 'created' : 'updated'} ${res.path}`);
    if (res.preserved.length > 0) {
      out(`left your existing hooks alone for: ${res.preserved.join(', ')}`);
      out('add the contextd hook to those events manually if you want them ingested');
    }
  });

/** Prefer the installed binary; fall back to running this very file with node. */
function resolveSelfCommand(): string {
  const self = process.argv[1];
  if (self && self.endsWith('.js') && existsSync(self)) return `node ${self}`;
  return 'contextd';
}

// ------------------------------------------------------------------ hook

program
  .command('hook')
  .description('handle one agent hook payload on stdin (fast, never calls a model)')
  .option('--adapter <name>', `adapter (${ADAPTER_NAMES.join('|')})`, 'claude')
  .action(async (opts, cmd) => {
    // Hooks run on the agent's critical path. Ingest, return, never block on a provider
    // (PRD 31) - and never fail the agent because of us (PRD 35).
    let m: ContextManager | null = null;
    const started = performance.now();
    try {
      const text = await readStdin();
      const payload = JSON.parse(text) as Record<string, unknown>;
      m = manager(cmd);
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
      // Hook payloads carry no token usage; without this the ladder only ever saw occupancy
      // from an explicit `attach`, and read a pre-compaction peak forever afterwards. First, so
      // that a payload the ingest rejects cannot also blind the ladder.
      m.observeUsage(opts.adapter, payload, sessionId);
      m.ingestOnly(opts.adapter, [payload], { sessionId, cwd: m.projectRoot });

      // PRD 24 - the compaction ladder, free rungs only. Folding and decaying here is what
      // keeps maintenance alive when no worker ever runs, and it stays inside the hook budget
      // because it is SQL rather than a provider call. Bailing out if we are already close to
      // the soft budget matters more than the maintenance does.
      if (performance.now() - started < m.config.limits.hook_latency_ms / 2) {
        await m.runLifecycle(sessionId, { deterministicOnly: true });
      }

      // SessionStart is the one hook where returning context is useful: it becomes the
      // agent's starting brief, which is exactly PRD 21's bootstrap injection.
      if (payload.hook_event_name === 'SessionStart') {
        const built = m.serveBootstrap(sessionId);
        if (built.text.length > 0) {
          out(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: `# Persistent project memory (contextd)\n\n${built.text}`,
              },
            }),
          );
        }
      }
    } catch (err) {
      process.stderr.write(`contextd hook: ${(err as Error).message}\n`);
    } finally {
      const elapsed = performance.now() - started;
      if (m) {
        m.recordLatency('hook', elapsed);
        // The agent is blocked while this runs, so a breach is worth saying out loud.
        if (m.overHardLatencyBudget(elapsed)) {
          process.stderr.write(
            `contextd hook took ${elapsed.toFixed(0)}ms, over the hard budget of ` +
              `${m.config.limits.hook_latency_hard_ms}ms\n`,
          );
        }
      }
      m?.close();
    }
    process.exit(0);
  });

// ---------------------------------------------------------------- ingest

program
  .command('ingest')
  .description('ingest JSONL records from stdin')
  .option('--adapter <name>', `adapter (${ADAPTER_NAMES.join('|')})`, 'generic')
  .option('--session <id>', 'session id', 'manual')
  .option('--worker', 'run a worker afterwards if triggers fire', false)
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const records = parseJsonl(await readStdin());
      const result = await m.cycle(
        opts.adapter,
        records,
        { sessionId: opts.session, cwd: m.projectRoot },
        { runWorker: opts.worker === true },
      );
      out(
        `ingested ${result.ingest.received} records: ${result.ingest.stored} stored, ` +
          `${result.ingest.discarded} discarded, ${result.ingest.duplicates} duplicate, ` +
          `${result.ingest.queued} queued`,
      );
      if (result.worker) out(`worker: ${result.worker.status} (${result.worker.reason})`);
      else out(`worker: skipped (${result.trigger.reason})`);
    } finally {
      m.close();
    }
  });

// ---------------------------------------------------------------- attach

program
  .command('attach')
  .description('follow an already-running agent session transcript')
  .option('--adapter <name>', `adapter (${ADAPTER_NAMES.join('|')})`, 'claude')
  .option('--transcript <path>', 'transcript file; defaults to the newest for this project')
  .option('--session <id>', 'session id override')
  .option('--watch', 'keep following', false)
  .option('--interval <seconds>', 'poll interval when watching', '5')
  .option('--from-start', 're-read the transcript from the beginning', false)
  .option('--no-worker', 'ingest only, never spawn a worker')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const found = opts.transcript
        ? { path: resolve(opts.transcript as string), sessionId: sessionIdFromFilename(resolve(opts.transcript as string)) ?? 'unknown' }
        : resolveTranscript(opts.adapter as string, m.projectRoot);
      if (!found) {
        const surface = preferredSurface(getAdapter(opts.adapter as string));
        out(`no transcript found for ${m.projectRoot}; pass --transcript`);
        if (surface?.description) out(`expected: ${surface.description}`);
        return;
      }
      const path = found.path;
      const sessionId = (opts.session as string) ?? found.sessionId;
      out(`following ${path}`);
      out(`session ${sessionId}`);

      const once = async (fromStart: boolean) => {
        const r = await m.tail(opts.adapter, path, sessionId, {
          runWorker: opts.worker !== false,
          fromStart,
        });
        if (r.ingest.received > 0 || r.worker) {
          out(
            `+${r.ingest.received} records, ${r.ingest.stored} stored, ${r.ingest.discarded} discarded` +
              (r.worker ? `, worker ${r.worker.status} -> v${r.worker.version}` : ''),
          );
        }
      };

      await once(opts.fromStart === true);
      if (opts.watch !== true) return;

      const interval = Math.max(1, Number(opts.interval)) * 1000;
      let stopping = false;
      process.on('SIGINT', () => {
        stopping = true;
      });
      while (!stopping) {
        await sleep(interval);
        if (stopping) break;
        try {
          await once(false);
        } catch (err) {
          process.stderr.write(`attach: ${(err as Error).message}\n`);
        }
      }
      out('detached');
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------- run

program
  .command('run')
  .description('run a coding agent with continuous context management')
  .argument('<command...>', 'the agent command, e.g. -- claude')
  .option('--adapter <name>', `adapter (${ADAPTER_NAMES.join('|')})`, 'claude')
  .option('--interval <seconds>', 'poll interval', '5')
  .action(async (commandArgs: string[], opts, cmd) => {
    const m = manager(cmd);
    const [bin, ...rest] = commandArgs;
    if (!bin) {
      out('nothing to run');
      m.close();
      return;
    }

    // The agent owns the terminal; we only watch its transcript. No PTY interception, so a
    // crash in the manager cannot take the agent down with it (PRD 35).
    const child = spawn(bin, rest, { stdio: 'inherit', cwd: m.projectRoot });
    const interval = Math.max(1, Number(opts.interval)) * 1000;
    let running = true;

    const loop = (async () => {
      while (running) {
        await sleep(interval);
        try {
          const found = resolveTranscript(opts.adapter as string, m.projectRoot);
          if (!found) continue;
          await m.tail(opts.adapter, found.path, found.sessionId, { runWorker: true });
        } catch (err) {
          process.stderr.write(`contextd: ${(err as Error).message}\n`);
        }
      }
    })();

    const code: number = await new Promise((res) => {
      child.on('exit', (c) => res(c ?? 0));
      child.on('error', (err) => {
        process.stderr.write(`failed to start ${bin}: ${err.message}\n`);
        res(127);
      });
    });
    running = false;
    await loop;

    // Final flush: capture whatever the last turns produced (PRD 24 session trigger).
    try {
      const found = resolveTranscript(opts.adapter as string, m.projectRoot);
      if (found) await m.tail(opts.adapter, found.path, found.sessionId, { runWorker: true });
      await m.compact(null);
    } catch (err) {
      process.stderr.write(`contextd final flush: ${(err as Error).message}\n`);
    }
    out(formatMetrics(m.metrics(null)));
    m.close();
    process.exit(code);
  });

// ---------------------------------------------------------------- status

program
  .command('status')
  .description('show context manager metrics')
  .option('--session <id>', 'limit to one session')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const metrics = m.metrics((opts.session as string) ?? null);
      out(opts.json ? JSON.stringify(metrics, null, 2) : formatMetrics(metrics));
    } finally {
      m.close();
    }
  });

// ---------------------------------------------------------------- memory

program
  .command('memory')
  .description('list persistent project memory')
  .option('--category <name>', `one of: ${MEMORY_CATEGORIES.join(', ')}`)
  .option('--all', 'include stale, superseded and archived items', false)
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const items = m.store
        .allItems(opts.all === true)
        .filter((i) => (opts.category ? i.category === opts.category : true))
        .filter((i) => (opts.all === true ? true : i.status === 'active'));

      if (opts.json) {
        out(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        out('no memory items yet');
        return;
      }
      let lastCategory = '';
      for (const i of items) {
        if (i.category !== lastCategory) {
          out(`\n${i.category}`);
          lastCategory = i.category;
        }
        const flags = [i.importance, `conf ${i.confidence.toFixed(2)}`, i.source];
        if (i.status !== 'active') flags.push(i.status);
        out(`  ${i.id}  ${i.text}`);
        out(`    ${flags.join(' · ')}${i.reason ? ` · why: ${i.reason}` : ''}`);
      }
    } finally {
      m.close();
    }
  });

// --------------------------------------------------------------- context

program
  .command('context')
  .description('build the context an agent should receive')
  .argument('[query...]', 'what you are about to work on')
  .option('--limit <n>', 'max retrieved items', '12')
  .option('--json', 'machine-readable output', false)
  .action((queryParts: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const query = queryParts.join(' ').trim();
      const built = query.length > 0 ? m.queryContext(query, { limit: Number(opts.limit) }) : m.bootstrapContext();
      if (opts.json) {
        out(JSON.stringify(built, null, 2));
        return;
      }
      out(built.text.length > 0 ? built.text : '(no memory recorded yet)');
      out('');
      out(`-- ${built.tokens} tokens of ${built.budget} budget, ${built.itemIds.length} items`);
    } finally {
      m.close();
    }
  });

// --------------------------------------------------------------- inspect

program
  .command('inspect')
  .description('explain why memory is held, or show the patch and event log')
  .argument('[id]', 'a memory item id')
  .option('--patches [n]', 'show the last N patches')
  .option('--events [n]', 'show the last N events')
  .option('--search <query>', 'show retrieval scoring for a query')
  .action((id: string | undefined, opts, cmd) => {
    const m = manager(cmd);
    try {
      if (id) {
        const item = m.store.getItem(id);
        if (!item) {
          out(`no such item: ${id}`);
          return;
        }
        out(JSON.stringify(item, null, 2));
        return;
      }

      if (opts.search) {
        const hits = new RetrievalEngine(m.store).search(opts.search as string, { limit: 15 });
        if (hits.length === 0) out('no matches');
        for (const h of hits) {
          out(`${h.score.toFixed(3)}  ${h.item.id}  [${h.item.category}]  ${h.item.text.slice(0, 90)}`);
          const f = h.factors;
          out(
            `        bm25 ${f.bm25.toFixed(3)} · importance ${f.importance.toFixed(2)} · ` +
              `recency ${f.recency.toFixed(3)} · confidence ${f.confidence.toFixed(2)}`,
          );
        }
        return;
      }

      if (opts.events) {
        const n = typeof opts.events === 'string' ? Number(opts.events) : 20;
        for (const e of m.store.recentEvents(null, n, 'low')) {
          out(`${e.timestamp}  ${e.type.padEnd(20)} ${e.importance.padEnd(9)} ${e.action}`);
          out(`    reasons: ${e.reasons.join(', ')}`);
        }
        return;
      }

      const n = typeof opts.patches === 'string' ? Number(opts.patches) : 15;
      for (const p of m.store.listPatches(n)) {
        const ops = [
          p.patch.add?.length ? `+${p.patch.add.length}` : null,
          p.patch.update?.length ? `~${p.patch.update.length}` : null,
          p.patch.remove?.length ? `-${p.patch.remove.length}` : null,
          p.patch.supersede?.length ? `>${p.patch.supersede.length}` : null,
          p.patch.working ? 'working' : null,
        ]
          .filter(Boolean)
          .join(' ');
        out(`v${p.base_version}->v${p.new_version}  ${p.origin.padEnd(14)} ${ops || '(no-op)'}`);
        if (p.note) out(`    ${p.note}`);
      }
    } finally {
      m.close();
    }
  });

// ---------------------------------------------------------------- replay

program
  .command('replay')
  .description('rebuild state by folding the patch log')
  .option('--version <n>', 'stop at this state version')
  .option('--verify', 'compare the fold against the materialized state', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const folded = m.store.replay(opts.version ? Number(opts.version) : undefined);
      if (opts.verify !== true) {
        out(JSON.stringify({ version: folded.version, working: folded.working, items: folded.items }, null, 2));
        return;
      }
      const live = m.store.currentState(true);
      const foldedIds = new Set(folded.items.map((i) => i.id));
      const liveIds = new Set(live.items.map((i) => i.id));
      const missing = [...liveIds].filter((i) => !foldedIds.has(i));
      const extra = [...foldedIds].filter((i) => !liveIds.has(i));
      out(`patch log version: ${folded.version}, materialized version: ${live.version}`);
      out(`items: ${folded.items.length} folded, ${live.items.length} materialized`);
      if (missing.length === 0 && extra.length === 0 && folded.version === live.version) {
        out('consistent');
      } else {
        out(`INCONSISTENT — missing from fold: ${missing.length}, only in fold: ${extra.length}`);
        process.exitCode = 1;
      }
    } finally {
      m.close();
    }
  });

// --------------------------------------------------------------- compact

program
  .command('compact')
  .description('drain the pending event queue through workers now')
  .option('--session <id>', 'limit to one session')
  .option('--task <name>', 'worker task (extraction|summarization|conflict_resolution|complex_reconciliation)', 'extraction')
  .option('--max-runs <n>', 'maximum worker runs', '10')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const outcomes = await m.compact(
        (opts.session as string) ?? null,
        opts.task as WorkerTask,
        Number(opts.maxRuns),
      );
      if (outcomes.length === 0) {
        out('nothing to compact');
        return;
      }
      for (const o of outcomes) {
        out(
          `${o.status.padEnd(9)} ${o.reason.padEnd(34)} events ${o.eventsProcessed}  ` +
            `v${o.version}  $${o.costUsd.toFixed(5)}`,
        );
        for (const v of o.violations) out(`    ${v.code}: ${v.message}`);
      }
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------- lifecycle

program
  .command('lifecycle')
  .description('where the session sits on the compaction ladder, and act on it')
  .option('--session <id>', 'limit to one session')
  .option('--act', 'run the maintenance the current stage authorises', false)
  .option('--max-runs <n>', 'maximum worker runs per model-backed action', '3')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const sessionId = (opts.session as string) ?? null;
      if (!opts.act) {
        out(formatPressure(m.pressure(sessionId), m.hardCompactions(sessionId)));
        out('');
        out('Nothing was run. Add --act to perform the authorised maintenance.');
        return;
      }
      const { assessment, performed } = await m.runLifecycle(sessionId, {
        maxRuns: Number(opts.maxRuns),
      });
      out(formatPressure(assessment, m.hardCompactions(sessionId)));
      out('');
      if (performed.length === 0) {
        out('steady: no maintenance warranted');
        return;
      }
      for (const p of performed) out(`${p.action.padEnd(18)} ${p.detail}`);
    } finally {
      m.close();
    }
  });

// -------------------------------------------------------------- conflicts

program
  .command('conflicts')
  .description('show contradictions currently sitting in memory (no model call)')
  .option('--limit <n>', 'maximum pairs', '20')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const conflicts = m.conflicts({ maxPairs: Number(opts.limit) });
      if (opts.json) {
        out(JSON.stringify(conflicts, null, 2));
        return;
      }
      if (conflicts.length === 0) {
        out('no contradictions detected');
        return;
      }
      for (const [n, c] of conflicts.entries()) {
        const where =
          c.a.category === c.b.category ? c.a.category : `${c.a.category} vs ${c.b.category}`;
        out(`${n + 1}. ${c.reason} (similarity ${c.similarity.toFixed(2)}) in ${where}`);
        for (const item of [c.a, c.b]) {
          const mark = item.id === c.newer ? 'newer' : 'older';
          out(`   ${item.id} [${mark}, ${item.importance}, src=${item.source}]`);
          out(`     ${item.text.slice(0, 140)}`);
        }
        out('');
      }
      out(`run "contextd reconcile" to have a worker resolve these`);
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------- reconcile

program
  .command('reconcile')
  .description('resolve contradictions, and optionally restructure the whole memory')
  .option('--restructure', 'also run the expensive whole-memory reconciliation pass', false)
  .option('--no-conflicts', 'skip conflict resolution')
  .option('--max-runs <n>', 'maximum conflict resolution runs', '3')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const outcomes = await m.reconcile({
        resolveConflicts: opts.conflicts !== false,
        restructure: opts.restructure === true,
        maxRuns: Number(opts.maxRuns),
      });
      if (outcomes.length === 0) {
        out('nothing to reconcile');
        return;
      }
      for (const o of outcomes) {
        out(`${o.status.padEnd(9)} ${o.reason.padEnd(34)} v${o.version}  $${o.costUsd.toFixed(5)}`);
        for (const v of o.violations) out(`    ${v.code}: ${v.message}`);
      }
    } finally {
      m.close();
    }
  });

// -------------------------------------------------------------- remember

program
  .command('remember')
  .description('record a user-level constraint or decision by hand')
  .argument('<text...>', 'the statement to remember')
  .option('--category <name>', `one of: ${MEMORY_CATEGORIES.join(', ')}`, 'constraints')
  .option('--reason <why>', 'why this holds')
  .option('--importance <level>', 'critical|high|medium|low', 'critical')
  .option('--source <who>', 'user|agent - "agent" for a correction you did not hear from the user', 'user')
  .option('--supersedes <ids>', 'comma-separated ids this statement replaces (they are retired, not deleted)')
  .action((textParts: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const text = textParts.join(' ').trim();
      const source = opts.source === 'agent' ? 'agent' : 'user';
      const supersedes = typeof opts.supersedes === 'string'
        ? opts.supersedes.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];
      const result = m.remember({
        add: [
          {
            category: opts.category as MemoryCategory,
            text,
            reason: (opts.reason as string) ?? null,
            importance: opts.importance,
            source,
            // 1.0 is for what the user said in so many words (invariant 23).
            confidence: source === 'user' ? 1 : 0.85,
            supersedes,
            ...(opts.reason ? { fields: { reason: opts.reason } } : {}),
          },
        ],
        note: 'contextd remember',
      });
      if (!result.ok) {
        out(`rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
        process.exitCode = 1;
        return;
      }
      out(`remembered ${result.added.join(', ')} (state v${result.version})`);
    } finally {
      m.close();
    }
  });

program
  .command('forget')
  .description('retire memory items that are wrong or not project state (kept in the patch log)')
  .argument('<ids...>', 'ids of the items to retire')
  .requiredOption('--reason <why>', 'why they are wrong - recorded in the patch log')
  .action((ids: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const result = m.retire(ids, opts.reason as string);
      if (!result.ok) {
        out(`rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
        process.exitCode = 1;
        return;
      }
      out(`retired ${ids.join(', ')} (state v${result.version})`);
    } finally {
      m.close();
    }
  });

// ----------------------------------------------------------------- export

program
  .command('export')
  .description('export the full memory and patch log as JSON')
  .option('--out <file>', 'write to a file instead of stdout')
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const payload = {
        exported_at: new Date().toISOString(),
        project: m.config.project.name,
        state: m.store.currentState(true),
        patches: m.store.listPatches(100_000).reverse(),
        sessions: m.store.listSessions(1000),
      };
      const text = JSON.stringify(payload, null, 2);
      if (opts.out) {
        writeFileSync(resolve(opts.out as string), `${text}\n`, 'utf8');
        out(`wrote ${opts.out}`);
      } else {
        out(text);
      }
    } finally {
      m.close();
    }
  });

// ----------------------------------------------------------------- import

program
  .command('import')
  .description('replay an exported patch log into this project')
  .argument('<file>', 'a file produced by `contextd export`')
  .option('--force', 'apply patches even if their items already exist', false)
  .action((file: string, opts, cmd) => {
    const m = manager(cmd);
    try {
      const raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as {
        patches?: Array<{ patch: unknown; origin?: string; note?: string | null }>;
      };
      if (!Array.isArray(raw.patches)) {
        out('that file has no patch log; expected the output of `contextd export`');
        process.exitCode = 1;
        return;
      }
      const parsed = raw.patches.flatMap((entry) => {
        const p = StatePatchSchema.safeParse(entry.patch);
        return p.success ? [{ patch: p.data, origin: entry.origin, note: entry.note ?? null }] : [];
      });
      const malformed = raw.patches.length - parsed.length;
      const r = m.importPatches(parsed, { skipExisting: opts.force !== true });
      out(`applied ${r.applied}, skipped ${r.skipped} already present, rejected ${r.rejected}`);
      if (malformed > 0) out(`ignored ${malformed} malformed entries`);
      out(`state is now at v${m.store.stateVersion()}`);
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------ prune

program
  .command('prune')
  .description('apply retention and memory decay')
  .action((_opts, cmd) => {
    const m = manager(cmd);
    try {
      const r = m.prune();
      out(`pruned ${r.events} raw events, marked ${r.items} memory items stale`);
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------ reset

program
  .command('reset')
  .description('delete all stored context for this project')
  .option('--events-only', 'keep memory, drop raw history', false)
  .option('--yes', 'skip the confirmation', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      if (opts.yes !== true) {
        out(`This deletes ${opts.eventsOnly ? 'all raw events' : 'all context'} in ${m.storageDir}.`);
        out('Re-run with --yes to confirm.');
        return;
      }
      if (opts.eventsOnly === true) {
        m.store.db.exec(`DELETE FROM events; DELETE FROM ingest_cursors;`);
        out('raw history cleared');
        return;
      }
      m.store.db.exec(
        `DELETE FROM events; DELETE FROM memory_items; DELETE FROM patches;
         DELETE FROM working_memory; DELETE FROM worker_runs; DELETE FROM file_index;
         DELETE FROM retrieval_log; DELETE FROM agent_usage; DELETE FROM ingest_cursors;
         UPDATE meta SET value = '0' WHERE key IN ('state_version', 'patch_seq');`,
      );
      out('context reset');
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------ bench

program
  .command('bench')
  .description('compare managed context against the unmanaged baseline')
  .option('--session <id>', 'limit to one session')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const b = benchmark(m, (opts.session as string) ?? null);
      out(opts.json ? JSON.stringify(b, null, 2) : formatBench(b));
    } finally {
      m.close();
    }
  });

// --------------------------------------------------------------------- ui

program
  .command('ui')
  .description('serve a read-only dashboard of the project state')
  .option('--port <n>', 'port to listen on', '7717')
  .option('--host <addr>', 'bind address; loopback by default', '127.0.0.1')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    const handle = await startUi(m, { port: Number(opts.port), host: opts.host as string });
    out(`contextd ui on ${handle.url}`);
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      out('warning: bound beyond loopback; project memory is now reachable from the network');
    }
    out('read-only. Ctrl-C to stop.');
    const stop = async () => {
      await handle.close();
      m.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  });

// -------------------------------------------------------------------- mcp

program
  .command('mcp')
  .description('serve project memory over MCP on stdio')
  .action(async (_opts, cmd) => {
    const m = manager(cmd);
    // stdout is the MCP transport from here on; anything else would corrupt the stream.
    await runMcpStdio(m);
  });

// ------------------------------------------------------------------- graph

program
  .command('graph')
  .description('show typed relations between memory items')
  .argument('[id]', 'a memory item id; omit to list every relation')
  .option('--json', 'machine-readable output', false)
  .action((id: string | undefined, opts, cmd) => {
    const m = manager(cmd);
    try {
      if (!id) {
        const edges = m.store.allEdges();
        if (opts.json) {
          out(JSON.stringify(edges, null, 2));
          return;
        }
        if (edges.length === 0) {
          out('no relations recorded yet');
          out('workers add these as they extract memory; see `contextd reconcile`');
          return;
        }
        for (const e of edges) {
          out(`${e.from} --${e.kind}--> ${e.to}${e.reason ? `  (${e.reason})` : ''}`);
        }
        return;
      }

      const item = m.store.getItem(id);
      if (!item) {
        out(`no such item: ${id}`);
        process.exitCode = 1;
        return;
      }
      const neighbourhood = m.graphOf(id);
      if (opts.json) {
        out(JSON.stringify({ item, edges: neighbourhood }, null, 2));
        return;
      }
      out(`${item.id} [${item.category}] ${item.text}`);
      if (neighbourhood.length === 0) {
        out('  (no relations)');
        return;
      }
      for (const { edge, direction, other } of neighbourhood) {
        const arrow = direction === 'out' ? `--${edge.kind}-->` : `<--${edge.kind}--`;
        const target = direction === 'out' ? edge.to : edge.from;
        out(`  ${arrow} ${target}`);
        if (other) out(`      ${other.text.slice(0, 110)}`);
        if (edge.reason) out(`      why: ${edge.reason}`);
      }
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------- embed

program
  .command('embed')
  .description('build the optional semantic index over memory')
  .option('--limit <n>', 'items per batch')
  .option('--all', 'keep going until nothing is stale', false)
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      if (!m.embeddings.enabled) {
        out('embeddings are disabled');
        out('enable with: "embeddings": { "enabled": true, "provider": "ollama" }');
        out('keyword retrieval works without this; it is an optional layer');
        return;
      }
      let total = 0;
      for (let round = 0; ; round += 1) {
        const r = await m.embed(opts.limit ? Number(opts.limit) : undefined);
        total += r.embedded;
        if (r.error) {
          out(`error: ${r.error}`);
          process.exitCode = 1;
          break;
        }
        if (r.embedded === 0) break;
        out(`embedded ${r.embedded} items (${total} total)`);
        if (opts.all !== true || round > 200) break;
      }
      out(`semantic index holds ${m.embeddings.count()} vectors (model ${m.embeddings.model})`);
    } finally {
      m.close();
    }
  });

// ------------------------------------------------------------------ doctor

program
  .command('doctor')
  .description('check that ingestion, providers, budgets and the patch log are wired correctly')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const checks = diagnose(m);
      out(opts.json ? JSON.stringify(checks, null, 2) : formatChecks(checks));
      // Non-zero on failure so this is usable in a setup script or CI step.
      if (worstStatus(checks) === 'fail') process.exitCode = 1;
    } finally {
      m.close();
    }
  });

// ---------------------------------------------------------------- surfaces

program
  .command('surfaces')
  .description('list how each supported agent can be ingested from')
  .action(() => {
    for (const adapter of Object.values(ADAPTERS)) {
      out(`${adapter.name}  (${adapter.agent})`);
      for (const s of adapter.surfaces) {
        const flags = [s.kind, s.preferred ? 'preferred' : null, s.installable ? 'auto-installable' : 'manual']
          .filter(Boolean)
          .join(', ');
        out(`  [${flags}]`);
        out(`    ${s.description}`);
      }
      out('');
    }
  });

// -------------------------------------------------------------- sessions

program
  .command('sessions')
  .description('list observed agent sessions')
  .action((_opts, cmd) => {
    const m = manager(cmd);
    try {
      const rows = m.store.listSessions(50);
      if (rows.length === 0) {
        out('no sessions observed yet');
        return;
      }
      for (const s of rows) {
        out(
          `${s.started_at}  ${s.source.padEnd(8)} ${String(s.events).padStart(6)} events  ` +
            `${s.ended_at ? 'ended  ' : 'active '} ${s.id}`,
        );
      }
    } finally {
      m.close();
    }
  });

// ---------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve which transcript to follow by asking the adapter, so the CLI keeps no knowledge
 * of where any particular agent stores its logs (PRD 22).
 */
function resolveTranscript(
  adapterName: string,
  projectRoot: string,
): { path: string; sessionId: string } | null {
  const found = newestTranscript(getAdapter(adapterName), projectRoot, homedir());
  if (!found) return null;
  return { path: found.path, sessionId: found.sessionId ?? sessionIdFromFilename(found.path) ?? 'unknown' };
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`contextd: ${(err as Error).message}\n`);
  process.exit(1);
});
