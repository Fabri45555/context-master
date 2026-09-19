import { sha256 } from '../core/ids.js';
import type { EmbeddingConfig } from '../core/config.js';
import type { MemoryItem } from '../core/state.js';
import type { ContextStore } from './store.js';

/**
 * PRD Phase 4 - semantic retrieval, as an optional layer over the keyword index.
 *
 * PRD 6 and 49 rule out a vector database for the MVP, and that call still holds: at a few
 * thousand memory items an exhaustive cosine scan is microseconds, so the dependency buys
 * nothing. What was missing is the *capability*, not the infrastructure.
 *
 * Off unless an embedding provider is configured. The default provider is local (ollama),
 * so switching it on does not silently break `privacy.local_only`.
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly isLocal: boolean;
  embed(texts: string[], config: EmbeddingConfig): Promise<number[][]>;
}

export const ollamaEmbeddings: EmbeddingProvider = {
  name: 'ollama',
  isLocal: true,
  async embed(texts, config) {
    const base = config.base_url ?? 'http://127.0.0.1:11434';
    const out: number[][] = [];
    // Ollama's embed endpoint takes one input at a time in older versions; loop for safety.
    for (const text of texts) {
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: text }),
      });
      if (!res.ok) throw new Error(`ollama embeddings ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { embedding?: number[] };
      if (!json.embedding) throw new Error('ollama returned no embedding');
      out.push(json.embedding);
    }
    return out;
  },
};

export const openaiEmbeddings: EmbeddingProvider = {
  name: 'openai',
  isLocal: false,
  async embed(texts, config) {
    const base = config.base_url ?? 'https://api.openai.com/v1';
    const env = config.api_key_env ?? 'OPENAI_API_KEY';
    const key = process.env[env];
    if (!key) throw new Error(`missing API key: set ${env}`);
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.model, input: texts }),
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return (json.data ?? []).map((d) => d.embedding);
  },
};

export function getEmbeddingProvider(name: EmbeddingConfig['provider']): EmbeddingProvider | null {
  if (name === 'ollama') return ollamaEmbeddings;
  if (name === 'openai') return openaiEmbeddings;
  return null;
}

// ------------------------------------------------------------------ storage

/** Float32 round-trip. Float64 would double the size for no useful precision here. */
export function packVector(vec: number[]): Buffer {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function unpackVector(buf: Buffer): Float32Array {
  // Copy rather than view: the Buffer may be a slice of a larger pooled allocation.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The text an item is embedded from: its statement plus the reason it is held. */
export function embeddingText(item: MemoryItem): string {
  return [item.category, item.text, item.reason ?? ''].filter(Boolean).join('\n');
}

export interface BackfillResult {
  embedded: number;
  skipped: number;
  failed: number;
  error?: string;
}

export class EmbeddingIndex {
  constructor(
    private store: ContextStore,
    private config: EmbeddingConfig,
  ) {}

  get enabled(): boolean {
    return this.config.enabled && this.config.provider !== 'none';
  }

  /** How much the semantic ranking counts when fused with BM25. */
  get weight(): number {
    return this.config.weight;
  }

  get isLocal(): boolean {
    return getEmbeddingProvider(this.config.provider)?.isLocal ?? true;
  }

  get model(): string {
    return this.config.model;
  }

  /** Items whose text has changed, or which were never embedded. */
  stale(limit: number): MemoryItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT m.*, e.text_hash AS existing_hash
         FROM memory_items m LEFT JOIN memory_embeddings e ON e.item_id = m.id
         WHERE m.status = 'active'
         LIMIT ?`,
      )
      .all(limit * 4) as Array<Record<string, unknown>>;

    const out: MemoryItem[] = [];
    for (const r of rows) {
      const item = this.store.getItem(String(r.id));
      if (!item) continue;
      const hash = sha256(embeddingText(item));
      if (r.existing_hash === hash) continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  async backfill(limit?: number): Promise<BackfillResult> {
    if (!this.enabled) return { embedded: 0, skipped: 0, failed: 0, error: 'embeddings disabled' };
    const provider = getEmbeddingProvider(this.config.provider);
    if (!provider) return { embedded: 0, skipped: 0, failed: 0, error: 'no embedding provider' };

    const items = this.stale(limit ?? this.config.batch_size);
    if (items.length === 0) return { embedded: 0, skipped: 0, failed: 0 };

    try {
      const vectors = await provider.embed(items.map(embeddingText), this.config);
      let embedded = 0;
      const stmt = this.store.db.prepare(
        `INSERT INTO memory_embeddings (item_id, model, dim, vec, text_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           model = excluded.model, dim = excluded.dim, vec = excluded.vec,
           text_hash = excluded.text_hash, created_at = excluded.created_at`,
      );
      const now = new Date().toISOString();
      this.store.db.transaction(() => {
        for (const [n, item] of items.entries()) {
          const vec = vectors[n];
          if (!vec) return;
          stmt.run(item.id, this.config.model, vec.length, packVector(vec), sha256(embeddingText(item)), now);
          embedded += 1;
        }
      })();
      return { embedded, skipped: 0, failed: items.length - embedded };
    } catch (err) {
      // A missing local model is the common case; it must not break retrieval.
      return { embedded: 0, skipped: 0, failed: items.length, error: (err as Error).message };
    }
  }

  /**
   * Cosine ranking over the stored vectors. Exhaustive by design: at this scale the scan is
   * far cheaper than maintaining an index, and it cannot go stale.
   */
  async rank(query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
    if (!this.enabled) return [];
    const provider = getEmbeddingProvider(this.config.provider);
    if (!provider) return [];

    let queryVec: Float32Array;
    try {
      const [vec] = await provider.embed([query], this.config);
      if (!vec) return [];
      queryVec = new Float32Array(vec);
    } catch {
      // Provider down: fall back to keyword-only ranking rather than failing the query.
      return [];
    }

    const rows = this.store.db
      .prepare(
        `SELECT e.item_id, e.vec FROM memory_embeddings e
         JOIN memory_items m ON m.id = e.item_id
         WHERE m.status = 'active' AND e.dim = ?`,
      )
      .all(queryVec.length) as Array<{ item_id: string; vec: Buffer }>;

    return rows
      .map((r) => ({ id: r.item_id, score: cosine(queryVec, unpackVector(r.vec)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  count(): number {
    return (
      this.store.db.prepare(`SELECT COUNT(*) n FROM memory_embeddings`).get() as { n: number }
    ).n;
  }
}

/**
 * Reciprocal rank fusion of two ranked lists.
 *
 * Chosen over score averaging because BM25 scores and cosine similarities are not on a
 * comparable scale, and normalising them would introduce a tuning parameter per corpus.
 * RRF only needs the ordering.
 */
export function reciprocalRankFusion(
  lists: Array<{ ids: string[]; weight: number }>,
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ids, weight } of lists) {
    if (weight <= 0) continue;
    for (const [rank, id] of ids.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank + 1));
    }
  }
  return scores;
}
