import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EmbeddingConfigSchema } from '../src/core/config.js';
import { similarity } from '../src/core/conflicts.js';
import { findSimilar, formatSimilarHint, SIMILAR_COSINE_THRESHOLD } from '../src/core/similar.js';
import { EmbeddingIndex, type EmbeddingProvider } from '../src/store/embeddings.js';
import {
  adaptiveKeywordWeight,
  exactMatchKinds,
  KEYWORD_WEIGHT_MAX,
  KEYWORD_WEIGHT_STRONG,
  RetrievalEngine,
} from '../src/store/retrieval.js';
import { omittedMarker } from '../src/retrieval/context-builder.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { evaluateRetrieval, GOLDEN_ITEMS, GOLDEN_QUERIES } from '../src/bench/retrieval-eval.js';
import { ContextManager } from '../src/daemon/manager.js';
import { makeManager, tempProject } from './helpers.js';

/** Vectors by exact text: each test states what the "model" believes, nothing more. */
class TableEmbeddings implements EmbeddingProvider {
  readonly name = 'table';
  readonly isLocal = true;
  constructor(private table: Array<[RegExp, number[]]>, private fallback: number[]) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.table.find(([re]) => re.test(t))?.[1] ?? this.fallback);
  }
}

// ------------------------------------------------------------------ A: similar-memory hint

describe('the similar-memory hint', () => {
  // The threshold is the conflict detector's restatement threshold (0.42). These pairs are why it
  // is right for a write-time hint too: every paraphrase clears it, every same-area-but-different
  // statement stays under it.
  const restatements: Array<[string, string]> = [
    ['Use SQLite for all persistence', 'Use SQLite for persistence'],
    ['Use SQLite for all persistence', 'All persistence goes through SQLite'],
    ['Workers are single calls with one repair retry', 'A worker is a single call with at most one repair retry'],
    ['Never commit secrets to the repository', 'Do not commit secrets into the repo'],
  ];
  const distinct: Array<[string, string]> = [
    ['Use SQLite for all persistence', 'Use PostgreSQL for the analytics warehouse'],
    ['Tests must never hit the network', 'Tests use scripted providers and never touch a network'],
    ['Retrieval fuses BM25 and cosine with RRF', 'Retrieval fuses keyword and semantic ranks by reciprocal rank fusion'],
    ['Adapters declare their surfaces', 'Adapters may not assert importance they do not know'],
  ];

  it('flags restatements and leaves merely related statements alone', () => {
    for (const [a, b] of restatements) expect(similarity(a, b), `${a} / ${b}`).toBeGreaterThanOrEqual(0.42);
    for (const [a, b] of distinct) expect(similarity(a, b), `${a} / ${b}`).toBeLessThan(0.42);
  });

  it('names the near-duplicate after a write, and changes nothing', async () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'd1', category: 'decisions', text: 'Use SQLite for all persistence', source: 'user', importance: 'critical' },
          { id: 'd2', category: 'decisions', text: 'Tests use scripted providers' },
          { id: 'k1', category: 'known_issues', text: 'Use SQLite for all persistence' },
        ],
      });
      const r = manager.remember({ add: [{ id: 'd3', category: 'decisions', text: 'All persistence goes through SQLite' }] });
      expect(r.ok).toBe(true);
      const versionBefore = manager.store.currentState().version;

      const hits = await manager.similarTo('d3');
      // known_issues is not comparable with decisions: an identical sentence there is not a duplicate.
      expect(hits.map((h) => h.item.id)).toEqual(['d1']);
      expect(hits[0]!.by).toBe('text');

      const hint = formatSimilarHint(manager.store.getItem('d3')!, hits, 'mcp');
      expect(hint).toContain('Similar to d1 (decisions, user; text similarity');
      expect(hint).toContain('"Use SQLite for all persistence"');
      // d1 is user-critical: suggesting a retire that isProtected would reject is no advice at all.
      expect(hint).not.toContain('memory_retire [d1]');
      expect(hint).toContain('d1 is user-critical and cannot be retired');
      expect(hint).toContain('memory_retire [d3] with reason "duplicate"');

      const plain = formatSimilarHint(manager.store.getItem('d3')!, [{ ...hits[0]!, item: { ...hits[0]!.item, source: 'agent' } }], 'cli');
      expect(plain).toContain('contextd forget d1 --reason "replaced by d3"');
      expect(plain).toContain('contextd forget d3 --reason "duplicate"');

      // Invariant 12: a hint is not a retirement. Both stay active, no patch was written.
      expect(manager.store.getItem('d1')!.status).toBe('active');
      expect(manager.store.getItem('d3')!.status).toBe('active');
      expect(manager.store.currentState().version).toBe(versionBefore);
      // Invariant 28: the similarity lives in the response, never in memory.
      expect(JSON.stringify(manager.store.getItem('d3'))).not.toMatch(/similar/);
    } finally {
      cleanup();
    }
  });

  it('does not name what the write already supersedes, or anything retired', async () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'd1', category: 'decisions', text: 'Use SQLite for all persistence' },
          { id: 'd2', category: 'decisions', text: 'Use SQLite for persistence' },
        ],
      });
      manager.retire(['d2'], 'test');
      manager.remember({ add: [{ id: 'd3', category: 'decisions', text: 'Use SQLite for persistence everywhere', supersedes: ['d1'] }] });
      expect(await manager.similarTo('d3')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('crosses into comparable categories, same category first', () => {
    const base = {
      status: 'active', importance: 'medium', source: 'agent', confidence: 0.8, reason: null, tags: [], evidence: [],
      supersedes: [], superseded_by: null, fields: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      last_validated_at: null, last_used_at: null, expires_at: null, ttl_days: null,
    } as never as Record<string, unknown>;
    const mk = (id: string, category: string, text: string) => ({ ...base, id, category, text }) as never;
    const target = mk('d9', 'decisions', 'Never commit secrets to the repository');
    const hits = findSimilar(target, [
      mk('c1', 'constraints', 'Never commit secrets to the repository'),
      mk('d1', 'decisions', 'Do not commit secrets into the repo'),
      mk('x1', 'discoveries', 'Never commit secrets to the repository'),
    ]);
    expect(hits.map((h: { item: { id: string } }) => h.item.id)).toEqual(['d1', 'c1']);
  });

  it('uses stored embeddings for a paraphrase the trigrams miss', async () => {
    const provider = new TableEmbeddings(
      [
        [/Persist state in one local database file/, [1, 0, 0.05]],
        [/Keep everything in SQLite/, [1, 0, 0]],
        [/Log rotation happens daily/, [0, 1, 0]],
      ],
      [0, 0, 1],
    );
    const { root, cleanup } = tempProject({ embeddings: { enabled: true, provider: 'ollama', model: 'table' } } as never);
    const manager = new ContextManager({ cwd: root, embeddingProvider: provider });
    try {
      manager.remember({
        add: [
          { id: 'd1', category: 'decisions', text: 'Keep everything in SQLite' },
          { id: 'd2', category: 'decisions', text: 'Log rotation happens daily' },
        ],
      });
      manager.remember({ add: [{ id: 'd3', category: 'decisions', text: 'Persist state in one local database file' }] });
      expect(similarity('Persist state in one local database file', 'Keep everything in SQLite')).toBeLessThan(0.42);
      const hits = await manager.similarTo('d3');
      expect(hits.map((h) => [h.item.id, h.by])).toEqual([['d1', 'embedding']]);
      expect(hits[0]!.similarity).toBeGreaterThanOrEqual(SIMILAR_COSINE_THRESHOLD);
    } finally {
      manager.close();
      cleanup();
    }
  });

  it('falls back to trigrams when the embedding provider is down', async () => {
    const down: EmbeddingProvider = { name: 'down', isLocal: true, embed: async () => { throw new Error('ECONNREFUSED'); } };
    const { root, cleanup } = tempProject({ embeddings: { enabled: true, provider: 'ollama', model: 'x' } } as never);
    const manager = new ContextManager({ cwd: root, embeddingProvider: down });
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Use SQLite for all persistence' }] });
      manager.remember({ add: [{ id: 'd2', category: 'decisions', text: 'Use SQLite for persistence' }] });
      expect((await manager.similarTo('d2')).map((h) => h.item.id)).toEqual(['d1']);
    } finally {
      manager.close();
      cleanup();
    }
  });
});

// ------------------------------------------------------------ B: adaptive keyword weight

describe('exact-match detection', () => {
  it.each([
    ['src/store/db.ts', 'path'],
    ['what does db.ts do', 'path'],
    ['commitPatch', 'identifier'],
    ['working_set_by_hand_at', 'identifier'],
    ['ContextManager facade', 'identifier'],
    ['why mem_01abc', 'memory_id'],
    ['explain d12', 'memory_id'],
    ['session 3f2b8c1e-9a4d-4e21-8b7a-0c9d1e2f3a4b', 'uuid'],
    ['upgrade to 1.30.0', 'version'],
    ['port 8080', 'number'],
    ['the --no-hooks flag', 'flag'],
  ])('%s -> %s', (query, kind) => {
    expect(exactMatchKinds(query)).toContain(kind);
  });

  it.each(['how do we store data', 'why are tests offline', 'e.g. three retries', 'what happens after compaction'])(
    'prose stays prose: %s',
    (query) => expect(exactMatchKinds(query)).toEqual([]),
  );

  it('raises the keyword weight, bounded, and never lowers it', () => {
    expect(adaptiveKeywordWeight('how do we store data', 0.5)).toBe(0.5);
    expect(adaptiveKeywordWeight('src/store/db.ts', 0.5)).toBe(KEYWORD_WEIGHT_STRONG);
    expect(adaptiveKeywordWeight('commitPatch', 0.5)).toBeGreaterThan(0.5);
    expect(adaptiveKeywordWeight('commitPatch', 0.5)).toBeLessThan(KEYWORD_WEIGHT_STRONG);
    expect(adaptiveKeywordWeight('src/store/db.ts', 0.95)).toBe(0.95);
    expect(adaptiveKeywordWeight('src/store/db.ts', 0.2)).toBeLessThanOrEqual(KEYWORD_WEIGHT_MAX);
    // A configured semantic-only fusion is a choice, not something to override.
    expect(adaptiveKeywordWeight('src/store/db.ts', 0)).toBe(0);
  });

  it('ranks the path item first even when the embedder prefers another', async () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'f_db', category: 'important_files', text: 'src/store/db.ts holds the schema' },
          // Mentions the path in passing: a keyword hit, but a weaker one (longer text, lower BM25).
          { id: 'd_sql', category: 'decisions', text: 'SQLite schema changes go through a reviewed migration in src/store/db.ts first' },
          { id: 'd_a', category: 'decisions', text: 'Unrelated alpha' },
          // Enough unrelated memory for the semantic cut (mean + 1 sd) to admit the top three.
          ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, category: 'discoveries' as const, text: `Noise item ${i}` })),
        ],
      });
      // The "model" puts the migration decision nearest the query and the file third.
      const provider = new TableEmbeddings(
        [
          [/SQLite schema changes/, [1, 0, 0]],
          [/Unrelated alpha/, [0.97, 0.24, 0]],
          [/holds the schema/, [0.9, 0.43, 0]],
          [/^src\/store\/db\.ts$/, [1, 0, 0]],
        ],
        [0, 0, 1],
      );
      const index = new EmbeddingIndex(
        manager.store,
        EmbeddingConfigSchema.parse({ enabled: true, provider: 'ollama', model: 'table' }),
        provider,
      );
      await index.backfill();
      const engine = new RetrievalEngine(manager.store);
      const keyword = engine.search('src/store/db.ts', { expandGraph: false }).map((h) => h.item.id);
      expect(keyword[0]).toBe('f_db');

      const fixed = await engine.searchHybrid('src/store/db.ts', index, { adaptiveKeywordWeight: false });
      expect(fixed[0]!.item.id).toBe('d_sql');
      const adaptive = await engine.searchHybrid('src/store/db.ts', index);
      expect(adaptive[0]!.item.id).toBe('f_db');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------- C: the omitted marker

describe('the omitted marker says how to get the rest', () => {
  it('points a bootstrap section at a category listing that actually returns the omitted items', async () => {
    const { manager, cleanup } = makeManager({
      context_budget: { total_tokens: 4000, reserve_for_retrieval: 3000, sections: { decisions: 60 } },
    } as never);
    try {
      manager.remember({
        add: Array.from({ length: 10 }, (_, i) => ({
          id: `d${i}`,
          category: 'decisions' as const,
          text: `A decision with enough words in it to consume part of the section allowance ${i}`,
        })),
      });
      const built = manager.bootstrapContext();
      const section = built.sections.find((s) => s.title === 'Decisions')!;
      expect(section.dropped).toBeGreaterThan(0);
      expect(section.droppedCategories).toEqual(['decisions']);
      expect(built.text).toContain(`(+${section.dropped} more omitted for budget - memory_query category="decisions")`);

      // Following the pointer: a category listing with no query returns what was omitted.
      const listed = await manager.queryContextHybrid('', { categories: ['decisions'], limit: 50, record: false });
      for (const id of section.droppedIds!) expect(listed.itemIds).toContain(id);
    } finally {
      cleanup();
    }
  });

  it('names a few omitted query hits by id, and advises narrowing past that', () => {
    expect(omittedMarker({ dropped: 2, droppedIds: ['d3', 'd4'], droppedCategories: ['decisions'] }, 'query')).toBe(
      '(+2 more omitted for budget: d3, d4 - memory_explain <id>)',
    );
    expect(omittedMarker({ dropped: 9, droppedIds: Array.from({ length: 9 }, (_, i) => `d${i}`) }, 'query')).toContain(
      'narrow the query',
    );
    expect(omittedMarker({ dropped: 0 }, 'bootstrap')).toBe('');
  });

  it('keeps a clipped item addressable by id', async () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd9', category: 'decisions', text: 'word '.repeat(80).trim(), source: 'user' }] });
      const line = manager.bootstrapContext().text.split('\n').find((l) => l.includes('d9'))!;
      expect(line).toContain('(full: memory_explain d9)');
    } finally {
      cleanup();
    }
  });
});

describe('over MCP', () => {
  async function connect(manager: ContextManager): Promise<Client> {
    const server = buildMcpServer(manager);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    return client;
  }
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  it('memory_remember appends the hint; memory_query lists a category; the resource resolves', async () => {
    const { manager, cleanup } = makeManager();
    try {
      const client = await connect(manager);
      await client.callTool({ name: 'memory_remember', arguments: { category: 'decisions', text: 'Use SQLite for all persistence' } });
      const second = text(
        await client.callTool({ name: 'memory_remember', arguments: { category: 'decisions', text: 'Use SQLite for persistence' } }),
      );
      expect(second).toMatch(/^Recorded \S+ \(state v\d+\)\.\nSimilar to /);
      expect(manager.store.currentState().items.filter((i) => i.status === 'active')).toHaveLength(2);

      const unrelated = text(
        await client.callTool({ name: 'memory_remember', arguments: { category: 'decisions', text: 'Ship on Fridays only after review' } }),
      );
      expect(unrelated).not.toContain('Similar to');

      const listed = text(await client.callTool({ name: 'memory_query', arguments: { category: 'decisions' } }));
      expect(listed).toContain('Ship on Fridays');
      const neither = await client.callTool({ name: 'memory_query', arguments: {} });
      expect(neither.isError).toBe(true);

      const resource = await client.readResource({ uri: 'contextd://memory/decisions' });
      const body = (resource.contents[0] as { text: string }).text;
      expect(JSON.parse(body)).toHaveLength(3);
      await client.close();
    } finally {
      cleanup();
    }
  });
});

// ------------------------------------------------------------------ D: retrieval eval

describe('retrieval eval', () => {
  it('has a golden set of the intended size whose expectations all exist', () => {
    const ids = new Set(GOLDEN_ITEMS.map((i) => i.id));
    expect(GOLDEN_ITEMS.length).toBeGreaterThanOrEqual(20);
    expect(GOLDEN_QUERIES.length).toBeGreaterThanOrEqual(15);
    for (const q of GOLDEN_QUERIES) for (const id of q.expected) expect(ids.has(id), `${q.query} -> ${id}`).toBe(true);
  });

  it('hybrid beats keyword-only, adaptive is no worse than fixed, and the numbers are stable', async () => {
    const first = await evaluateRetrieval();
    const second = await evaluateRetrieval();
    expect(second.keyword).toEqual(first.keyword);
    expect(second.hybrid).toEqual(first.hybrid);
    expect(second.hybrid_fixed).toEqual(first.hybrid_fixed);

    expect(first.hybrid.recall_at_k).toBeGreaterThanOrEqual(first.keyword.recall_at_k);
    expect(first.hybrid.mrr).toBeGreaterThan(first.keyword.mrr);
    expect(first.hybrid.mrr).toBeGreaterThanOrEqual(first.hybrid_fixed.mrr);

    // Pinned: a change to retrieval that moves these should be a deliberate one.
    const r = (x: number) => Math.round(x * 1000) / 1000;
    expect([r(first.keyword.recall_at_k), r(first.keyword.mrr)]).toEqual([0.875, 0.778]);
    expect([r(first.hybrid_fixed.recall_at_k), r(first.hybrid_fixed.mrr)]).toEqual([1, 0.885]);
    expect([r(first.hybrid.recall_at_k), r(first.hybrid.mrr)]).toEqual([1, 0.906]);
  });
});
