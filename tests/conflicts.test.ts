import { describe, expect, it } from 'vitest';
import { detectConflicts, isNegated, similarity } from '../src/core/conflicts.js';
import { MemoryItemSchema, type MemoryItem } from '../src/core/state.js';
import { TASK_DEFINITIONS, buildConflictsPrompt, taskDefinition } from '../src/workers/tasks.js';
import { WorkerRunner } from '../src/workers/runner.js';
import { ScriptedProvider, makeManager } from './helpers.js';

let seq = 0;
function item(over: Partial<MemoryItem> & { text: string }): MemoryItem {
  seq += 1;
  const now = new Date(Date.parse('2026-01-01T00:00:00.000Z') + seq * 60_000).toISOString();
  return MemoryItemSchema.parse({
    id: over.id ?? `mem_${seq}`,
    category: over.category ?? 'decisions',
    importance: over.importance ?? 'high',
    source: over.source ?? 'worker',
    created_at: over.created_at ?? now,
    updated_at: over.updated_at ?? now,
    ...over,
  });
}

describe('similarity', () => {
  it('scores restatements high and unrelated text low', () => {
    expect(similarity('Use PostgreSQL for token storage', 'Use Postgres for token storage')).toBeGreaterThan(0.5);
    expect(similarity('Use PostgreSQL for tokens', 'Tailwind for styling')).toBeLessThan(0.2);
  });

  it('detects negation in both languages', () => {
    expect(isNegated('Do not use Redis')).toBe(true);
    expect(isNegated('Non usare Redis')).toBe(true);
    expect(isNegated('Use Redis for caching')).toBe(false);
  });
});

describe('conflict detection', () => {
  it('flags a polarity flip about the same subject', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Use Redis for refresh token storage' }),
      item({ id: 'mem_b', text: 'Do not use Redis for refresh token storage' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('polarity');
    // The later-created item is reported as newer, as a hint for the worker.
    expect(conflicts[0]!.newer).toBe('mem_b');
  });

  it('does not pair two negatives about unrelated subjects', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Do not use Redis for caching layers' }),
      item({ id: 'mem_b', text: 'Never commit generated migration files' }),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('flags two near-identical statements as duplicates to reconcile', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Refresh tokens are stored in PostgreSQL' }),
      item({ id: 'mem_b', text: 'Refresh tokens get stored in PostgreSQL' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('similar_statement');
  });

  it('ignores a pair already linked by a supersession', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Use Redis for token storage', status: 'active' }),
      item({
        id: 'mem_b',
        text: 'Do not use Redis for token storage',
        supersedes: ['mem_a'],
      }),
    ]);
    // Re-flagging a resolved pair would make reconciliation loop on it forever.
    expect(conflicts).toHaveLength(0);
  });

  it('ignores retired items and different categories', () => {
    expect(
      detectConflicts([
        item({ id: 'mem_a', text: 'Use Redis for token storage' }),
        item({ id: 'mem_b', text: 'Do not use Redis for token storage', status: 'stale' }),
      ]),
    ).toHaveLength(0);

    expect(
      detectConflicts([
        item({ id: 'mem_a', text: 'Use Redis for token storage', category: 'decisions' }),
        item({ id: 'mem_b', text: 'Do not use Redis for token storage', category: 'discoveries' }),
      ]),
    ).toHaveLength(0);
  });

  it('catches a user constraint contradicted by an agent decision', () => {
    // The case K2 exists to protect, and the one a within-category-only check misses.
    const conflicts = detectConflicts([
      item({
        id: 'mem_user',
        category: 'constraints',
        text: 'Never store refresh tokens in Redis',
        source: 'user',
        importance: 'critical',
      }),
      item({
        id: 'mem_agent',
        category: 'decisions',
        text: 'Store refresh tokens in Redis for speed',
        source: 'agent',
        importance: 'high',
      }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('polarity');
  });

  it('notices two decisions that give different answers for the same subject', () => {
    // Textually dissimilar, so only the shared subject reveals the conflict.
    const conflicts = detectConflicts([
      item({ id: 'mem_a', category: 'decisions', text: 'Refresh tokens live in Redis' }),
      item({ id: 'mem_b', category: 'decisions', text: 'Refresh tokens belong in PostgreSQL' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('same_subject');
  });

  it('does not compare categories where overlap means nothing', () => {
    expect(
      detectConflicts([
        item({ id: 'mem_a', category: 'conventions', text: 'Refresh tokens live in Redis' }),
        item({ id: 'mem_b', category: 'goals', text: 'Refresh tokens belong in PostgreSQL' }),
      ]),
    ).toHaveLength(0);
  });

  it('skips low-importance overlap that is not worth a model call', () => {
    expect(
      detectConflicts([
        item({ id: 'mem_a', text: 'Use Redis for token storage', importance: 'low' }),
        item({ id: 'mem_b', text: 'Do not use Redis for token storage', importance: 'low' }),
      ]),
    ).toHaveLength(0);
  });

  it('puts polarity flips ahead of mere duplicates', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Rate limit the public API per API key' }),
      item({ id: 'mem_b', text: 'Rate limit the public API per api key' }),
      item({ id: 'mem_c', text: 'Store sessions in Redis for speed' }),
      item({ id: 'mem_d', text: 'Do not store sessions in Redis for speed' }),
    ]);
    expect(conflicts[0]!.reason).toBe('polarity');
  });
});

describe('specialised task prompts', () => {
  it('gives every task its own system prompt', () => {
    const prompts = Object.values(TASK_DEFINITIONS).map((d) => d.system);
    // Regression: all five tasks were routed to different model tiers but shared the
    // extraction prompt, so a high tier was paying to do a job it was never told about.
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it('declares what each task reads', () => {
    expect(taskDefinition('extraction').input).toBe('events');
    expect(taskDefinition('conflict_resolution').input).toBe('conflicts');
    expect(taskDefinition('complex_reconciliation').input).toBe('memory');
  });

  it('tells the conflict worker that user-critical items win', () => {
    expect(taskDefinition('conflict_resolution').system).toMatch(/user constraint wins/i);
  });

  it('renders both sides of a pair with provenance', () => {
    const conflicts = detectConflicts([
      item({ id: 'mem_a', text: 'Use Redis for token storage', source: 'agent' }),
      item({ id: 'mem_b', text: 'Do not use Redis for token storage', source: 'user', importance: 'critical' }),
    ]);
    const prompt = buildConflictsPrompt({ version: 7, working: {} as never, items: [] }, conflicts);
    expect(prompt).toContain('mem_a');
    expect(prompt).toContain('mem_b');
    expect(prompt).toContain('src=user');
    expect(prompt).toContain('base_version 7');
  });
});

describe('conflict resolution worker', () => {
  it('spends nothing when there is no contradiction', async () => {
    const provider = new ScriptedProvider([]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.remember({ add: [{ category: 'decisions', text: 'Use PostgreSQL' }] });
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce(null, 'conflict_resolution');
      expect(outcome.status).toBe('skipped');
      expect(outcome.reason).toBe('nothing_to_do');
      expect(provider.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('supersedes the losing side and keeps the history', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        supersede: [{ id: 'mem_old', by: 'mem_new', reason: 'production has no Redis instance' }],
        note: 'resolved cache backend contradiction',
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.remember({
        add: [
          { id: 'mem_old', category: 'decisions', text: 'Use Redis for refresh token storage', importance: 'high' },
          { id: 'mem_new', category: 'decisions', text: 'Do not use Redis for refresh token storage', importance: 'high' },
        ],
      });
      expect(manager.conflicts()).toHaveLength(1);

      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce(null, 'conflict_resolution');

      expect(outcome.status).toBe('ok');
      const old = manager.store.getItem('mem_old')!;
      expect(old.status).toBe('superseded');
      expect(old.superseded_by).toBe('mem_new');
      expect(old.reason).toContain('no Redis');
      // Resolved, so it is no longer reported as a conflict.
      expect(manager.conflicts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('cannot be talked into weakening a user-critical constraint', async () => {
    // The prompt forbids it; the validator is what makes it true.
    const provider = new ScriptedProvider([
      JSON.stringify({ supersede: [{ id: 'mem_user', by: 'mem_agent', reason: 'newer' }] }),
      JSON.stringify({}),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.remember({
        add: [
          {
            id: 'mem_user',
            category: 'constraints',
            text: 'Never store tokens in Redis',
            source: 'user',
            importance: 'critical',
          },
          {
            id: 'mem_agent',
            category: 'constraints',
            text: 'Store tokens in Redis for speed',
            source: 'agent',
            importance: 'high',
          },
        ],
      });
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      await runner.runOnce(null, 'conflict_resolution');

      const protectedItem = manager.store.getItem('mem_user')!;
      expect(protectedItem.status).toBe('active');
      expect(protectedItem.importance).toBe('critical');
    } finally {
      cleanup();
    }
  });

  it('reconciliation reads the whole memory rather than the event queue', async () => {
    const provider = new ScriptedProvider([JSON.stringify({ note: 'already coherent' })]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.remember({
        add: [
          { id: 'mem_1', category: 'conventions', text: 'Tailwind for styling' },
          { id: 'mem_2', category: 'goals', text: 'Ship rate limiting this quarter' },
        ],
      });
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce(null, 'complex_reconciliation');

      expect(outcome.status).toBe('noop');
      expect(provider.calls[0]).toContain('mem_1');
      expect(provider.calls[0]).toContain('mem_2');
      expect(provider.calls[0]).toContain('complete active memory');
    } finally {
      cleanup();
    }
  });
});
