import { describe, expect, it } from 'vitest';
import { cosine, packVector, reciprocalRankFusion, unpackVector } from '../src/store/embeddings.js';
import { RetrievalEngine } from '../src/store/retrieval.js';
import { edgeKey, isSymmetric, traversalWeight } from '../src/core/graph.js';
import { makeManager, ScriptedProvider } from './helpers.js';

describe('graph edges', () => {
  it('records a typed relation as part of a patch', () => {
    const { manager, cleanup } = makeManager();
    try {
      const r = manager.remember({
        add: [
          { id: 'mem_c', category: 'constraints', text: 'Never change the public API' },
          { id: 'mem_d', category: 'decisions', text: 'Version the auth endpoints under /v2' },
        ],
        link: [{ from: 'mem_c', to: 'mem_d', kind: 'governs', reason: 'the constraint forced versioning' }],
      });
      expect(r.ok).toBe(true);
      expect(manager.store.edgeCount()).toBe(1);

      const neighbourhood = manager.graphOf('mem_d');
      expect(neighbourhood).toHaveLength(1);
      expect(neighbourhood[0]!.direction).toBe('in');
      expect(neighbourhood[0]!.edge.kind).toBe('governs');
      expect(neighbourhood[0]!.other?.id).toBe('mem_c');
    } finally {
      cleanup();
    }
  });

  it('rejects a link to a non-existent item, and a self link', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'mem_a', category: 'goals', text: 'ship it' }] });

      // A dangling edge never enters the graph. It is dropped as a no-op rather than
      // rejected, so a patch that is only a dangling link ends up empty.
      const unknown = manager.store.commitPatch(
        { link: [{ from: 'mem_a', to: 'mem_nope', kind: 'relates_to' }] },
        'worker',
        {},
      );
      expect(unknown.ok).toBe(false);
      expect(manager.store.edgeCount()).toBe(0);

      // A user's own patch still gets the error, because there the typo is worth reporting.
      const byHand = manager.store.commitPatch(
        { link: [{ from: 'mem_a', to: 'mem_nope', kind: 'relates_to' }] },
        'user',
        {},
      );
      expect(byHand.violations.map((v) => v.code)).toContain('unknown_item');

      const self = manager.store.commitPatch(
        { link: [{ from: 'mem_a', to: 'mem_a', kind: 'relates_to' }] },
        'worker',
        {},
      );
      expect(self.ok).toBe(false);
      expect(self.violations.map((v) => v.code)).toContain('self_link');
    } finally {
      cleanup();
    }
  });

  it('drops a relation on unlink', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'mem_a', category: 'goals', text: 'ship rate limiting' },
          { id: 'mem_b', category: 'decisions', text: 'token bucket per key' },
        ],
        link: [{ from: 'mem_a', to: 'mem_b', kind: 'implemented_by' }],
      });
      expect(manager.store.edgeCount()).toBe(1);

      manager.remember({ unlink: [{ from: 'mem_a', to: 'mem_b' }] });
      expect(manager.store.edgeCount()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('stores a symmetric relation once regardless of direction', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'mem_z', category: 'decisions', text: 'use redis' },
          { id: 'mem_a', category: 'decisions', text: 'do not use redis' },
        ],
        link: [{ from: 'mem_z', to: 'mem_a', kind: 'contradicts' }],
      });
      manager.remember({ link: [{ from: 'mem_a', to: 'mem_z', kind: 'contradicts' }] });
      expect(manager.store.edgeCount()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('keys symmetric and asymmetric relations differently', () => {
    expect(isSymmetric('contradicts')).toBe(true);
    expect(isSymmetric('governs')).toBe(false);
    expect(edgeKey('b', 'a', 'contradicts')).toBe(edgeKey('a', 'b', 'contradicts'));
    expect(edgeKey('b', 'a', 'governs')).not.toBe(edgeKey('a', 'b', 'governs'));
    // A governing constraint is the most valuable thing to reach from a hit.
    expect(traversalWeight('governs')).toBeGreaterThan(traversalWeight('relates_to'));
  });
});

describe('graph-expanded retrieval', () => {
  it('reaches a constraint whose text does not match the query', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          {
            id: 'mem_decision',
            category: 'decisions',
            text: 'Refresh tokens rotate on every use',
            importance: 'high',
          },
          {
            // Nothing here mentions refresh tokens, so keyword search can never find it.
            id: 'mem_constraint',
            category: 'constraints',
            text: 'Storage layer must stay on PostgreSQL 16',
            importance: 'critical',
            source: 'agent',
          },
        ],
        link: [{ from: 'mem_constraint', to: 'mem_decision', kind: 'governs' }],
      });

      const engine = new RetrievalEngine(manager.store);
      const withoutGraph = engine.search('refresh token rotation', { expandGraph: false });
      expect(withoutGraph.map((h) => h.item.id)).not.toContain('mem_constraint');

      const withGraph = engine.search('refresh token rotation');
      const reached = withGraph.find((h) => h.item.id === 'mem_constraint');
      expect(reached).toBeDefined();
      expect(reached!.via?.kind).toBe('governs');
      expect(reached!.via?.from).toBe('mem_decision');
    } finally {
      cleanup();
    }
  });

  it('never lets a neighbour outrank the hit that found it', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'mem_hit', category: 'decisions', text: 'Rate limit the public API per key', importance: 'high' },
          { id: 'mem_near', category: 'conventions', text: 'Prettier with 100 column width', importance: 'low' },
        ],
        link: [{ from: 'mem_hit', to: 'mem_near', kind: 'relates_to' }],
      });
      const hits = new RetrievalEngine(manager.store).search('rate limit public api');
      expect(hits[0]!.item.id).toBe('mem_hit');
      const neighbour = hits.find((h) => h.item.id === 'mem_near');
      if (neighbour) expect(neighbour.score).toBeLessThan(hits[0]!.score);
    } finally {
      cleanup();
    }
  });

  it('does not follow edges into retired items', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'mem_live', category: 'decisions', text: 'Cache sessions in PostgreSQL', importance: 'high' },
          { id: 'mem_dead', category: 'decisions', text: 'Something unrelated entirely', importance: 'high' },
        ],
        link: [{ from: 'mem_live', to: 'mem_dead', kind: 'relates_to' }],
      });
      manager.store.commitPatch({ update: [{ id: 'mem_dead', status: 'stale' }] }, 'worker', {});

      const hits = new RetrievalEngine(manager.store).search('cache sessions postgresql');
      expect(hits.map((h) => h.item.id)).not.toContain('mem_dead');
    } finally {
      cleanup();
    }
  });
});

describe('embeddings', () => {
  it('round-trips a vector through the blob encoding', () => {
    const vec = [0.5, -0.25, 0.125, 1];
    const back = unpackVector(packVector(vec));
    expect([...back]).toEqual(vec);
  });

  it('computes cosine similarity, and is safe on mismatched dimensions', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
    expect(cosine(a, c)).toBeCloseTo(0, 6);
    expect(cosine(a, new Float32Array([1, 0]))).toBe(0);
    expect(cosine(new Float32Array([0, 0, 0]), b)).toBe(0);
  });

  it('fuses two rankings by reciprocal rank, not by raw score', () => {
    // BM25 scores and cosine similarities are not on a comparable scale, so only the
    // ordering is used. An item both lists rank well beats one that only one list likes.
    const fused = reciprocalRankFusion([
      { ids: ['keyword_only', 'agreed', 'tail'], weight: 0.5 },
      { ids: ['semantic_only', 'agreed', 'tail'], weight: 0.5 },
    ]);
    const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(ranked[0]).toBe('agreed');
    expect(fused.get('keyword_only')).toBeCloseTo(fused.get('semantic_only')!, 10);
  });

  it('ignores a list with zero weight', () => {
    const fused = reciprocalRankFusion([
      { ids: ['a'], weight: 1 },
      { ids: ['b'], weight: 0 },
    ]);
    expect(fused.has('b')).toBe(false);
  });

  it('is inert and harmless when disabled', async () => {
    const { manager, cleanup } = makeManager();
    try {
      expect(manager.embeddings.enabled).toBe(false);
      expect(manager.embeddings.count()).toBe(0);
      const r = await manager.embed();
      expect(r.embedded).toBe(0);
      expect(r.error).toContain('disabled');
      // Retrieval must keep working with no semantic index at all.
      manager.remember({ add: [{ category: 'goals', text: 'ship rate limiting' }] });
      const hybrid = await new RetrievalEngine(manager.store).searchHybrid(
        'rate limiting',
        manager.embeddings,
      );
      expect(hybrid.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('falls back to keyword ranking when the provider is unreachable', async () => {
    // Points at a port nothing is listening on, which is the realistic failure.
    const { manager, cleanup } = makeManager({
      embeddings: { enabled: true, provider: 'ollama', base_url: 'http://127.0.0.1:1', model: 'x' },
    } as never);
    try {
      manager.remember({ add: [{ category: 'goals', text: 'ship rate limiting soon' }] });
      const hits = await new RetrievalEngine(manager.store).searchHybrid(
        'rate limiting',
        manager.embeddings,
      );
      expect(hits.length).toBeGreaterThan(0);
      const r = await manager.embed();
      expect(r.error).toBeDefined();
      expect(r.embedded).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('memory portability', () => {
  it('replays an exported patch log into a fresh project', () => {
    const source = makeManager({}, new ScriptedProvider([]));
    const target = makeManager({}, new ScriptedProvider([]));
    try {
      source.manager.remember({
        add: [
          {
            id: 'mem_c',
            category: 'constraints',
            text: 'Never store tokens in Redis',
            source: 'user',
            importance: 'critical',
          },
          { id: 'mem_d', category: 'decisions', text: 'Store tokens in PostgreSQL' },
        ],
        link: [{ from: 'mem_c', to: 'mem_d', kind: 'governs' }],
      });

      const exported = source.manager.store.listPatches(1000).reverse();
      const result = target.manager.importPatches(exported);

      expect(result.applied).toBe(exported.length);
      expect(result.rejected).toBe(0);
      const moved = target.manager.store.getItem('mem_c')!;
      expect(moved.text).toBe('Never store tokens in Redis');
      expect(moved.source).toBe('user');
      // Relations travel with the log, because they are part of the patch.
      expect(target.manager.store.edgeCount()).toBe(1);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('is idempotent: importing twice changes nothing the second time', () => {
    const source = makeManager({}, new ScriptedProvider([]));
    const target = makeManager({}, new ScriptedProvider([]));
    try {
      source.manager.remember({ add: [{ id: 'mem_a', category: 'goals', text: 'ship it' }] });
      const exported = source.manager.store.listPatches(1000).reverse();

      const first = target.manager.importPatches(exported);
      const version = target.manager.store.stateVersion();
      const second = target.manager.importPatches(exported);

      expect(first.applied).toBeGreaterThan(0);
      expect(second.applied).toBe(0);
      expect(second.skipped).toBe(exported.length);
      expect(target.manager.store.stateVersion()).toBe(version);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });
});

describe('a patch that is mostly right', () => {
  it('keeps the good extraction and drops only the dead links', async () => {
    // Real run: the model invented three link targets, one of them a file path, and the whole
    // batch of 45 events was rejected twice over it - losing every item it had extracted.
    const { manager, cleanup } = makeManager();
    try {
      const result = manager.store.commitPatch(
        {
          add: [
            { id: 'mem_real', category: 'decisions', text: 'Keep the writer path synchronous' },
            { id: 'mem_two', category: 'constraints', text: 'Node 22 or newer' },
          ],
          link: [
            { from: 'mem_real', to: 'mem_two', kind: 'governs' },
            { from: 'mem_real', to: 'src/core/ingest.ts', kind: 'relates_to' },
            { from: 'mem_invented', to: 'mem_two', kind: 'refines' },
          ],
          remove: ['mem_from_another_database'],
        },
        'worker',
        {},
      );

      expect(result.ok).toBe(true);
      expect(result.added).toHaveLength(2);
      // The one real edge survives; the file path and the invented id do not.
      expect(manager.store.edgeCount()).toBe(1);
      // And the drop is recorded rather than silent, so the patch log still explains itself.
      const patch = manager.store.listPatches(1)[0]!;
      expect(JSON.stringify(patch)).toContain('dropped inert');
    } finally {
      cleanup();
    }
  });
});
