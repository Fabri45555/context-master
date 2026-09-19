import { z } from 'zod';
import { contentHash, newId } from './ids.js';

/**
 * PRD 11 - the normalized, provider-neutral event vocabulary. Adapters translate into
 * this; the core never learns what a "Bash tool" or a "codex rollout" is.
 */
export const EVENT_TYPES = [
  'SESSION_STARTED',
  'USER_MESSAGE',
  'ASSISTANT_MESSAGE',
  'TOOL_CALL',
  'TOOL_RESULT',
  'FILE_CHANGED',
  'COMMAND_EXECUTED',
  'ERROR_DETECTED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'DECISION_DETECTED',
  'REQUIREMENT_CHANGED',
  'CONSTRAINT_CHANGED',
  'ARCHITECTURE_CHANGED',
  'COMPACTION_REQUESTED',
  'SESSION_ENDED',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

/** PRD 17 - information value model, ordered least to most valuable. */
export const IMPORTANCE_LEVELS = ['ephemeral', 'low', 'medium', 'high', 'critical'] as const;
export const ImportanceSchema = z.enum(IMPORTANCE_LEVELS);
export type Importance = z.infer<typeof ImportanceSchema>;

export function importanceRank(i: Importance): number {
  return IMPORTANCE_LEVELS.indexOf(i);
}

export function atLeast(i: Importance, floor: Importance): boolean {
  return importanceRank(i) >= importanceRank(floor);
}

export const EventPayloadSchema = z
  .object({
    text: z.string().optional(),
    tool: z.string().optional(),
    tool_use_id: z.string().optional(),
    args: z.unknown().optional(),
    output: z.string().optional(),
    exit_code: z.number().int().optional(),
    command: z.string().optional(),
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    error: z.string().optional(),
    /** Set by the deterministic core when a large payload was trimmed (PRD 51). */
    truncated: z.boolean().optional(),
    original_bytes: z.number().int().optional(),
    original_hash: z.string().optional(),
    /** Redaction bookkeeping (PRD 36) - how many secrets were masked. */
    redactions: z.number().int().optional(),
    /** Provider token usage when the adapter can see it - feeds baseline metrics (PRD 28). */
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export type EventPayload = z.infer<typeof EventPayloadSchema>;

export const EventSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  timestamp: z.string(),
  type: EventTypeSchema,
  /** Which adapter produced it: claude, codex, generic, ... */
  source: z.string(),
  importance: ImportanceSchema,
  /**
   * Whether `importance` is a deliberate claim by the adapter or just the default.
   *
   * The deterministic classifier may only be overridden by something an adapter actually
   * knows; treating the fallback as a claim would mean nothing is ever downgraded, and the
   * deterministic filter would silently stop discarding anything.
   */
  importance_source: z.enum(['adapter', 'default', 'engine']).default('default'),
  payload: EventPayloadSchema,
  /** Idempotency key. Same hash in the same session means one event, not two. */
  dedupe_hash: z.string(),
  /** Adapter-assigned ordering hint (transcript line number, codex ordinal). */
  ordinal: z.number().int().nullable().optional(),
});

export type ContextEvent = z.infer<typeof EventSchema>;

export type EventInput = Omit<
  ContextEvent,
  'id' | 'dedupe_hash' | 'importance' | 'importance_source'
> & {
  importance?: Importance;
  dedupe_hash?: string;
};

/** Build a complete event from adapter input, filling id/hash and defaulting importance. */
export function makeEvent(input: EventInput): ContextEvent {
  const dedupe_hash =
    input.dedupe_hash ??
    contentHash([
      input.session_id,
      input.type,
      input.source,
      input.ordinal ?? null,
      input.payload,
    ]);
  return EventSchema.parse({
    id: newId('evt'),
    ...input,
    payload: withoutNulls(input.payload),
    importance: input.importance ?? 'medium',
    importance_source: input.importance ? 'adapter' : 'default',
    dedupe_hash,
  });
}

/**
 * Adapters read optional fields with helpers that return `null` for "absent", and the payload
 * schema's optional fields accept `undefined`, not `null`. The mismatch made every Claude `Stop`
 * hook throw (`text: null`) for as long as the hook was installed - silently, because a hook
 * must never fail the agent. Absent is absent, however it was spelled.
 */
function withoutNulls<T extends Record<string, unknown>>(payload: T): T {
  if (!payload || typeof payload !== 'object') return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (v !== null) out[k] = v;
  return out as T;
}

/** Rough token estimate. Deliberately cheap: no tokenizer dependency, ~4 chars/token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function eventText(e: ContextEvent): string {
  const p = e.payload;
  return [p.text, p.command, p.output, p.error, p.path, p.paths?.join(' ')]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join('\n');
}
