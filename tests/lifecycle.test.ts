import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  actionsFor,
  assessPressure,
  needsProvider,
  type PressureInput,
} from '../src/core/lifecycle.js';
import { ScriptedProvider, makeManager, testConfig } from './helpers.js';

function input(over: Partial<PressureInput> = {}): PressureInput {
  return {
    occupiedTokens: 0,
    observedPeakTokens: 0,
    model: null,
    pendingEvents: 0,
    pendingTokens: 0,
    compactionRequested: false,
    stateVersion: 3,
    bootstrapTokens: 400,
    ...over,
  };
}

describe('context pressure', () => {
  it('stays steady with an empty session and reports no occupancy', () => {
    const p = assessPressure(testConfig(), input());
    expect(p.stage).toBe('steady');
    expect(p.ratio).toBeNull();
    expect(p.actions).toHaveLength(0);
    expect(p.window_source).toBe('default');
    expect(p.window_tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('climbs one rung per threshold', () => {
    const w = DEFAULT_CONTEXT_WINDOW_TOKENS;
    const at = (share: number) =>
      assessPressure(testConfig(), input({ occupiedTokens: w * share, observedPeakTokens: w * share }));
    expect(at(0.3).stage).toBe('steady');
    expect(at(0.6).stage).toBe('maintain');
    expect(at(0.8).stage).toBe('consolidate');
    expect(at(0.95).stage).toBe('reduce');
  });

  it('lets an observed occupancy disprove an inferred window', () => {
    // Found on a real session: the agent reported `claude-opus-5` while occupying 512,598
    // tokens. Trusting the model id put it at 256% of a 200k window, which pinned the ladder
    // at its most expensive rung for the whole session.
    const p = assessPressure(
      testConfig(),
      input({ occupiedTokens: 150_970, observedPeakTokens: 512_598, model: 'claude-opus-5' }),
    );
    expect(p.window_tokens).toBe(1_000_000);
    expect(p.window_source).toBe('observed');
    expect(p.stage).toBe('steady');
  });

  it('keeps an explicit window even when a turn exceeded it', () => {
    // The user pinning a window is a statement about the budget they want respected.
    const config = testConfig({ lifecycle: { context_window_tokens: 100_000 } } as never);
    const p = assessPressure(config, input({ occupiedTokens: 90_000, observedPeakTokens: 400_000 }));
    expect(p.window_tokens).toBe(100_000);
    expect(p.window_source).toBe('config');
  });

  it('spends nothing at the free rungs and only then reaches for a model', () => {
    // The whole economic argument: escalation must cost nothing until it has to.
    expect(actionsFor('maintain').some(needsProvider)).toBe(false);
    expect(actionsFor('consolidate').some(needsProvider)).toBe(true);
    expect(actionsFor('reduce')).toContain('reconcile');
  });

  it('infers the window from the model, and a declared long-context variant beats the default', () => {
    const short = assessPressure(
      testConfig(),
      input({ occupiedTokens: 1, observedPeakTokens: 1, model: 'claude-opus-5' }),
    );
    expect(short.window_tokens).toBe(200_000);
    expect(short.window_source).toBe('model');

    const long = assessPressure(
      testConfig(),
      input({ occupiedTokens: 1, observedPeakTokens: 1, model: 'claude-opus-5[1m]' }),
    );
    expect(long.window_tokens).toBe(1_000_000);
  });

  it('never lets an inferred window override an explicit one', () => {
    // Behind a gateway that caps the window, the model's own figure is a lie about capacity.
    const config = testConfig({ lifecycle: { context_window_tokens: 50_000 } } as never);
    const p = assessPressure(
      config,
      input({ occupiedTokens: 40_000, observedPeakTokens: 40_000, model: 'claude-opus-5[1m]' }),
    );
    expect(p.window_tokens).toBe(50_000);
    expect(p.window_source).toBe('config');
    expect(p.stage).toBe('consolidate');
  });

  it('treats the agent asking to compact as the ladder having already lost', () => {
    const p = assessPressure(testConfig(), input({ compactionRequested: true }));
    expect(p.stage).toBe('reduce');
    expect(p.reasons).toContain('compaction_requested');
  });

  it('escalates on backlog even when the agent context is nearly empty', () => {
    // A backlog is stored context we cannot yet serve, which is its own kind of pressure.
    const p = assessPressure(testConfig(), input({ pendingEvents: 900, pendingTokens: 90_000 }));
    expect(p.stage).toBe('consolidate');
    expect(p.reasons.some((r) => r.startsWith('backlog_tokens'))).toBe(true);
  });

  it('reports recovery as not ready when a large backlog sits under high occupancy', () => {
    // K5 asked before the fact: compacting now would lose everything still unprocessed.
    const p = assessPressure(
      testConfig(),
      input({
        occupiedTokens: 190_000,
        observedPeakTokens: 190_000,
        pendingEvents: 3000,
        pendingTokens: 400_000,
      }),
    );
    expect(p.stage).toBe('reduce');
    expect(p.recovery_ready).toBe(false);
    expect(p.recovery_blockers.join(' ')).toContain('3000 events unprocessed');
  });

  it('reports recovery as not ready when nothing has been derived at all', () => {
    const p = assessPressure(testConfig(), input({ stateVersion: 0, bootstrapTokens: 0 }));
    expect(p.recovery_ready).toBe(false);
    expect(p.recovery_blockers).toContain('no derived state yet');
  });
});

describe('the ladder in the manager', () => {
  it('runs nothing while steady', async () => {
    const provider = new ScriptedProvider([]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      const { assessment, performed } = await manager.runLifecycle(null);
      expect(assessment.stage).toBe('steady');
      expect(performed).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('takes only the free rungs when told to stay deterministic', async () => {
    const provider = new ScriptedProvider([JSON.stringify({})]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      const { assessment, performed, skipped } = await manager.runLifecycle('s1', {
        deterministicOnly: true,
      });

      expect(assessment.stage).toBe('reduce');
      // The hook path is synchronous for the agent, so no provider may be called from it.
      expect(provider.calls).toHaveLength(0);
      expect(performed.map((p) => p.action)).toEqual(['fold', 'decay', 'prune']);
      expect(skipped).toContain('reconcile');
    } finally {
      cleanup();
    }
  });

  it('stops treating a compaction as live once the agent has taken another turn', async () => {
    // The request event sat pending in the queue after the compaction had finished, which kept a
    // real session at `reduce` - the most expensive rung - with its window half empty.
    const { manager, cleanup } = makeManager();
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'manual' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      expect(manager.pressure('s1').reasons).toContain('compaction_requested');

      await new Promise((r) => setTimeout(r, 5));
      manager.store.recordAgentUsage('s1', { input_tokens: 20_000 }, 'claude-opus-5');
      const after = manager.pressure('s1');
      expect(after.reasons).not.toContain('compaction_requested');
      expect(after.stage).not.toBe('reduce');
      // It still happened: the failure counter is not the flag.
      expect(manager.metrics('s1').lifecycle.hard_compactions).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('counts a hard compaction once, not once per duplicate hook delivery', async () => {
    const { manager, cleanup } = makeManager();
    try {
      const payload = { hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' };
      manager.ingestOnly('claude', [payload], { sessionId: 's1', cwd: manager.projectRoot });
      manager.ingestOnly('claude', [payload], { sessionId: 's1', cwd: manager.projectRoot });

      // Hook and transcript ingestion overlap by design, so the counter has to survive it.
      expect(manager.hardCompactions('s1')).toBe(1);
      expect(manager.metrics('s1').lifecycle.hard_compactions).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('folds a queued event a rule can now explain, sparing a model the read', async () => {
    // One pending event is enough to reach the free rungs here, so the test is about refold
    // rather than about where the thresholds happen to sit.
    const { manager, cleanup } = makeManager({ lifecycle: { backlog_event_threshold: 1 } } as never);
    try {
      manager.ingestOnly(
        'claude',
        [
          {
            hook_event_name: 'PostToolUse',
            session_id: 's1',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_response: {
              stdout: '',
              stderr: 'FAIL tests/auth.test.ts\nTypeError: cannot read property id of undefined',
              exit_code: 1,
            },
          },
        ],
        { sessionId: 's1', cwd: manager.projectRoot },
      );

      // Simulate the case refold exists for: an event that was queued before any rule could
      // explain it. Clearing processed_at is the only way to reproduce that from outside.
      manager.store.db.prepare(`UPDATE events SET processed_at = NULL`).run();
      expect(manager.store.pendingSummary('s1').count).toBeGreaterThan(0);

      const { performed } = await manager.runLifecycle('s1', { deterministicOnly: true });
      const fold = performed.find((p) => p.action === 'fold');
      expect(fold?.detail).toMatch(/[1-9]\d* events folded/);
    } finally {
      cleanup();
    }
  });

  it('refold never marks an event processed that nothing derived state from', async () => {
    const { manager, cleanup } = makeManager({ lifecycle: { backlog_event_threshold: 1 } } as never);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'switch auth to OIDC' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      const before = manager.store.pendingSummary('s1').count;
      expect(before).toBeGreaterThan(0);

      await manager.runLifecycle('s1', { deterministicOnly: true });

      // A user message needs meaning, so it must still be waiting for a worker. Marking it
      // done here would make `processed_at` a lie and inflate coverage (invariant 5).
      expect(manager.store.pendingSummary('s1').count).toBe(before);
    } finally {
      cleanup();
    }
  });

  it('reports pressure from the latest turn, not the peak', async () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.store.upsertSession({ id: 's1', source: 'claude', agent: 'claude', cwd: null });
      manager.store.recordAgentUsage('s1', { input_tokens: 180_000 }, 'claude-opus-5');
      manager.store.recordAgentUsage('s1', { input_tokens: 9_000 }, 'claude-opus-5');

      // After a compaction the occupancy drops; reading the peak would keep us escalated
      // forever and spend a model on work that is no longer needed.
      const p = manager.pressure('s1');
      expect(p.occupied_tokens).toBe(9_000);
      expect(p.stage).toBe('steady');
    } finally {
      cleanup();
    }
  });
});

describe('occupancy on a hook-only install', () => {
  it('reads the last turn from the transcript on Stop, once per message', async () => {
    // Hook payloads carry no usage. A live session compacted, and the ladder went on reading the
    // pre-compaction peak because nothing but `attach` had ever recorded a turn.
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { manager, cleanup } = makeManager();
    try {
      const transcript = join(manager.projectRoot, 't.jsonl');
      const turn = (id: string, cached: number) => JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: { id, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cached } },
      });
      writeFileSync(transcript, [turn('msg_a', 500_000), turn('msg_b', 30_000)].join('\n') + '\n');

      manager.ingestOnly('claude', [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'manual' }],
        { sessionId: 's1', cwd: manager.projectRoot });
      await new Promise((r) => setTimeout(r, 5));

      const stop = { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcript };
      expect(manager.observeUsage('claude', stop, 's1')).toBe(true);
      expect(manager.observeUsage('claude', stop, 's1')).toBe(true);

      expect(manager.metrics('s1').agent.turns).toBe(1);
      const p = manager.pressure('s1');
      expect(p.occupied_tokens).toBe(30_010);
      expect(p.reasons).not.toContain('compaction_requested');
      // Anything but Stop has no finished turn to read.
      expect(manager.observeUsage('claude', { ...stop, hook_event_name: 'PreToolUse' }, 's1')).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('the always-on slice', () => {
  it('keeps a hedged worker guess out of every session but still finds it on request', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          {
            id: 'mem_guess',
            category: 'decisions',
            text: 'The rate limiter probably uses a sliding window',
            source: 'worker',
            importance: 'medium',
            confidence: 0.3,
          },
        ],
      });

      // The bootstrap is paid for on every single session, so a guess does not belong in it.
      expect(manager.bootstrapContext().itemIds).not.toContain('mem_guess');
      // But it is withheld, not lost: a query about the area still surfaces it.
      expect(manager.queryContext('rate limiter sliding window').itemIds).toContain('mem_guess');
    } finally {
      cleanup();
    }
  });

  it('never withholds a user constraint, however low its confidence', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          {
            id: 'mem_user',
            category: 'constraints',
            text: 'Never store refresh tokens in Redis',
            source: 'user',
            importance: 'critical',
            confidence: 0.1,
          },
        ],
      });
      expect(manager.bootstrapContext().itemIds).toContain('mem_user');
    } finally {
      cleanup();
    }
  });

  it('serves the goals, since they are the one thing the repository cannot tell a new session', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'g1', category: 'goals', text: 'Ship the billing export by Friday' },
          { id: 'r1', category: 'requirements', text: 'The export must be CSV with a header row' },
        ],
      });
      const built = manager.bootstrapContext();
      expect(built.itemIds).toEqual(expect.arrayContaining(['g1', 'r1']));
      expect(built.text).toContain('## Goals');
    } finally {
      cleanup();
    }
  });

  it('gives every category a place: served at session start, or left to query on purpose', async () => {
    const { MEMORY_CATEGORIES } = await import('../src/core/state.js');
    const { BOOTSTRAP_SECTIONS, QUERY_ONLY_CATEGORIES } = await import('../src/retrieval/context-builder.js');
    const placed = [...BOOTSTRAP_SECTIONS.flatMap((s) => s.categories), ...QUERY_ONLY_CATEGORIES];
    expect([...placed].sort()).toEqual([...MEMORY_CATEGORIES].sort());
  });

  it('counts a served bootstrap as a retrieval, and a measured one as nothing', () => {
    // SessionStart injection and memory_bootstrap are how most memory reaches an agent. Counting
    // only queries left every always-on item looking never-retrieved.
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });

      manager.bootstrapContext();
      expect(manager.metrics(null).retrieval.count).toBe(0);

      manager.serveBootstrap('s1');
      const m = manager.metrics(null);
      expect(m.retrieval.count).toBe(1);
      expect(m.precision.never_retrieved_ratio).toBe(0);
    } finally {
      cleanup();
    }
  });
});
