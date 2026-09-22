import { EmbeddingConfigSchema, type EmbeddingConfig } from '../core/config.js';
import type { MemoryCategory } from '../core/state.js';
import { EmbeddingIndex, type EmbeddingProvider } from '../store/embeddings.js';
import { openDb } from '../store/db.js';
import { RetrievalEngine } from '../store/retrieval.js';
import { ContextStore } from '../store/store.js';

/**
 * Retrieval quality, measured against a golden set - borrowed from headroom's memory evals.
 *
 * `contextd bench` measures what context costs; nothing measured whether the right items come
 * back. This does, on a fixed fixture in an in-memory store, so the numbers move only when
 * retrieval changes. They are printed and asserted in tests, never stored (invariant 28).
 *
 * The default embedder is a deterministic stand-in (`ConceptEmbeddings`): it maps words onto a
 * handful of concept axes, which is the one property of a real model the fixture exercises -
 * a paraphrase lands near what it paraphrases - plus a hashed bag of words for texture. It is
 * also wrong in the way real models are wrong: `src/store/db.ts` looks like "database", which is
 * what the adaptive keyword weight exists to overrule.
 */

export interface GoldenItem {
  id: string;
  category: MemoryCategory;
  text: string;
  reason?: string;
}

export interface GoldenQuery {
  query: string;
  /** Items a correct retrieval returns; recall counts each, MRR the first found. */
  expected: string[];
  /** What the query exercises, for reading a per-query breakdown. */
  kind: 'keyword' | 'paraphrase' | 'exact';
}

export const GOLDEN_ITEMS: readonly GoldenItem[] = [
  { id: 'c_local', category: 'constraints', text: 'Embeddings stay local by default; memory text never goes to a remote provider without opt-in' },
  { id: 'c_nonet', category: 'constraints', text: 'Tests must never hit the network or a real model' },
  { id: 'c_secrets', category: 'constraints', text: 'Redact secrets at ingest, including values whose key names a secret' },
  { id: 'c_hooklat', category: 'constraints', text: 'The hook path must answer within 250ms' },
  { id: 'c_node', category: 'constraints', text: 'Target Node 22 or newer with ESM modules' },
  { id: 'd_sqlite', category: 'decisions', text: 'Use SQLite with WAL journaling as the only persistence layer', reason: 'one file, no server to run' },
  { id: 'd_rrf', category: 'decisions', text: 'Fuse keyword and semantic rankings with reciprocal rank fusion', reason: 'BM25 and cosine scores are not on comparable scales' },
  { id: 'd_fts', category: 'decisions', text: 'Keyword retrieval uses FTS5 BM25 over memory items' },
  { id: 'd_patchlog', category: 'decisions', text: 'The patch log is the source of truth; memory items are a materialization of it' },
  { id: 'd_mcp', category: 'decisions', text: 'Serve context by pull over an MCP server rather than rewriting the prompt' },
  { id: 'd_zod', category: 'decisions', text: 'Validate every boundary with zod schemas' },
  { id: 'd_single', category: 'decisions', text: 'Workers are single calls: one prompt, one patch, at most one repair retry' },
  { id: 'd_clip', category: 'decisions', text: 'The bootstrap clips any item longer than 240 characters' },
  { id: 'a_layers', category: 'architecture', text: 'Memory has three levels: working memory, memory items, raw events' },
  { id: 'a_daemon', category: 'architecture', text: 'The ContextManager facade owns ingest, retrieval and maintenance' },
  { id: 'a_graph', category: 'architecture', text: 'Retrieval walks one hop of typed graph relations from its best hits' },
  { id: 'v_imports', category: 'conventions', text: 'Relative imports carry the .js extension' },
  { id: 'v_comments', category: 'conventions', text: 'Comments explain why, never restate the code' },
  { id: 'f_db', category: 'important_files', text: 'src/store/db.ts - SQLite schema, FTS5 tables and migrations' },
  { id: 'f_retrieval', category: 'important_files', text: 'src/store/retrieval.ts - keyword search, hybrid fusion and scoring' },
  { id: 'f_builder', category: 'important_files', text: 'src/retrieval/context-builder.ts - packs the bootstrap and query context under a token budget' },
  { id: 'f_server', category: 'important_files', text: 'src/mcp/server.ts - MCP tools such as memory_query and memory_remember' },
  { id: 'f_cli', category: 'important_files', text: 'src/cli/index.ts - the contextd command line' },
  { id: 'f_redact', category: 'important_files', text: 'src/core/redact.ts - secret redaction applied at ingest' },
  { id: 'k_ollama', category: 'known_issues', text: 'When the local embedding model is missing, semantic search silently falls back to keywords' },
  { id: 'k_usage', category: 'known_issues', text: 'Claude hook payloads carry no token usage, so occupancy is read from the transcript' },
  { id: 'q_vector', category: 'open_questions', text: 'Is a vector database worth it once memory exceeds ten thousand items?' },
  { id: 'x_stop', category: 'discoveries', text: 'The Stop hook fires at the end of every turn, not at the end of a task' },
  { id: 'x_dup', category: 'discoveries', text: 'A pasted memory listing was re-extracted into seven duplicate items' },
  { id: 'g_reduce', category: 'goals', text: 'Cut the tokens an agent re-reads each session by more than seventy percent' },
  { id: 'g_resume', category: 'goals', text: 'A fresh agent must resume work from the repository and memory alone' },
  { id: 'w_hybrid', category: 'completed_work', text: 'Hybrid retrieval shipped behind the embeddings flag' },
];

export const GOLDEN_QUERIES: readonly GoldenQuery[] = [
  { query: 'sqlite persistence', expected: ['d_sqlite'], kind: 'keyword' },
  { query: 'reciprocal rank fusion', expected: ['d_rrf'], kind: 'keyword' },
  { query: 'redact secrets', expected: ['c_secrets', 'f_redact'], kind: 'keyword' },
  { query: 'patch log source of truth', expected: ['d_patchlog'], kind: 'keyword' },
  { query: 'stop hook end of turn', expected: ['x_stop'], kind: 'keyword' },
  { query: 'where is data stored on disk', expected: ['d_sqlite'], kind: 'paraphrase' },
  { query: 'how do we combine lexical and vector search', expected: ['d_rrf'], kind: 'paraphrase' },
  { query: 'keep api keys and passwords out of memory', expected: ['c_secrets', 'f_redact'], kind: 'paraphrase' },
  { query: 'unit tests should run offline', expected: ['c_nonet'], kind: 'paraphrase' },
  { query: 'why does the session summary truncate long entries', expected: ['d_clip'], kind: 'paraphrase' },
  { query: 'llm extraction jobs retry policy', expected: ['d_single'], kind: 'paraphrase' },
  { query: 'new agent picking up where the last one left off', expected: ['g_resume'], kind: 'paraphrase' },
  { query: 'shrink what each session costs', expected: ['g_reduce'], kind: 'paraphrase' },
  { query: 'what happens when ollama is not installed', expected: ['k_ollama'], kind: 'paraphrase' },
  { query: 'avoid storing the same fact twice', expected: ['x_dup'], kind: 'paraphrase' },
  { query: 'src/store/db.ts', expected: ['f_db'], kind: 'exact' },
  { query: 'context-builder.ts budget', expected: ['f_builder'], kind: 'exact' },
  { query: 'memory_remember', expected: ['f_server'], kind: 'exact' },
  { query: 'ContextManager', expected: ['a_daemon'], kind: 'exact' },
  { query: 'src/core/redact.ts', expected: ['f_redact'], kind: 'exact' },
  { query: 'hook budget 250ms', expected: ['c_hooklat'], kind: 'exact' },
  { query: 'Node 22 ESM', expected: ['c_node'], kind: 'exact' },
  // The stand-in reads `db.ts` as "database" and prefers the FTS decision; the path names the file.
  { query: 'fts5 bm25 in db.ts', expected: ['f_db'], kind: 'exact' },
  // Kept although every mode ranks it second: a golden set of only wins measures nothing.
  { query: 'db.ts wal journaling', expected: ['f_db'], kind: 'exact' },
];

/** Concept axes: words on one axis are synonyms to the stand-in model. */
const CONCEPTS: ReadonlyArray<readonly string[]> = [
  ['sqlite', 'database', 'db', 'persistence', 'persist', 'stored', 'storage', 'disk', 'wal', 'journaling'],
  ['search', 'retrieval', 'keyword', 'keywords', 'lexical', 'bm25', 'fts5', 'vector', 'semantic', 'cosine', 'rankings'],
  ['fuse', 'fusion', 'combine', 'merge', 'reciprocal', 'hybrid'],
  ['secret', 'secrets', 'password', 'passwords', 'credential', 'credentials', 'keys', 'redact', 'redaction'],
  ['network', 'offline', 'remote', 'internet'],
  ['test', 'tests', 'unit'],
  ['clip', 'clips', 'truncate', 'truncation', 'shorten', 'long', 'longer', 'characters', 'entries'],
  ['bootstrap', 'session', 'summary'],
  ['mcp', 'pull', 'fetch', 'serve', 'injection', 'prompt'],
  ['worker', 'workers', 'llm', 'extraction', 'job', 'jobs'],
  ['retry', 'retries', 'repair', 'policy'],
  ['resume', 'continue', 'picking', 'fresh', 'handoff', 'left'],
  ['tokens', 'size', 'budget', 'cost', 'costs', 'reduce', 'shrink', 'cut'],
  ['ollama', 'embedding', 'embeddings', 'installed', 'missing', 'local'],
  ['graph', 'relations', 'hop', 'neighbours'],
  ['hook', 'hooks', 'stop', 'turn', 'payloads'],
  ['duplicate', 'duplicates', 'twice', 'same', 'listing'],
  ['src', 'ts', 'file', 'path', 'store', 'core'],
];

const HASH_DIMS = 16;
/** Bag-of-words texture: enough that shared words pull vectors together, never enough to beat a concept. */
const HASH_WEIGHT = 0.25;

function fnv1a(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The deterministic stand-in for an embedding model. Offline, and identical on every run. */
export class ConceptEmbeddings implements EmbeddingProvider {
  readonly name = 'concepts';
  readonly isLocal = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      const vec = new Array<number>(CONCEPTS.length + HASH_DIMS).fill(0);
      for (const w of words) {
        CONCEPTS.forEach((group, n) => {
          if (group.includes(w)) vec[n]! += 1;
        });
        const slot = CONCEPTS.length + (fnv1a(w) % HASH_DIMS);
        vec[slot]! += HASH_WEIGHT;
      }
      return vec;
    });
  }
}

export interface RankingScores {
  recall_at_k: number;
  mrr: number;
}

export interface QueryOutcome {
  query: string;
  kind: GoldenQuery['kind'];
  expected: string[];
  keyword: string[];
  hybrid_fixed: string[];
  hybrid: string[];
}

export interface RetrievalEval {
  k: number;
  items: number;
  queries: number;
  embedder: string;
  keyword: RankingScores;
  /** RRF with the configured weight on every query. */
  hybrid_fixed: RankingScores;
  /** RRF with the keyword weight raised for exact-match queries - what `memory_query` does. */
  hybrid: RankingScores;
  per_query: QueryOutcome[];
}

export interface EvalOptions {
  k?: number;
  /** A real provider, for `contextd bench --retrieval --real-embeddings`. Default: the stand-in. */
  provider?: EmbeddingProvider;
  embeddings?: EmbeddingConfig;
  items?: readonly GoldenItem[];
  queries?: readonly GoldenQuery[];
}

function score(outcomes: Array<{ expected: string[]; ranked: string[] }>, k: number): RankingScores {
  if (outcomes.length === 0) return { recall_at_k: 0, mrr: 0 };
  let recall = 0;
  let rr = 0;
  for (const { expected, ranked } of outcomes) {
    const top = ranked.slice(0, k);
    recall += expected.filter((id) => top.includes(id)).length / expected.length;
    const first = ranked.findIndex((id) => expected.includes(id));
    rr += first >= 0 ? 1 / (first + 1) : 0;
  }
  return { recall_at_k: recall / outcomes.length, mrr: rr / outcomes.length };
}

/**
 * Load the fixture into a throwaway in-memory store and rank every query three ways. The store is
 * never the project's: nothing measured here can leak into memory.
 */
export async function evaluateRetrieval(opts: EvalOptions = {}): Promise<RetrievalEval> {
  const k = opts.k ?? 5;
  const items = opts.items ?? GOLDEN_ITEMS;
  const queries = opts.queries ?? GOLDEN_QUERIES;
  const provider = opts.provider ?? new ConceptEmbeddings();
  const config =
    opts.embeddings ?? EmbeddingConfigSchema.parse({ enabled: true, provider: 'ollama', model: provider.name });

  const db = openDb(':memory:');
  try {
    const store = new ContextStore(db);
    const committed = store.commitPatch(
      {
        add: items.map((i) => ({
          id: i.id,
          category: i.category,
          text: i.text,
          reason: i.reason ?? null,
          importance: 'medium' as const,
          source: 'user' as const,
          confidence: 1,
        })),
        note: 'retrieval eval fixture',
      },
      'import',
    );
    if (!committed.ok) {
      throw new Error(`fixture rejected: ${committed.violations.map((v) => v.message).join('; ')}`);
    }

    const index = new EmbeddingIndex(store, { ...config, enabled: true }, provider);
    for (let round = 0; round < 100; round += 1) {
      const r = await index.backfill();
      if (r.error) throw new Error(`embedding the fixture failed: ${r.error}`);
      if (r.embedded === 0) break;
    }

    const engine = new RetrievalEngine(store);
    // A fixed clock: recency is a scoring factor, and "now" moving between runs must not move the numbers.
    const now = Date.now();
    const limit = Math.max(10, k);
    const perQuery: QueryOutcome[] = [];
    for (const q of queries) {
      const base = { limit, expandGraph: false, now } as const;
      const ids = (hits: Array<{ item: { id: string } }>) => hits.map((h) => h.item.id);
      perQuery.push({
        query: q.query,
        kind: q.kind,
        expected: [...q.expected],
        keyword: ids(engine.search(q.query, base)),
        hybrid_fixed: ids(await engine.searchHybrid(q.query, index, { ...base, adaptiveKeywordWeight: false })),
        hybrid: ids(await engine.searchHybrid(q.query, index, base)),
      });
    }

    const of = (pick: (o: QueryOutcome) => string[]) =>
      score(perQuery.map((o) => ({ expected: o.expected, ranked: pick(o) })), k);
    return {
      k,
      items: items.length,
      queries: queries.length,
      embedder: opts.provider ? `${provider.name} (${config.model})` : 'concepts (deterministic stand-in)',
      keyword: of((o) => o.keyword),
      hybrid_fixed: of((o) => o.hybrid_fixed),
      hybrid: of((o) => o.hybrid),
      per_query: perQuery,
    };
  } finally {
    db.close();
  }
}

export function formatRetrievalEval(e: RetrievalEval, verbose = false): string {
  const f = (x: number) => x.toFixed(3);
  const row = (name: string, s: RankingScores) =>
    `${name.padEnd(26)}${f(s.recall_at_k).padStart(10)}${f(s.mrr).padStart(8)}`;
  const lines = [
    'Retrieval quality (golden fixture)',
    '',
    `Items: ${e.items}   queries: ${e.queries}   embedder: ${e.embedder}`,
    '',
    `${''.padEnd(26)}${`recall@${e.k}`.padStart(10)}${'MRR'.padStart(8)}`,
    row('keyword only (FTS5 BM25)', e.keyword),
    row('hybrid, fixed weight', e.hybrid_fixed),
    row('hybrid, adaptive weight', e.hybrid),
  ];
  if (verbose) {
    lines.push('', 'Per query (rank of the first expected item; - = not in the top 10):');
    const rank = (ranked: string[], expected: string[]) => {
      const n = ranked.findIndex((id) => expected.includes(id));
      return n >= 0 ? String(n + 1) : '-';
    };
    lines.push(`  ${'kind'.padEnd(11)}${'kw'.padStart(4)}${'fix'.padStart(5)}${'hyb'.padStart(5)}  query`);
    for (const o of e.per_query) {
      lines.push(
        `  ${o.kind.padEnd(11)}${rank(o.keyword, o.expected).padStart(4)}${rank(o.hybrid_fixed, o.expected).padStart(5)}` +
          `${rank(o.hybrid, o.expected).padStart(5)}  ${o.query}`,
      );
    }
  }
  lines.push('', 'A measurement of the fixture, not of this project: printed, never stored.');
  return lines.join('\n');
}
