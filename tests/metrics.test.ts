import { describe, expect, it } from 'vitest';
import { WorkerRunner } from '../src/workers/runner.js';
import { ScriptedProvider, makeManager } from './helpers.js';

/**
 * K1's third definition, and why.
 *
 * `coverage` began as derived/stored, which read 98.9% on an empty memory. Subtracting inert
 * events fixed that and introduced the opposite error: a session that discarded worthless tool
 * traffic *correctly* read 18.9% with nothing outstanding at all. Coverage now asks only about
 * events that could ever have produced state.
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

describe('coverage', () => {
  it('does not punish correctly discarding worthless events', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ add: [{ category: 'decisions', text: 'Keep the writer path synchronous' }] }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly('claude', toolTraffic('s1', 30), { sessionId: 's1', cwd: manager.projectRoot });
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'keep the writer path synchronous' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');

      const m = manager.metrics('s1');
      expect(m.events.pending).toBe(0);
      expect(m.events.inert).toBeGreaterThan(0);
      // Nothing is outstanding and state was derived, so there is no backlog to discount.
      expect(m.context.coverage).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('discounts a backlog nobody has read', () => {
    const { manager, cleanup } = makeManager();
    try {
      // Nine user messages queue for a worker that never runs, alongside inert tool traffic.
      manager.ingestOnly('claude', toolTraffic('s1', 10), { sessionId: 's1', cwd: manager.projectRoot });
      manager.ingestOnly(
        'claude',
        Array.from({ length: 9 }, (_, i) => ({
          hook_event_name: 'UserPromptSubmit',
          session_id: 's1',
          prompt: `question ${i} about the authentication flow`,
        })),
        { sessionId: 's1', cwd: manager.projectRoot },
      );

      const m = manager.metrics('s1');
      expect(m.events.pending).toBeGreaterThan(0);
      // Derived nothing yet, so no compression may be claimed.
      expect(m.context.coverage).toBe(0);
      expect(m.context.effective_reduction).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('stays at zero when a broken worker drains the queue without recording anything', async () => {
    const provider = new ScriptedProvider([JSON.stringify({}), JSON.stringify({})]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'switch the token store to PostgreSQL' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');

      const m = manager.metrics('s1');
      // The batch is closed as inert, so a naive "nothing pending" reading would report 100%.
      expect(m.events.pending).toBe(0);
      expect(m.memory.items).toBe(0);
      expect(m.context.coverage).toBe(0);
      expect(m.context.effective_reduction).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('retrieval accounting', () => {
  it('counts the items a query actually returned', () => {
    // `finish` used to recover ids by scraping its own rendered text for `[mem_...]`, so the
    // moment workers began assigning short ids like `d3` the list came back empty - and
    // `never_retrieved` was pinned at 100% no matter how much was retrieved.
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'd3', category: 'decisions', text: 'Guard supersede against user-critical items' },
          { id: 'mem_long', category: 'decisions', text: 'Unrelated styling convention' },
        ],
      });

      const built = manager.queryContext('supersede user critical guard');
      expect(built.itemIds).toContain('d3');

      const m = manager.metrics(null);
      expect(m.retrieval.count).toBe(1);
      expect(m.precision.never_retrieved_ratio).toBeLessThan(1);
    } finally {
      cleanup();
    }
  });

  it('labels each query hit with its category, so a fixed bug does not read as an open one', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [{ id: 'disc2', category: 'discoveries', text: 'The fold recorded ENOENT as a known issue', source: 'agent', importance: 'high', confidence: 0.9 }],
      });
      const built = manager.queryContext('fold ENOENT known issue', { record: false });
      expect(built.text).toContain('(discovery, historical) The fold recorded ENOENT');
    } finally {
      cleanup();
    }
  });

  it('does not count a preview that never reached an agent', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd3', category: 'decisions', text: 'Guard supersede against user-critical items' }] });
      manager.queryContext('supersede guard', { record: false });
      const m = manager.metrics(null);
      expect(m.retrieval.count).toBe(0);
      expect(m.precision.never_retrieved_ratio).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('rebuilds the never_retrieved history so that it ends at the current value', () => {
    // The dashboard trend is reconstructed from the retrieval log rather than sampled. If the
    // two ever disagree, the chart is showing a history of some other metric.
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'd3', category: 'decisions', text: 'Guard supersede against user-critical items' },
          { id: 'mem_css', category: 'conventions', text: 'Unrelated styling convention' },
        ],
      });
      const before = manager.store.neverRetrievedHistory();
      expect(before.at(-1)).toMatchObject({ total: 2, never: 2 });

      manager.queryContext('supersede guard', { record: false });
      expect(manager.store.neverRetrievedHistory()).toEqual(before);

      manager.queryContext('supersede user critical guard');
      manager.remember({ add: [{ id: 'mem_late', category: 'goals', text: 'Ship the dashboard trend' }] });

      const history = manager.store.neverRetrievedHistory();
      const last = history.at(-1)!;
      expect(last.never / last.total).toBeCloseTo(manager.metrics(null).precision.never_retrieved_ratio, 10);
      expect(last.never).toBeLessThan(last.total);
      expect(history.map((p) => p.at)).toEqual([...history.map((p) => p.at)].sort());
    } finally {
      cleanup();
    }
  });

  it('does not credit an item the budget dropped', () => {
    // Only what was rendered counts as retrieved; an item squeezed out was never shown.
    const { manager, cleanup } = makeManager({
      context_budget: { total_tokens: 400, reserve_for_retrieval: 40, sections: { decisions: 30 } },
    } as never);
    try {
      manager.remember({
        add: Array.from({ length: 12 }, (_, i) => ({
          id: `d${i}`,
          category: 'decisions' as const,
          text: `A decision with enough words in it to consume part of the section allowance ${i}`,
        })),
      });
      const built = manager.bootstrapContext();
      const rendered = built.sections.find((s) => s.title === 'Decisions');

      expect(rendered!.dropped).toBeGreaterThan(0);
      expect(built.itemIds).toHaveLength(rendered!.itemIds.length);
    } finally {
      cleanup();
    }
  });
});

describe('benefits', () => {
  it('reports only what was measured, and says so when there is nothing to compare against', async () => {
    const { collectBenefits } = await import('../src/metrics/benefits.js');
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });
      manager.ingestOnly('claude', toolTraffic('s1', 12), { sessionId: 's1', cwd: manager.projectRoot });

      let b = collectBenefits(manager.store, manager.config, manager.metrics(null));
      // No agent turn and no delivery: the page must not invent a saving.
      expect(b.resume.smaller_by).toBeNull();
      expect(b.delivery.tokens_avoided).toBe(0);
      expect(b.caveats.join(' ')).toMatch(/never been delivered/);
      expect(b.triage.handled_by_code).toBeGreaterThan(0);

      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(join(manager.projectRoot, 'docs'), { recursive: true });
      writeFileSync(join(manager.projectRoot, 'README.md'), 'x'.repeat(40_000));
      writeFileSync(join(manager.projectRoot, 'docs', 'design.md'), 'x'.repeat(20_000));
      // Loaded every session regardless, so re-reading it is not something memory avoids.
      writeFileSync(join(manager.projectRoot, 'CLAUDE.md'), 'x'.repeat(100_000));

      manager.store.recordAgentUsage('s1', { input_tokens: 50_000 }, 'claude-opus-5');
      manager.serveBootstrap('s1');
      manager.serveBootstrap(null); // the same resume, served again over MCP
      manager.queryContext('writer', { sessionId: 's1' }); // a query inside a session avoids nothing
      b = collectBenefits(manager.store, manager.config, manager.metrics(null), manager.projectRoot);
      expect(b.delivery.bootstrap).toBe(2);
      expect(b.delivery.resumes).toBe(1);
      expect(b.delivery.rebuild_tokens).toBe(15_000);
      expect(b.delivery.tokens_avoided).toBe(15_000 - b.resume.bootstrap_tokens);
      expect(b.resume.smaller_by).toBeGreaterThan(1);
      // No price was stated, so no dollar figure is made up.
      expect(b.delivery.usd_avoided).toBeNull();
      expect(b.quality.used_share).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('counts a compaction hours later as a second resume', async () => {
    const { countResumes } = await import('../src/metrics/benefits.js');
    expect(
      countResumes([
        { at: '2026-09-19T10:00:00Z', session_id: 's1' },
        { at: '2026-09-19T10:00:30Z', session_id: null },
        { at: '2026-09-19T13:00:00Z', session_id: 's1' },
      ]),
    ).toBe(2);
  });
});
