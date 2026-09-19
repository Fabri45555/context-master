import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, dbPath } from '../src/store/db.js';
import { ContextStore } from '../src/store/store.js';
import { RetrievalEngine, toMatchQuery } from '../src/store/retrieval.js';
import { ContextBuilder } from '../src/retrieval/context-builder.js';
import { event, testConfig } from './helpers.js';
import type { EventDecision } from '../src/core/deterministic.js';

function decision(e: ReturnType<typeof event>, over: Partial<EventDecision> = {}): EventDecision {
  return {
    action: 'persist_and_queue',
    event: e,
    importance: e.importance,
    reasons: ['test'],
    tokens: 25,
    ...over,
  };
}

describe('context store', () => {
  let dir: string;
  let store: ContextStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextd-store-'));
    store = new ContextStore(openDb(dbPath(dir)));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deduplicates by content hash within a session', () => {
    const e = event('USER_MESSAGE', { text: 'no Redis' });
    expect(store.insertEvent(decision(e))).toBe(true);
    expect(store.insertEvent(decision({ ...e, id: 'different' }))).toBe(false);
    expect(store.isDuplicate(e.session_id, e.dedupe_hash)).toBe(true);
  });

  it('leaves every inserted event pending until something derives state from it', () => {
    // Marking an event processed at insert would claim the history is already represented
    // in memory; only the deterministic fold or a worker may make that claim.
    store.insertEvent(decision(event('FILE_CHANGED', { path: 'a.ts' }), { action: 'persist' }));
    store.insertEvent(decision(event('USER_MESSAGE', { text: 'do not touch auth' })));
    expect(store.pendingEvents('s1')).toHaveLength(2);
  });

  it('counts discards without storing them', () => {
    expect(store.countDiscarded('s1')).toBe(0);
    store.noteDiscarded('s1', 3);
    store.noteDiscarded('s1');
    expect(store.countDiscarded('s1')).toBe(4);
    expect(store.countDiscarded()).toBe(4);
    expect(store.pendingEvents('s1')).toHaveLength(0);
  });

  it('summarises the pending queue for the trigger evaluator', () => {
    store.insertEvent(decision(event('USER_MESSAGE', { text: 'x' }, { importance: 'high' })));
    store.insertEvent(decision(event('COMPACTION_REQUESTED', {}, { importance: 'high' })));
    const s = store.pendingSummary('s1');
    expect(s.count).toBe(2);
    expect(s.tokens).toBe(50);
    expect(s.highest).toBe('high');
    expect(s.compactionRequested).toBe(true);
  });

  it('commits a patch, bumps the version and materialises items', () => {
    const r = store.commitPatch(
      {
        working: { current_task: 'ship the thing' },
        add: [{ category: 'decisions', text: 'Use PostgreSQL', reason: 'no Redis in prod' }],
      },
      'worker',
      { sessionId: 's1' },
    );
    expect(r.ok).toBe(true);
    expect(r.version).toBe(1);
    expect(store.stateVersion()).toBe(1);
    expect(store.workingMemory().current_task).toBe('ship the thing');
    expect(store.allItems()).toHaveLength(1);
  });

  it('leaves state untouched when a patch is rejected', () => {
    store.commitPatch({ add: [{ category: 'goals', text: 'a' }] }, 'worker', {});
    const before = store.stateVersion();
    const r = store.commitPatch({ update: [{ id: 'mem_nope', text: 'x' }] }, 'worker', {});
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.code).toBe('unknown_item');
    expect(store.stateVersion()).toBe(before);
  });

  it('rebuilds the same state by folding the patch log', () => {
    store.commitPatch(
      { add: [{ id: 'mem_a', category: 'constraints', text: 'No public API changes', source: 'user', importance: 'critical' }] },
      'user',
      {},
    );
    store.commitPatch({ working: { current_task: 'auth refactor' } }, 'worker', {});
    store.commitPatch(
      { add: [{ id: 'mem_b', category: 'decisions', text: 'Rotate refresh tokens', supersedes: [] }] },
      'worker',
      {},
    );

    const folded = store.replay();
    const live = store.currentState(true);
    expect(folded.version).toBe(live.version);
    expect(folded.items.map((i) => i.id).sort()).toEqual(live.items.map((i) => i.id).sort());
    expect(folded.working.current_task).toBe('auth refactor');
  });

  it('reproduces the same item ids on replay', () => {
    // Regression: ids minted inside applyPatch meant a replay produced a different set of
    // items, silently voiding the rollback and audit guarantees of the patch log.
    store.commitPatch({ add: [{ category: 'goals', text: 'ship it' }] }, 'worker', {});
    const live = store.currentState(true);
    const folded = store.replay();
    expect(folded.items.map((i) => i.id)).toEqual(live.items.map((i) => i.id));
  });

  it('can rebuild an earlier version', () => {
    store.commitPatch({ add: [{ id: 'mem_a', category: 'goals', text: 'first' }] }, 'worker', {});
    store.commitPatch({ add: [{ id: 'mem_b', category: 'goals', text: 'second' }] }, 'worker', {});
    const v1 = store.replay(1);
    expect(v1.items.map((i) => i.id)).toEqual(['mem_a']);
  });

  it('sheds low-value pending events under back-pressure', () => {
    for (let i = 0; i < 10; i += 1) {
      store.insertEvent(decision(event('TOOL_RESULT', { output: `out ${i}` }, { importance: 'low', ordinal: i })));
    }
    store.insertEvent(decision(event('USER_MESSAGE', { text: 'critical thing' }, { importance: 'critical' })));
    const shed = store.shedQueue(5);
    expect(shed).toBeGreaterThan(0);
    const remaining = store.pendingEvents(null, 100);
    // The critical event is never shed.
    expect(remaining.some((e) => e.importance === 'critical')).toBe(true);
    expect(remaining.length).toBeLessThanOrEqual(6);
  });

  it('tracks worker usage for the budget window', () => {
    const id = store.startWorkerRun({
      sessionId: 's1',
      task: 'extraction',
      tier: 'cheap',
      provider: 'scripted',
      model: 'm',
      eventCount: 3,
    });
    store.finishWorkerRun(id, { status: 'ok', inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
    expect(store.sessionWorkerCost('s1')).toBeCloseTo(0.01, 6);
    expect(store.recentWorkerUsage(Date.now() - 60_000)[0]!.tokens).toBe(120);
  });
});

describe('retrieval', () => {
  let dir: string;
  let store: ContextStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contextd-ret-'));
    store = new ContextStore(openDb(dbPath(dir)));
    store.commitPatch(
      {
        add: [
          {
            id: 'mem_api',
            category: 'constraints',
            text: 'Do not change the public API surface',
            source: 'user',
            importance: 'critical',
          },
          {
            id: 'mem_pg',
            category: 'decisions',
            text: 'Use PostgreSQL for refresh token storage',
            reason: 'production does not run Redis',
            importance: 'high',
          },
          {
            id: 'mem_css',
            category: 'conventions',
            text: 'Tailwind for styling, no CSS modules',
            importance: 'low',
          },
        ],
      },
      'user',
      {},
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a safe FTS query and drops noise words', () => {
    expect(toMatchQuery('the and for')).toBeNull();
    expect(toMatchQuery('refresh token" OR 1=1')).toContain('"refresh"*');
  });

  it('ranks a topical match above an unrelated item', () => {
    const hits = new RetrievalEngine(store).search('refresh token rotation');
    expect(hits[0]!.item.id).toBe('mem_pg');
    expect(hits.map((h) => h.item.id)).not.toContain('mem_css');
  });

  it('returns critical items regardless of the query', () => {
    const always = new RetrievalEngine(store).alwaysOn();
    expect(always.map((i) => i.id)).toContain('mem_api');
  });

  it('keeps the built context inside its budget and cites item ids', () => {
    const config = testConfig({ context_budget: { total_tokens: 400, reserve_for_retrieval: 150 } } as never);
    const built = new ContextBuilder(store, config).forQuery('refresh token');
    expect(built.tokens).toBeLessThanOrEqual(config.context_budget.total_tokens);
    expect(built.itemIds).toContain('mem_api');
    expect(built.text).toContain('Active constraints');
    // The reason a decision was taken travels with it (PRD 14).
    expect(built.text).toContain('production does not run Redis');
  });

  it('logs retrievals so accuracy can be measured later', () => {
    new ContextBuilder(store, testConfig()).forQuery('postgres');
    expect(store.retrievalStats().count).toBe(1);
  });
});
