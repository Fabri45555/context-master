import { describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager } from '../src/daemon/manager.js';
import { benchmark } from '../src/bench/index.js';
import { ScriptedProvider, makeManager, tempProject } from './helpers.js';

/** Build a Claude Code transcript line the way the real agent writes one. */
function line(rec: Record<string, unknown>): string {
  return `${JSON.stringify(rec)}\n`;
}

function userTurn(uuid: string, text: string): string {
  return line({
    type: 'user',
    sessionId: 'sess-1',
    uuid,
    timestamp: new Date().toISOString(),
    cwd: '/proj',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantTurn(uuid: string, text: string, usage = { input_tokens: 4000, output_tokens: 150 }): string {
  return line({
    type: 'assistant',
    sessionId: 'sess-1',
    uuid,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage },
  });
}

function toolNoise(uuid: string, n: number): string {
  return line({
    type: 'user',
    sessionId: 'sess-1',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: `listing ${n}\n`.repeat(20) }],
    },
  });
}

describe('end to end', () => {
  it('runs a full cycle: ingest, deterministic filtering, worker, retrieval', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        working: {
          current_task: 'Implement OAuth refresh token rotation',
          task_status: 'in_progress',
          next_action: 'write the rotation endpoint',
        },
        add: [
          {
            id: 'mem_c1',
            category: 'constraints',
            text: 'Do not change the public API',
            source: 'user',
            importance: 'critical',
            confidence: 1,
          },
          {
            id: 'mem_d1',
            category: 'decisions',
            text: 'Store refresh tokens in PostgreSQL',
            reason: 'production infrastructure does not run Redis',
            importance: 'high',
            fields: { reason: 'production infrastructure does not run Redis' },
          },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);

    try {
      const records = [
        JSON.parse(userTurn('u1', 'Do not change the public API. Implement OAuth refresh token rotation.')),
        JSON.parse(assistantTurn('a1', "Redis is not available in production, so we'll use PostgreSQL instead.")),
        ...Array.from({ length: 6 }, (_, n) => JSON.parse(toolNoise(`t${n}`, n))),
      ];

      const result = await manager.cycle('claude', records, { sessionId: 'sess-1', cwd: manager.projectRoot });

      expect(result.ingest.received).toBe(8);
      expect(result.trigger.fire).toBe(true);
      expect(result.worker?.status).toBe('ok');

      // The state machine walked a legal path and came to rest.
      const states = result.transitions.map((t) => t.to);
      expect(states).toContain('CLASSIFY');
      expect(states).toContain('SPAWN_WORKER');
      expect(states[states.length - 1]).toBe('IDLE');

      // Retrieval returns the decision with its reason, and the constraint unconditionally.
      const ctx = manager.queryContext('refresh token storage');
      expect(ctx.text).toContain('PostgreSQL');
      expect(ctx.text).toContain('production infrastructure does not run Redis');
      expect(ctx.text).toContain('Do not change the public API');
      expect(ctx.tokens).toBeLessThan(manager.config.context_budget.total_tokens);
    } finally {
      cleanup();
    }
  });

  it('actually discards low-value noise and counts it', async () => {
    const { manager, cleanup } = makeManager({}, new ScriptedProvider([]));
    try {
      const records = [
        JSON.parse(userTurn('u1', 'Add rate limiting')),
        // Empty tool results carry nothing derivable and must not reach the store.
        ...Array.from({ length: 12 }, (_, n) =>
          JSON.parse(
            line({
              type: 'user',
              sessionId: 'sess-1',
              uuid: `empty${n}`,
              timestamp: new Date().toISOString(),
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: '' }],
              },
            }),
          ),
        ),
      ];
      const r = await manager.cycle('claude', records, { sessionId: 'sess-1', cwd: manager.projectRoot }, { runWorker: false });

      expect(r.ingest.discarded).toBe(12);
      expect(r.ingest.stored).toBe(1);
      // The tally survives into metrics even though discarded events are never rows.
      const m = manager.metrics('sess-1');
      expect(m.events.discarded).toBe(12);
      expect(m.events.total).toBe(13);
    } finally {
      cleanup();
    }
  });

  it('does not invent a session row for records that name none', async () => {
    const { manager, cleanup } = makeManager({}, new ScriptedProvider([]));
    try {
      await manager.cycle(
        'claude',
        [JSON.parse(line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }))],
        { sessionId: 'phantom', cwd: manager.projectRoot },
        { runWorker: false },
      );
      expect(manager.store.listSessions().map((s) => s.id)).not.toContain('phantom');
    } finally {
      cleanup();
    }
  });

  it('is idempotent: re-ingesting the same records changes nothing', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ note: 'no change' }), JSON.stringify({ note: 'no change' })]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      const records = [JSON.parse(userTurn('u1', 'Never commit directly to main'))];
      const ctx = { sessionId: 'sess-1', cwd: manager.projectRoot };

      const first = await manager.cycle('claude', records, ctx, { runWorker: false });
      const second = await manager.cycle('claude', records, ctx, { runWorker: false });

      expect(first.ingest.stored).toBe(1);
      expect(second.ingest.stored).toBe(0);
      expect(second.ingest.duplicates).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('tails a growing transcript from a cursor', async () => {
    const { root, cleanup } = tempProject();
    const manager = new ContextManager({ cwd: root, provider: new ScriptedProvider([]) });
    const path = join(root, 'transcript.jsonl');
    try {
      writeFileSync(path, userTurn('u1', 'first instruction: never use eval'));
      const a = await manager.tail('claude', path, 'sess-1', { runWorker: false });
      expect(a.ingest.stored).toBe(1);

      // Nothing new: the cursor means we do not re-read what we already saw.
      const b = await manager.tail('claude', path, 'sess-1', { runWorker: false });
      expect(b.ingest.received).toBe(0);

      appendFileSync(path, userTurn('u2', 'second instruction: always run the tests'));
      const c = await manager.tail('claude', path, 'sess-1', { runWorker: false });
      expect(c.ingest.stored).toBe(1);

      // A partial final line must not be consumed until it is complete.
      appendFileSync(path, '{"type":"user","sessionId":"sess-1"');
      const d = await manager.tail('claude', path, 'sess-1', { runWorker: false });
      expect(d.ingest.received).toBe(0);
      expect(d.skipped).toBe(0);
    } finally {
      manager.close();
      cleanup();
    }
  });

  it('lets a fresh manager resume from memory alone (K5)', async () => {
    const { root, cleanup } = tempProject();
    const provider = new ScriptedProvider([
      JSON.stringify({
        working: { current_task: 'Refactor authentication', task_status: 'in_progress', next_action: 'split the token module' },
        add: [
          { id: 'mem_c', category: 'constraints', text: 'Keep Node 22 compatibility', source: 'user', importance: 'critical' },
        ],
      }),
    ]);
    try {
      const first = new ContextManager({ cwd: root, provider });
      await first.cycle(
        'claude',
        [JSON.parse(userTurn('u1', 'Refactor authentication. Must keep Node 22 compatibility.'))],
        { sessionId: 'sess-1', cwd: root },
      );
      first.close();

      // A brand new process, no conversation, nothing but the repository and the store.
      const second = new ContextManager({ cwd: root });
      const bootstrap = second.bootstrapContext();
      expect(bootstrap.text).toContain('Refactor authentication');
      expect(bootstrap.text).toContain('Keep Node 22 compatibility');
      expect(bootstrap.text).toContain('split the token module');
      second.close();
    } finally {
      cleanup();
    }
  });

  it('keeps the agent running when the worker cannot', async () => {
    const provider = new ScriptedProvider([new Error('provider exploded')]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      const result = await manager.cycle(
        'claude',
        [JSON.parse(userTurn('u1', 'Do not delete the migrations'))],
        { sessionId: 'sess-1', cwd: manager.projectRoot },
      );
      expect(result.worker?.status).toBe('error');
      // Ingestion still succeeded, so nothing was lost.
      expect(result.ingest.stored).toBe(1);
      expect(manager.store.pendingSummary('sess-1').count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('reports a context reduction and a measurable baseline', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        working: { current_task: 'Add rate limiting' },
        add: [{ category: 'decisions', text: 'Use a token bucket per API key' }],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      const records = [
        JSON.parse(userTurn('u1', 'Add rate limiting to the public API')),
        ...Array.from({ length: 40 }, (_, n) => JSON.parse(toolNoise(`t${n}`, n))),
        JSON.parse(assistantTurn('a1', 'Using a token bucket per API key.')),
      ];
      await manager.cycle('claude', records, { sessionId: 'sess-1', cwd: manager.projectRoot });

      const m = manager.metrics('sess-1');
      expect(m.events.total).toBeGreaterThan(0);
      expect(m.context.active_tokens).toBeGreaterThan(0);
      expect(m.context.token_reduction).toBeGreaterThan(0.7);
      // Coverage is what stops the token ratio being quoted on an undrained backlog.
      expect(m.context.coverage).toBeGreaterThan(0);
      expect(m.context.effective_reduction).toBeCloseTo(
        m.context.token_reduction * m.context.coverage,
        6,
      );
      expect(m.agent.turns).toBe(1);
      expect(m.agent.input_tokens).toBe(4000);

      const b = benchmark(manager, 'sess-1');
      expect(b.turns).toBe(1);
      expect(b.baseline_prompt_tokens).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('records a user constraint by hand and protects it from later workers', async () => {
    const { manager, cleanup } = makeManager({}, new ScriptedProvider([]));
    try {
      const r = manager.remember({
        add: [
          {
            category: 'constraints',
            text: 'Never run migrations against production',
            source: 'user',
            importance: 'critical',
            confidence: 1,
          },
        ],
      });
      expect(r.ok).toBe(true);
      const id = r.added[0]!;
      const attack = manager.store.commitPatch({ remove: [id] }, 'worker', {});
      expect(attack.ok).toBe(false);
      expect(attack.violations[0]!.code).toBe('protected_item');
    } finally {
      cleanup();
    }
  });

  it('expires a time-limited item without deleting it', async () => {
    const { manager, cleanup } = makeManager({}, new ScriptedProvider([]));
    try {
      manager.remember({
        add: [
          {
            id: 'mem_flaky',
            category: 'known_issues',
            text: 'auth test is flaky',
            importance: 'medium',
            ttl_seconds: 1,
          },
        ],
      });
      // Reach back in time rather than sleeping.
      manager.store.db
        .prepare(`UPDATE memory_items SET last_validated_at = ?, updated_at = ? WHERE id = 'mem_flaky'`)
        .run(new Date(Date.now() - 10_000).toISOString(), new Date(Date.now() - 10_000).toISOString());

      expect(manager.decay()).toBe(1);
      expect(manager.store.getItem('mem_flaky')!.status).toBe('stale');
      expect(manager.bootstrapContext().text).not.toContain('auth test is flaky');
    } finally {
      cleanup();
    }
  });
});

describe('metrics honesty', () => {
  it('does not report coverage for events that derived nothing', async () => {
    const { manager, cleanup } = makeManager();
    try {
      // Tool traffic with nothing to learn from it. Real data: 726 such events, an empty
      // memory, and a reported coverage of 98.9% - a discard rate dressed as compression.
      const records = Array.from({ length: 20 }, (_, i) => ({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Read',
        tool_input: { file_path: `/project/src/file${i}.ts` },
        tool_response: { file: { numLines: 10 } },
      }));
      manager.ingestOnly('claude', records, { sessionId: 's1', cwd: manager.projectRoot });

      const m = manager.metrics('s1');
      expect(m.memory.items).toBe(0);
      expect(m.events.inert).toBeGreaterThan(0);
      expect(m.context.coverage).toBe(0);
      expect(m.context.effective_reduction).toBe(0);
    } finally {
      cleanup();
    }
  });
});
