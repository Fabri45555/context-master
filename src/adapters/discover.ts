import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptCandidate } from './types.js';

/** Shared filesystem helpers for adapters that locate their own transcripts. */

export function* walkJsonl(dir: string, depth: number): Generator<string> {
  if (depth < 0 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(p, depth - 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield p;
  }
}

export function candidatesIn(dir: string, depth = 0): TranscriptCandidate[] {
  const out: TranscriptCandidate[] = [];
  for (const path of walkJsonl(dir, depth)) {
    try {
      out.push({ path, mtime: statSync(path).mtimeMs, sessionId: sessionIdFromFilename(path) });
    } catch {
      // A file that vanished between listing and stat is simply not a candidate.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Most agents name the transcript after the session id. */
export function sessionIdFromFilename(path: string): string | undefined {
  const base = path.split('/').pop();
  if (!base) return undefined;
  const stem = base.replace(/\.jsonl$/, '');
  const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid?.[0] ?? stem;
}

/**
 * Read the first line of a JSONL file, for transcripts that carry metadata up front.
 * Reads a bounded prefix rather than the file: transcripts reach hundreds of megabytes.
 */
export function firstRecord(path: string, maxBytes = 65_536): unknown | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return JSON.parse(nl === -1 ? text : text.slice(0, nl)) as unknown;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}
