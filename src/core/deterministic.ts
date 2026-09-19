import type { Config } from './config.js';
import { atLeast, estimateTokens, type ContextEvent, type Importance } from './events.js';
import { classifyImportance, needsSemantics } from './importance.js';
import { isSensitivePath, redactValue } from './redact.js';
import { sha256 } from './ids.js';

/**
 * PRD 13 / 51 - the deterministic core.
 *
 * Every event passes through here first. Only what survives and genuinely needs semantic
 * understanding is allowed to cost tokens. This is the "deterministic first, LLM second"
 * rule made executable rather than aspirational.
 */

export type EventAction =
  /** Dropped entirely: duplicate, sensitive, or provably valueless. */
  | 'discard'
  /** Written to L2 and folded into deterministic state, but no worker needed. */
  | 'persist'
  /** Written to L2 and queued for a worker because it carries meaning. */
  | 'persist_and_queue';

export interface EventDecision {
  action: EventAction;
  event: ContextEvent;
  importance: Importance;
  /** Human-readable rule trail, surfaced by `contextd inspect` (PRD 42). */
  reasons: string[];
  tokens: number;
}

export interface EngineDeps {
  config: Config;
  /** True when this session already stored an event with the same dedupe hash. */
  isDuplicate(sessionId: string, dedupeHash: string): boolean;
  /** Last known content hash for a path, or null if never indexed. */
  knownFileHash(path: string): string | null;
  /** True when the path is excluded (gitignore / config / sensitive). */
  isExcluded(path: string): boolean;
}

export class DeterministicEngine {
  constructor(private deps: EngineDeps) {}

  process(input: ContextEvent): EventDecision {
    const reasons: string[] = [];
    let event = input;
    const { config } = this.deps;

    // R1 - duplicate suppression. Hooks and transcript tailing overlap by design.
    if (this.deps.isDuplicate(event.session_id, event.dedupe_hash)) {
      return { action: 'discard', event, importance: 'ephemeral', reasons: ['duplicate_event'], tokens: 0 };
    }

    // R2 - never ingest secrets-by-path, even redacted.
    const paths = [event.payload.path, ...(event.payload.paths ?? [])].filter(
      (p): p is string => typeof p === 'string',
    );
    for (const p of paths) {
      if (isSensitivePath(p) || this.deps.isExcluded(p)) {
        return {
          action: 'discard',
          event,
          importance: 'ephemeral',
          reasons: [`excluded_path:${p}`],
          tokens: 0,
        };
      }
    }

    // R3 - truncate + hash oversized payloads instead of storing them whole.
    event = this.trimPayload(event, config.retention.max_payload_chars, reasons);

    // R4 - redact before anything is written or sent.
    if (config.privacy.redact_secrets) {
      const { value, count } = redactValue(event.payload);
      if (count > 0) {
        reasons.push(`redacted:${count}`);
        event = { ...event, payload: { ...value, redactions: count } };
      }
    }

    // R5 - a file whose content hash is unchanged carries no new information.
    if (event.type === 'FILE_CHANGED' && typeof event.payload.content_hash === 'string') {
      const p = event.payload.path;
      if (typeof p === 'string' && this.deps.knownFileHash(p) === event.payload.content_hash) {
        return {
          action: 'discard',
          event,
          importance: 'ephemeral',
          reasons: [...reasons, 'file_unchanged'],
          tokens: 0,
        };
      }
    }

    // R6 - importance. The deterministic verdict stands unless an adapter *deliberately*
    // claimed something stronger, because an adapter can know things we cannot infer. A
    // merely defaulted importance is not such a claim: honouring it would mean nothing is
    // ever downgraded and the filter below would never discard anything.
    const inferred = classifyImportance(event);
    const claimed = event.importance_source === 'adapter';
    const importance = claimed && atLeast(event.importance, inferred) ? event.importance : inferred;
    if (importance !== event.importance) reasons.push(`reclassified:${event.importance}->${importance}`);
    event = { ...event, importance, importance_source: claimed ? event.importance_source : 'engine' };

    const tokens = estimateTokens(JSON.stringify(event.payload));

    // R7 - ephemeral events with nothing derivable are dropped (PRD 17).
    if (importance === 'ephemeral') {
      return { action: 'discard', event, importance, reasons: [...reasons, 'ephemeral_no_residue'], tokens };
    }

    // R8 - semantic work only when meaning is at stake.
    if (needsSemantics(event)) {
      reasons.push('needs_semantics');
      return { action: 'persist_and_queue', event, importance, reasons, tokens };
    }

    reasons.push('deterministic_only');
    return { action: 'persist', event, importance, reasons, tokens };
  }

  private trimPayload(event: ContextEvent, limit: number, reasons: string[]): ContextEvent {
    const payload = { ...event.payload };
    let changed = false;
    for (const key of ['output', 'text', 'error'] as const) {
      const v = payload[key];
      if (typeof v !== 'string' || v.length <= limit) continue;
      // Keep both ends: the head has the command/context, the tail has the verdict.
      const head = v.slice(0, Math.floor(limit * 0.6));
      const tail = v.slice(-Math.floor(limit * 0.3));
      payload[key] = `${head}\n...[${v.length - head.length - tail.length} chars elided]...\n${tail}`;
      payload.truncated = true;
      payload.original_bytes = v.length;
      payload.original_hash = sha256(v);
      changed = true;
    }
    if (changed) reasons.push('payload_truncated');
    return changed ? { ...event, payload } : event;
  }
}

/**
 * PRD 24 / 25 - should a worker run now?
 *
 * `adaptive` scales the thresholds with session length so a six hour session does not pay
 * for a worker every forty events, while a short session still gets prompt maintenance.
 */
export interface TriggerInput {
  pendingEvents: number;
  pendingTokens: number;
  highestPendingImportance: Importance | null;
  secondsSinceLastWorker: number;
  totalEventsThisSession: number;
  compactionRequested: boolean;
}

export interface TriggerVerdict {
  fire: boolean;
  reason: string;
}

export function evaluateTriggers(config: Config, input: TriggerInput): TriggerVerdict {
  const t = config.triggers;
  if (input.pendingEvents === 0) return { fire: false, reason: 'no_pending_events' };

  if (input.compactionRequested) return { fire: true, reason: 'compaction_requested' };

  if (input.highestPendingImportance && atLeast(input.highestPendingImportance, t.importance_floor)) {
    return { fire: true, reason: `importance>=${t.importance_floor}` };
  }

  const scale = t.adaptive ? adaptiveScale(input.totalEventsThisSession) : 1;
  const eventLimit = Math.ceil(t.event_count * scale);
  const tokenLimit = Math.ceil(t.token_threshold * scale);

  if (input.pendingEvents >= eventLimit) {
    return { fire: true, reason: `event_count>=${eventLimit}` };
  }
  if (input.pendingTokens >= tokenLimit) {
    return { fire: true, reason: `pending_tokens>=${tokenLimit}` };
  }
  if (t.interval_seconds > 0 && input.secondsSinceLastWorker >= t.interval_seconds * scale) {
    return { fire: true, reason: `interval>=${Math.ceil(t.interval_seconds * scale)}s` };
  }
  return { fire: false, reason: 'below_thresholds' };
}

/** 1x for short sessions, growing to a 4x cap as the session gets long (PRD 25). */
export function adaptiveScale(totalEvents: number): number {
  if (totalEvents < 200) return 1;
  if (totalEvents < 1000) return 1.5;
  if (totalEvents < 3000) return 2.5;
  return 4;
}
