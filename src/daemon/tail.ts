import { createReadStream, existsSync, statSync } from 'node:fs';
import { once } from 'node:events';

/**
 * Byte-offset JSONL tailing.
 *
 * Transcripts are append-only, so a byte cursor is enough and avoids re-reading a file
 * that can reach hundreds of megabytes. A file that shrank was rotated or replaced, so the
 * cursor resets rather than reading from the middle of a record.
 */

export interface TailResult {
  records: unknown[];
  offset: number;
  /** True when the file was rotated and reading restarted from zero. */
  restarted: boolean;
  /** Lines that failed to parse - a partial final line is the usual cause. */
  skipped: number;
}

export async function tailJsonl(path: string, fromOffset: number): Promise<TailResult> {
  if (!existsSync(path)) return { records: [], offset: fromOffset, restarted: false, skipped: 0 };

  const size = statSync(path).size;
  let start = fromOffset;
  let restarted = false;
  if (size < fromOffset) {
    start = 0;
    restarted = true;
  }
  if (size === start) return { records: [], offset: start, restarted, skipped: 0 };

  const stream = createReadStream(path, { start, end: size - 1, encoding: 'utf8' });
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
  });
  await once(stream, 'end');

  const records: unknown[] = [];
  let skipped = 0;
  let consumed = 0;

  // Only advance the cursor past complete lines; a half-written final line is left for the
  // next pass, which is what makes tailing a live transcript safe.
  let index: number;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    consumed += Buffer.byteLength(line, 'utf8') + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }

  return { records, offset: start + consumed, restarted, skipped };
}

export function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}
