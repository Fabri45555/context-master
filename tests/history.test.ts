import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectBenefits } from '../src/metrics/benefits.js';
import { collectHistory, toWeeks, weekOf, type HistoryBucket } from '../src/metrics/history.js';
import { MIRROR_LABEL } from '../src/ops/mirror.js';
import { collectRequests } from '../src/metrics/requests.js';
import { makeManager } from './helpers.js';

/**
 * Savings over time are rebuilt from the retrieval log, not sampled - the same decision as the
 * never_retrieved trend. If the running total ever ends somewhere other than the Benefits figure,
 * the chart is the history of some other number.
 */
function toolTraffic(session: string, n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    hook_event_name: 'PostToolUse',
    session_id: session,
    tool_name: 'Read',
    tool_input: { file_path: `/project/src/file${i}.ts` },
    tool_response: { file: { numLines: 10 } },
  }));
}

/** retrieval_log stamps "now"; move the latest row so two serves can be hours apart. */
function backdateLastServe(db: { prepare(sql: string): { run(...a: unknown[]): unknown } }, at: string): void {
  db.prepare(`UPDATE retrieval_log SET at = ? WHERE rowid = (SELECT MAX(rowid) FROM retrieval_log)`).run(at);
}

describe('savings history', () => {
  it('ends the running total of tokens avoided exactly at the Benefits figure', () => {
    const { manager, cleanup } = makeManager();
    try {
      mkdirSync(join(manager.projectRoot, 'docs'), { recursive: true });
      writeFileSync(join(manager.projectRoot, 'README.md'), 'x'.repeat(40_000));
      manager.ingestOnly('claude', toolTraffic('s1', 6), { sessionId: 's1', cwd: manager.projectRoot });
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });

      manager.serveBootstrap('s1');
      backdateLastServe(manager.store.db, '2026-09-14T09:00:00.000Z');
      const small = manager.bootstrapContext().tokens;

      // Memory grows between resumes, so each resume served a different bootstrap. Charging both
      // today's size would be inventing history.
      manager.remember({
        add: [
          { id: 'd2', category: 'decisions', text: 'Workers are single calls with at most one repair retry' },
          { id: 'c1', category: 'constraints', text: 'Never store counts, percentages or timings as memory' },
        ],
      });
      manager.serveBootstrap('s1');
      backdateLastServe(manager.store.db, '2026-09-15T09:00:00.000Z');
      manager.serveBootstrap(null); // the same resume again, over MCP
      backdateLastServe(manager.store.db, '2026-09-15T09:00:40.000Z');
      manager.serveBootstrap(null, { label: MIRROR_LABEL }); // a copy, not a resume (invariant 46)
      manager.queryContext('writer', { sessionId: 's1' });

      const history = collectHistory(manager.store, manager.config, manager.projectRoot);
      const benefits = collectBenefits(manager.store, manager.config, manager.metrics(null), manager.projectRoot);

      expect(history.resumes).toHaveLength(2);
      expect(benefits.delivery.resumes).toBe(2);
      expect(history.resumes[0]!.served_tokens).toBe(small);
      expect(history.resumes[1]!.served_tokens).toBeGreaterThan(small);
      expect(history.resumes.at(-1)!.cumulative_avoided).toBe(benefits.delivery.tokens_avoided);
      expect(history.tokens_avoided).toBe(benefits.delivery.tokens_avoided);
      expect(benefits.delivery.tokens_avoided).toBe(
        2 * 10_000 - history.resumes[0]!.served_tokens - history.resumes[1]!.served_tokens,
      );

      // The mirror is a delivery, but neither a resume nor a targeted query.
      expect(benefits.delivery.mirror).toBe(1);
      expect(benefits.delivery.query).toBe(1);
      const sum = (k: keyof HistoryBucket) => history.daily.reduce((n, b) => n + (b[k] as number), 0);
      expect(sum('resumes')).toBe(2);
      expect(sum('queries')).toBe(1);
      expect(sum('tokens_avoided')).toBe(benefits.delivery.tokens_avoided);
      // Discarded events are a counter with no date: stored rows are what the buckets can hold.
      const m = manager.metrics(null);
      expect(sum('events')).toBe(m.events.stored);
      expect(sum('settled_by_code')).toBe(m.events.inert);
      expect(history.discarded_undated).toBe(m.events.discarded);
      expect(history.daily.map((b) => b.start)).toEqual([...history.daily.map((b) => b.start)].sort());
      expect(history.weekly.reduce((n, b) => n + b.resumes, 0)).toBe(2);

      // Per request: the same rows, the same window, so the savings add up to the same total.
      const log = collectRequests(manager.store, manager.config, manager.projectRoot);
      expect(log.total).toBe(5);
      expect(log.rows.map((r) => r.kind).reverse()).toEqual(['resume', 'resume', 'resume_repeat', 'mirror', 'query']);
      expect(log.resumes).toBe(benefits.delivery.resumes);
      expect(log.queries).toBe(benefits.delivery.query);
      expect(log.tokens_avoided).toBe(benefits.delivery.tokens_avoided);
      expect(log.rows.reduce((n, r) => n + (r.avoided_tokens ?? 0), 0)).toBe(benefits.delivery.tokens_avoided);
      // A query has no measured alternative: a dash, never an invented saving.
      const query = log.rows.find((r) => r.kind === 'query')!;
      expect(query.avoided_tokens).toBeNull();
      expect(query.query).toBe('writer');
      expect(log.rows.find((r) => r.kind === 'resume_repeat')!.avoided_tokens).toBe(0);
      expect(collectRequests(manager.store, manager.config, manager.projectRoot, 2).rows).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('is empty rather than invented when nothing was served', () => {
    const { manager, cleanup } = makeManager();
    try {
      const h = collectHistory(manager.store, manager.config, manager.projectRoot);
      expect(h.resumes).toEqual([]);
      expect(h.tokens_avoided).toBe(0);
      expect(h.daily).toEqual([]);
      expect(h.first_at).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('buckets weeks from Monday, UTC', () => {
    expect(weekOf('2026-09-21')).toBe('2026-09-21'); // a Monday
    expect(weekOf('2026-09-27')).toBe('2026-09-21'); // the Sunday after
    expect(weekOf('2026-09-20')).toBe('2026-09-14');
    const day = (start: string, resumes: number): HistoryBucket => ({
      start, resumes, queries: 1, events: 10, settled_by_code: 5, worker_runs: 0, worker_tokens: 0,
      worker_cost_usd: 0, tokens_avoided: 100 * resumes,
    });
    const weeks = toWeeks([day('2026-09-19', 1), day('2026-09-20', 2), day('2026-09-22', 3)]);
    expect(weeks.map((w) => [w.start, w.resumes, w.queries, w.tokens_avoided])).toEqual([
      ['2026-09-14', 3, 2, 300],
      ['2026-09-21', 3, 1, 300],
    ]);
  });
});

describe('benefits by session', () => {
  it('scopes deliveries to one session and leaves project-wide figures alone', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });
      manager.ingestOnly('claude', toolTraffic('s1', 8), { sessionId: 's1', cwd: manager.projectRoot });
      manager.ingestOnly('claude', toolTraffic('s2', 3), { sessionId: 's2', cwd: manager.projectRoot });
      manager.serveBootstrap('s1');
      backdateLastServe(manager.store.db, '2026-09-14T09:00:00.000Z');
      manager.serveBootstrap('s2');
      manager.queryContext('writer', { sessionId: 's2' });

      const all = collectBenefits(manager.store, manager.config, manager.metrics(null), manager.projectRoot);
      const s2 = collectBenefits(manager.store, manager.config, manager.metrics('s2'), manager.projectRoot, 's2');
      expect(all.delivery.resumes).toBe(2);
      expect(s2.delivery.resumes).toBe(1);
      expect(s2.delivery.query).toBe(1);
      expect(s2.triage.events).toBeLessThan(all.triage.events);
      // Memory belongs to the project: the same number in either scope.
      expect(s2.protection.user_critical_items).toBe(all.protection.user_critical_items);
      expect(s2.quality.active_items).toBe(all.quality.active_items);
    } finally {
      cleanup();
    }
  });
});
