import { newId } from '../core/ids.js';
import type { EventDecision } from '../core/deterministic.js';
import {
  IMPORTANCE_LEVELS,
  importanceRank,
  type ContextEvent,
  type Importance,
} from '../core/events.js';
import {
  applyPatch,
  isClosed,
  isProtected,
  MAX_INFERRED_CONFIDENCE,
  normalizePatch,
  pruneInertOperations,
  validatePatch,
  type PatchViolation,
  type StatePatch,
} from '../core/patch.js';
import {
  MemoryItemSchema,
  WorkingMemorySchema,
  emptyWorkingMemory,
  type MemoryItem,
  type ProjectState,
  type WorkingMemory,
} from '../core/state.js';
import type { UsageRecord } from '../core/budget.js';
import { MemoryEdgeSchema, isSymmetric, traversalWeight, type MemoryEdge } from '../core/graph.js';
import { getIntMeta, getMeta, setMeta, type Db } from './db.js';
import { isMilestoneCommand } from '../core/importance.js';

export interface StoredEvent extends ContextEvent {
  action: string;
  reasons: string[];
  tokens: number;
  processed_at: string | null;
}

export interface CommitResult {
  ok: boolean;
  version: number;
  patchId: string | null;
  violations: PatchViolation[];
  added: string[];
  updated: string[];
  removed: string[];
  superseded: string[];
  touched: string[];
}

export interface WorkerRunInit {
  sessionId: string | null;
  task: string;
  tier: string;
  provider: string;
  model: string;
  eventCount: number;
}

export interface WorkerRunResult {
  status: 'ok' | 'error' | 'skipped' | 'invalid';
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  attempts?: number;
  error?: string;
  patchId?: string | null;
}

/**
 * The single writer over the SQLite file. Everything that mutates memory goes through
 * `commitPatch`, which is what keeps the patch log and the materialized items in step.
 */
/**
 * Appended to `reasons` when an event was closed without contributing to state. Also the
 * marker `coverage` subtracts, so it has to be a single agreed constant.
 */
export const INERT_REASON = 'inert_no_state';

export class ContextStore {
  constructor(readonly db: Db) {}

  // ---------------------------------------------------------------- sessions

  upsertSession(s: {
    id: string;
    source: string;
    agent?: string | null;
    cwd?: string | null;
    startedAt?: string;
    meta?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, source, agent, cwd, started_at, meta)
         VALUES (@id, @source, @agent, @cwd, @started_at, @meta)
         ON CONFLICT(id) DO UPDATE SET
           source = excluded.source,
           agent = COALESCE(excluded.agent, sessions.agent),
           cwd = COALESCE(excluded.cwd, sessions.cwd)`,
      )
      .run({
        id: s.id,
        source: s.source,
        agent: s.agent ?? null,
        cwd: s.cwd ?? null,
        started_at: s.startedAt ?? new Date().toISOString(),
        meta: JSON.stringify(s.meta ?? {}),
      });
  }

  endSession(id: string, at = new Date().toISOString()): void {
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(at, id);
  }

  listSessions(limit = 20): Array<{
    id: string;
    source: string;
    agent: string | null;
    started_at: string;
    ended_at: string | null;
    events: number;
  }> {
    return this.db
      .prepare(
        `SELECT s.id, s.source, s.agent, s.started_at, s.ended_at,
                (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events
         FROM sessions s ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as never;
  }

  // ------------------------------------------------------------------ events

  isDuplicate(sessionId: string, dedupeHash: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM events WHERE session_id = ? AND dedupe_hash = ? LIMIT 1`)
      .get(sessionId, dedupeHash);
    return row !== undefined;
  }

  /** Persist a decided event. Discarded events are counted, not stored. */
  insertEvent(decision: EventDecision): boolean {
    const e = decision.event;
    const info = this.db
      .prepare(
        `INSERT INTO events (id, session_id, ordinal, ts, type, source, importance,
                             importance_source, payload, dedupe_hash, action, reasons, tokens,
                             processed_at)
         VALUES (@id, @session_id, @ordinal, @ts, @type, @source, @importance,
                 @importance_source, @payload, @dedupe_hash, @action, @reasons, @tokens,
                 @processed_at)
         ON CONFLICT(session_id, dedupe_hash) DO NOTHING`,
      )
      .run({
        id: e.id,
        session_id: e.session_id,
        ordinal: e.ordinal ?? null,
        ts: e.timestamp,
        type: e.type,
        source: e.source,
        importance: decision.importance,
        importance_source: e.importance_source,
        payload: JSON.stringify(e.payload),
        dedupe_hash: e.dedupe_hash,
        action: decision.action,
        reasons: JSON.stringify(decision.reasons),
        tokens: decision.tokens,
        // Always pending on insert. The deterministic fold marks an event processed once
        // it has actually derived state from it; marking it here would claim the history
        // is represented in memory before anything has read it.
        processed_at: null,
      });
    return info.changes > 0;
  }

  /**
   * Discarded events are counted but never stored - storing them would defeat the point.
   * The tally therefore lives in `meta`, or the "events discarded" metric could only ever
   * report zero.
   */
  noteDiscarded(sessionId: string, n = 1): void {
    if (n <= 0) return;
    for (const key of ['discarded_total', `discarded:${sessionId}`]) {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + ? AS TEXT)`,
        )
        .run(key, String(n), n);
    }
  }

  countDiscarded(sessionId?: string | null): number {
    return getIntMeta(this.db, sessionId ? `discarded:${sessionId}` : 'discarded_total', 0);
  }

  pendingEvents(sessionId: string | null, limit = 200): StoredEvent[] {
    const rows = (
      sessionId
        ? this.db
            .prepare(
              `SELECT * FROM events WHERE processed_at IS NULL AND session_id = ?
               ORDER BY ts ASC, ordinal ASC LIMIT ?`,
            )
            .all(sessionId, limit)
        : this.db
            .prepare(
              `SELECT * FROM events WHERE processed_at IS NULL ORDER BY ts ASC, ordinal ASC LIMIT ?`,
            )
            .all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  pendingSummary(sessionId: string | null): {
    count: number;
    tokens: number;
    highest: Importance | null;
    compactionRequested: boolean;
  } {
    const where = sessionId ? `processed_at IS NULL AND session_id = ?` : `processed_at IS NULL`;
    const args = sessionId ? [sessionId] : [];
    const agg = this.db
      .prepare(`SELECT COUNT(*) n, COALESCE(SUM(tokens), 0) t FROM events WHERE ${where}`)
      .get(...args) as { n: number; t: number };
    const imps = this.db
      .prepare(`SELECT DISTINCT importance FROM events WHERE ${where}`)
      .all(...args) as Array<{ importance: Importance }>;
    const highest =
      imps.length === 0
        ? null
        : imps
            .map((r) => r.importance)
            .reduce((a, b) => (importanceRank(a) >= importanceRank(b) ? a : b));
    // A compaction request is live only until the agent reports another turn. After that the
    // window has been rewritten and occupancy is measured again; keeping the flag while the
    // event merely sat in the queue pinned a real session at `reduce` with 52% occupancy.
    const comp = this.db
      .prepare(
        `SELECT 1 FROM events e WHERE ${where} AND e.type = 'COMPACTION_REQUESTED'
           AND NOT EXISTS (SELECT 1 FROM agent_usage u WHERE u.session_id = e.session_id AND u.at > e.ts)
         LIMIT 1`,
      )
      .get(...args);
    return { count: agg.n, tokens: agg.t, highest, compactionRequested: comp !== undefined };
  }

  markProcessed(ids: string[], at = new Date().toISOString()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE events SET processed_at = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id);
    })();
  }

  /**
   * Close an event that carried no derivable state.
   *
   * Distinct from `markProcessed` on purpose. Both mean "done", but only the latter means
   * "state was derived from this", and `coverage` is the difference: 726 resolved events with
   * an empty memory once read as 98.9% coverage, which is a discard rate dressed as
   * compression.
   */
  markInert(ids: string[], at = new Date().toISOString()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE events SET processed_at = ?, reasons = json_insert(reasons, '$[#]', ?) WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, INERT_REASON, id);
    })();
  }

  recentEvents(sessionId: string | null, limit = 20, minImportance: Importance = 'medium'): StoredEvent[] {
    const allowed = IMPORTANCE_LEVELS.filter((i) => importanceRank(i) >= importanceRank(minImportance));
    const placeholders = allowed.map(() => '?').join(',');
    const sql = sessionId
      ? `SELECT * FROM events WHERE session_id = ? AND action != 'discard' AND importance IN (${placeholders})
         ORDER BY ts DESC LIMIT ?`
      : `SELECT * FROM events WHERE action != 'discard' AND importance IN (${placeholders})
         ORDER BY ts DESC LIMIT ?`;
    const args = sessionId ? [sessionId, ...allowed, limit] : [...allowed, limit];
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * The latest tool traffic of a session, oldest first, excluding `excludeIds`.
   *
   * What the fold looks back over to pair a success with the failure before it: on the hook path
   * each ingest batch is one event, so the failure is always in an earlier batch. Bounded, and
   * served by the `(session_id, ts)` index, because this runs on the hook path.
   */
  recentToolEvents(sessionId: string, excludeIds: string[], limit = 40): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ?
           AND type IN ('TOOL_CALL', 'FILE_CHANGED', 'TOOL_RESULT', 'ERROR_DETECTED', 'COMMAND_EXECUTED')
           AND id NOT IN (SELECT value FROM json_each(?))
         ORDER BY ts DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, JSON.stringify(excludeIds), limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEvent(r)).reverse();
  }

  /**
   * The active known issue the fold recorded from this event, when a patch may still retire it.
   *
   * A protected item is never returned: an `add.supersedes` naming one would be refused by
   * `validatePatch` (invariant 12) and take the whole fold patch down with it.
   */
  issueRecordedFrom(eventId: string): string | null {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_items m, json_each(m.evidence) ev
         WHERE m.category = 'known_issues' AND m.status = 'active' AND ev.value = ?`,
      )
      .all(eventId) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const item = rowToItem(r);
      if (!isProtected(item) && !isClosed(item)) return item.id;
    }
    return null;
  }

  /** PRD 10 - L2 is for audit and replay, not for eternity. */
  pruneRawEvents(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM events WHERE processed_at IS NOT NULL AND ts < ?`)
      .run(cutoff);
    return info.changes;
  }

  /** PRD 31 - shed the cheapest pending events when the queue runs away. */
  shedQueue(max: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) n FROM events WHERE processed_at IS NULL`).get() as {
      n: number;
    };
    if (row.n <= max) return 0;
    const excess = row.n - max;
    const info = this.db
      .prepare(
        `UPDATE events SET processed_at = datetime('now'), reasons = json_insert(reasons, '$[#]', 'shed_backpressure')
         WHERE id IN (
           SELECT id FROM events WHERE processed_at IS NULL AND importance IN ('low','ephemeral')
           ORDER BY ts ASC LIMIT ?
         )`,
      )
      .run(excess);
    return info.changes;
  }

  private rowToEvent(r: Record<string, unknown>): StoredEvent {
    return {
      id: String(r.id),
      session_id: String(r.session_id),
      ordinal: r.ordinal == null ? null : Number(r.ordinal),
      timestamp: String(r.ts),
      type: r.type as ContextEvent['type'],
      source: String(r.source),
      importance: r.importance as Importance,
      importance_source: (r.importance_source ?? 'engine') as ContextEvent['importance_source'],
      payload: JSON.parse(String(r.payload)),
      dedupe_hash: String(r.dedupe_hash),
      action: String(r.action),
      reasons: JSON.parse(String(r.reasons ?? '[]')),
      tokens: Number(r.tokens ?? 0),
      processed_at: r.processed_at == null ? null : String(r.processed_at),
    };
  }

  // ------------------------------------------------------------------- state

  stateVersion(): number {
    return getIntMeta(this.db, 'state_version', 0);
  }

  workingMemory(): WorkingMemory {
    const row = this.db.prepare(`SELECT state FROM working_memory WHERE id = 1`).get() as
      | { state: string }
      | undefined;
    if (!row) return emptyWorkingMemory();
    return WorkingMemorySchema.parse(JSON.parse(row.state));
  }

  allItems(includeDead = false): MemoryItem[] {
    const sql = includeDead
      ? `SELECT * FROM memory_items ORDER BY created_at ASC`
      : `SELECT * FROM memory_items WHERE status NOT IN ('deleted') ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map(rowToItem);
  }

  currentState(includeDead = false): ProjectState {
    return {
      version: this.stateVersion(),
      working: this.workingMemory(),
      items: this.allItems(includeDead),
    };
  }

  getItem(id: string): MemoryItem | null {
    const row = this.db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Validate, apply and persist a patch atomically (PRD 34). A rejected patch leaves the
   * previous state intact, which is the whole reason workers emit patches rather than
   * rewriting the state file.
   */
  commitPatch(
    rawPatch: StatePatch,
    origin: 'worker' | 'deterministic' | 'user' | 'import',
    opts: {
      sessionId?: string | null;
      workerRunId?: string | null;
      /** Timestamp of the newest event the patch was derived from. */
      observedUntil?: string | null;
    } = {},
  ): CommitResult {
    // Ids are assigned before the patch is written, so replaying the log rebuilds exactly
    // the same items rather than a fresh set with new ids.
    const normalized = normalizePatch(rawPatch);
    // The patch log is append-only and must serialize, so validation and write share one
    // transaction: two concurrent commits cannot both see the same base version.
    const run = this.db.transaction((): CommitResult => {
      const state = this.currentState(true);
      // A model's dead links and removes of things that do not exist are no-ops; dropping them
      // beats rejecting a whole batch of good extraction over them. A user's own patch is left
      // exactly as written, because there they deserve the error.
      const pruned = origin === 'user' ? { patch: normalized, dropped: [] } : pruneInertOperations(normalized, state);
      // Only a worker has to prove provenance: `user` origin is the user, and `import` replays a
      // log that was already checked when it was first written.
      const proven = origin === 'worker' ? this.verifyUserProvenance(pruned.patch) : { patch: pruned.patch, downgraded: [] };
      const closures = origin === 'worker' ? this.verifyClosures(proven.patch, state) : { patch: proven.patch, refused: [] };
      // Working memory is one row, and last write wins. A worker reading an older batch rewrote a
      // task set by hand after those events - "Commit: blocked" came back over the real state. So a
      // worker may not overwrite a task a person set after everything it read. Keyed on the hand
      // edit, not on `updated_at`: a worker's own commit stamps "now", which would lock out the
      // second batch of any backlog.
      const setByHand = getMeta(this.db, 'working_set_by_hand_at');
      const staleWorking =
        origin === 'worker' &&
        closures.patch.working != null &&
        opts.observedUntil != null &&
        setByHand != null &&
        setByHand > opts.observedUntil;
      const withWorking = staleWorking ? { ...closures.patch, working: undefined } : closures.patch;
      const checked = { patch: withWorking, downgraded: proven.downgraded };
      const notes = [
        checked.patch.note,
        pruned.dropped.length > 0 ? `dropped inert: ${pruned.dropped.join(', ')}` : null,
        checked.downgraded.length > 0
          ? `downgraded to agent (no user-message evidence): ${checked.downgraded.join(', ')}`
          : null,
        closures.refused.length > 0
          ? `close refused (user-critical, no event evidence): ${closures.refused.join(', ')}`
          : null,
        staleWorking ? 'working dropped: the task was updated after the newest event this patch read' : null,
      ].filter(Boolean);
      const patch = notes.length > 0 ? { ...checked.patch, note: notes.join(' | ') } : checked.patch;
      const violations = validatePatch(patch, state);
      // Consent to lift protection is a person's to give. `import` replays a log that was checked
      // when it was first written, so it may carry one; a worker or the fold may not.
      if (patch.release_protected?.length && origin !== 'user' && origin !== 'import') {
        violations.push({
          code: 'protected_item',
          message: `only a person may release user-critical items (${patch.release_protected.join(', ')})`,
        });
      }
      if (violations.length > 0) {
        return {
          ok: false,
          version: state.version,
          patchId: null,
          violations,
          added: [],
          updated: [],
          removed: [],
          superseded: [],
          touched: [],
        };
      }

      const result = applyPatch(state, patch);
      const byId = new Map(result.state.items.map((i) => [i.id, i]));
      const dirty = new Set([
        ...result.added,
        ...result.updated,
        ...result.removed,
        ...result.superseded,
        ...result.touched,
      ]);
      const upsert = this.db.prepare(UPSERT_ITEM_SQL);
      for (const id of dirty) {
        const item = byId.get(id);
        if (item) upsert.run(itemToRow(item));
      }

      if (patch.working) {
        this.db
          .prepare(
            `INSERT INTO working_memory (id, state) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
          )
          .run(JSON.stringify(result.state.working));
      }

      // Edges live in the same transaction as the items, so a rejected patch cannot leave
      // a relation pointing at an item that was never written.
      for (const e of result.linked) {
        const [from, to] =
          isSymmetric(e.kind) && e.to < e.from ? [e.to, e.from] : [e.from, e.to];
        this.db
          .prepare(
            `INSERT INTO memory_edges (from_id, to_id, kind, reason, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
               reason = COALESCE(excluded.reason, memory_edges.reason),
               confidence = excluded.confidence`,
          )
          .run(from, to, e.kind, e.reason, e.confidence, e.created_at);
      }
      for (const u of result.unlinked) {
        if (u.kind) {
          this.db
            .prepare(
              `DELETE FROM memory_edges WHERE kind = ?
                 AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
            )
            .run(u.kind, u.from, u.to, u.to, u.from);
        } else {
          this.db
            .prepare(
              `DELETE FROM memory_edges
                 WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`,
            )
            .run(u.from, u.to, u.to, u.from);
        }
      }

      const seq = getIntMeta(this.db, 'patch_seq', 0) + 1;
      const patchId = newId('pat');
      this.db
        .prepare(
          `INSERT INTO patches (id, seq, session_id, base_version, new_version, patch, note, origin,
                                worker_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          patchId,
          seq,
          opts.sessionId ?? null,
          state.version,
          result.state.version,
          JSON.stringify(patch),
          patch.note ?? null,
          origin,
          opts.workerRunId ?? null,
          new Date().toISOString(),
        );
      if (origin === 'user' && patch.working) setMeta(this.db, 'working_set_by_hand_at', new Date().toISOString());
      setMeta(this.db, 'patch_seq', String(seq));
      setMeta(this.db, 'state_version', String(result.state.version));

      return {
        ok: true,
        version: result.state.version,
        patchId,
        violations: [],
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        superseded: result.superseded,
        touched: result.touched,
      };
    });
    return run();
  }

  /** PRD 33 - rebuild any historical version by folding the log (`contextd replay`). */
  replay(upToVersion?: number): ProjectState {
    const rows = this.db
      .prepare(`SELECT patch, new_version FROM patches ORDER BY seq ASC`)
      .all() as Array<{ patch: string; new_version: number }>;
    let state: ProjectState = { version: 0, working: emptyWorkingMemory(), items: [] };
    for (const r of rows) {
      if (upToVersion != null && r.new_version > upToVersion) break;
      const patch = JSON.parse(r.patch) as StatePatch;
      // Replaying must not re-run the concurrency check; the log is by definition in order.
      const { base_version: _ignored, ...rest } = patch;
      state = applyPatch(state, rest as StatePatch).state;
    }
    return state;
  }

  listPatches(limit = 20): Array<{
    id: string;
    seq: number;
    base_version: number;
    new_version: number;
    origin: string;
    note: string | null;
    created_at: string;
    patch: StatePatch;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, seq, base_version, new_version, origin, note, created_at, patch
         FROM patches ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      seq: Number(r.seq),
      base_version: Number(r.base_version),
      new_version: Number(r.new_version),
      origin: String(r.origin),
      note: r.note == null ? null : String(r.note),
      created_at: String(r.created_at),
      patch: JSON.parse(String(r.patch)) as StatePatch,
    }));
  }

  markUsed(ids: string[], at = new Date().toISOString()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      `UPDATE memory_items SET last_used_at = ?, retrieved_count = retrieved_count + 1 WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id);
    })();
  }

  // ------------------------------------------------------------------ graph

  /** Every relation touching an item, in both directions (PRD 56). */
  edgesOf(id: string): Array<{ edge: MemoryEdge; direction: 'out' | 'in' }> {
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, kind, reason, confidence, created_at
         FROM memory_edges WHERE from_id = ? OR to_id = ?`,
      )
      .all(id, id) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const edge = MemoryEdgeSchema.parse({
        from: String(r.from_id),
        to: String(r.to_id),
        kind: r.kind,
        reason: r.reason == null ? null : String(r.reason),
        confidence: Number(r.confidence),
        created_at: String(r.created_at),
      });
      return { edge, direction: edge.from === id ? ('out' as const) : ('in' as const) };
    });
  }

  allEdges(): MemoryEdge[] {
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, kind, reason, confidence, created_at FROM memory_edges
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) =>
      MemoryEdgeSchema.parse({
        from: String(r.from_id),
        to: String(r.to_id),
        kind: r.kind,
        reason: r.reason == null ? null : String(r.reason),
        confidence: Number(r.confidence),
        created_at: String(r.created_at),
      }),
    );
  }

  /** Neighbour ids of a set of items, with the weight that survived the hop. */
  neighbours(ids: string[]): Map<string, { weight: number; via: MemoryEdge }> {
    const out = new Map<string, { weight: number; via: MemoryEdge }>();
    if (ids.length === 0) return out;
    const seeds = new Set(ids);
    for (const id of ids) {
      for (const { edge } of this.edgesOf(id)) {
        const other = edge.from === id ? edge.to : edge.from;
        if (seeds.has(other)) continue;
        const weight = traversalWeight(edge.kind) * edge.confidence;
        const prev = out.get(other);
        if (!prev || weight > prev.weight) out.set(other, { weight, via: edge });
      }
    }
    return out;
  }

  edgeCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM memory_edges`).get() as { n: number }).n;
  }

  // ---------------------------------------------------------------- latency

  /** PRD 31 - record how long an operation took, so the budget can be judged. */
  recordLatency(op: string, ms: number, detail?: string | null, keepSamples = 500): void {
    this.db
      .prepare(`INSERT INTO op_latency (op, ms, at, detail) VALUES (?, ?, ?, ?)`)
      .run(op, ms, new Date().toISOString(), detail ?? null);
    // Keep the table bounded; old samples tell us nothing we do not already know.
    this.db
      .prepare(
        `DELETE FROM op_latency WHERE op = ? AND id <= (
           SELECT MAX(id) FROM op_latency WHERE op = ?
         ) - ?`,
      )
      .run(op, op, keepSamples);
  }

  latencyStats(op: string): { count: number; p50: number; p95: number; max: number } | null {
    const rows = this.db
      .prepare(`SELECT ms FROM op_latency WHERE op = ? ORDER BY ms ASC`)
      .all(op) as Array<{ ms: number }>;
    if (rows.length === 0) return null;
    const at = (q: number) => rows[Math.min(rows.length - 1, Math.floor(q * rows.length))]!.ms;
    return { count: rows.length, p50: at(0.5), p95: at(0.95), max: rows[rows.length - 1]!.ms };
  }

  /**
   * PRD 29 has no metric for memory that is true but worthless, which was the failure mode
   * seen in real use. These are the cheap proxies for precision.
   */
  precisionStats(): {
    total: number;
    neverRetrieved: number;
    shortLived: number;
    lowConfidence: number;
    unverified: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) total,
           COALESCE(SUM(CASE WHEN retrieved_count = 0 THEN 1 ELSE 0 END), 0) never_retrieved,
           -- Retired within an hour of being written: it should not have been written.
           COALESCE(SUM(CASE WHEN status IN ('superseded','stale','deleted')
                              AND (julianday(updated_at) - julianday(created_at)) * 86400 < 3600
                        THEN 1 ELSE 0 END), 0) short_lived,
           COALESCE(SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END), 0) low_confidence,
           COALESCE(SUM(CASE WHEN tags LIKE '%unverified%' THEN 1 ELSE 0 END), 0) unverified
         FROM memory_items`,
      )
      .get() as Record<string, number>;
    return {
      total: row.total ?? 0,
      neverRetrieved: row.never_retrieved ?? 0,
      shortLived: row.short_lived ?? 0,
      lowConfidence: row.low_confidence ?? 0,
      unverified: row.unverified ?? 0,
    };
  }

  /**
   * `never_retrieved` as it stood after each change, rebuilt from the audit trail rather than
   * sampled: `retrieval_log` is written alongside every `markUsed`, and the ratio counts every
   * item ever created whatever its status, so creation times plus first retrievals determine
   * the whole series. Nothing new has to be stored, and history exists from the first item.
   */
  neverRetrievedHistory(): Array<{ at: string; total: number; never: number }> {
    const created = this.db.prepare(`SELECT id, created_at FROM memory_items`).all() as Array<{
      id: string;
      created_at: string;
    }>;
    const firstUse = new Map(
      (
        this.db
          .prepare(
            `SELECT j.value AS id, MIN(r.at) AS at FROM retrieval_log r, json_each(r.item_ids) j
             GROUP BY j.value`,
          )
          .all() as Array<{ id: string; at: string }>
      ).map((r) => [r.id, r.at]),
    );

    const changes: Array<{ at: string; total: number; never: number }> = [];
    for (const { id, created_at } of created) {
      changes.push({ at: created_at, total: 1, never: 1 });
      const used = firstUse.get(id);
      // An item cannot be retrieved before it exists; clamp against clock skew between writers.
      if (used) changes.push({ at: used < created_at ? created_at : used, total: 0, never: -1 });
    }
    changes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const out: Array<{ at: string; total: number; never: number }> = [];
    let total = 0;
    let never = 0;
    for (const c of changes) {
      total += c.total;
      never += c.never;
      // Changes sharing a timestamp are one step: a patch adds its items at once.
      const last = out[out.length - 1];
      if (last && last.at === c.at) {
        last.total = total;
        last.never = never;
      } else {
        out.push({ at: c.at, total, never });
      }
    }
    return out;
  }

  // ------------------------------------------------------------- worker runs

  startWorkerRun(init: WorkerRunInit): string {
    const id = newId('wrk');
    this.db
      .prepare(
        `INSERT INTO worker_runs (id, session_id, task, tier, provider, model, status, event_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        init.sessionId,
        init.task,
        init.tier,
        init.provider,
        init.model,
        init.eventCount,
        new Date().toISOString(),
      );
    return id;
  }

  finishWorkerRun(id: string, r: WorkerRunResult): void {
    this.db
      .prepare(
        `UPDATE worker_runs SET status = @status, input_tokens = @input_tokens,
           output_tokens = @output_tokens, cached_tokens = @cached_tokens, cost_usd = @cost_usd,
           attempts = @attempts, error = @error, patch_id = @patch_id, finished_at = @finished_at
         WHERE id = @id`,
      )
      .run({
        id,
        status: r.status,
        input_tokens: r.inputTokens ?? 0,
        output_tokens: r.outputTokens ?? 0,
        cached_tokens: r.cachedTokens ?? 0,
        cost_usd: r.costUsd ?? 0,
        attempts: r.attempts ?? 1,
        error: r.error ?? null,
        patch_id: r.patchId ?? null,
        finished_at: new Date().toISOString(),
      });
  }

  recentWorkerUsage(sinceMs: number): UsageRecord[] {
    const since = new Date(sinceMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT started_at, input_tokens + output_tokens + cached_tokens AS tokens, cost_usd
         FROM worker_runs WHERE started_at >= ?`,
      )
      .all(since) as Array<{ started_at: string; tokens: number; cost_usd: number }>;
    return rows.map((r) => ({ at: Date.parse(r.started_at), tokens: r.tokens, cost_usd: r.cost_usd }));
  }

  sessionWorkerCost(sessionId: string | null): number {
    const row = (
      sessionId
        ? this.db
            .prepare(`SELECT COALESCE(SUM(cost_usd), 0) c FROM worker_runs WHERE session_id = ?`)
            .get(sessionId)
        : this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) c FROM worker_runs`).get()
    ) as { c: number };
    return row.c;
  }

  lastWorkerAt(sessionId: string | null): number | null {
    const row = (
      sessionId
        ? this.db
            .prepare(
              `SELECT started_at FROM worker_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
            )
            .get(sessionId)
        : this.db.prepare(`SELECT started_at FROM worker_runs ORDER BY started_at DESC LIMIT 1`).get()
    ) as { started_at: string } | undefined;
    return row ? Date.parse(row.started_at) : null;
  }

  // -------------------------------------------------------------- file index

  knownFileHash(path: string): string | null {
    const row = this.db.prepare(`SELECT content_hash FROM file_index WHERE path = ?`).get(path) as
      | { content_hash: string | null }
      | undefined;
    return row?.content_hash ?? null;
  }

  noteFile(path: string, contentHash: string | null, purpose?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO file_index (path, content_hash, purpose, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           content_hash = excluded.content_hash,
           purpose = COALESCE(excluded.purpose, file_index.purpose),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(path, contentHash, purpose ?? null, new Date().toISOString());
  }

  // ------------------------------------------------------- usage & retrieval

  recordAgentUsage(sessionId: string, usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    message_id?: string | null;
  }, model?: string | null): void {
    // Keyed by the provider's message id when there is one: the same turn is seen by the
    // transcript tail and by the Stop hook, and must count as one turn, not two.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_usage (id, session_id, at, input_tokens, output_tokens, cached_tokens, model)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.message_id ? `ausg_${usage.message_id}` : newId('ausg'),
        sessionId,
        new Date().toISOString(),
        usage.input_tokens ?? 0,
        usage.output_tokens ?? 0,
        (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        model ?? null,
      );
  }

  agentUsageTotals(sessionId: string | null): {
    input: number;
    output: number;
    cached: number;
    turns: number;
    peakInput: number;
  } {
    const row = (
      sessionId
        ? this.db
            .prepare(
              `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,
                      COALESCE(SUM(cached_tokens),0) c, COUNT(*) n,
                      COALESCE(MAX(input_tokens + cached_tokens),0) p
               FROM agent_usage WHERE session_id = ?`,
            )
            .get(sessionId)
        : this.db
            .prepare(
              `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,
                      COALESCE(SUM(cached_tokens),0) c, COUNT(*) n,
                      COALESCE(MAX(input_tokens + cached_tokens),0) p
               FROM agent_usage`,
            )
            .get()
    ) as { i: number; o: number; c: number; n: number; p: number };
    return { input: row.i, output: row.o, cached: row.c, turns: row.n, peakInput: row.p };
  }

  /**
   * The most recent turn's occupancy, which is what the compaction ladder reads. The peak is
   * the wrong number for a live decision: the agent may have compacted since.
   */
  latestAgentUsage(sessionId: string | null): { occupied: number; model: string | null } | null {
    const row = (
      sessionId
        ? this.db
            .prepare(
              `SELECT input_tokens + cached_tokens occupied, model FROM agent_usage
               WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`,
            )
            .get(sessionId)
        : this.db
            .prepare(
              `SELECT input_tokens + cached_tokens occupied, model FROM agent_usage
               ORDER BY at DESC, rowid DESC LIMIT 1`,
            )
            .get()
    ) as { occupied: number; model: string | null } | undefined;
    return row ? { occupied: row.occupied, model: row.model } : null;
  }

  /**
   * Count a hard compaction by the agent. This is the ladder's failure counter, so it is
   * persisted rather than derived: the events it comes from are subject to retention.
   */
  noteHardCompaction(sessionId: string | null, n = 1): void {
    if (n <= 0) return;
    const keys = sessionId ? ['hard_compactions', `hard_compactions:${sessionId}`] : ['hard_compactions'];
    for (const key of keys) {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + ? AS TEXT)`,
        )
        .run(key, String(n), n);
    }
  }

  countHardCompactions(sessionId?: string | null): number {
    return getIntMeta(
      this.db,
      sessionId ? `hard_compactions:${sessionId}` : 'hard_compactions',
      0,
    );
  }

  /**
   * How many of the most recent completed runs read events and recorded nothing.
   *
   * A wrong model, a model that ignores the JSON contract, or a fine-tune with no idea what it
   * is being asked will return an empty patch every time, drain the queue and look like a
   * healthy `ok`. This is the only signal that distinguishes it from a genuinely quiet project.
   */
  emptyRunStreak(): { streak: number; lastModel: string | null } {
    const rows = this.db
      .prepare(
        `SELECT status, event_count, patch_id, model FROM worker_runs
         WHERE finished_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 20`,
      )
      .all() as Array<{ status: string; event_count: number; patch_id: string | null; model: string }>;
    let streak = 0;
    let lastModel: string | null = null;
    for (const r of rows) {
      const readSomething = r.event_count > 0;
      const recordedNothing = r.status === 'ok' && r.patch_id == null;
      if (readSomething && recordedNothing) {
        streak += 1;
        lastModel ??= r.model;
      } else if (readSomething) {
        break;
      }
    }
    return { streak, lastModel };
  }

  /**
   * Downgrade any `source: "user"` item a worker cannot actually justify.
   *
   * `source: user` plus `critical` is the one combination `isProtected` makes permanent, so a
   * worker must not be able to award it on its own say-so. A real run synthesised a goal from the
   * conversation — including a detail the agent had proposed, not the user — and filed it as a
   * user-critical instruction that nothing could then remove.
   *
   * The rule is provenance, not prohibition: a worker may still record what the user said, as long
   * as it cites at least one `USER_MESSAGE` event as evidence. Unbacked claims keep their text and
   * lose the attribution, because discarding the content would lose real information.
   */
  private verifyUserProvenance(patch: StatePatch): { patch: StatePatch; downgraded: string[] } {
    const claims = (patch.add ?? []).filter((a) => a.source === 'user');
    if (claims.length === 0) return { patch, downgraded: [] };

    const cited = [...new Set(claims.flatMap((a) => a.evidence ?? []))];
    const userEvents = new Set<string>();
    if (cited.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT id FROM events WHERE type = 'USER_MESSAGE' AND id IN (${cited.map(() => '?').join(',')})`,
        )
        .all(...cited) as Array<{ id: string }>;
      for (const r of rows) userEvents.add(r.id);
    }

    const downgraded: string[] = [];
    const add = (patch.add ?? []).map((a) => {
      if (a.source !== 'user') return a;
      if ((a.evidence ?? []).some((id) => userEvents.has(id))) return a;
      downgraded.push(a.id ?? a.text.slice(0, 40));
      // The confidence ceiling is applied in `normalizePatch`, which runs before this and exempts
      // user-authored items - so a claim that loses its attribution here has to be capped here too,
      // or it keeps a certainty that only the user was ever entitled to.
      return {
        ...a,
        source: 'agent' as const,
        ...(a.confidence != null
          ? { confidence: Math.min(a.confidence, MAX_INFERRED_CONFIDENCE) }
          : {}),
      };
    });

    return downgraded.length > 0 ? { patch: { ...patch, add }, downgraded } : { patch, downgraded };
  }

  /**
   * A worker may declare a user's goal met only by citing something that happened.
   *
   * Closing does not delete, but it does take the goal out of every session start, which is most
   * of what deleting it would do. So the same rule as provenance: the claim needs evidence that
   * exists. A close that cannot show any is dropped, not the whole patch.
   */
  private verifyClosures(patch: StatePatch, state: ProjectState): { patch: StatePatch; refused: string[] } {
    if (!patch.close?.length) return { patch, refused: [] };
    const byId = new Map(state.items.map((i) => [i.id, i]));
    const cited = [...new Set(patch.close.flatMap((c) => c.evidence ?? []))];
    const real = new Set<string>();
    if (cited.length > 0) {
      const rows = this.db
        .prepare(`SELECT id FROM events WHERE id IN (${cited.map(() => '?').join(',')})`)
        .all(...cited) as Array<{ id: string }>;
      for (const r of rows) real.add(r.id);
    }
    const refused: string[] = [];
    const close = patch.close.filter((c) => {
      const target = byId.get(c.id);
      if (!target || !isProtected(target)) return true;
      if ((c.evidence ?? []).some((id) => real.has(id))) return true;
      refused.push(c.id);
      return false;
    });
    return refused.length > 0 ? { patch: { ...patch, close }, refused } : { patch, refused };
  }

  /**
   * Successful milestone commands (commit, push, merge, publish...) after `iso`, newest first.
   * Filtered in code rather than SQL so the definition lives in one place: `isMilestoneCommand`.
   */
  milestonesSince(iso: string | null, limit = 50): Array<{ command: string; summary: string | null; at: string }> {
    const rows = (
      iso
        ? this.db
            .prepare(`SELECT ts, payload FROM events WHERE type = 'COMMAND_EXECUTED' AND ts > ? ORDER BY ts DESC LIMIT 500`)
            .all(iso)
        : this.db.prepare(`SELECT ts, payload FROM events WHERE type = 'COMMAND_EXECUTED' ORDER BY ts DESC LIMIT 500`).all()
    ) as Array<{ ts: string; payload: string }>;
    const out: Array<{ command: string; summary: string | null; at: string }> = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { command?: string; exit_code?: number; output?: string };
      if (p.exit_code !== 0 || !isMilestoneCommand(p.command)) continue;
      // `git commit` prints "[branch abc1234] subject": the one line worth showing.
      const subject = /^\[[^\]]+\]\s*(.+)$/m.exec(p.output ?? '')?.[1] ?? null;
      out.push({ command: p.command!, summary: subject, at: r.ts });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** How many times the user has spoken since `iso` - the signal that a recorded task has moved on. */
  userMessagesSince(iso: string | null): number {
    const row = (
      iso
        ? this.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'USER_MESSAGE' AND ts > ?`).get(iso)
        : this.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'USER_MESSAGE'`).get()
    ) as { n: number };
    return row.n;
  }

  /**
   * The session an MCP call most likely belongs to.
   *
   * An MCP server is spawned by the agent without being told which session it serves, while the
   * hooks of that same session are writing events. So the session with the freshest event, if it
   * is fresh at all, is the caller. An inference, used only to attribute retrievals; null when
   * nothing is recent, rather than a guess at an idle session.
   */
  activeSessionId(withinMs = 30 * 60_000, now = Date.now()): string | null {
    const row = this.db
      .prepare(`SELECT session_id, ts FROM events ORDER BY ts DESC LIMIT 1`)
      .get() as { session_id: string; ts: string } | undefined;
    if (!row) return null;
    return now - Date.parse(row.ts) <= withinMs ? row.session_id : null;
  }

  logRetrieval(sessionId: string | null, query: string, itemIds: string[], tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO retrieval_log (id, session_id, query, item_ids, tokens, at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId('ret'), sessionId, query, JSON.stringify(itemIds), tokens, new Date().toISOString());
  }

  /**
   * What agents pulled since `iso`: bootstraps and queries. A mirror write is left out - it is
   * served, but nothing about it says an agent asked (see `contextd doctor`, "memory pulled").
   */
  retrievalsSince(iso: string): { bootstraps: number; queries: number; last: string | null } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN query = '(bootstrap)' THEN 1 ELSE 0 END), 0) b,
                COALESCE(SUM(CASE WHEN query NOT IN ('(bootstrap)', '(mirror)') THEN 1 ELSE 0 END), 0) q,
                MAX(CASE WHEN query <> '(mirror)' THEN at END) last
         FROM retrieval_log WHERE at >= ?`,
      )
      .get(iso) as { b: number; q: number; last: string | null };
    return { bootstraps: row.b, queries: row.q, last: row.last };
  }

  /** Sessions that produced events since `iso`, and the newest event overall in that window. */
  sessionsActiveSince(iso: string): { sessions: number; last: string | null } {
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT session_id) n, MAX(ts) last FROM events WHERE ts >= ?`)
      .get(iso) as { n: number; last: string | null };
    return { sessions: row.n, last: row.last };
  }

  /** Newest thing that happened to this project: an event or a patch. */
  lastActivity(): string | null {
    const row = this.db
      .prepare(`SELECT MAX(at) at FROM (SELECT MAX(ts) at FROM events UNION ALL SELECT MAX(created_at) at FROM patches)`)
      .get() as { at: string | null };
    return row.at;
  }

  retrievalStats(): { count: number; avgTokens: number; emptyCount: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(AVG(tokens),0) t,
                COALESCE(SUM(CASE WHEN item_ids = '[]' THEN 1 ELSE 0 END),0) e FROM retrieval_log`,
      )
      .get() as { n: number; t: number; e: number };
    return { count: row.n, avgTokens: row.t, emptyCount: row.e };
  }

  // ---------------------------------------------------------------- cursors

  getCursor(key: string): number {
    const row = this.db.prepare(`SELECT offset FROM ingest_cursors WHERE key = ?`).get(key) as
      | { offset: number }
      | undefined;
    return row?.offset ?? 0;
  }

  setCursor(key: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO ingest_cursors (key, offset, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at`,
      )
      .run(key, offset, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

const UPSERT_ITEM_SQL = `
INSERT INTO memory_items (id, category, text, fields, importance, confidence, status, source,
                          evidence, reason, created_at, updated_at, last_used_at,
                          last_validated_at, ttl_seconds, supersedes, superseded_by, tags,
                          retrieved_count)
VALUES (@id, @category, @text, @fields, @importance, @confidence, @status, @source,
        @evidence, @reason, @created_at, @updated_at, @last_used_at,
        @last_validated_at, @ttl_seconds, @supersedes, @superseded_by, @tags,
        @retrieved_count)
ON CONFLICT(id) DO UPDATE SET
  category = excluded.category, text = excluded.text, fields = excluded.fields,
  importance = excluded.importance, confidence = excluded.confidence, status = excluded.status,
  source = excluded.source, evidence = excluded.evidence, reason = excluded.reason,
  updated_at = excluded.updated_at, last_used_at = excluded.last_used_at,
  last_validated_at = excluded.last_validated_at, ttl_seconds = excluded.ttl_seconds,
  supersedes = excluded.supersedes, superseded_by = excluded.superseded_by, tags = excluded.tags,
  -- Never regress the retrieval counter: it is evidence, not part of the patch.
  retrieved_count = MAX(memory_items.retrieved_count, excluded.retrieved_count)`;

export function itemToRow(i: MemoryItem): Record<string, unknown> {
  return {
    id: i.id,
    category: i.category,
    text: i.text,
    fields: JSON.stringify(i.fields ?? {}),
    importance: i.importance,
    confidence: i.confidence,
    status: i.status,
    source: i.source,
    evidence: JSON.stringify(i.evidence ?? []),
    reason: i.reason,
    created_at: i.created_at,
    updated_at: i.updated_at,
    last_used_at: i.last_used_at,
    last_validated_at: i.last_validated_at,
    ttl_seconds: i.ttl_seconds,
    supersedes: JSON.stringify(i.supersedes ?? []),
    superseded_by: i.superseded_by,
    tags: JSON.stringify(i.tags ?? []),
    retrieved_count: i.retrieved_count ?? 0,
  };
}

export function rowToItem(r: Record<string, unknown>): MemoryItem {
  return MemoryItemSchema.parse({
    id: String(r.id),
    category: r.category,
    text: String(r.text),
    fields: JSON.parse(String(r.fields ?? '{}')),
    importance: r.importance,
    confidence: Number(r.confidence),
    status: r.status,
    source: r.source,
    evidence: JSON.parse(String(r.evidence ?? '[]')),
    reason: r.reason == null ? null : String(r.reason),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    last_validated_at: r.last_validated_at == null ? null : String(r.last_validated_at),
    ttl_seconds: r.ttl_seconds == null ? null : Number(r.ttl_seconds),
    supersedes: JSON.parse(String(r.supersedes ?? '[]')),
    superseded_by: r.superseded_by == null ? null : String(r.superseded_by),
    tags: JSON.parse(String(r.tags ?? '[]')),
    retrieved_count: r.retrieved_count == null ? 0 : Number(r.retrieved_count),
  });
}
