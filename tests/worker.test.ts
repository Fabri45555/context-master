import { describe, expect, it } from 'vitest';
import { parsePatch, WorkerRunner } from '../src/workers/runner.js';
import { ollamaProvider, ProviderError } from '../src/workers/providers/index.js';
import { providerIsLocal } from '../src/workers/providers/types.js';
import { ScriptedProvider, event, makeManager } from './helpers.js';
import type { EventDecision } from '../src/core/deterministic.js';
import type { ContextStore } from '../src/store/store.js';
import { diagnose } from '../src/daemon/doctor.js';

function queue(store: ContextStore, e: ReturnType<typeof event>): void {
  const decision: EventDecision = {
    action: 'persist_and_queue',
    event: e,
    importance: e.importance,
    reasons: ['test'],
    tokens: 30,
  };
  store.insertEvent(decision);
}

describe('patch parsing', () => {
  it('recovers JSON wrapped in a fence or prose', () => {
    expect(parsePatch('```json\n{"note":"a"}\n```')).toEqual({ ok: true, patch: { note: 'a' } });
    expect(parsePatch('Here you go: {"note":"b"} hope that helps')).toEqual({
      ok: true,
      patch: { note: 'b' },
    });
  });

  it('is not fooled by braces inside strings', () => {
    const r = parsePatch('{"note":"a } b","add":[]}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.note).toBe('a } b');
  });

  it('rejects malformed output with a usable reason', () => {
    expect(parsePatch('not json at all').ok).toBe(false);
    const bad = parsePatch('{"add":[{"category":"nope","text":"x"}]}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('schema');
  });
});

describe('worker runner', () => {
  it('is never asked to look at an event the deterministic pass already resolved', async () => {
    // The fold runs at ingest, so a TASK_STARTED becomes working memory without a model
    // and leaves nothing pending for a worker to bill for.
    const provider = new ScriptedProvider([]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly(
        'generic',
        [{ type: 'TASK_STARTED', session_id: 's1', payload: { text: 'Refactor auth' } }],
        { sessionId: 's1' },
      );
      expect(manager.store.workingMemory().current_task).toBe('Refactor auth');
      expect(manager.store.pendingSummary('s1').count).toBe(0);

      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');
      expect(outcome.status).toBe('skipped');
      expect(outcome.reason).toBe('no_pending_events');
      expect(provider.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('applies a valid patch and marks the events processed', async () => {
    const said = event('USER_MESSAGE', { text: 'Do not use Redis, production has no instance' });
    const provider = new ScriptedProvider([
      JSON.stringify({
        working: { current_task: 'swap the cache', task_status: 'in_progress' },
        add: [
          {
            category: 'constraints',
            text: 'Do not use Redis',
            source: 'user',
            importance: 'critical',
            // The real event id: `source: user` is only granted where it can be checked.
            evidence: [said.id],
          },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, said);
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');

      expect(outcome.status).toBe('ok');
      expect(outcome.eventsProcessed).toBe(1);
      expect(manager.store.pendingSummary('s1').count).toBe(0);
      const items = manager.store.allItems();
      expect(items).toHaveLength(1);
      expect(items[0]!.source).toBe('user');
      expect(items[0]!.importance).toBe('critical');
      expect(manager.store.workingMemory().current_task).toBe('swap the cache');
    } finally {
      cleanup();
    }
  });

  it('repairs a rejected patch on a second pass', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ update: [{ id: 'mem_hallucinated', text: 'nope' }] }),
      JSON.stringify({ add: [{ category: 'discoveries', text: 'auth lives in src/auth' }] }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'where does auth live?' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');

      expect(outcome.status).toBe('ok');
      expect(outcome.attempts).toBe(2);
      // The repair prompt must actually tell the model what was wrong.
      expect(provider.calls[1]).toContain('unknown_item');
      expect(manager.store.allItems()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('leaves state and queue intact when both passes are rejected', async () => {
    // An update, not a remove: a remove of an unknown id is a provable no-op and is pruned, while
    // a mistyped update target is real intent and must still be refused.
    const bad = JSON.stringify({ update: [{ id: 'mem_nonexistent', text: 'changed' }] });
    const provider = new ScriptedProvider([bad, bad]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'hello' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');

      expect(outcome.status).toBe('invalid');
      expect(manager.store.stateVersion()).toBe(0);
      // Events stay pending so a later run can retry them (PRD 35).
      expect(manager.store.pendingSummary('s1').count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('refuses to weaken a user-critical constraint even if the model asks', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ remove: ['mem_api'] }),
      JSON.stringify({ note: 'nothing to do' }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.remember({
        add: [
          {
            id: 'mem_api',
            category: 'constraints',
            text: 'Never change the public API',
            source: 'user',
            importance: 'critical',
          },
        ],
      });
      queue(manager.store, event('USER_MESSAGE', { text: 'go ahead and refactor' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      await runner.runOnce('s1');

      const item = manager.store.getItem('mem_api')!;
      expect(item.status).toBe('active');
      expect(item.importance).toBe('critical');
    } finally {
      cleanup();
    }
  });

  it('defers rather than failing when the budget is exhausted', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ note: 'x' })]);
    const { manager, cleanup } = makeManager(
      { budget: { max_cost_per_session_usd: 0.000001, max_tokens_per_hour: 1 } } as never,
      provider,
    );
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'do not use Redis' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');
      expect(outcome.status).toBe('deferred');
      expect(outcome.reason).toContain('budget');
      expect(provider.calls).toHaveLength(0);
      expect(manager.store.pendingSummary('s1').count).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('blocks a remote provider when local_only is set', async () => {
    const { manager, cleanup } = makeManager({ privacy: { local_only: true } } as never);
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'do not use Redis' }));
      const remote = {
        name: 'remote',
        isLocal: false,
        complete: async () => {
          throw new Error('should never be called');
        },
      };
      const runner = new WorkerRunner(manager.store, manager.config, { provider: remote });
      const outcome = await runner.runOnce('s1');
      expect(outcome.status).toBe('deferred');
      expect(outcome.reason).toContain('local_only');
    } finally {
      cleanup();
    }
  });

  it('records a provider failure without losing the events', async () => {
    const provider = new ScriptedProvider([new ProviderError('502 bad gateway', false)]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'do not use Redis' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1');
      expect(outcome.status).toBe('error');
      expect(manager.store.pendingSummary('s1').count).toBe(1);
      expect(manager.store.stateVersion()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('sends the worker a state slice, not the whole memory', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ note: 'ok' })]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      // One always-on critical item plus noise that should not all be shipped.
      manager.remember({
        add: [
          { id: 'mem_crit', category: 'constraints', text: 'Never touch billing', source: 'user', importance: 'critical' },
          ...Array.from({ length: 30 }, (_, n) => ({
            id: `mem_noise_${n}`,
            category: 'conventions' as const,
            text: `unrelated convention number ${n} about formatting`,
            importance: 'low' as const,
          })),
        ],
      });
      queue(manager.store, event('USER_MESSAGE', { text: 'how does billing work?' }));
      const runner = new WorkerRunner(manager.store, manager.config, { provider, maxStateItems: 5 });
      await runner.runOnce('s1');

      const prompt = provider.calls[0]!;
      expect(prompt).toContain('mem_crit');
      const noiseShipped = (prompt.match(/mem_noise_/g) ?? []).length;
      expect(noiseShipped).toBeLessThanOrEqual(5);
    } finally {
      cleanup();
    }
  });
});

describe('a worker that records nothing', () => {
  it('does not count the batch as coverage', async () => {
    const provider = new ScriptedProvider([JSON.stringify({}), JSON.stringify({})]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'switch auth to OIDC' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1', 'extraction');

      expect(outcome.status).toBe('noop');
      // The queue must drain - otherwise the same batch is re-read forever - but a run that
      // derived nothing must not raise coverage, or a broken model shows a rising K1 against
      // an empty memory.
      expect(manager.store.pendingSummary('s1').count).toBe(0);
      expect(manager.metrics('s1').context.coverage).toBe(0);
      expect(manager.metrics('s1').events.inert).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('is visible to doctor once it keeps happening', async () => {
    const provider = new ScriptedProvider(Array(8).fill(JSON.stringify({})));
    const { manager, cleanup } = makeManager({}, provider);
    try {
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      for (let i = 0; i < 3; i += 1) {
        manager.ingestOnly(
          'claude',
          [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: `question ${i} about the auth flow` }],
          { sessionId: 's1', cwd: manager.projectRoot },
        );
        await runner.runOnce('s1', 'extraction');
      }
      const streak = manager.store.emptyRunStreak();
      expect(streak.streak).toBeGreaterThanOrEqual(3);

      const check = diagnose(manager).find((c) => c.name === 'worker output');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('recorded nothing');
    } finally {
      cleanup();
    }
  });
});

describe('local-only is about the model, not the daemon', () => {
  const spec = (model: string, base?: string) =>
    ({ provider: 'ollama' as const, model, ...(base ? { base_url: base } : {}) }) as never;

  it('treats an ollama cloud model as remote', () => {
    // ollama runs on this machine and proxies *-cloud models to ollama.com, so a provider-level
    // `isLocal` let local_only pass while the prompt left the machine.
    expect(ollamaProvider.isLocal).toBe(true);
    expect(providerIsLocal(ollamaProvider, spec('gpt-oss:120b-cloud'))).toBe(false);
    expect(providerIsLocal(ollamaProvider, spec('qwen2.5:7b'))).toBe(true);
  });

  it('treats a non-loopback base_url as remote', () => {
    expect(providerIsLocal(ollamaProvider, spec('qwen2.5:7b', 'http://192.168.1.50:11434'))).toBe(false);
    expect(providerIsLocal(ollamaProvider, spec('qwen2.5:7b', 'http://127.0.0.1:11434'))).toBe(true);
  });

  it('refuses to run a cloud model under local_only', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ add: [{ category: 'decisions', text: 'x' }] })]);
    const { manager, cleanup } = makeManager({
      privacy: { local_only: true, redact_secrets: true },
      models: { tiers: { cheap: { provider: 'ollama', model: 'gpt-oss:120b-cloud' } }, routing: { extraction: 'cheap' } },
    } as never);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'never send this anywhere' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      // Deliberately no provider override: the point is the real registry entry.
      const runner = new WorkerRunner(manager.store, manager.config, {});
      const outcome = await runner.runOnce('s1', 'extraction');

      expect(outcome.status).toBe('deferred');
      expect(outcome.reason).toContain('local_only');
      expect(provider.calls).toHaveLength(0);
      // The events stay pending, so nothing is lost by refusing.
      expect(manager.store.pendingSummary('s1').count).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
