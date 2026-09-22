/**
 * Marker-delimited blocks in files contextd shares with a person or another tool.
 *
 * Everything contextd writes into a file it does not own (an agent's config, an instruction file)
 * sits between a start and an end marker, so it can be replaced and removed without reading or
 * touching a single byte outside them. Pure string functions; the callers do the I/O.
 */

export interface Markers {
  start: string;
  end: string;
}

interface Span {
  from: number;
  to: number;
}

function find(content: string, m: Markers): Span | null {
  const from = content.indexOf(m.start);
  if (from === -1) return null;
  const endAt = content.indexOf(m.end, from + m.start.length);
  if (endAt === -1) return null;
  return { from, to: endAt + m.end.length };
}

/** The text between the markers, or null when the block is absent (or unterminated). */
export function extractBlock(content: string, m: Markers): string | null {
  const span = find(content, m);
  if (!span) return null;
  return content.slice(span.from + m.start.length, span.to - m.end.length);
}

export function hasBlock(content: string, m: Markers): boolean {
  return find(content, m) != null;
}

/**
 * Put `inner` between the markers: in place when the block exists, appended otherwise.
 * An unterminated start marker is treated as absent - guessing where it was meant to end could
 * swallow the rest of someone's file.
 */
export function upsertBlock(content: string, m: Markers, inner: string): string {
  const block = `${m.start}\n${inner.replace(/\n+$/, '')}\n${m.end}`;
  const span = find(content, m);
  if (span) return content.slice(0, span.from) + block + content.slice(span.to);
  const body = content.replace(/\n+$/, '');
  return body.length > 0 ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** Remove the block and the blank line that separated it; null when there was none. */
export function removeBlock(content: string, m: Markers): string | null {
  const span = find(content, m);
  if (!span) return null;
  const before = content.slice(0, span.from).replace(/\n+$/, '');
  const after = content.slice(span.to).replace(/^\n+/, '');
  if (before && after) return `${before}\n\n${after}`;
  const rest = before || after;
  return rest ? `${rest.replace(/\n+$/, '')}\n` : '';
}
