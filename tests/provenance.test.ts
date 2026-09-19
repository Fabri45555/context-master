import { describe, expect, it } from 'vitest';
import { WorkerRunner } from '../src/workers/runner.js';
import { ScriptedProvider, event, makeManager } from './helpers.js';
import type { EventDecision } from '../src/core/deterministic.js';
import type { ContextStore } from '../src/store/store.js';

function queue(store: ContextStore, e: ReturnType<typeof event>): void {
  const decision: EventDecision = {
    action: 'persist_and_queue',
    event: e,
    importance: e.importance,
    reasons: ['needs_semantics'],
    tokens: 20,
  };
  store.insertEvent(decision);
}

/**
 * `source: user` plus `critical` is the one combination `isProtected` makes permanent, so a worker
 * may not award it on its own say-so.
 *
 * On a live session the extraction worker synthesised a goal out of the conversation — including a
 * detail the agent had proposed rather than the user — and filed it as a user-critical instruction
 * that nothing could afterwards remove.
 */
describe('a worker must be able to prove a user attribution', () => {
  it('keeps the attribution when a user message backs it', async () => {
    const said = event('USER_MESSAGE', { text: 'Never store refresh tokens in Redis' });
    const provider = new ScriptedProvider([
      JSON.stringify({
        add: [
          {
            category: 'constraints',
            text: 'Never store refresh tokens in Redis',
            source: 'user',
            importance: 'critical',
            evidence: [said.id],
          },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, said);
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');

      const item = manager.store.allItems()[0]!;
      expect(item.source).toBe('user');
      expect(item.importance).toBe('critical');
    } finally {
      cleanup();
    }
  });

  it('downgrades an attribution it cannot back, and says so', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        add: [
          {
            id: 'g1',
            category: 'goals',
            text: 'Run a real test using a local model, and check MCP next session',
            source: 'user',
            importance: 'critical',
            confidence: 1,
          },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      queue(manager.store, event('USER_MESSAGE', { text: 'run a real test now' }));
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');

      const item = manager.store.getItem('g1')!;
      // The text survives - discarding it would lose real information - but the attribution does
      // not, so `isProtected` never applies and the item stays correctable.
      expect(item.text).toContain('Run a real test');
      expect(item.source).toBe('agent');
      // And once it is not user-authored, the inferred-confidence ceiling applies to it too.
      expect(item.confidence).toBeLessThanOrEqual(0.9);
      expect(JSON.stringify(manager.store.listPatches(1))).toContain('downgraded to agent');
    } finally {
      cleanup();
    }
  });

  it('does not accept evidence that points at something other than a user message', async () => {
    const toolEvent = event('TOOL_RESULT', { output: 'the user probably wants postgres' });
    const provider = new ScriptedProvider([
      JSON.stringify({
        add: [
          {
            id: 'c1',
            category: 'constraints',
            text: 'Use PostgreSQL everywhere',
            source: 'user',
            importance: 'critical',
            evidence: [toolEvent.id],
          },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.store.insertEvent({
        action: 'persist',
        event: toolEvent,
        importance: toolEvent.importance,
        reasons: [],
        tokens: 10,
      });
      queue(manager.store, event('USER_MESSAGE', { text: 'what database are we on?' }));
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');

      expect(manager.store.getItem('c1')!.source).toBe('agent');
    } finally {
      cleanup();
    }
  });
});

describe('retiring memory by hand', () => {
  it('retires a wrong item but still refuses a user-critical one', () => {
    // CLAUDE.md tells the agent to correct wrong memory; until `retire` existed there was no
    // command that could, short of `reset`.
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({
        add: [
          { id: 'ki1', category: 'known_issues', text: 'Permission denials are logged', source: 'agent', importance: 'medium', confidence: 0.8 },
          { id: 'c1', category: 'constraints', text: 'Never store tokens in Redis', source: 'user', importance: 'critical', confidence: 1 },
        ],
      });

      expect(manager.retire(['ki1'], 'harness noise, not a project issue').ok).toBe(true);
      expect(manager.bootstrapContext().itemIds).not.toContain('ki1');

      const refused = manager.retire(['c1'], 'trying anyway');
      expect(refused.ok).toBe(false);
      expect(manager.bootstrapContext().itemIds).toContain('c1');
    } finally {
      cleanup();
    }
  });
});
