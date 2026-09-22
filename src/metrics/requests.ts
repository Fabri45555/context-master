import type { Config } from '../core/config.js';
import { MIRROR_LABEL } from '../ops/mirror.js';
import type { ContextStore } from '../store/store.js';
import { avoidedFor, rebuildBaseline, RESUME_WINDOW_MS } from './benefits.js';

/**
 * Every delivery of memory to an agent, one row each, with what that delivery saved - headroom's
 * "Recent requests", for a tool that does not sit on the wire.
 *
 * Only a resume has a measurable alternative: without memory, a fresh session re-reads the
 * project's documents, so it saves those tokens minus the bootstrap it was served. The second
 * serve of the same resume (the hook, then `memory_bootstrap`) is that context again and saves
 * nothing more. A targeted query inside a session has no measured "without" - the session already
 * holds its context - so it reports what it cost and `avoided: null`, never an invented figure.
 * The mirror copy is a delivery to a file, not to an agent's context (invariant 46).
 *
 * Rows are grouped into resumes with the same window as `resumesFrom`, over the same rows, so the
 * per-request savings add up to exactly the Benefits total (tested).
 */
export type RequestKind = 'resume' | 'resume_repeat' | 'query' | 'mirror' | 'empty';

export interface RequestRow {
  id: string;
  at: string;
  session_id: string | null;
  kind: RequestKind;
  /** The query as the agent asked it; null for a bootstrap. */
  query: string | null;
  item_ids: string[];
  /** Tokens of memory this delivery put in front of the agent. */
  tokens: number;
  /** What re-orienting from the documents would have cost; only a resume has one. */
  alternative_tokens: number | null;
  /** alternative - tokens for a resume; null where there is no measured alternative. */
  avoided_tokens: number | null;
}

export interface RequestLog {
  rebuild_tokens: number;
  rebuild_source: 'config' | 'documents';
  total: number;
  resumes: number;
  queries: number;
  tokens_served: number;
  /** Sum over every resume, not only the rows returned - equals Benefits' tokens_avoided. */
  tokens_avoided: number;
  /** Newest first, at most `limit`. */
  rows: RequestRow[];
}

export function collectRequests(
  store: ContextStore,
  config: Config,
  projectRoot: string | null,
  limit = 100,
): RequestLog {
  const rebuild = rebuildBaseline(config, projectRoot);
  const raw = store.db
    .prepare(`SELECT id, session_id, query, item_ids, tokens, at FROM retrieval_log ORDER BY at, rowid`)
    .all() as Array<{ id: string; session_id: string | null; query: string; item_ids: string; tokens: number; at: string }>;

  const rows: RequestRow[] = [];
  let lastServe: number | null = null;
  const totals = { resumes: 0, queries: 0, served: 0, avoided: 0 };

  for (const r of raw) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(r.item_ids) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // A malformed row still happened; it is shown with no items.
    }
    let kind: RequestKind;
    if (r.query === MIRROR_LABEL) kind = 'mirror';
    else if (r.query !== '(bootstrap)') kind = 'query';
    else if (ids.length === 0) kind = 'empty';
    else {
      // Exactly resumesFrom's rule: a serve opens a resume when the previous serve is more than
      // the window away, and every serve moves the window on.
      const t = Date.parse(r.at);
      kind = lastServe == null || t - lastServe > RESUME_WINDOW_MS ? 'resume' : 'resume_repeat';
      lastServe = t;
    }

    const avoided = kind === 'resume' ? avoidedFor(r, rebuild.tokens) : kind === 'resume_repeat' ? 0 : null;
    if (kind === 'resume') totals.resumes += 1;
    if (kind === 'query') totals.queries += 1;
    if (kind !== 'mirror') totals.served += r.tokens;
    totals.avoided += avoided ?? 0;

    rows.push({
      id: r.id,
      at: r.at,
      session_id: r.session_id,
      kind,
      query: kind === 'query' ? r.query : null,
      item_ids: ids,
      tokens: r.tokens,
      alternative_tokens: kind === 'resume' || kind === 'resume_repeat' ? rebuild.tokens : null,
      avoided_tokens: avoided,
    });
  }

  return {
    rebuild_tokens: rebuild.tokens,
    rebuild_source: rebuild.source,
    total: rows.length,
    resumes: totals.resumes,
    queries: totals.queries,
    tokens_served: totals.served,
    tokens_avoided: totals.avoided,
    rows: rows.slice(-Math.max(0, limit)).reverse(),
  };
}
