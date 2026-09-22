import { comparable, RESTATEMENT_THRESHOLD, similarity } from './conflicts.js';
import { isProtected } from './patch.js';
import { isLive, type MemoryItem } from './state.js';

/**
 * The write-time "did you mean to replace this?" hint, borrowed from headroom's memory tools.
 *
 * A verbatim re-add is already a no-op (invariant 35), but a paraphrase is not: "Use SQLite for
 * persistence" recorded twice in different words is two items that both reach every bootstrap,
 * and a changed decision recorded without `supersedes` leaves the old one live beside it. The
 * writer is the one party that knows which it meant, and it is still in the conversation - so the
 * response names the near neighbours and lets it decide. Nothing here merges or retires anything
 * (invariant 12): the hint is text in a tool response, never a patch.
 *
 * Deterministic and model-free: trigram similarity always, cosine over vectors already stored
 * when the embedding layer is on. Never computed on the hook path (invariant 17) - only
 * `memory_remember` and `contextd remember` ask for it.
 */

/**
 * Cosine at which two stored embeddings count as the same statement. Deliberately high: the
 * cosine scan elsewhere uses a per-query relative cut because unrelated text sits at ~0.1 under
 * one model and ~0.45 under another, but a *restatement* scores above 0.9 under all the common
 * ones, and a false "similar to" costs the writer a detour on every write.
 */
export const SIMILAR_COSINE_THRESHOLD = 0.9;

/** At most this many neighbours are named; past three, the writer should query instead. */
export const SIMILAR_MAX_HITS = 3;

export interface SimilarHit {
  item: MemoryItem;
  /** 0..1, for the tool response only - never written to memory (invariant 28). */
  similarity: number;
  by: 'text' | 'embedding';
}

export interface FindSimilarOptions {
  /** Cosine of the target against other items, by id, when embeddings are available. */
  cosine?: ReadonlyMap<string, number>;
  textThreshold?: number;
  cosineThreshold?: number;
  max?: number;
  now?: number;
}

/**
 * Live items in the target's category - or a category it can contradict, the pairs
 * `memory_conflicts` compares - that restate it closely enough to be a duplicate or the thing it
 * replaces. Strongest first.
 */
export function findSimilar(target: MemoryItem, items: MemoryItem[], opts: FindSimilarOptions = {}): SimilarHit[] {
  const textThreshold = opts.textThreshold ?? RESTATEMENT_THRESHOLD;
  const cosineThreshold = opts.cosineThreshold ?? SIMILAR_COSINE_THRESHOLD;
  const now = opts.now ?? Date.now();
  const replaced = new Set(target.supersedes);

  const hits: SimilarHit[] = [];
  for (const other of items) {
    if (other.id === target.id || replaced.has(other.id)) continue;
    if (!isLive(other, now) || !comparable(target.category, other.category)) continue;
    const text = similarity(target.text, other.text);
    const cos = opts.cosine?.get(other.id);
    if (text >= textThreshold) {
      hits.push({ item: other, similarity: text, by: 'text' });
    } else if (cos != null && cos >= cosineThreshold) {
      hits.push({ item: other, similarity: cos, by: 'embedding' });
    }
  }
  return hits
    .sort((a, b) => {
      // Same category first: that is the duplicate case; across categories it is the conflict case.
      const sa = a.item.category === target.category ? 0 : 1;
      const sb = b.item.category === target.category ? 0 : 1;
      return sa !== sb ? sa - sb : b.similarity - a.similarity;
    })
    .slice(0, opts.max ?? SIMILAR_MAX_HITS);
}

const QUOTE_CHARS = 160;

/**
 * The hint appended to a successful write. `surface` picks the vocabulary: an agent over MCP
 * retires with `memory_retire`, a person at the CLI with `contextd forget`.
 *
 * The advice has to be something that works. A user-critical item refuses every retirement path
 * (invariants 6 and 12), so for one of those the hint says so instead of suggesting a call that
 * would be rejected.
 */
export function formatSimilarHint(written: MemoryItem, hits: SimilarHit[], surface: 'mcp' | 'cli'): string {
  if (hits.length === 0) return '';
  const newId = written.id;
  const lines: string[] = [];
  for (const h of hits) {
    const quoted = h.item.text.length > QUOTE_CHARS ? `${h.item.text.slice(0, QUOTE_CHARS).trimEnd()}…` : h.item.text;
    const measure = `${h.by === 'text' ? 'text' : 'embedding'} similarity ${h.similarity.toFixed(2)}`;
    lines.push(`Similar to ${h.item.id} (${h.item.category}, ${h.item.source}; ${measure}): "${quoted}"`);
  }
  const retirable = hits.filter((h) => !isProtected(h.item)).map((h) => h.item.id);
  const fixed = hits.filter((h) => isProtected(h.item)).map((h) => h.item.id);
  const retire = (ids: string[], reason: string) =>
    surface === 'mcp'
      ? `memory_retire [${ids.join(', ')}] with reason "${reason}"`
      : `contextd forget ${ids.join(' ')} --reason "${reason}"`;
  // Retiring is the advice, not re-recording with `supersedes`: the new item is already written,
  // so a second write would leave a third copy.
  const advice: string[] = [];
  if (retirable.length > 0) {
    advice.push(`If ${newId} replaces ${retirable.length === 1 ? retirable[0] : `one of ${retirable.join(', ')}`}: ${retire(retirable, `replaced by ${newId}`)}.`);
  }
  if (fixed.length > 0) {
    advice.push(`${fixed.join(', ')} ${fixed.length === 1 ? 'is' : 'are'} user-critical and cannot be retired by an agent; if ${newId} contradicts ${fixed.length === 1 ? 'it' : 'them'}, raise it with the user.`);
  }
  if (isProtected(written)) {
    advice.push(`${newId} is user-critical too; only the user can retire a duplicate, with \`contextd forget ${newId} --protected\` at a terminal.`);
  } else {
    advice.push(`If ${newId} only repeats it: ${retire([newId], 'duplicate')}.`);
  }
  lines.push(`${advice.join(' ')} Nothing was merged or retired.`);
  return lines.join('\n');
}
