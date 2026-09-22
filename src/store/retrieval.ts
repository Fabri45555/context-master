import { importanceRank } from '../core/events.js';
import { isLive, type MemoryCategory, type MemoryItem } from '../core/state.js';
import type { ContextStore } from './store.js';
import { rowToItem } from './store.js';
import { reciprocalRankFusion, type EmbeddingIndex } from './embeddings.js';

/**
 * PRD 20 - targeted retrieval. Structured metadata plus keyword search is explicitly
 * enough for the MVP, and BM25 via FTS5 needs no embedding provider, which keeps the
 * local-only privacy default (PRD 37) intact.
 */

export interface SearchOptions {
  limit?: number;
  categories?: MemoryCategory[];
  /** Include items that are stale/superseded/archived. Off by default. */
  includeDead?: boolean;
  /**
   * PRD 56 - pull in the neighbours of the strongest hits. A constraint that governs a
   * decision is often the thing you needed, and its text may not match the query at all.
   */
  expandGraph?: boolean;
  /** How many direct hits get their neighbourhood walked. */
  expandFrom?: number;
  /** Minimum importance to return. */
  minImportance?: MemoryItem['importance'];
  now?: number;
  /**
   * Raise the keyword side of hybrid fusion when the query names something exact (a path, an
   * identifier, an id). On by default; the retrieval eval turns it off to measure what it buys.
   */
  adaptiveKeywordWeight?: boolean;
}

export interface ScoredItem {
  item: MemoryItem;
  score: number;
  /** Why it ranked where it did - surfaced by `contextd inspect`. */
  factors: { bm25: number; importance: number; recency: number; confidence: number };
  /** Set when the item was reached through the graph rather than matched directly. */
  via?: { kind: string; from: string; reason: string | null };
}

const IMPORTANCE_WEIGHT: Record<MemoryItem['importance'], number> = {
  critical: 2.2,
  high: 1.6,
  medium: 1.0,
  low: 0.6,
  ephemeral: 0.3,
};

/** Turn free text into a safe FTS5 MATCH expression: quoted terms OR-ed together. */
export function toMatchQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .slice(0, 24);
  if (terms.length === 0) return null;
  // Prefix-match each term so "auth" finds "authentication"; quote to neutralise operators.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'has',
  'have', 'not', 'but', 'you', 'your', 'our', 'their', 'its', 'can', 'will', 'would', 'should',
  'about', 'when', 'what', 'how', 'why', 'per', 'con', 'del', 'della', 'delle', 'dei', 'che',
  'non', 'una', 'uno', 'gli', 'gia', 'come', 'sono', 'gli', 'gl', 'gl',
]);

/**
 * Tokens that name one thing exactly, by kind. An embedding places `src/store/db.ts` near every
 * sentence about databases, and `d12` near nothing at all; the keyword index matches them
 * literally. So when a query carries one, the keyword ranking is the more trustworthy of the two.
 */
export type ExactKind = 'uuid' | 'path' | 'memory_id' | 'identifier' | 'version' | 'number' | 'flag';

const EXACT_PATTERNS: ReadonlyArray<readonly [ExactKind, RegExp]> = [
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // A slash between word characters, or a name with a short extension: `src/cli`, `db.ts`.
  // Two characters before the dot keeps "e.g" and "i.e" out.
  ['path', /[\w.-]+\/[\w.-]+|\b[\w-]{2,}\.[a-z][a-z0-9]{0,5}\b/i],
  // `mem_...` and the short ids workers assign (`d3`, `kw12`).
  ['memory_id', /\bmem_[a-z0-9_]+\b|\b[a-z]{1,3}\d{1,4}\b/],
  // camelCase, PascalCase with an inner capital, snake_case, SCREAMING_CASE.
  ['identifier', /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/],
  ['version', /\bv?\d+\.\d+(?:\.\d+)*\b/],
  // Three digits or more: a port, an error code, a line number. "3 retries" is prose.
  ['number', /\b\d{3,}\b/],
  ['flag', /(?:^|\s)--?[a-z][\w-]*/i],
];

/** Which exact-match kinds a query contains. Pure, so it is tested on its own. */
export function exactMatchKinds(query: string): ExactKind[] {
  return EXACT_PATTERNS.filter(([, re]) => re.test(query)).map(([kind]) => kind);
}

/** Kinds that name one item or one file: a semantic neighbour is almost never what was meant. */
const STRONG_KINDS: ReadonlySet<ExactKind> = new Set(['uuid', 'path', 'memory_id']);

/** Keyword weight for a query with a strong exact token, and with any other one. */
export const KEYWORD_WEIGHT_STRONG = 0.8;
export const KEYWORD_WEIGHT_EXACT = 0.7;
/** Never all the way to 1: the semantic list still breaks ties and finds what the words miss. */
export const KEYWORD_WEIGHT_MAX = 0.9;

/**
 * The keyword side's weight in reciprocal rank fusion, raised - never lowered - for queries that
 * name something exactly. Borrowed from headroom's adaptive alpha. A configured keyword weight of
 * 0 is a deliberate "semantic only" and is left alone.
 */
export function adaptiveKeywordWeight(query: string, base: number): number {
  if (base <= 0) return base;
  const kinds = exactMatchKinds(query);
  if (kinds.length === 0) return base;
  const target = kinds.some((k) => STRONG_KINDS.has(k)) ? KEYWORD_WEIGHT_STRONG : KEYWORD_WEIGHT_EXACT;
  return Math.max(base, Math.min(KEYWORD_WEIGHT_MAX, target));
}

export class RetrievalEngine {
  constructor(private store: ContextStore) {}

  /** Keyword + metadata hybrid search over L1. */
  search(query: string, opts: SearchOptions = {}): ScoredItem[] {
    const limit = opts.limit ?? 12;
    const now = opts.now ?? Date.now();
    const match = toMatchQuery(query);

    // The category filter goes into the SQL, not only after it: `memory_query` with a category
    // and no query text lists that category, and a post-filter over the top rows of every
    // category would return a partial list whenever other categories fill the window.
    const cats = opts.categories && opts.categories.length > 0 ? opts.categories : null;
    const catSql = cats ? ` AND m.category IN (${cats.map(() => '?').join(', ')})` : '';
    const rows = match
      ? (this.store.db
          .prepare(
            `SELECT m.*, bm25(memory_fts) AS bm25
             FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
             WHERE memory_fts MATCH ?${catSql}
             ORDER BY bm25 LIMIT ?`,
          )
          .all(match, ...(cats ?? []), limit * 6) as Array<Record<string, unknown>>)
      : (this.store.db
          .prepare(
            `SELECT m.*, 0 AS bm25 FROM memory_items m
             WHERE 1 = 1${catSql}
             ORDER BY CASE m.importance WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, m.updated_at DESC
             LIMIT ?`,
          )
          .all(...(cats ?? []), limit * 6) as Array<Record<string, unknown>>);

    const scored: ScoredItem[] = [];
    for (const r of rows) {
      const item = rowToItem(r);
      if (!opts.includeDead && !isLive(item, now)) continue;
      if (opts.categories && !opts.categories.includes(item.category)) continue;
      if (opts.minImportance && importanceRank(item.importance) < importanceRank(opts.minImportance)) {
        continue;
      }
      scored.push(this.score(item, Number(r.bm25 ?? 0), now));
    }

    scored.sort((a, b) => b.score - a.score);
    const direct = scored.slice(0, limit);
    if (opts.expandGraph === false) return direct;
    return this.expand(direct, limit, now);
  }

  /**
   * One hop out from the best hits. The hop's weight multiplies the source item's score, so
   * a neighbour can never outrank the hit that found it and a weak match cannot drag in a
   * whole subgraph.
   */
  private expand(direct: ScoredItem[], limit: number, now: number): ScoredItem[] {
    const seeds = direct.slice(0, Math.max(1, Math.min(direct.length, 5)));
    const byScore = new Map(seeds.map((h) => [h.item.id, h.score]));
    const found = this.store.neighbours([...byScore.keys()]);
    if (found.size === 0) return direct;

    const have = new Set(direct.map((h) => h.item.id));
    const extra: ScoredItem[] = [];
    for (const [id, { weight, via }] of found) {
      if (have.has(id)) continue;
      const item = this.store.getItem(id);
      if (!item || !isLive(item, now)) continue;
      const sourceId = via.from === id ? via.to : via.from;
      const base = byScore.get(sourceId) ?? 0;
      extra.push({
        item,
        score: base * weight,
        factors: { bm25: 0, importance: IMPORTANCE_WEIGHT[item.importance], recency: 0, confidence: item.confidence },
        via: { kind: via.kind, from: sourceId, reason: via.reason },
      });
    }

    return [...direct, ...extra].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private score(item: MemoryItem, bm25: number, now: number): ScoredItem {
    // FTS5 bm25() is negative, more negative meaning a better match.
    const relevance = bm25 === 0 ? 0.5 : Math.min(1, -bm25 / 10);
    const importance = IMPORTANCE_WEIGHT[item.importance];
    const stamp = Date.parse(item.last_validated_at ?? item.updated_at ?? item.created_at);
    const ageDays = Number.isFinite(stamp) ? (now - stamp) / 86_400_000 : 30;
    // Half-life of a week: recent facts win ties, old ones are not erased.
    const recency = Math.pow(0.5, ageDays / 7);
    const score = (relevance + 0.35 * recency) * importance * (0.5 + 0.5 * item.confidence);
    return {
      item,
      score,
      factors: { bm25: relevance, importance, recency, confidence: item.confidence },
    };
  }

  /**
   * Keyword + semantic hybrid, fused by reciprocal rank.
   *
   * Async because embedding the query requires a provider call. Callers on a latency budget
   * (the hook path) use `search` instead; nothing degrades if embeddings are off, because
   * the semantic list is simply empty and fusion reduces to the keyword order.
   */
  async searchHybrid(
    query: string,
    index: EmbeddingIndex,
    opts: SearchOptions = {},
  ): Promise<ScoredItem[]> {
    const limit = opts.limit ?? 12;
    const keyword = this.search(query, { ...opts, limit: limit * 2, expandGraph: false });
    if (!index.enabled) return this.expand(keyword.slice(0, limit), limit, opts.now ?? Date.now());

    const semantic = await index.rank(query, limit * 2);
    if (semantic.length === 0) {
      return this.expand(keyword.slice(0, limit), limit, opts.now ?? Date.now());
    }

    const semanticWeight = index.weight;
    const keywordWeight =
      opts.adaptiveKeywordWeight === false ? 1 - semanticWeight : adaptiveKeywordWeight(query, 1 - semanticWeight);
    const fused = reciprocalRankFusion([
      { ids: keyword.map((h) => h.item.id), weight: keywordWeight },
      { ids: semantic.map((h) => h.id), weight: 1 - keywordWeight },
    ]);

    const byId = new Map(keyword.map((h) => [h.item.id, h]));
    const merged: ScoredItem[] = [];
    for (const [id, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
      const existing = byId.get(id);
      if (existing) {
        merged.push({ ...existing, score });
        continue;
      }
      // Semantic-only hit: it never matched a keyword, which is the point.
      const item = this.store.getItem(id);
      if (!item || (!opts.includeDead && !isLive(item, opts.now ?? Date.now()))) continue;
      if (opts.categories && !opts.categories.includes(item.category)) continue;
      merged.push({
        item,
        score,
        factors: { bm25: 0, importance: IMPORTANCE_WEIGHT[item.importance], recency: 0, confidence: item.confidence },
      });
      if (merged.length >= limit * 2) break;
    }

    return this.expand(merged.slice(0, limit), limit, opts.now ?? Date.now());
  }

  /** Everything that must always be present regardless of the query (PRD 21 bootstrap). */
  alwaysOn(now = Date.now()): MemoryItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE status = 'active' AND (importance = 'critical' OR (source = 'user' AND importance = 'high'))
         ORDER BY created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToItem).filter((i) => isLive(i, now));
  }

  byCategory(category: MemoryCategory, limit = 50, now = Date.now()): MemoryItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM memory_items WHERE category = ? AND status = 'active'
         ORDER BY CASE importance WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                  WHEN 'low' THEN 3 ELSE 4 END, updated_at DESC LIMIT ?`,
      )
      .all(category, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToItem).filter((i) => isLive(i, now));
  }
}
