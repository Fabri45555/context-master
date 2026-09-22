import { describe, expect, it } from 'vitest';
import { EmbeddingConfigSchema } from '../src/core/config.js';
import { EmbeddingIndex, standOut, type EmbeddingProvider } from '../src/store/embeddings.js';
import { RetrievalEngine } from '../src/store/retrieval.js';
import { makeManager, tempProject } from './helpers.js';
import { ContextManager } from '../src/daemon/manager.js';

/**
 * End-to-end hybrid retrieval: real store, real FTS5, real cosine scan and fusion - only the
 * embedding model is scripted.
 *
 * The fake embeds by concept, not by word: synonyms land on the same axis. That is the one
 * property of a real model these tests need, because the point of the semantic list is to
 * find an item whose text shares no keyword with the query.
 */
const CONCEPTS = [
  ['database', 'postgres', 'sqlite', 'persistence', 'storage'],
  ['auth', 'login', 'credentials', 'password', 'sign'],
  ['deploy', 'release', 'ship', 'rollout'],
];

class ConceptEmbeddings implements EmbeddingProvider {
  readonly name = 'scripted';
  readonly isLocal = true;
  calls: string[][] = [];
  failQueries = false;
  down = false;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    if (this.down) throw new Error('connect ECONNREFUSED');
    // Backfill embeds items (which carry their category on the first line); a query does not.
    if (this.failQueries && texts.length === 1 && !texts[0]!.includes('\n')) {
      throw new Error('provider down');
    }
    return texts.map((text) => {
      const words = text.toLowerCase().split(/[^a-z]+/);
      return CONCEPTS.map((group) => words.filter((w) => group.includes(w)).length);
    });
  }
}

const CONFIG = EmbeddingConfigSchema.parse({ enabled: true, provider: 'ollama', model: 'concepts' });

function seed(manager: ReturnType<typeof makeManager>['manager']): void {
  manager.remember({
    add: [
      { id: 'mem_db', category: 'decisions', text: 'Use sqlite for persistence' },
      // Shares no keyword with "login credentials" - only the semantic list can find it.
      { id: 'mem_signin', category: 'constraints', text: 'Users must sign in before editing' },
      { id: 'mem_ship', category: 'goals', text: 'Ship the release on friday' },
      { id: 'mem_form', category: 'decisions', text: 'The login page takes credentials in one form' },
    ],
  });
}

describe('hybrid search, end to end', () => {
  it('surfaces a semantic-only hit that keyword search cannot find', async () => {
    const { manager, cleanup } = makeManager();
    try {
      seed(manager);
      const index = new EmbeddingIndex(manager.store, CONFIG, new ConceptEmbeddings());
      expect((await index.backfill()).embedded).toBe(4);

      const engine = new RetrievalEngine(manager.store);
      const keyword = engine.search('login credentials').map((h) => h.item.id);
      expect(keyword).not.toContain('mem_signin');

      const ids = (await engine.searchHybrid('login credentials', index)).map((h) => h.item.id);
      // Both lists agree on the form, so it wins; the sign-in rule arrives through meaning alone.
      expect(ids[0]).toBe('mem_form');
      expect(ids).toContain('mem_signin');
      // The scan is exhaustive: without a cut, unrelated items would ride in on the semantic list.
      expect(ids).not.toContain('mem_db');
      expect(ids).not.toContain('mem_ship');
    } finally {
      cleanup();
    }
  });

  it('never serves a retired item through its leftover vector', async () => {
    const { manager, cleanup } = makeManager();
    try {
      seed(manager);
      const index = new EmbeddingIndex(manager.store, CONFIG, new ConceptEmbeddings());
      await index.backfill();
      expect(manager.retire(['mem_signin'], 'rule dropped').ok).toBe(true);

      const ids = (await new RetrievalEngine(manager.store).searchHybrid('login credentials', index)).map(
        (h) => h.item.id,
      );
      expect(ids).not.toContain('mem_signin');
    } finally {
      cleanup();
    }
  });

  it('falls back to keyword order when the provider fails at query time', async () => {
    const { manager, cleanup } = makeManager();
    try {
      seed(manager);
      const provider = new ConceptEmbeddings();
      const index = new EmbeddingIndex(manager.store, CONFIG, provider);
      await index.backfill();
      provider.failQueries = true;

      const engine = new RetrievalEngine(manager.store);
      const hybrid = (await engine.searchHybrid('login credentials', index)).map((h) => h.item.id);
      expect(hybrid).toEqual(engine.search('login credentials').map((h) => h.item.id));
    } finally {
      cleanup();
    }
  });

  it('does not re-embed unchanged items', async () => {
    const { manager, cleanup } = makeManager();
    try {
      seed(manager);
      const provider = new ConceptEmbeddings();
      const index = new EmbeddingIndex(manager.store, CONFIG, provider);
      await index.backfill();
      const calls = provider.calls.length;

      expect((await index.backfill()).embedded).toBe(0);
      expect(provider.calls.length).toBe(calls);
    } finally {
      cleanup();
    }
  });

  it('embeds a new item even when more than a batch of items is already embedded', async () => {
    // Regression: `stale` scanned only the first `limit * 4` rows, so once that many items
    // were embedded every later item was skipped and backfill reported nothing to do.
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: Array.from({ length: 10 }, (_, n) => ({
          category: 'discoveries' as const,
          text: `sqlite fact number ${n}`,
        })),
      });
      const index = new EmbeddingIndex(manager.store, CONFIG, new ConceptEmbeddings());
      expect((await index.backfill(10)).embedded).toBe(10);

      manager.remember({ add: [{ category: 'decisions', text: 'Deploy with a canary rollout' }] });
      expect((await index.backfill(2)).embedded).toBe(1);
      expect(index.count()).toBe(11);
    } finally {
      cleanup();
    }
  });

  it('re-embeds everything when the model changes', async () => {
    // Vectors from another model are filtered out by dimension at query time, so keeping
    // them would silently empty the semantic list rather than fail.
    const { manager, cleanup } = makeManager();
    try {
      seed(manager);
      const provider = new ConceptEmbeddings();
      await new EmbeddingIndex(manager.store, CONFIG, provider).backfill();

      const next = new EmbeddingIndex(manager.store, { ...CONFIG, model: 'concepts-v2' }, provider);
      expect((await next.backfill()).embedded).toBe(4);
    } finally {
      cleanup();
    }
  });
});

describe('semantic cut', () => {
  it('keeps only similarities that stand out from the rest, whatever the model baseline', () => {
    // Same shape under two models: one scores unrelated text near 0.1, the other near 0.45.
    const low = [0.62, 0.12, 0.1, 0.11, 0.09, 0.13].map((score, n) => ({ id: `a${n}`, score }));
    const high = [0.81, 0.46, 0.44, 0.45, 0.43, 0.47].map((score, n) => ({ id: `b${n}`, score }));
    expect(standOut(low).map((x) => x.id)).toEqual(['a0']);
    expect(standOut(high).map((x) => x.id)).toEqual(['b0']);
  });

  it('honours an absolute floor, and never keeps a non-positive similarity', () => {
    const scored = [0.3, 0.1, 0].map((score, n) => ({ id: `c${n}`, score }));
    expect(standOut(scored, 0.5)).toEqual([]);
    expect(standOut([{ id: 'z', score: 0 }])).toEqual([]);
  });
});

/**
 * Query-only memory. `seed` writes user items, which the bootstrap serves unconditionally - so
 * they would appear in the keyword answer too and prove nothing about the semantic list.
 */
function seedQueryOnly(manager: ReturnType<typeof makeManager>['manager']): void {
  const texts: Record<string, string> = {
    mem_db: 'Use sqlite for persistence',
    mem_signin: 'Users must sign in before editing',
    mem_ship: 'Ship the release on friday',
    mem_form: 'The login page takes credentials in one form',
  };
  manager.remember({
    add: Object.entries(texts).map(([id, text]) => ({
      id, text, category: 'discoveries' as const, source: 'agent' as const, confidence: 0.8,
    })),
  });
}

describe('queryContextHybrid, the path an agent query takes', () => {
  function hybridManager(provider: ConceptEmbeddings) {
    const { root, cleanup } = tempProject({
      embeddings: { enabled: true, provider: 'ollama', model: 'concepts' },
    } as never);
    const manager = new ContextManager({ cwd: root, embeddingProvider: provider });
    return { manager, cleanup: () => { manager.close(); cleanup(); } };
  }

  it('embeds new memory on the way in and serves the semantic hit, counted as a retrieval', async () => {
    const provider = new ConceptEmbeddings();
    const { manager, cleanup } = hybridManager(provider);
    try {
      seedQueryOnly(manager);
      // Nobody ran `contextd embed`: the query path brings the index up to date itself.
      expect(manager.embeddings.count()).toBe(0);
      const built = await manager.queryContextHybrid('login credentials');
      expect(manager.embeddings.count()).toBe(4);
      expect(built.itemIds).toContain('mem_signin');
      expect(built.text).toContain('Users must sign in before editing');
      expect(manager.metrics(null).retrieval.count).toBe(1);
      expect(manager.queryContext('login credentials', { record: false }).itemIds).not.toContain('mem_signin');
    } finally {
      cleanup();
    }
  });

  it('degrades to exactly the keyword answer, with one provider attempt, when the provider is down', async () => {
    const provider = new ConceptEmbeddings();
    provider.down = true;
    const { manager, cleanup } = hybridManager(provider);
    try {
      seedQueryOnly(manager);
      const hybrid = await manager.queryContextHybrid('login credentials', { record: false });
      expect(hybrid.text).toBe(manager.queryContext('login credentials', { record: false }).text);
      // The failed refresh short-circuits: no second call waiting out another timeout.
      expect(provider.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('is exactly queryContext when embeddings are off', async () => {
    const provider = new ConceptEmbeddings();
    const { manager, cleanup } = makeManager();
    try {
      seedQueryOnly(manager);
      const hybrid = await manager.queryContextHybrid('login credentials', { record: false });
      expect(hybrid.text).toBe(manager.queryContext('login credentials', { record: false }).text);
      expect(provider.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
