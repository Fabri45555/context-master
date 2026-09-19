import { createHash, randomUUID } from 'node:crypto';

/** Sortable, greppable id: prefix + base36 timestamp + random suffix. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}_${ts}${rand}`;
}

/**
 * Stable content hash used for idempotency. Hooks and transcript tails both emit the
 * same logical event, so ingestion must be able to recognise a repeat.
 */
export function contentHash(parts: unknown[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(typeof p === 'string' ? p : JSON.stringify(p ?? null));
    h.update('\x1f');
  }
  return h.digest('hex').slice(0, 32);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
