import { CostController, priceUsage, totalTokens, type TokenUsage } from '../core/budget.js';
import { resolveModel, type Config, type WorkerTask } from '../core/config.js';
import { eventText, estimateTokens } from '../core/events.js';
import { isEmptyPatch, StatePatchSchema, type PatchViolation, type StatePatch } from '../core/patch.js';
import type { MemoryItem } from '../core/state.js';
import { RetrievalEngine } from '../store/retrieval.js';
import type { ContextStore, StoredEvent } from '../store/store.js';
import { getProvider, ProviderError, type Provider } from './providers/index.js';
import { providerIsLocal } from './providers/types.js';
import { buildLearnPrompt, buildRepairPrompt } from './prompts.js';
import { advanceWatermark, buildLearnInput, restrictLearnPatch } from './learn.js';
import { detectConflicts, withoutReviewed, type Conflict } from '../core/conflicts.js';
import {
  buildConflictsPrompt,
  buildEventsPrompt,
  buildMemoryPrompt,
  taskDefinition,
  type TaskDefinition,
} from './tasks.js';

/**
 * PRD 15 - the ephemeral worker.
 *
 * spawn, read the state slice it needs, read one event batch, emit a patch, terminate.
 * There is deliberately no conversation object here: a worker cannot accumulate history
 * because it is a single function call with a single response.
 */

export interface RunnerOptions {
  /** Cap on events handed to one worker, so a burst cannot produce a huge prompt. */
  maxEventsPerRun?: number;
  /** Cap on state items rendered into the prompt. */
  maxStateItems?: number;
  timeoutMs?: number;
  /** Cap on contradiction pairs handed to one conflict_resolution run. */
  maxConflictPairs?: number;
  /** Injectable for tests. */
  provider?: Provider;
  /** Project root, so the `learn` digest names paths relative to it. */
  projectRoot?: string;
}

interface Batch {
  prompt: string;
  /** Events this run consumes: marked processed on success, inert on an empty answer. */
  events: StoredEvent[];
  /** How many events the prompt was built from, for the worker-run record. */
  eventCount: number;
  /** `episodes` tasks: the only ids a lesson may cite, and where the session watermark moves. */
  learn?: { evidenceIds: Set<string>; sessionId: string; until: string };
  /** `conflicts` tasks: the pairs shown, marked reviewed once the worker has answered for them. */
  conflicts?: Conflict[];
}

export interface RunOutcome {
  status: 'ok' | 'skipped' | 'deferred' | 'invalid' | 'error' | 'noop';
  reason: string;
  workerRunId: string | null;
  patchId: string | null;
  version: number;
  eventsProcessed: number;
  usage: TokenUsage | null;
  costUsd: number;
  violations: PatchViolation[];
  attempts: number;
}

export class WorkerRunner {
  constructor(
    private store: ContextStore,
    private config: Config,
    private opts: RunnerOptions = {},
  ) {}

  /**
   * Process the pending queue for a session once.
   *
   * Only events that survived the deterministic pass at ingest reach here, so every event
   * this sees is one that genuinely needs a model. When the budget is gone or no provider
   * is configured this returns `deferred` and the events stay queued: losing the LLM
   * degrades the system rather than stopping it (PRD 26/35).
   */
  async runOnce(sessionId: string | null, task: WorkerTask = 'extraction'): Promise<RunOutcome> {
    const definition = taskDefinition(task);
    const version = this.store.stateVersion();

    // Each task reads a different thing: events for extraction, contradiction pairs for
    // conflict resolution, the whole memory for reconciliation (PRD 44).
    const batch = this.selectBatch(definition, sessionId);
    if (!batch) {
      const why =
        definition.input === 'events'
          ? 'no_pending_events'
          : definition.input === 'episodes'
            ? sessionId == null
              ? 'learn_needs_a_session'
              : 'no_new_episodes'
            : 'nothing_to_do';
      return this.outcome('skipped', why);
    }
    const forModel = batch.events;

    // --- budget gate --------------------------------------------------------
    const spec = resolveModel(this.config, task);
    const provider = this.opts.provider ?? getProvider(spec.provider);

    if (this.config.privacy.local_only && !providerIsLocal(provider, spec)) {
      return this.outcome('deferred', `local_only blocks ${provider.name}:${spec.model}`, {
        version,
        eventsProcessed: 0,
      });
    }

    const userPrompt = batch.prompt;
    const estimated = estimateTokens(definition.system) + estimateTokens(userPrompt) + 1200;

    const controller = new CostController(this.config, {
      recentUsage: (since) => this.store.recentWorkerUsage(since),
      sessionCostUsd: () => this.store.sessionWorkerCost(sessionId),
    });
    const budget = controller.check(estimated);
    if (!budget.allowed) {
      // Deferred, not dropped: the events stay pending and are retried next cycle.
      return this.outcome('deferred', `budget: ${budget.reason}`, {
        version,
        eventsProcessed: 0,
      });
    }

    // --- semantic pass ------------------------------------------------------
    const tier = this.config.models.routing[task] ?? 'cheap';
    const runId = this.store.startWorkerRun({
      sessionId,
      task,
      tier,
      provider: provider.name,
      model: spec.model,
      eventCount: batch.eventCount,
    });

    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let attempts = 0;
    let violations: PatchViolation[] = [];
    let lastRaw = '';
    /**
     * What each pass did. A run that succeeds on the repair pass used to look identical to one
     * that succeeded first time, so a first attempt that lost 19 of 22 items left no trace and
     * could not be explained afterwards.
     */
    const trail: string[] = [];

    try {
      for (let pass = 0; pass < 2; pass += 1) {
        attempts += 1;
        const prompt = pass === 0 ? userPrompt : `${userPrompt}\n\n${buildRepairPrompt(lastRaw, violations)}`;
        const res = await this.callProvider(provider, spec, prompt, definition.system);
        usage.input_tokens += res.usage.input_tokens;
        usage.output_tokens += res.usage.output_tokens;
        usage.cache_read_input_tokens =
          (usage.cache_read_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
        usage.cache_creation_input_tokens =
          (usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        lastRaw = res.text;

        const parsed = parsePatch(res.text);
        if (!parsed.ok) {
          // `empty_patch` was reported for every parse failure, including "one item lacked a
          // required field" - which reads as though the model said nothing.
          violations = [{ code: 'unparsable_response', message: parsed.error }];
          trail.push(`pass ${pass + 1}: unparsable_response: ${parsed.error}`);
          continue;
        }
        if (parsed.dropped?.length) {
          trail.push(`pass ${pass + 1}: dropped malformed ${parsed.dropped.join(', ')}`);
        }

        // Salvaged entries are recorded in the patch itself, so the log says what was ignored
        // rather than leaving a silent gap between what the model wrote and what was stored.
        let patch = parsed.dropped?.length
          ? {
              ...parsed.patch,
              note: [parsed.patch.note, `dropped malformed: ${parsed.dropped.join(', ')}`]
                .filter(Boolean)
                .join(' | '),
            }
          : parsed.patch;
        if (batch.learn) {
          // A task-scoped worker is cut down to its task in code before anything is committed.
          const restricted = restrictLearnPatch(patch, batch.learn.evidenceIds);
          if (restricted.violations.length > 0) {
            violations = restricted.violations;
            trail.push(`pass ${pass + 1}: ${restricted.violations.map((v) => v.code).join(',')}`);
            continue;
          }
          if (restricted.dropped.length > 0) trail.push(`pass ${pass + 1}: learn dropped ${restricted.dropped.length}`);
          patch = restricted.patch;
        }
        // Empty as written, or empty once the store pruned its provable no-ops (every add a
        // verbatim copy of existing memory): either way nothing was derived, and a retry would
        // only ask the same question again.
        const commit = Object.keys(patch).length === 0
          ? null
          : this.store.commitPatch(patch, 'worker', {
              sessionId,
              workerRunId: runId,
              observedUntil: forModel.reduce<string | null>((m, e) => (m == null || e.timestamp > m ? e.timestamp : m), null),
            });
        if (commit == null || (!commit.ok && commit.violations.every((v) => v.code === 'empty_patch'))) {
          const cost = priceUsage(spec, usage);
          this.store.finishWorkerRun(runId, {
            status: 'ok',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedTokens: usage.cache_read_input_tokens ?? 0,
            costUsd: cost,
            attempts,
          });
          // Closed, but as inert: a worker that recorded nothing derived nothing, and counting
          // these as coverage would let a misconfigured model report a rising K1 while the
          // memory stays empty. They remain in L2, so `inspect` can still reach them.
          this.store.markInert(forModel.map((e) => e.id));
          if (batch.learn) advanceWatermark(this.store, batch.learn.sessionId, batch.learn.until);
          // Nothing to change about any pair: each was judged compatible as it reads now.
          if (batch.conflicts) this.store.markConflictsReviewed(batch.conflicts, `worker:${spec.model}`, 'no change needed');
          return this.outcome('noop', 'worker_returned_empty_patch', {
            version,
            eventsProcessed: forModel.length,
            usage,
            costUsd: cost,
            workerRunId: runId,
            attempts,
          });
        }

        if (commit.ok) {
          const cost = priceUsage(spec, usage);
          this.store.finishWorkerRun(runId, {
            status: 'ok',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cachedTokens: usage.cache_read_input_tokens ?? 0,
            costUsd: cost,
            attempts,
            patchId: commit.patchId,
            ...(trail.length > 0 ? { error: trail.join(' | ').slice(0, 800) } : {}),
          });
          this.store.markProcessed(forModel.map((e) => e.id));
          if (batch.learn) advanceWatermark(this.store, batch.learn.sessionId, batch.learn.until);
          // Marked with the fingerprints the worker saw: a pair it edited no longer matches and is
          // detected afresh; a pair it left alone it judged compatible.
          if (batch.conflicts) this.store.markConflictsReviewed(batch.conflicts, `worker:${spec.model}`, 'reviewed with a patch');
          return this.outcome('ok', 'patch_applied', {
            version: commit.version,
            eventsProcessed: batch.learn ? batch.eventCount : forModel.length,
            usage,
            costUsd: cost,
            workerRunId: runId,
            patchId: commit.patchId,
            attempts,
          });
        }
        violations = commit.violations;
        trail.push(
          `pass ${pass + 1}: rejected ${commit.violations.map((v) => v.code).join(',')} ` +
            `(${patch.add?.length ?? 0} add, ${patch.update?.length ?? 0} update)`,
        );
      }

      // Both passes rejected. The old state is still valid; the events stay pending so a
      // later run with a different model or a smaller batch can try again (PRD 35).
      const cost = priceUsage(spec, usage);
      this.store.finishWorkerRun(runId, {
        status: 'invalid',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        costUsd: cost,
        attempts,
        error: [...trail, violations.map((v) => `${v.code}: ${v.message}`).join('; ')]
          .join(' | ')
          .slice(0, 1200),
      });
      return this.outcome('invalid', 'patch_rejected_twice', {
        version,
        eventsProcessed: 0,
        usage,
        costUsd: cost,
        workerRunId: runId,
        violations,
        attempts,
      });
    } catch (err) {
      const cost = priceUsage(spec, usage);
      const message = err instanceof Error ? err.message : String(err);
      this.store.finishWorkerRun(runId, {
        status: 'error',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        costUsd: cost,
        attempts,
        error: message.slice(0, 800),
      });
      return this.outcome('error', message, {
        version,
        eventsProcessed: 0,
        usage,
        costUsd: cost,
        workerRunId: runId,
        attempts,
      });
    }
  }

  /**
   * Choose what this task reads, and render its prompt. Returning null means there is
   * nothing for a model to do, which must never cost a call.
   */
  private selectBatch(definition: TaskDefinition, sessionId: string | null): Batch | null {
    if (definition.input === 'episodes') {
      // Per session by construction: an episode never spans two sessions.
      if (sessionId == null) return null;
      const input = buildLearnInput(this.store, this.config, sessionId, this.opts.projectRoot ?? null);
      if (!input) return null;
      return {
        prompt: buildLearnPrompt(input.existing, input.digest.text),
        events: [],
        eventCount: input.digest.evidenceIds.size,
        learn: { evidenceIds: input.digest.evidenceIds, sessionId, until: input.until },
      };
    }

    const state = this.store.currentState();

    if (definition.input === 'events') {
      const maxEvents = this.opts.maxEventsPerRun ?? 120;
      const pending = this.store.pendingEvents(sessionId, maxEvents);
      if (pending.length === 0) return null;
      const items = this.selectStateSlice(pending, this.opts.maxStateItems ?? 60);
      return { prompt: buildEventsPrompt(state, items, pending), events: pending, eventCount: pending.length };
    }

    if (definition.input === 'conflicts') {
      // A pair already judged compatible is not asked about again until one of its items changes.
      const reviews = this.store.conflictReviews();
      const max = this.opts.maxConflictPairs ?? 8;
      const conflicts = withoutReviewed(detectConflicts(state.items, { maxPairs: max + reviews.size }), reviews).slice(0, max);
      if (conflicts.length === 0) return null;
      return { prompt: buildConflictsPrompt(state, conflicts), events: [], eventCount: 0, conflicts };
    }

    // 'memory': the whole active memory, capped so one run cannot blow the context.
    const active = state.items
      .filter((i) => i.status === 'active')
      .slice(0, this.opts.maxStateItems ?? 200);
    if (active.length === 0) return null;
    return { prompt: buildMemoryPrompt(state, active), events: [], eventCount: 0 };
  }

  private async callProvider(
    provider: Provider,
    spec: ReturnType<typeof resolveModel>,
    user: string,
    system: string,
  ) {
    const timeoutMs = this.opts.timeoutMs ?? this.config.limits.worker_timeout_ms;
    let lastErr: unknown;
    // One retry for transient provider failures; a worker must not block the agent, so the
    // total time here is bounded by 2 * timeoutMs.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        return await provider.complete(
          { system, user, maxTokens: spec.max_output_tokens, signal: ac.signal },
          spec,
        );
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt === 1) throw err;
        await sleep(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('provider failed');
  }

  /**
   * PRD 15 - the worker gets "current relevant state", not all of it. Always-on critical
   * items plus whatever the batch's own text retrieves, so a long-lived project does not
   * make every worker call more expensive than the last.
   */
  private selectStateSlice(events: StoredEvent[], max: number): MemoryItem[] {
    const retrieval = new RetrievalEngine(this.store);
    const chosen = new Map<string, MemoryItem>();
    for (const i of retrieval.alwaysOn()) chosen.set(i.id, i);

    const query = events
      .map(eventText)
      .join(' ')
      .slice(0, 2000);
    for (const hit of retrieval.search(query, { limit: max })) {
      if (chosen.size >= max) break;
      chosen.set(hit.item.id, hit.item);
    }
    return [...chosen.values()];
  }

  private outcome(
    status: RunOutcome['status'],
    reason: string,
    extra: Partial<RunOutcome> = {},
  ): RunOutcome {
    return {
      status,
      reason,
      workerRunId: null,
      patchId: null,
      version: this.store.stateVersion(),
      eventsProcessed: 0,
      usage: null,
      costUsd: 0,
      violations: [],
      attempts: 0,
      ...extra,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type ParseResult =
  | { ok: true; patch: StatePatch; dropped?: string[] }
  | { ok: false; error: string };

/** Models wrap JSON in prose or fences more often than they should; recover what we can. */
export function parsePatch(raw: string): ParseResult {
  const text = stripFence(raw).trim();
  if (text.length === 0) return { ok: false, error: 'empty response' };

  const candidate = extractJsonObject(text);
  if (!candidate) return { ok: false, error: 'no JSON object found in response' };

  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }

  const parsed = StatePatchSchema.safeParse(json);
  if (parsed.success) return { ok: true, patch: parsed.data };

  // One malformed entry must not destroy the rest. A real run emitted 23 items of which one
  // lacked `text`, and the whole patch was rejected twice - 48 events and 22 good items lost to
  // a single missing field. An `add` with no text is not a fact anyway, so dropping it loses
  // nothing that could have been recorded.
  const salvaged = salvageEntries(json, parsed.error.issues);
  if (salvaged) return { ok: true, patch: salvaged.patch, dropped: salvaged.dropped };

  const issues = parsed.error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `patch failed schema: ${issues}` };
}

/**
 * Remove the individual array entries a schema failure blames, and re-parse.
 *
 * Only whole entries of the array-valued operations, and only when something survives: this is
 * "ignore the one broken row", not "coerce the patch into validity". If the failure is anywhere
 * else - a malformed `working` block, a non-object at the top level - nothing is salvaged and the
 * caller reports the schema error as before.
 */
const SALVAGEABLE = ['add', 'update', 'remove', 'supersede', 'touch', 'link', 'unlink'] as const;

function salvageEntries(
  json: unknown,
  issues: ReadonlyArray<{ path: Array<string | number | symbol>; message: string }>,
): { patch: StatePatch; dropped: string[] } | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;

  const blamed = new Map<string, Map<number, string>>();
  for (const issue of issues) {
    const [key, index] = issue.path;
    if (typeof key !== 'string' || typeof index !== 'number') return null;
    if (!(SALVAGEABLE as readonly string[]).includes(key)) return null;
    const perKey = blamed.get(key) ?? new Map<number, string>();
    // The field that failed is what makes the trail actionable: "add[0]" alone cannot tell you
    // whether the model used the wrong category, the wrong field name, or no text at all.
    if (!perKey.has(index)) perKey.set(index, `${issue.path.slice(2).join('.')} ${issue.message}`.trim());
    blamed.set(key, perKey);
  }
  if (blamed.size === 0) return null;

  const copy: Record<string, unknown> = { ...(json as Record<string, unknown>) };
  const dropped: string[] = [];
  for (const [key, entries] of blamed) {
    const arr = copy[key];
    if (!Array.isArray(arr)) return null;
    // Losing *every* entry of an operation is not a salvage: the model has misunderstood the
    // shape, and a patch that keeps only its `working` block would be applied as a success while
    // storing nothing - consuming the batch and inflating coverage exactly as invariant 20 warns.
    if (entries.size >= arr.length) return null;
    copy[key] = arr.filter((_, n) => !entries.has(n));
    for (const [n, why] of entries) dropped.push(`${key}[${n}]: ${why}`);
  }

  const reparsed = StatePatchSchema.safeParse(copy);
  if (!reparsed.success || isEmptyPatch(reparsed.data)) return null;
  return { patch: reparsed.data, dropped };
}

function stripFence(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence?.[1] ?? s;
}

/** Take the first balanced top-level object, ignoring braces inside strings. */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
