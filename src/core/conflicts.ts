import { importanceRank } from './events.js';
import { isLive, type MemoryCategory, type MemoryItem } from './state.js';

/**
 * PRD 44 - contradiction detection.
 *
 * The PRD describes what to do once a contradiction is known but never says how one is
 * noticed. Nothing in the pipeline was looking, so two incompatible decisions could sit
 * side by side indefinitely, both "active", and retrieval would serve both.
 *
 * Detection is deterministic and cheap: contradictions are found here for free, and a model
 * is spent only on deciding which side wins and why.
 */

/** Categories where two similar statements genuinely conflict rather than merely overlap. */
const CONFLICT_PRONE: ReadonlySet<MemoryCategory> = new Set([
  'decisions',
  'constraints',
  'requirements',
  'architecture',
  'conventions',
  'goals',
]);

/**
 * Category pairs worth comparing across.
 *
 * Comparing only within a category missed the case that matters most: a user constraint in
 * `constraints` contradicted by an agent decision in `decisions`. That is exactly the
 * situation PRD 18 and K2 exist to protect, so it cannot be the one case we ignore.
 */
const COMPARABLE: ReadonlyArray<readonly [MemoryCategory, MemoryCategory]> = [
  ['constraints', 'decisions'],
  ['constraints', 'architecture'],
  ['constraints', 'conventions'],
  ['requirements', 'decisions'],
  ['requirements', 'architecture'],
  ['goals', 'decisions'],
  ['architecture', 'decisions'],
];

export function comparable(a: MemoryCategory, b: MemoryCategory): boolean {
  if (a === b) return true;
  return COMPARABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** Words that flip a statement's polarity, in the two languages this project uses. */
const NEGATIONS = [
  /\bnot\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /\bdon'?t\b/i,
  /\bdoes ?n'?t\b/i,
  /\bavoid\b/i,
  /\bstop\b/i,
  /\bwithout\b/i,
  /\bnon\b/i,
  /\bmai\b/i,
  /\bsenza\b/i,
  /\bevitare\b/i,
];

export interface Conflict {
  a: MemoryItem;
  b: MemoryItem;
  /** 0..1 textual similarity. */
  similarity: number;
  /** Why these two were paired, for the worker prompt and for `contextd conflicts`. */
  reason: 'polarity' | 'same_subject' | 'similar_statement';
  /** The item that looks newer, as a hint only - the worker decides. */
  newer: string;
}

export interface DetectOptions {
  /** Minimum trigram similarity for two statements to count as restating each other. */
  threshold?: number;
  /** Lower floor applied when two items share distinctive subject words. */
  subjectFloor?: number;
  /** Ignore items below this importance; low-value overlap is not worth a model call. */
  minImportance?: MemoryItem['importance'];
  maxPairs?: number;
  now?: number;
}

export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trigrams(text: string): Set<string> {
  const s = ` ${normalizeForCompare(text)} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

/** Jaccard similarity over character trigrams: no dependency, robust to word order. */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export function isNegated(text: string): boolean {
  return NEGATIONS.some((p) => p.test(text));
}

/**
 * Content words shared by two statements, used to require that a conflict is actually about
 * the same thing rather than two unrelated sentences of the same shape.
 */
function contentWords(text: string): Set<string> {
  return new Set(
    normalizeForCompare(text)
      .split(' ')
      .filter((w) => w.length >= 4 && !SUBJECT_STOPWORDS.has(w)),
  );
}

/**
 * Words that two statements can share without being about the same subject. Without this,
 * "must always" in both halves of two unrelated rules counts as agreement on a topic.
 */
const SUBJECT_STOPWORDS = new Set([
  'must', 'should', 'always', 'never', 'need', 'needs', 'used', 'using', 'with', 'from',
  'into', 'this', 'that', 'them', 'they', 'when', 'where', 'while', 'only', 'also', 'more',
  'than', 'then', 'each', 'every', 'have', 'been', 'will', 'would', 'shall', 'does',
  'deve', 'devono', 'sempre', 'anche', 'come', 'quando', 'tutti', 'tutte', 'essere',
]);

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

/**
 * Trigram similarity at which two statements restate each other (`similar_statement`). Shared
 * with the write-time hint in [similar.ts](similar.ts), so what `memory_remember` flags and what
 * `memory_conflicts` reports agree.
 */
export const RESTATEMENT_THRESHOLD = 0.42;

export function detectConflicts(items: MemoryItem[], opts: DetectOptions = {}): Conflict[] {
  const threshold = opts.threshold ?? RESTATEMENT_THRESHOLD;
  const subjectFloor = opts.subjectFloor ?? 0.2;
  const minImportance = opts.minImportance ?? 'medium';
  const now = opts.now ?? Date.now();
  const maxPairs = opts.maxPairs ?? 20;

  const candidates = items.filter(
    (i) =>
      i.status === 'active' &&
      isLive(i, now) &&
      CONFLICT_PRONE.has(i.category) &&
      importanceRank(i.importance) >= importanceRank(minImportance),
  );

  // Already-resolved relationships are not conflicts; re-flagging them would make the
  // reconciliation worker loop forever on the same pair.
  const linked = new Set<string>();
  for (const i of candidates) {
    for (const s of i.supersedes) linked.add(pairKey(i.id, s));
    if (i.superseded_by) linked.add(pairKey(i.id, i.superseded_by));
  }

  const conflicts: Conflict[] = [];
  {
    const group = candidates;
    for (let x = 0; x < group.length; x += 1) {
      for (let y = x + 1; y < group.length; y += 1) {
        const a = group[x]!;
        const b = group[y]!;
        if (!comparable(a.category, b.category)) continue;
        if (linked.has(pairKey(a.id, b.id))) continue;

        const sim = similarity(a.text, b.text);
        const polarityDiffers = isNegated(a.text) !== isNegated(b.text);

        // A polarity flip is the strongest signal, but only when both statements are about
        // the same subject - otherwise every prohibition conflicts with every permission.
        const shared = overlapCount(contentWords(a.text), contentWords(b.text));
        const polarityConflict = polarityDiffers && shared >= 2 && sim >= threshold * 0.5;

        // Two statements about the same subject can contradict without resembling each
        // other: "tokens live in Redis" against "tokens live in PostgreSQL" share little
        // text. Deciding whether they really conflict is the worker's job; ours is to
        // notice they are about the same thing. Only below the restatement threshold, or
        // this label would swallow the near-duplicate case that `similar_statement` names.
        const sameSubject =
          !polarityConflict && shared >= 2 && sim >= subjectFloor && sim < threshold;

        if (!polarityConflict && !sameSubject && sim < threshold) continue;

        conflicts.push({
          a,
          b,
          similarity: sim,
          reason: polarityConflict ? 'polarity' : sameSubject ? 'same_subject' : 'similar_statement',
          newer: newerOf(a, b),
        });
      }
    }
  }

  // Strongest signal first, then the most similar pairs within each signal.
  const rank = { polarity: 0, same_subject: 1, similar_statement: 2 } as const;
  conflicts.sort((p, q) => {
    if (rank[p.reason] !== rank[q.reason]) return rank[p.reason] - rank[q.reason];
    return q.similarity - p.similarity;
  });
  return conflicts.slice(0, maxPairs);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function newerOf(a: MemoryItem, b: MemoryItem): string {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return b.id;
  return ta >= tb ? a.id : b.id;
}
