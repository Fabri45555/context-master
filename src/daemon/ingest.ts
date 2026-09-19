import type { Adapter, AdapterContext } from '../adapters/index.js';
import type { Config } from '../core/config.js';
import { DeterministicEngine } from '../core/deterministic.js';
import { deterministicFold } from '../core/fold.js';
import { IgnoreMatcher } from '../core/ignore.js';
import type { ContextStore, StoredEvent } from '../store/store.js';

/**
 * PRD 48 - the ingest half of the end-to-end flow.
 *
 * Adapter translates, the deterministic engine decides, the store persists. Nothing here
 * calls a model; that decision is deferred to the scheduler so ingestion stays non-blocking
 * (PRD 31).
 */

export interface IngestStats {
  received: number;
  stored: number;
  discarded: number;
  duplicates: number;
  queued: number;
  tokens: number;
  /** Events fully resolved by the deterministic fold, with no model involved. */
  folded: number;
  reasons: Record<string, number>;
}

export function emptyStats(): IngestStats {
  return {
    received: 0,
    stored: 0,
    discarded: 0,
    duplicates: 0,
    queued: 0,
    tokens: 0,
    folded: 0,
    reasons: {},
  };
}

export class IngestPipeline {
  private engine: DeterministicEngine;

  constructor(
    private store: ContextStore,
    private config: Config,
    projectRoot: string,
  ) {
    const ignore = IgnoreMatcher.fromProject(
      projectRoot,
      config.privacy.exclude_paths,
      config.privacy.respect_gitignore,
    );
    this.engine = new DeterministicEngine({
      config,
      isDuplicate: (sid, hash) => this.store.isDuplicate(sid, hash),
      knownFileHash: (p) => this.store.knownFileHash(p),
      isExcluded: (p) => ignore.ignores(p),
    });
  }

  /** Ingest a batch of raw adapter records. Returns what happened, for observability. */
  ingest(adapter: Adapter, records: unknown[], ctx: AdapterContext): IngestStats {
    const stats = emptyStats();
    const accepted: StoredEvent[] = [];

    for (const [n, raw] of records.entries()) {
      stats.received += 1;
      const translated = adapter.translate(raw, { ...ctx, ordinal: ctx.ordinal ?? n });

      if (translated.session?.id) {
        this.store.upsertSession({
          id: translated.session.id,
          source: adapter.name,
          agent: translated.session.agent ?? null,
          cwd: translated.session.cwd ?? ctx.cwd ?? null,
        });
      }
      if (translated.agentUsage) {
        this.store.recordAgentUsage(
          translated.session?.id ?? ctx.sessionId,
          translated.agentUsage,
          translated.agentUsage.model ?? null,
        );
      }

      for (const event of translated.events) {
        const decision = this.engine.process(event);
        for (const r of decision.reasons) {
          const key = r.split(':')[0]!;
          stats.reasons[key] = (stats.reasons[key] ?? 0) + 1;
        }

        if (decision.action === 'discard') {
          // Discards are counted, not stored: keeping them would defeat the point. A
          // duplicate is not a discard - it was already counted the first time round.
          if (decision.reasons.includes('duplicate_event')) {
            stats.duplicates += 1;
          } else {
            stats.discarded += 1;
            this.store.noteDiscarded(event.session_id);
          }
          continue;
        }

        const inserted = this.store.insertEvent(decision);
        if (!inserted) {
          stats.duplicates += 1;
          continue;
        }
        stats.stored += 1;
        stats.tokens += decision.tokens;
        if (decision.event.type === 'COMPACTION_REQUESTED') {
          // The agent compacting is the compaction ladder failing; count it here rather than
          // in an adapter, so every agent is scored the same way.
          this.store.noteHardCompaction(decision.event.session_id);
        }
        if (decision.action === 'persist_and_queue') stats.queued += 1;
        accepted.push({
          ...decision.event,
          action: decision.action,
          reasons: decision.reasons,
          tokens: decision.tokens,
          processed_at: null,
        });
      }
    }

    this.fold(accepted, stats);

    // PRD 31 - shed the cheapest pending work rather than letting the queue grow unbounded.
    this.store.shedQueue(this.config.retention.max_queue_events);
    return stats;
  }

  /**
   * Re-run the deterministic pass over events still waiting for a worker.
   *
   * The cheapest rung of the compaction ladder: an event queued when no fold rule matched it
   * may be foldable now, and every event resolved here is one a model does not have to read.
   */
  refold(sessionId: string | null, limit = 500): { folded: number } {
    const pending = this.store.pendingEvents(sessionId, limit);
    if (pending.length === 0) return { folded: 0 };
    const result = deterministicFold(pending);

    for (const f of result.fileNotes) this.store.noteFile(f.path, f.contentHash);
    if (Object.keys(result.patch).length > 0) {
      this.store.commitPatch(result.patch, 'deterministic', { sessionId: pending[0]!.session_id });
    }
    if (result.consumed.length > 0) this.store.markProcessed(result.consumed);
    if (result.inert.length > 0) this.store.markInert(result.inert);
    return { folded: result.consumed.length };
  }

  /**
   * PRD 13 - the deterministic pass, run at ingest rather than inside the worker.
   *
   * Doing it here means it still happens when no worker can run at all: no budget, no
   * provider, local-only mode. It also keeps "processed" honest, because an event is only
   * marked done once something has actually derived state from it.
   */
  private fold(events: StoredEvent[], stats: IngestStats): void {
    if (events.length === 0) return;
    const result = deterministicFold(events);

    for (const f of result.fileNotes) this.store.noteFile(f.path, f.contentHash);

    if (Object.keys(result.patch).length > 0) {
      this.store.commitPatch(result.patch, 'deterministic', {
        sessionId: events[0]!.session_id,
      });
    }

    if (result.consumed.length > 0) {
      this.store.markProcessed(result.consumed);
      stats.folded = result.consumed.length;
    }
    // Rejected noise is resolved, not derived from, so it must not inflate coverage.
    if (result.inert.length > 0) this.store.markInert(result.inert);

    // Anything neither folded nor queued carries no derivable state, so it is history now -
    // recorded as inert rather than as processed, so it cannot be counted as coverage.
    const accounted = new Set([...result.consumed, ...result.inert]);
    const remaining = events
      .filter((e) => e.action === 'persist' && !accounted.has(e.id))
      .map((e) => e.id);
    if (remaining.length > 0) this.store.markInert(remaining);
  }
}
