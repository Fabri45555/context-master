import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { getAdapter, type Adapter, type AdapterContext } from '../adapters/index.js';
import { loadConfig, type Config, type LoadedConfig, type WorkerTask } from '../core/config.js';
import { evaluateTriggers, type TriggerVerdict } from '../core/deterministic.js';
import {
  assessPressure,
  needsProvider,
  type LifecycleAction,
  type PressureAssessment,
} from '../core/lifecycle.js';
import { detectConflicts, type Conflict } from '../core/conflicts.js';
import { estimateTokens } from '../core/events.js';
import type { StatePatch } from '../core/patch.js';
import { collectMetrics, type Metrics } from '../metrics/index.js';
import { ContextBuilder, type BuiltContext, type QueryOptions } from '../retrieval/context-builder.js';
import { dbPath, getMeta, openDb, setMeta } from '../store/db.js';
import { ContextStore } from '../store/store.js';
import { EmbeddingIndex, type BackfillResult, type EmbeddingProvider } from '../store/embeddings.js';
import type { MemoryEdge } from '../core/graph.js';
import type { MemoryItem, WorkingMemory } from '../core/state.js';
import { WorkerRunner, type RunOutcome, type RunnerOptions } from '../workers/runner.js';
import type { Provider } from '../workers/providers/types.js';
import { IngestPipeline, type IngestStats } from './ingest.js';
import { applyStaleReferences } from './stale.js';
import { StateMachine, type Transition } from './machine.js';
import { tailJsonl } from './tail.js';

/** How often the hook path may re-stat memory's file references. */
const REFS_VERIFY_INTERVAL_MS = 10 * 60_000;

/** Enough for several assistant records; a turn's usage sits in its last one. */
const USAGE_TAIL_BYTES = 256 * 1024;

/**
 * The daemon's brain, usable in-process.
 *
 * Everything the CLI, the hook bridge and the MCP server do goes through here, so there is
 * exactly one writer to the SQLite file and exactly one place where the PRD 12 state machine
 * is driven.
 */

export interface CycleResult {
  ingest: IngestStats;
  trigger: TriggerVerdict;
  worker: RunOutcome | null;
  transitions: readonly Transition[];
}

export interface ManagerOptions {
  cwd?: string;
  configOverrides?: Partial<Config>;
  /** Override the LLM provider, so tests and dry runs never touch a network. */
  provider?: Provider;
  /** Extra worker runner options (batch caps, timeouts). */
  runnerOptions?: RunnerOptions;
  /** Override the embedding provider, for the same reason as `provider`. */
  embeddingProvider?: EmbeddingProvider;
}

export class ContextManager {
  readonly store: ContextStore;
  readonly config: Config;
  readonly loaded: LoadedConfig;
  private pipeline: IngestPipeline;
  private runner: WorkerRunner;
  private builder: ContextBuilder;
  private machine = new StateMachine();
  private embeddingIndex: EmbeddingIndex | null = null;
  private embeddingProvider: EmbeddingProvider | undefined;

  constructor(opts: ManagerOptions = {}) {
    this.loaded = loadConfig(opts.cwd ?? process.cwd(), opts.configOverrides ?? {});
    this.config = this.loaded.config;
    mkdirSync(this.loaded.storageDir, { recursive: true });
    this.store = new ContextStore(openDb(dbPath(this.loaded.storageDir)));
    this.pipeline = new IngestPipeline(this.store, this.config, this.loaded.root);
    this.runner = new WorkerRunner(this.store, this.config, {
      ...(opts.runnerOptions ?? {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
    });
    this.builder = new ContextBuilder(this.store, this.config);
    this.embeddingProvider = opts.embeddingProvider;
  }

  get storageDir(): string {
    return this.loaded.storageDir;
  }

  get projectRoot(): string {
    return this.loaded.root;
  }

  /**
   * One full cycle: ingest raw records, then run a worker if the triggers say so.
   *
   * Ingestion never awaits a model, so a caller on the agent's critical path (a hook) can
   * pass `runWorker: false` and return in milliseconds (PRD 31).
   */
  async cycle(
    adapterName: string,
    records: unknown[],
    ctx: AdapterContext,
    opts: { runWorker?: boolean; task?: WorkerTask; force?: boolean } = {},
  ): Promise<CycleResult> {
    const adapter = getAdapter(adapterName);
    let ingest: IngestStats;

    this.machine.to('INGEST', `${records.length} records via ${adapterName}`);
    try {
      ingest = this.pipeline.ingest(adapter, records, ctx);
    } catch (err) {
      this.machine.to('FAILED', (err as Error).message);
      this.machine.to('PERSIST', 'raw events retained');
      this.machine.to('IDLE');
      throw err;
    }

    this.machine.to('CLASSIFY', `${ingest.stored} stored, ${ingest.queued} queued`);

    const trigger = this.shouldRunWorker(ctx.sessionId);
    const fire = opts.force === true || (opts.runWorker !== false && trigger.fire);

    if (!fire) {
      this.machine.to(ingest.stored > 0 ? 'UPDATE_STATE' : 'DISCARD', trigger.reason);
      this.machine.to('PERSIST', 'no worker this cycle');
      this.machine.to('IDLE');
      return { ingest, trigger, worker: null, transitions: this.machine.history };
    }

    this.machine.to('NEED_LLM', trigger.reason);
    this.machine.to('SPAWN_WORKER');
    let worker: RunOutcome;
    try {
      worker = await this.runner.runOnce(ctx.sessionId, opts.task ?? 'extraction');
    } catch (err) {
      // PRD 35 - a worker failure must never propagate to the coding agent.
      this.machine.to('FAILED', (err as Error).message);
      this.machine.to('PERSIST', 'events left pending for retry');
      this.machine.to('IDLE');
      return {
        ingest,
        trigger,
        worker: {
          status: 'error',
          reason: (err as Error).message,
          workerRunId: null,
          patchId: null,
          version: this.store.stateVersion(),
          eventsProcessed: 0,
          usage: null,
          costUsd: 0,
          violations: [],
          attempts: 0,
        },
        transitions: this.machine.history,
      };
    }

    this.machine.to('APPLY_RESULT', worker.status);
    this.machine.to('PERSIST', `version ${worker.version}`);
    this.machine.to('IDLE');
    return { ingest, trigger, worker, transitions: this.machine.history };
  }

  /** Ingest only, no worker. The path a synchronous hook takes. */
  ingestOnly(adapterName: string, records: unknown[], ctx: AdapterContext): IngestStats {
    const started = performance.now();
    try {
      return this.pipeline.ingest(getAdapter(adapterName), records, ctx);
    } finally {
      this.recordLatency('ingest', performance.now() - started, `${records.length} records`);
    }
  }

  /**
   * PRD 31 - the latency budget. Recording is best effort: a failure to measure must never
   * be the reason the agent's hook fails.
   */
  recordLatency(op: string, ms: number, detail?: string | null): void {
    try {
      this.store.recordLatency(op, ms, detail ?? null, this.config.limits.latency_samples);
    } catch {
      // Measurement is diagnostics, not correctness.
    }
  }

  /** True when this measurement breaches the hard ceiling and deserves a warning. */
  overHardLatencyBudget(ms: number): boolean {
    return ms > this.config.limits.hook_latency_hard_ms;
  }

  /** Remember exactly what `init` wired into the agent, so `doctor` can verify it. */
  noteInstalledHookCommand(command: string): void {
    setMeta(this.store.db, 'hook_command', command);
  }

  installedHookCommand(): string | null {
    return getMeta(this.store.db, 'hook_command');
  }

  shouldRunWorker(sessionId: string | null): TriggerVerdict {
    const pending = this.store.pendingSummary(sessionId);
    const last = this.store.lastWorkerAt(sessionId);
    const totalEvents = (
      this.store.db
        .prepare(
          sessionId
            ? `SELECT COUNT(*) n FROM events WHERE session_id = ?`
            : `SELECT COUNT(*) n FROM events`,
        )
        .get(...(sessionId ? [sessionId] : [])) as { n: number }
    ).n;

    return evaluateTriggers(this.config, {
      pendingEvents: pending.count,
      pendingTokens: pending.tokens,
      highestPendingImportance: pending.highest,
      secondsSinceLastWorker: last == null ? Number.POSITIVE_INFINITY : (Date.now() - last) / 1000,
      totalEventsThisSession: totalEvents,
      compactionRequested: pending.compactionRequested,
    });
  }

  /** Drain the pending queue with repeated worker runs. Backs off on anything but success. */
  async compact(sessionId: string | null, task: WorkerTask = 'extraction', maxRuns = 10): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < maxRuns; i += 1) {
      const outcome = await this.runner.runOnce(sessionId, task);
      outcomes.push(outcome);
      if (outcome.status !== 'ok' && outcome.status !== 'noop') break;
      if (this.store.pendingSummary(sessionId).count === 0) break;
    }
    return outcomes;
  }

  /**
   * Record the agent's latest usage from the tail of its transcript, if its adapter says where.
   *
   * Reads a bounded window from the end of the file rather than tailing it with a cursor: this
   * runs on the hook path, and only the last turn's usage matters. Returns whether a turn was found.
   */
  observeUsage(adapterName: string, hookPayload: unknown, sessionId: string): boolean {
    const adapter = getAdapter(adapterName);
    const path = adapter.usageSource?.(hookPayload);
    if (!path) return false;
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      const size = fstatSync(fd).size;
      const window = Math.min(size, USAGE_TAIL_BYTES);
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      const lines = buf.toString('utf8').split('\n');
      // The first line of the window is almost always cut mid-record.
      if (window < size) lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = adapter.translate(rec, { sessionId, cwd: this.loaded.root }).agentUsage;
        if (!usage) continue;
        this.store.recordAgentUsage(sessionId, usage, usage.model ?? null);
        return true;
      }
      return false;
    } catch {
      // A missing or unreadable transcript is not the agent's problem.
      return false;
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  /** PRD 22 - follow an agent transcript from where we left off. */
  async tail(
    adapterName: string,
    transcriptPath: string,
    sessionId: string,
    opts: { runWorker?: boolean; fromStart?: boolean } = {},
  ): Promise<CycleResult & { offset: number; skipped: number }> {
    const key = `${adapterName}:${transcriptPath}`;
    const from = opts.fromStart ? 0 : this.store.getCursor(key);
    const tailed = await tailJsonl(transcriptPath, from);
    const result = await this.cycle(
      adapterName,
      tailed.records,
      { sessionId, cwd: this.loaded.root },
      { runWorker: opts.runWorker },
    );
    this.store.setCursor(key, tailed.offset);
    return { ...result, offset: tailed.offset, skipped: tailed.skipped };
  }

  // --------------------------------------------------------------- retrieval

  /** Measure the always-on slice. Logs nothing: use `serveBootstrap` when an agent reads it. */
  bootstrapContext(): BuiltContext {
    return this.builder.bootstrap();
  }

  /** The always-on slice as delivered to an agent; counted as a retrieval. */
  serveBootstrap(sessionId: string | null = null): BuiltContext {
    return this.builder.serveBootstrap(sessionId);
  }

  /** Keyword-only and synchronous: safe inside the hook latency budget. */
  queryContext(query: string, opts: QueryOptions = {}): BuiltContext {
    return this.builder.forQuery(query, opts);
  }

  /**
   * What an agent's own query should get: keyword plus semantic when embeddings are on, and
   * exactly `queryContext` when they are off or the provider is down. Never on the hook path.
   */
  queryContextHybrid(query: string, opts: QueryOptions = {}): Promise<BuiltContext> {
    return this.builder.forQueryHybrid(query, this.embeddings, opts);
  }

  // ------------------------------------------------------------- maintenance

  /** User-authored memory, e.g. `contextd remember`. Always source "user". */
  remember(patch: StatePatch): ReturnType<ContextStore['commitPatch']> {
    return this.store.commitPatch(patch, 'user', {});
  }

  /**
   * Retire items that should never have been memory. A `remove` rather than a supersede
   * because there is nothing to replace them with; the patch log keeps them and the reason.
   * User-critical items still refuse, by `isProtected`, whoever asks.
   */
  retire(ids: string[], reason: string): ReturnType<ContextStore['commitPatch']> {
    return this.store.commitPatch({ remove: ids, note: `retired: ${reason}` }, 'user', {});
  }

  /**
   * Set the current task by hand. Working memory was writable only by a worker, and a worker never
   * sees what closed a task when it happens as a successful shell command (the fold closes those
   * as inert) - so a finished commit left "Commit project repository: blocked" in every bootstrap.
   */
  setTask(working: Partial<Pick<WorkingMemory, 'current_task' | 'task_status' | 'current_state' | 'next_action' | 'current_plan'>>): ReturnType<ContextStore['commitPatch']> {
    return this.store.commitPatch({ working, note: 'task set by hand' }, 'user', {});
  }

  /** Mark goals met, requirements satisfied, questions answered or issues resolved. */
  closeItems(ids: string[], reason: string, evidence: string[] = []): ReturnType<ContextStore['commitPatch']> {
    return this.store.commitPatch(
      { close: ids.map((id) => ({ id, reason, evidence })), note: `closed: ${reason}` },
      'user',
      {},
    );
  }

  reopenItems(ids: string[], reason: string): ReturnType<ContextStore['commitPatch']> {
    return this.store.commitPatch({ reopen: ids, note: `reopened: ${reason}` }, 'user', {});
  }

  metrics(sessionId: string | null): Metrics {
    return collectMetrics(this.store, this.config, sessionId);
  }

  /** Phase 4 - the optional semantic index. Empty and inert unless configured. */
  get embeddings(): EmbeddingIndex {
    this.embeddingIndex ??= new EmbeddingIndex(this.store, this.config.embeddings, this.embeddingProvider);
    return this.embeddingIndex;
  }

  /** Bring the semantic index up to date with the current memory. */
  async embed(limit?: number): Promise<BackfillResult> {
    return this.embeddings.backfill(limit);
  }

  /** Graph neighbourhood of one item, for `contextd graph` and the MCP tool. */
  graphOf(id: string): Array<{ edge: MemoryEdge; direction: 'out' | 'in'; other: MemoryItem | null }> {
    return this.store.edgesOf(id).map(({ edge, direction }) => {
      const other = direction === 'out' ? edge.to : edge.from;
      return { edge, direction, other: this.store.getItem(other) };
    });
  }

  /**
   * PRD 44 - the contradictions currently sitting in memory, found deterministically.
   * Cheap enough to call before deciding whether a model is worth spending on.
   */
  conflicts(opts: { maxPairs?: number } = {}): Conflict[] {
    return detectConflicts(this.store.currentState().items, {
      ...(opts.maxPairs != null ? { maxPairs: opts.maxPairs } : {}),
    });
  }

  /**
   * PRD 44 / 6 Phase 6 - resolve contradictions, then restructure what is left.
   *
   * Conflict resolution runs first and on a mid tier, because it is a bounded decision about
   * specific pairs. Reconciliation is the expensive whole-memory pass, so it only runs when
   * asked for and when there is enough memory for it to have anything to do.
   */
  async reconcile(
    opts: { resolveConflicts?: boolean; restructure?: boolean; maxRuns?: number } = {},
  ): Promise<RunOutcome[]> {
    const outcomes: RunOutcome[] = [];
    const maxRuns = opts.maxRuns ?? 3;

    if (opts.resolveConflicts !== false) {
      for (let i = 0; i < maxRuns; i += 1) {
        if (this.conflicts({ maxPairs: 1 }).length === 0) break;
        const outcome = await this.runner.runOnce(null, 'conflict_resolution');
        outcomes.push(outcome);
        if (outcome.status !== 'ok') break;
      }
    }

    if (opts.restructure === true) {
      outcomes.push(await this.runner.runOnce(null, 'complex_reconciliation'));
    }
    return outcomes;
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * PRD 24 - where on the compaction ladder this session currently is.
   *
   * Free and deterministic: it reads the occupancy the agent itself reported, the backlog and
   * the state version. Nothing here calls a model, so it is safe on the hook path.
   */
  pressure(sessionId: string | null): PressureAssessment {
    const usage = this.store.latestAgentUsage(sessionId);
    const pending = this.store.pendingSummary(sessionId);
    return assessPressure(this.config, {
      occupiedTokens: usage?.occupied ?? 0,
      observedPeakTokens: this.store.agentUsageTotals(sessionId).peakInput,
      model: usage?.model ?? null,
      pendingEvents: pending.count,
      pendingTokens: pending.tokens,
      compactionRequested: pending.compactionRequested,
      stateVersion: this.store.stateVersion(),
      bootstrapTokens: this.bootstrapContext().tokens,
    });
  }

  /** How many times the agent compacted anyway - the ladder's failure count. */
  hardCompactions(sessionId: string | null): number {
    return this.store.countHardCompactions(sessionId);
  }

  /**
   * Run exactly the actions the current stage authorises, cheapest first.
   *
   * The ordering matters: folding and decaying before any model call means the worker reads a
   * smaller, cleaner backlog, so escalation gets cheaper rather than more expensive.
   */
  async runLifecycle(
    sessionId: string | null,
    opts: { maxRuns?: number; deterministicOnly?: boolean } = {},
  ): Promise<{
    assessment: PressureAssessment;
    performed: Array<{ action: LifecycleAction; detail: string }>;
    skipped: LifecycleAction[];
  }> {
    const assessment = this.pressure(sessionId);
    const performed: Array<{ action: LifecycleAction; detail: string }> = [];
    // The hook path is synchronous for the agent, so it takes the free rungs only; the
    // model-backed ones are left to `contextd lifecycle --act` or the next cycle.
    const allowed = opts.deterministicOnly
      ? assessment.actions.filter((a) => !needsProvider(a))
      : assessment.actions;
    const skipped = assessment.actions.filter((a) => !allowed.includes(a));

    for (const action of allowed) {
      switch (action) {
        case 'fold': {
          const { folded } = this.pipeline.refold(sessionId);
          performed.push({ action, detail: `${folded} events folded deterministically` });
          break;
        }
        case 'decay': {
          const n = this.decay();
          performed.push({ action, detail: `${n} items expired` });
          break;
        }
        case 'verify_refs': {
          const r = this.verifyReferences();
          performed.push({
            action,
            detail: r ? `${r.stale.length} items reference missing files, ${r.revived.length} revived` : 'checked recently',
          });
          break;
        }
        case 'prune': {
          const p = this.prune();
          performed.push({ action, detail: `${p.events} raw events dropped, ${p.items} items decayed` });
          break;
        }
        case 'extract': {
          const outcomes = await this.compact(sessionId, 'extraction', opts.maxRuns ?? 3);
          performed.push({ action, detail: summarizeOutcomes(outcomes) });
          break;
        }
        case 'resolve_conflicts': {
          const outcomes = await this.reconcile({ resolveConflicts: true, restructure: false });
          performed.push({ action, detail: summarizeOutcomes(outcomes) });
          break;
        }
        case 'reconcile': {
          const outcomes = await this.reconcile({ resolveConflicts: false, restructure: true });
          performed.push({ action, detail: summarizeOutcomes(outcomes) });
          break;
        }
      }
    }

    return { assessment, performed, skipped };
  }

  /**
   * Mark memory whose referenced files are gone as stale, and revive it if they come back.
   *
   * Throttled: the maintain rung runs on the hook path, and files do not vanish between two tool
   * calls often enough to stat every reference on each of them. `force` is for the CLI.
   */
  verifyReferences(opts: { force?: boolean; now?: number } = {}): ReturnType<typeof applyStaleReferences> | null {
    const now = opts.now ?? Date.now();
    const last = Date.parse(getMeta(this.store.db, 'refs_verified_at') ?? '');
    if (!opts.force && Number.isFinite(last) && now - last < REFS_VERIFY_INTERVAL_MS) return null;
    setMeta(this.store.db, 'refs_verified_at', new Date(now).toISOString());
    return applyStaleReferences(this.store, this.loaded.root);
  }

  /** PRD 43 - mark expired items stale so they stop being injected. */
  decay(now = Date.now()): number {
    const rows = this.store.db
      .prepare(
        `SELECT id, ttl_seconds, COALESCE(last_validated_at, updated_at, created_at) AS base
         FROM memory_items WHERE status = 'active' AND ttl_seconds IS NOT NULL`,
      )
      .all() as Array<{ id: string; ttl_seconds: number; base: string }>;
    const expired = rows.filter((r) => now - Date.parse(r.base) > r.ttl_seconds * 1000);
    if (expired.length === 0) return 0;
    const result = this.store.commitPatch(
      {
        update: expired.map((r) => ({ id: r.id, status: 'stale' as const })),
        note: 'ttl decay',
      },
      'deterministic',
      {},
    );
    return result.ok ? expired.length : 0;
  }

  /**
   * Replay an export's patch log into this store.
   *
   * This is the answer to "distributed storage" for a tool like this: the need is to move a
   * project's memory between machines, not to run a cluster. Because the patch log is the
   * source of truth, importing is just replaying it, and the result is identical state.
   */
  importPatches(
    patches: Array<{ patch: StatePatch; origin?: string; note?: string | null }>,
    opts: { skipExisting?: boolean } = {},
  ): { applied: number; skipped: number; rejected: number } {
    let applied = 0;
    let skipped = 0;
    let rejected = 0;

    for (const entry of patches) {
      // base_version belongs to the source store's timeline, not ours.
      const { base_version: _ignored, ...patch } = entry.patch;
      if (opts.skipExisting !== false && this.alreadyPresent(patch as StatePatch)) {
        skipped += 1;
        continue;
      }
      const origin = entry.origin === 'user' ? 'user' : 'import';
      const result = this.store.commitPatch(patch as StatePatch, origin, {});
      if (result.ok) applied += 1;
      else rejected += 1;
    }
    return { applied, skipped, rejected };
  }

  /** True when every item this patch adds is already in the store, by id. */
  private alreadyPresent(patch: StatePatch): boolean {
    const adds = patch.add ?? [];
    if (adds.length === 0) return false;
    return adds.every((a) => a.id != null && this.store.getItem(a.id) != null);
  }

  prune(): { events: number; items: number } {
    const events = this.store.pruneRawEvents(this.config.retention.raw_events_days);
    const items = this.decay();
    return { events, items };
  }

  estimateContextTokens(text: string): number {
    return estimateTokens(text);
  }

  close(): void {
    this.store.close();
  }
}

function summarizeOutcomes(outcomes: RunOutcome[]): string {
  if (outcomes.length === 0) return 'nothing to do';
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const summary = [...counts].map(([status, n]) => `${n} ${status}`).join(', ');
  // "1 error" alone sends the reader to the logs. The reason is the whole point of the line,
  // and a rung that failed because no provider is configured needs to say so.
  const firstProblem = outcomes.find((o) => o.status !== 'ok' && o.status !== 'noop');
  return firstProblem ? `${summary} (${firstProblem.reason})` : summary;
}
