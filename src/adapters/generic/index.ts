import { EventSchema, EventTypeSchema, ImportanceSchema, makeEvent } from '../../core/events.js';
import { contentHash } from '../../core/ids.js';
import type { Adapter, AdapterContext, AdapterSurface, TranslateResult } from '../types.js';

/**
 * PRD 23 - the generic protocol.
 *
 * Accepts records that are already in the normalized shape, so any agent can integrate by
 * emitting JSON lines to `contextd ingest` without a bespoke adapter being written first.
 */
export class GenericAdapter implements Adapter {
  readonly name = 'generic';
  readonly agent = 'any agent emitting the normalized protocol';

  readonly surfaces: readonly AdapterSurface[] = [
    {
      kind: 'stdin',
      preferred: true,
      // There is nothing to install: the agent chooses to pipe events to us.
      installable: false,
      description: 'Normalized protocol records piped to `contextd ingest`.',
    },
  ];

  translate(raw: unknown, ctx: AdapterContext): TranslateResult {
    if (!raw || typeof raw !== 'object') return { events: [] };
    const rec = raw as Record<string, unknown>;

    // Already a complete event: accept as-is so replay and export round-trip.
    const complete = EventSchema.safeParse(rec);
    if (complete.success) return { events: [complete.data] };

    const type = EventTypeSchema.safeParse(rec.type);
    if (!type.success) return { events: [] };

    const importance = ImportanceSchema.safeParse(rec.importance);
    const sessionId = typeof rec.session_id === 'string' ? rec.session_id : ctx.sessionId;
    const payload = (rec.payload ?? {}) as Record<string, unknown>;

    return {
      events: [
        makeEvent({
          session_id: sessionId,
          source: typeof rec.source === 'string' ? rec.source : this.name,
          timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : new Date().toISOString(),
          type: type.data,
          payload,
          ordinal: typeof rec.ordinal === 'number' ? rec.ordinal : (ctx.ordinal ?? null),
          ...(importance.success ? { importance: importance.data } : {}),
          dedupe_hash:
            typeof rec.dedupe_hash === 'string'
              ? rec.dedupe_hash
              : contentHash(['generic', sessionId, type.data, ctx.ordinal ?? null, payload]),
        }),
      ],
      session: { id: sessionId, cwd: ctx.cwd ?? null, agent: 'generic' },
    };
  }
}

export const genericAdapter = new GenericAdapter();
