#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADAPTER_NAMES,
  ADAPTERS,
  agentDetected,
  getAdapter,
  getIngestAdapter,
  hookInstaller,
  INGEST_ADAPTER_NAMES,
  ingests,
  instructionFiles,
  mcpAdapters,
  nativeMemorySources,
  newestTranscript,
  preferredSurface,
  realHost,
  sessionIdFromFilename,
  type McpChange,
} from '../adapters/index.js';
import { MEMORY_CATEGORIES, type MemoryCategory } from '../core/state.js';
import { isOurHookCommand, launchString, selfLaunch } from '../ops/self.js';
import { entryIsLive, filterRegistry, registerProject, readRegistry, registryPath, unregisterProject } from '../ops/registry.js';
import { dbPath } from '../store/db.js';
import { mcpInstall, mcpStatus, mcpUninstall, purge, purgeTargets, uninstallWiring } from '../ops/install.js';
import {
  candidateMirrorFiles,
  checkMirror,
  mirrorCreatedFiles,
  isTrackedByGit,
  mirrorTarget,
  writeMirror,
} from '../ops/mirror.js';
import { applyNativeImport, planNativeImport, type ImportPlan } from '../ops/import-native.js';
import { MARKDOWN_SOURCE, planMarkdownImport } from '../ops/import-markdown.js';
import { formatOverview, summarizeProject } from '../ops/overview.js';
import { createInterface } from 'node:readline/promises';
import { isProtected, StatePatchSchema } from '../core/patch.js';
import { CONFIG_FILENAMES, findConfigFile, loadConfig, ModelTierSchema, type WorkerTask } from '../core/config.js';
import { ContextManager } from '../daemon/manager.js';
import { formatMetrics, formatPressure } from '../metrics/index.js';
import { benchmark, formatBench } from '../bench/index.js';
import { evaluateRetrieval, formatRetrievalEval } from '../bench/retrieval-eval.js';
import { formatJudgeReport, judgeRetrieval, JudgeRefused } from '../bench/retrieval-judge.js';
import { getProvider } from '../workers/providers/index.js';
import { runMcpStdio, similarHint } from '../mcp/server.js';
import { startUi } from '../ui/server.js';
import { RetrievalEngine } from '../store/retrieval.js';
import { getEmbeddingProvider } from '../store/embeddings.js';
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
  .option('--agent <name>', `adapter to wire up (${ADAPTER_NAMES.join('|')})`, 'claude')
  .option('--global', 'install hooks in the user-level settings instead of the project', false)
  .option('--no-hooks', 'write the config only')
  .option('--mcp [scope]', 'also register the MCP server for this agent (default scope: the adapter\'s)')
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
    const recorded = m.installedHookCommand();
    const root = m.projectRoot;
    noteProject(m);
    m.close();

    const adapter = getAdapter(opts.agent as string);
    const host = realHost(root);
    if (!ingests(adapter)) {
      // Nothing to wire for ingestion; say how memory reaches this agent instead.
      out(`${adapter.agent} has no ingestion surface contextd supports: nothing it does is recorded`);
      const file = adapter.instructionFiles?.[0];
      if (file) out(`to give it the bootstrap as a file: contextd mirror --target ${file.target}`);
    } else if (opts.hooks !== false) {
      const installer = hookInstaller(adapter);
      if (!installer) {
        out(`${adapter.agent} has no hook surface; use "contextd attach" or "contextd ingest"`);
      } else {
        const hookCommand = `${launchString(selfLaunch())} -C ${cwd} hook`;
        // A hook left over from a build that has since moved would otherwise count as "someone
        // else's hook" and block the new one; ours are recognised by shape and replaced.
        const stale = installer.uninstall(
          host,
          (c) => c !== hookCommand && isOurHookCommand(c, root, recorded),
        );
        for (const s of stale) out(`replaced the previous contextd hook in ${s.path}`);
        const res = installer.install(host, { command: hookCommand, global: opts.global === true });
        const recorder = new ContextManager({ cwd });
        recorder.noteInstalledHookCommand(hookCommand);
        recorder.close();
        out(`${res.created ? 'created' : 'updated'} ${res.path}`);
        if (res.preserved.length > 0) {
          out(`left your existing hooks alone for: ${res.preserved.join(', ')}`);
          out('add the contextd hook to those events manually if you want them ingested');
        }
      }
    }

    if (opts.mcp !== undefined) {
      if (!adapter.mcp) {
        out(`${adapter.agent} has no MCP registration surface`);
        return;
      }
      const scope = typeof opts.mcp === 'string' ? opts.mcp : undefined;
      printMcpChange(adapter.name, mcpInstall(host, adapter, selfLaunch(), { ...(scope ? { scope } : {}) }));
    } else if (adapter.mcp) {
      out(`to let ${adapter.agent} query memory: contextd mcp install --adapter ${adapter.name}`);
    }
  });

/** Record the project in the user-level registry for `status --all`. Never fails the caller. */
function noteProject(m: ContextManager): void {
  registerProject(registryPath(homedir(), process.env), m.projectRoot, m.storageDir);
}

/**
 * The same, for commands that also run in directories nobody set up: opening a manager creates
 * storage, so a stray `contextd status` in the wrong directory must not add it to every future
 * `status --all`. A config file or an observed session is the evidence of real use.
 */
function noteProjectIfInUse(m: ContextManager): void {
  if (m.loaded.path != null || m.store.lastActivity() != null) noteProject(m);
}

function printMcpChange(adapter: string, c: McpChange): void {
  out(`${adapter}: ${c.status.padEnd(10)} [${c.scope}] ${c.detail}`);
  if (c.status === 'conflict' || c.status === 'failed') process.exitCode = 1;
}

// ------------------------------------------------------------------ hook

program
  .command('hook')
  .description('handle one agent hook payload on stdin (fast, never calls a model)')
  .option('--adapter <name>', `adapter (${INGEST_ADAPTER_NAMES.join('|')})`, 'claude')
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
        // Projects set up before the registry existed appear in `status --all` from their next
        // session. Once per session, and a no-op read when the entry is already current.
        noteProject(m);
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
  .option('--adapter <name>', `adapter (${INGEST_ADAPTER_NAMES.join('|')})`, 'generic')
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
  .option('--adapter <name>', `adapter (${INGEST_ADAPTER_NAMES.join('|')})`, 'claude')
  .option('--transcript <path>', 'transcript file; defaults to the newest for this project')
  .option('--session <id>', 'session id override')
  .option('--watch', 'keep following', false)
  .option('--interval <seconds>', 'poll interval when watching', '5')
  .option('--from-start', 're-read the transcript from the beginning', false)
  .option('--no-worker', 'ingest only, never spawn a worker')
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    noteProject(m);
    try {
      const found = opts.transcript
        ? { path: resolve(opts.transcript as string), sessionId: sessionIdFromFilename(resolve(opts.transcript as string)) ?? 'unknown' }
        : resolveTranscript(opts.adapter as string, m.projectRoot);
      if (!found) {
        const surface = preferredSurface(getIngestAdapter(opts.adapter as string));
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
  .option('--adapter <name>', `adapter (${INGEST_ADAPTER_NAMES.join('|')})`, 'claude')
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
  .option('--all', 'one line per project contextd knows on this machine (read-only)', false)
  .action((opts, cmd) => {
    if (opts.all === true) {
      // Deliberately no manager for the current directory: that would create storage here.
      const rows = readRegistry(registryPath(homedir(), process.env)).map(summarizeProject);
      out(opts.json ? JSON.stringify(rows, null, 2) : formatOverview(rows));
      return;
    }
    const m = manager(cmd);
    try {
      noteProjectIfInUse(m);
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
  .option('--category <name>', `restrict to one category; alone, list it (${MEMORY_CATEGORIES.join(', ')})`)
  .option('--json', 'machine-readable output', false)
  .action(async (queryParts: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const query = queryParts.join(' ').trim();
      const category = opts.category as string | undefined;
      if (category && !(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
        out(`unknown category: ${category} (one of: ${MEMORY_CATEGORIES.join(', ')})`);
        process.exitCode = 1;
        return;
      }
      const categories = category ? { categories: [category as MemoryCategory] } : {};
      const built =
        query.length > 0 || category
          ? await m.queryContextHybrid(query, { limit: Number(opts.limit), ...categories })
          : m.bootstrapContext();
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
  .option('--task <name>', 'worker task (extraction|summarization|conflict_resolution|complex_reconciliation; learn has its own command)', 'extraction')
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

// ------------------------------------------------------------------ learn

program
  .command('learn')
  .description('turn failure -> success episodes into lessons (one model call per session with an episode)')
  .option('--session <id>', 'learn from this session (default: the most recent one)')
  .option('--all', 'every session with new episodes', false)
  .option('--dry-run', 'print the digests that would be sent; call no model, write nothing', false)
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      const results = await m.learn({
        sessionId: (opts.session as string) ?? null,
        all: opts.all === true,
        dryRun: opts.dryRun === true,
      });
      const withEpisodes = results.filter((r) => r.input != null);
      if (withEpisodes.length === 0) {
        out('no new failure -> success episodes; no model was called');
        return;
      }
      let cost = 0;
      let tokens = 0;
      for (const r of withEpisodes) {
        const d = r.input!.digest;
        const omitted = d.omitted > 0 ? `, ${d.omitted} left for the next run` : '';
        out(`session ${r.sessionId}: ${d.episodes.length} episodes, ~${d.tokens} digest tokens${omitted}`);
        if (opts.dryRun) {
          out('');
          out(d.text);
          out('');
          continue;
        }
        const o = r.outcome!;
        cost += o.costUsd;
        tokens += o.usage ? o.usage.input_tokens + o.usage.output_tokens : 0;
        out(`  ${o.status.padEnd(9)} ${o.reason}  v${o.version}`);
        for (const v of o.violations) out(`    ${v.code}: ${v.message}`);
        if (o.patchId) {
          const learned = m.store
            .allItems()
            .filter((i) => i.tags.includes('learned') && i.evidence.some((id) => d.evidenceIds.has(id)));
          for (const i of learned) out(`    + ${i.id} [${i.category}] ${i.text}`);
        }
      }
      if (opts.dryRun) out('dry run: no model called, nothing written');
      else out(`worker tokens ${tokens}  cost $${cost.toFixed(5)}`);
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
  .action(async (textParts: string[], opts, cmd) => {
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
      const newId = result.added[0];
      const hint = newId ? await similarHint(m, newId, 'cli') : '';
      if (hint) out(hint);
    } finally {
      m.close();
    }
  });

program
  .command('forget')
  .description('retire memory items that are wrong or not project state (kept in the patch log)')
  .argument('<ids...>', 'ids of the items to retire')
  .requiredOption('--reason <why>', 'why they are wrong - recorded in the patch log')
  .option('--protected', 'also user-critical items; asks you to type each id at an interactive terminal', false)
  .action(async (ids: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      let release: string[] = [];
      if (opts.protected === true) {
        const guarded = ids.filter((id) => {
          const item = m.store.getItem(id);
          return item != null && isProtected(item);
        });
        if (guarded.length > 0) {
          // The consent has to come from a person. An agent's shell tool is not a terminal, so this
          // is the line between the user correcting their own instruction and an agent removing it.
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            out(`refused: ${guarded.join(', ')} ${guarded.length === 1 ? 'is' : 'are'} user-critical; releasing ${guarded.length === 1 ? 'it' : 'them'} must be confirmed at an interactive terminal`);
            process.exitCode = 1;
            return;
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            for (const id of guarded) {
              out(`${id}  ${m.store.getItem(id)?.text ?? ''}`);
              const typed = (await rl.question(`user-critical. Type ${id} to retire it: `)).trim();
              if (typed !== id) {
                out('not confirmed; nothing retired');
                process.exitCode = 1;
                return;
              }
            }
          } finally {
            rl.close();
          }
          release = guarded;
        }
      }
      const result = m.retire(ids, opts.reason as string, { releaseProtected: release });
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

program
  .command('task')
  .description('show or set the current task in working memory')
  .argument('[text...]', 'the task; omit to show the current one')
  .option('--status <s>', 'unknown|planning|in_progress|blocked|review|done')
  .option('--next <action>', 'the next concrete action')
  .option('--state <text>', 'where things stand')
  .option('--plan <steps...>', 'replace the plan with these steps')
  .option('--clear', 'clear task, state, next action and plan')
  .action((textParts: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const text = textParts.join(' ').trim();
      const change = opts.clear
        ? { current_task: null, task_status: 'unknown' as const, current_state: null, next_action: null, current_plan: [] }
        : {
            ...(text ? { current_task: text } : {}),
            ...(opts.status ? { task_status: opts.status } : {}),
            ...(opts.next ? { next_action: opts.next as string } : {}),
            ...(opts.state ? { current_state: opts.state as string } : {}),
            ...(opts.plan ? { current_plan: opts.plan as string[] } : {}),
          };
      if (Object.keys(change).length > 0) {
        const result = m.setTask(change);
        if (!result.ok) {
          out(`rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
          process.exitCode = 1;
          return;
        }
      }
      const w = m.store.workingMemory();
      out(`task:    ${w.current_task ?? '(none)'}`);
      out(`status:  ${w.task_status}`);
      if (w.current_state) out(`state:   ${w.current_state}`);
      if (w.next_action) out(`next:    ${w.next_action}`);
      for (const [n, p] of w.current_plan.entries()) out(`plan ${n + 1}:  ${p}`);
      out(`updated: ${w.updated_at ?? 'never'}`);
    } finally {
      m.close();
    }
  });

program
  .command('close')
  .description('mark goals met, requirements satisfied, questions answered or issues resolved')
  .argument('<ids...>', 'ids of the items to close')
  .requiredOption('--reason <what>', 'what closed them - kept with the item')
  .action((ids: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const result = m.closeItems(ids, opts.reason as string);
      if (!result.ok) {
        out(`rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
        process.exitCode = 1;
        return;
      }
      out(`closed ${ids.join(', ')} (state v${result.version}); still findable by query`);
    } finally {
      m.close();
    }
  });

program
  .command('reopen')
  .description('undo a close: the goal was not met after all')
  .argument('<ids...>', 'ids of the items to reopen')
  .requiredOption('--reason <why>', 'why it is open again')
  .action((ids: string[], opts, cmd) => {
    const m = manager(cmd);
    try {
      const result = m.reopenItems(ids, opts.reason as string);
      if (!result.ok) {
        out(`rejected: ${result.violations.map((v) => `${v.code} ${v.message}`).join('; ')}`);
        process.exitCode = 1;
        return;
      }
      out(`reopened ${ids.join(', ')} (state v${result.version})`);
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
  .description('replay an exported patch log, or import an agent\'s own memory or instruction files (--from)')
  .argument(
    '[files...]',
    'a file produced by `contextd export`; with --from, the directory to read; with --from markdown, the files',
  )
  .option('--force', 'apply patches even if their items already exist', false)
  .option(
    '--from <source>',
    `one-way import of an agent's native memory (${nativeMemorySources().map((s) => s.name).join('|')}), ` +
      `or of instruction files (${MARKDOWN_SOURCE}: CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules/*.mdc, any .md)`,
  )
  .option('--dry-run', 'with --from: show what would be imported, change nothing', false)
  .action((files: string[], opts, cmd) => {
    const m = manager(cmd);
    const file = files[0];
    try {
      if (opts.from === MARKDOWN_SOURCE) {
        if (files.length === 0) {
          out(`pass the files to read: contextd import --from ${MARKDOWN_SOURCE} CLAUDE.md AGENTS.md`);
          process.exitCode = 1;
          return;
        }
        runImport(m, planMarkdownImport(m.store, files, m.projectRoot), opts.dryRun === true, true);
        return;
      }
      if (opts.from) {
        const source = nativeMemorySources().find((s) => s.name === opts.from);
        if (!source) {
          out(`unknown source "${opts.from}" (available: ${nativeMemorySources().map((s) => s.name).join(', ')})`);
          process.exitCode = 1;
          return;
        }
        const dir = file ? resolve(file) : source.locate(m.projectRoot, homedir());
        if (!existsSync(dir)) {
          out(`nothing to import: ${dir} does not exist`);
          return;
        }
        runImport(m, planNativeImport(m.store, source, dir), opts.dryRun === true, false);
        return;
      }
      if (!file) {
        out('pass a file from `contextd export`, or --from <source>');
        process.exitCode = 1;
        return;
      }
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

/** Show an import plan, then apply it unless it is a dry run. */
function runImport(m: ContextManager, plan: ImportPlan, dryRun: boolean, quietSkips: boolean): void {
  out(`${plan.source}: ${plan.dir}`);
  for (const c of plan.changes) {
    const verb = c.action === 'add' ? '+ add    ' : c.action === 'replace' ? '~ replace' : '~ refresh';
    out(`${verb} [${c.entry.category}] ${c.entry.text.slice(0, 100)}${c.previous ? `  (was ${c.previous.id})` : ''}`);
  }
  // A markdown file skips most of what it holds; the reasons are the review, shown on a dry run.
  if (quietSkips && !dryRun) {
    if (plan.skipped.length > 0) out(`  ${plan.skipped.length} blocks skipped; --dry-run lists them with the reason`);
  } else {
    for (const s of plan.skipped) out(`  skip   ${s.file.split('/').pop()} (${s.reason})`);
  }
  for (const o of plan.orphaned) {
    out(`  gone   ${o.id} [${o.category}] ${o.text.slice(0, 80)} - no longer in the source; kept (contextd forget ${o.id})`);
  }
  out(`${plan.changes.length} to import, ${plan.unchanged.length} unchanged since the last import`);
  if (dryRun) {
    out('dry run: nothing was written');
    return;
  }
  const r = applyNativeImport(m, plan);
  if (!r.ok) {
    out(`rejected: ${r.violations.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  if (r.nothingNew) out('nothing new: already in memory');
  else out(`imported: ${r.added.length} added, ${r.updated.length} updated (state v${r.version}), source "import"`);
}

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
  .option('--retrieval', 'instead: retrieval quality (recall@k, MRR) on the golden fixture', false)
  .option('--real-embeddings', 'with --retrieval: use the configured embedding provider, not the offline stand-in', false)
  .option('--k <n>', 'with --retrieval: cutoff for recall@k', '5')
  .option('--verbose', 'with --retrieval: per-query ranks', false)
  .option('--judge', 'with --retrieval: ask a model whether each served context answers its query (costs calls)', false)
  .option('--judge-tier <tier>', 'with --judge: which configured model tier judges (cheap|medium|high)', 'cheap')
  .option('--judge-limit <n>', 'with --judge: judge only the first n queries')
  .option('--json', 'machine-readable output', false)
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    try {
      if (opts.retrieval === true) {
        // The fixture runs in its own in-memory store; this project's memory is only read for its
        // embedding config, and nothing measured is written back (invariant 28).
        const real = opts.realEmbeddings === true;
        if (real && !m.embeddings.enabled) {
          out('--real-embeddings: embeddings are disabled in this project; using the offline stand-in');
        }
        const provider = real && m.embeddings.enabled ? getEmbeddingProvider(m.config.embeddings.provider) : null;
        const e = await evaluateRetrieval({
          k: Number(opts.k),
          ...(provider ? { provider, embeddings: m.config.embeddings } : {}),
        });
        if (opts.judge !== true) {
          out(opts.json ? JSON.stringify(e, null, 2) : formatRetrievalEval(e, opts.verbose === true));
          return;
        }
        const tier = ModelTierSchema.parse(opts.judgeTier);
        const spec = m.config.models.tiers[tier];
        if (!spec) throw new Error(`no model configured for tier ${tier}`);
        try {
          const report = await judgeRetrieval(e, {
            provider: getProvider(spec.provider),
            spec,
            localOnly: m.config.privacy.local_only,
            timeoutMs: m.config.limits.worker_timeout_ms,
            ...(opts.judgeLimit != null ? { limit: Number(opts.judgeLimit) } : {}),
          });
          if (opts.json) {
            out(JSON.stringify({ ...e, judge: report }, null, 2));
          } else {
            out(formatRetrievalEval(e, opts.verbose === true));
            out('');
            out(formatJudgeReport(report, opts.verbose === true));
          }
        } catch (err) {
          if (!(err instanceof JudgeRefused)) throw err;
          out(formatRetrievalEval(e, opts.verbose === true));
          out('');
          out(`--judge: ${err.message}`);
          process.exitCode = 1;
        }
        return;
      }
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
    noteProjectIfInUse(m);
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

const mcp = program.command('mcp').description('serve memory over MCP (default), or manage its registration');

mcp
  .command('serve', { isDefault: true })
  .description('serve project memory over MCP on stdio')
  .action(async (_opts, cmd) => {
    const m = manager(cmd);
    // stdout is the MCP transport from here on; anything else would corrupt the stream.
    await runMcpStdio(m);
  });

function projectRootOf(cmd: Command): string {
  const m = manager(cmd);
  const root = m.projectRoot;
  m.close();
  return root;
}

mcp
  .command('install')
  .description('register the contextd MCP server with an agent (idempotent)')
  .option('--adapter <name>', 'only this agent; default every agent that speaks MCP and is in use here')
  .option('--scope <scope>', "where to register; default the adapter's own default")
  .option('--force', 'replace an existing contextd entry that runs a different command', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    noteProject(m);
    const host = realHost(m.projectRoot);
    m.close();
    const launch = selfLaunch();
    // Without --adapter, only agents that look used: registering creates their config directory.
    const targets = opts.adapter
      ? mcpAdapters(opts.adapter as string)
      : mcpAdapters().filter((a) => agentDetected(a, host));
    for (const adapter of targets) {
      try {
        printMcpChange(
          adapter.name,
          mcpInstall(host, adapter, launch, {
            ...(opts.scope ? { scope: opts.scope as string } : {}),
            force: opts.force === true,
          }),
        );
      } catch (err) {
        out(`${adapter.name}: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
    out('start a new agent session for the server to load');
  });

mcp
  .command('uninstall')
  .description("remove this project's contextd MCP registrations (nothing else)")
  .option('--adapter <name>', 'only this agent')
  .option('--scope <scope>', 'only this scope')
  .action((opts, cmd) => {
    const host = realHost(projectRootOf(cmd));
    for (const adapter of mcpAdapters(opts.adapter as string | undefined)) {
      const changes = mcpUninstall(host, adapter, opts.scope as string | undefined);
      if (changes.length === 0) out(`${adapter.name}: absent     not registered`);
      for (const c of changes) printMcpChange(adapter.name, c);
    }
  });

mcp
  .command('status')
  .description('where the contextd MCP server is registered, and whether it can start')
  .option('--adapter <name>', 'only this agent')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const host = realHost(projectRootOf(cmd));
    const status = mcpStatus(host, mcpAdapters(opts.adapter as string | undefined));
    if (opts.json) {
      out(JSON.stringify(status, null, 2));
      return;
    }
    for (const r of status.rows) {
      const flags = [
        r.entry.managed ? null : 'not written by contextd',
        r.servesThisProject ? 'serves this project' : 'another project',
        r.resolution?.problem ? `BROKEN: ${r.resolution.problem}` : null,
      ].filter(Boolean);
      out(`${r.adapter}: [${r.entry.scope}] ${r.entry.where}`);
      if (r.entry.managed) out(`    ${[r.entry.command, ...r.entry.args].join(' ')}`);
      out(`    ${flags.join(' · ')}`);
    }
    for (const name of status.missing) {
      // An agent never used here is not "missing" a registration unless it was asked about.
      if (!opts.adapter && !agentDetected(getAdapter(name), host)) continue;
      out(`${name}: not registered  (contextd mcp install --adapter ${name})`);
    }
  });

// -------------------------------------------------------------- uninstall

program
  .command('uninstall')
  .description('remove the hooks, MCP registrations and mirror blocks contextd added; keeps .context unless --purge')
  .option('--purge', 'also delete the stored memory and the config file', false)
  .option('--yes', 'confirm --purge without a prompt (required when not a terminal)', false)
  .action(async (opts, cmd) => {
    const m = manager(cmd);
    const root = m.projectRoot;
    const recordedHook = m.installedHookCommand();
    const storageDir = m.storageDir;
    const mirrorFiles = candidateMirrorFiles(m);
    const mirrorCreated = mirrorCreatedFiles(m);
    const doomed = opts.purge === true ? purgeTargets(m.storageDir, m.loaded.path) : [];
    m.close();

    // Confirm before touching anything, so a declined purge leaves the wiring as it was too.
    if (doomed.length > 0) {
      out('--purge deletes:');
      for (const p of doomed) out(`  ${p}`);
      if (opts.yes !== true) {
        if (!process.stdin.isTTY) {
          out('not a terminal: re-run with --yes to confirm');
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('delete these? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') {
          out('nothing changed');
          return;
        }
      }
    }

    const report = uninstallWiring({
      env: realHost(root),
      adapters: Object.values(ADAPTERS),
      recordedHook,
      mirrorFiles,
      mirrorCreated,
    });
    for (const h of report.hooks) out(`${h.adapter}: removed hooks (${h.events.join(', ')}) from ${h.path}`);
    for (const { adapter, change } of report.mcp) printMcpChange(adapter, change);
    for (const mm of report.mirrors) out(`mirror: ${mm.result === 'deleted' ? 'deleted' : 'removed the block from'} ${mm.path}`);
    if (report.hooks.length + report.mcp.length + report.mirrors.length === 0) out('no contextd wiring found');

    if (doomed.length > 0) {
      purge(doomed);
      unregisterProject(registryPath(homedir(), process.env), root);
      for (const p of doomed) out(`deleted ${p}`);
    } else {
      out(`project memory kept in ${storageDir} (use --purge to delete it)`);
    }
  });

// ----------------------------------------------------------------- mirror

program
  .command('mirror')
  .description('write the bootstrap into an instruction file the agent already reads')
  .option(
    '--target <name|path>',
    `${instructionFiles().map((f) => `${f.target} (${f.path})`).join(', ')}, an agent's name, or a path; default config mirror.target`,
  )
  .option('--budget <tokens>', "tokens the memory may take; default the target's own (see `contextd surfaces`)")
  .option('--check', 'exit non-zero if the block is missing or stale; writes nothing', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      const name = (opts.target as string | undefined) ?? m.config.mirror.target;
      const budget = opts.budget != null ? Number(opts.budget) : undefined;
      if (budget != null && !(Number.isInteger(budget) && budget > 0)) {
        out('--budget takes a positive number of tokens');
        process.exitCode = 1;
        return;
      }
      let target;
      try {
        target = mirrorTarget(name, m.projectRoot, budget != null ? { budget } : {});
      } catch (err) {
        out((err as Error).message);
        process.exitCode = 1;
        return;
      }
      const { path } = target;
      if (opts.check === true) {
        const c = checkMirror(m, target);
        out(`${c.stale ? 'stale' : 'fresh'}: ${path} (${c.reason})`);
        if (c.stale) process.exitCode = 1;
        return;
      }
      const w = writeMirror(m, target);
      // Sections have their own allowances inside the budget, so items can be left out of a full
      // section while the total is well under it.
      const fit = w.omitted > 0 ? `; ${w.omitted} items over their section's share left out, reachable by query` : '';
      out(
        w.changed
          ? `${w.created ? 'created' : 'updated'} ${path} (${w.tokens} tokens of memory, budget ${w.budget}${fit})`
          : `${path} is already up to date`,
      );
      if (isTrackedByGit(realHost(m.projectRoot), path)) {
        out(`warning: ${path} is tracked by git; the generated block will be committed and change on every refresh`);
      }
    } finally {
      m.close();
    }
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

// --------------------------------------------------------------- projects

/*
 * The registry behind `status --all` is a list of paths, and it goes stale: projects get moved,
 * deleted, or were only ever a test. Cleaning it must not mean editing a JSON file by hand, and
 * none of these touch a project's memory - that is `uninstall --purge`, run in the project.
 */
const projects = program
  .command('projects')
  .description('the projects `status --all` lists: show, add, remove, prune (memory is never touched)');

function registryFile(): string {
  return registryPath(homedir(), process.env);
}

projects
  .command('list', { isDefault: true })
  .description('every registered project, and whether its memory is still there')
  .option('--json', 'machine-readable output', false)
  .action((opts) => {
    const path = registryFile();
    const rows = readRegistry(path).map((e) => ({ ...e, live: entryIsLive(e, dbPath) }));
    if (opts.json) {
      out(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      out(`no projects registered (${path})`);
      return;
    }
    for (const r of rows) out(`${r.live ? '  ' : '✗ '}${r.root}${r.live ? '' : '   (gone - contextd projects prune)'}`);
    out(`\n${rows.length} project(s) in ${path}`);
  });

projects
  .command('add')
  .description('register a project that already has contextd memory (default: this one)')
  .argument('[dir]', 'project directory')
  .action((dir: string | undefined, _opts, cmd) => {
    // Config only, no manager: opening one would create storage in whatever directory was typed.
    const loaded = loadConfig(resolve(dir ?? (cmd.optsWithGlobals().cwd as string) ?? process.cwd()));
    if (!existsSync(dbPath(loaded.storageDir))) {
      out(`${loaded.root} has no contextd memory; run \`contextd init\` there first`);
      process.exitCode = 1;
      return;
    }
    registerProject(registryFile(), loaded.root, loaded.storageDir);
    out(`registered ${loaded.root}`);
  });

projects
  .command('remove')
  .description("forget projects in the registry; their memory and wiring stay as they are")
  .argument('<dirs...>', 'project directories, as listed')
  .action((dirs: string[]) => {
    // Entries hold the resolved root (macOS /var is /private/var), so resolve what was typed the same way.
    const real = (d: string) => {
      const abs = resolve(d);
      try {
        return realpathSync(abs);
      } catch {
        return abs;
      }
    };
    const roots = new Set(dirs.flatMap((d) => [resolve(d), real(d)]));
    const dropped = filterRegistry(registryFile(), (e) => !roots.has(e.root));
    for (const e of dropped) out(`removed ${e.root}`);
    const missed = dirs.filter((d) => !dropped.some((e) => e.root === resolve(d) || e.root === real(d)));
    for (const r of missed) out(`not registered: ${r}`);
    if (missed.length > 0 && dropped.length === 0) process.exitCode = 1;
  });

projects
  .command('prune')
  .description('drop entries whose directory or memory no longer exists')
  .option('--dry-run', 'show what would be dropped', false)
  .action((opts) => {
    const path = registryFile();
    const gone = readRegistry(path).filter((e) => !entryIsLive(e, dbPath));
    if (gone.length === 0) {
      out('nothing to prune');
      return;
    }
    const dropped = opts.dryRun === true ? gone : filterRegistry(path, (e) => entryIsLive(e, dbPath));
    for (const e of dropped) out(`${opts.dryRun === true ? 'would remove' : 'removed'} ${e.root}`);
  });

projects
  .command('clear')
  .description('empty the registry (projects re-register on their next session)')
  .option('--yes', 'confirm', false)
  .action((opts) => {
    const path = registryFile();
    const n = readRegistry(path).length;
    if (opts.yes !== true) {
      out(`this forgets all ${n} registered project(s) - their memory is kept. Re-run with --yes.`);
      process.exitCode = 1;
      return;
    }
    const dropped = filterRegistry(path, () => false);
    out(`cleared ${dropped.length} project(s)`);
  });

program
  .command('doctor')
  .description('check that ingestion, providers, budgets and the patch log are wired correctly')
  .option('--json', 'machine-readable output', false)
  .action((opts, cmd) => {
    const m = manager(cmd);
    try {
      noteProjectIfInUse(m);
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
        const flags =
          s.kind === 'none'
            ? 'no ingestion surface'
            : [s.kind, s.preferred ? 'preferred' : null, s.installable ? 'auto-installable' : 'manual'].filter(Boolean).join(', ');
        out(`  [${flags}]`);
        out(`    ${s.description}`);
      }
      if (adapter.mcp) {
        out(`  [mcp: ${adapter.mcp.scopes.join('|')}, default ${adapter.mcp.defaultScope}]`);
        out(`    ${adapter.mcp.description}`);
      }
      for (const f of adapter.instructionFiles ?? []) {
        out(`  [mirror target: ${f.target}, ${f.format}, ${f.budget} tokens]`);
        out(`    ${f.path} - ${f.description}`);
      }
      if (adapter.nativeMemory) {
        out(`  [import --from ${adapter.nativeMemory.name}]`);
        out(`    ${adapter.nativeMemory.description}`);
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
  const found = newestTranscript(getIngestAdapter(adapterName), projectRoot, homedir());
  if (!found) return null;
  return { path: found.path, sessionId: found.sessionId ?? sessionIdFromFilename(found.path) ?? 'unknown' };
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`contextd: ${(err as Error).message}\n`);
  process.exit(1);
});
