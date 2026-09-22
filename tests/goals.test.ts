import { describe, expect, it } from 'vitest';
import { WorkerRunner } from '../src/workers/runner.js';
import { ScriptedProvider, makeManager } from './helpers.js';

/**
 * Finishing is not forgetting.
 *
 * Two sessions in a row reported every goal as still open with the work visibly done: there was
 * no way to say a goal was met, and retiring a user goal is what `isProtected` exists to stop.
 */
function withGoal(responses: string[] = []) {
  const provider = new ScriptedProvider(responses);
  const made = makeManager({}, provider);
  made.manager.remember({
    add: [
      { id: 'g1', category: 'goals', text: 'Write a complete README for the MCP server', source: 'user', importance: 'critical', confidence: 1 },
      { id: 'c1', category: 'constraints', text: 'Never store refresh tokens in Redis', source: 'user', importance: 'critical', confidence: 1 },
    ],
  });
  return { provider, ...made };
}

describe('closing a goal', () => {
  it('takes it out of the bootstrap but keeps it findable, protected and reopenable', () => {
    const { manager, cleanup } = withGoal();
    try {
      expect(manager.closeItems(['g1'], 'README.md written').ok).toBe(true);

      expect(manager.bootstrapContext().itemIds).not.toContain('g1');
      const q = manager.queryContext('README MCP server', { record: false });
      expect(q.text).toContain('(goal, done) Write a complete README');
      expect(q.text).toContain('(closed: README.md written)');

      // Closed is not weakened: the protection still holds.
      expect(manager.retire(['g1'], 'done anyway').ok).toBe(false);

      expect(manager.reopenItems(['g1'], 'README misses the uninstall section').ok).toBe(true);
      expect(manager.bootstrapContext().itemIds).toContain('g1');
    } finally {
      cleanup();
    }
  });

  it('refuses to close a constraint - a standing rule is never done', () => {
    const { manager, cleanup } = withGoal();
    try {
      const r = manager.closeItems(['c1'], 'no longer relevant');
      expect(r.ok).toBe(false);
      expect(r.violations[0]!.code).toBe('not_closable');
      expect(manager.bootstrapContext().itemIds).toContain('c1');
    } finally {
      cleanup();
    }
  });

  it('survives replay', () => {
    const { manager, cleanup } = withGoal();
    try {
      manager.closeItems(['g1'], 'README.md written');
      const replayed = manager.store.replay();
      const g1 = replayed.items.find((i) => i.id === 'g1')!;
      expect(g1.fields.closed_reason).toBe('README.md written');
    } finally {
      cleanup();
    }
  });
});

describe('a worker closing a goal', () => {
  const prompt = (text: string) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: text });

  it('closes a user goal when it cites an event that exists', async () => {
    const { manager, cleanup } = withGoal();
    try {
      manager.ingestOnly('claude', [prompt('the README is finished, thanks')], { sessionId: 's1', cwd: manager.projectRoot });
      const evt = manager.store.pendingEvents('s1', 10)[0]!.id;
      const provider = new ScriptedProvider([
        JSON.stringify({ close: [{ id: 'g1', reason: 'user confirmed the README is finished', evidence: [evt] }] }),
      ]);

      const out = await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      expect(out.status).toBe('ok');
      expect(manager.bootstrapContext().itemIds).not.toContain('g1');
    } finally {
      cleanup();
    }
  });

  it('may not close a user goal on its own say-so', async () => {
    // Closing removes the goal from every session start, which is most of what deleting it
    // would do - so, like a user attribution, it needs evidence that exists.
    const { manager, provider, cleanup } = withGoal([
      JSON.stringify({ close: [{ id: 'g1', reason: 'looks done', evidence: ['evt_invented'] }] }),
    ]);
    try {
      manager.ingestOnly('claude', [prompt('let us look at the README later')], { sessionId: 's1', cwd: manager.projectRoot });
      await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      expect(manager.bootstrapContext().itemIds).toContain('g1');
    } finally {
      cleanup();
    }
  });
});

describe('attributing an MCP call to a session', () => {
  it('names the session whose hooks are writing right now, and nobody when all is idle', () => {
    // retrieval_log rows from MCP had no session: the server is never told which one it serves.
    const { manager, cleanup } = withGoal();
    try {
      expect(manager.store.activeSessionId()).toBeNull();
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's7', prompt: 'where were we on the README' }],
        { sessionId: 's7', cwd: manager.projectRoot },
      );
      expect(manager.store.activeSessionId()).toBe('s7');
      expect(manager.store.activeSessionId(30 * 60_000, Date.now() + 2 * 60 * 60_000)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('the current task', () => {
  it('can be set by hand, and says how old it is when the user has moved on', () => {
    // A commit made in another session is a successful shell command, which the fold closes as
    // inert, so no worker ever learned the task was finished: "Commit: blocked" stayed in every
    // bootstrap with nothing able to change it.
    const { manager, cleanup } = withGoal();
    try {
      expect(manager.setTask({ current_task: 'Commit the repository', task_status: 'blocked' }).ok).toBe(true);
      expect(manager.bootstrapContext().text).toMatch(/- recorded: just now\n?/);

      manager.ingestOnly(
        'claude',
        [1, 2].map((n) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: `something else entirely ${n}` })),
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      expect(manager.bootstrapContext().text).toContain('2 user messages since - verify before relying on it');

      manager.setTask({ current_task: 'Build goal closing', task_status: 'in_progress', next_action: 'write tests' });
      const w = manager.store.workingMemory();
      expect(w.current_task).toBe('Build goal closing');
      expect(w.task_status).toBe('in_progress');
      expect(manager.bootstrapContext().text).not.toContain('user messages since');
    } finally {
      cleanup();
    }
  });
});

describe('milestone commands', () => {
  it('recognises the commands that finish work, and not the ones that merely mention it', async () => {
    const { isMilestoneCommand } = await import('../src/core/importance.js');
    for (const c of [
      'git commit -m "feat: x"',
      'cd /repo && git add -A && git commit -m "x"',
      'git -C /repo push origin main',
      'git commit -n -m "skip hooks"',
      'gh pr create --fill',
      'npm publish',
      'git tag v1.2.0',
    ]) expect(isMilestoneCommand(c), c).toBe(true);
    for (const c of [
      'git status',
      'git log --grep commit',
      'echo "git commit"',
      'git commit --dry-run',
      'git diff HEAD~1',
    ]) expect(isMilestoneCommand(c), c).toBe(false);
  });

  it('keeps a successful commit for a worker and reports it against the recorded task', () => {
    const { manager, cleanup } = withGoal();
    try {
      manager.setTask({ current_task: 'Commit the repository', task_status: 'blocked' });
      // Recorded strictly before the commit, as it would be in any real session.
      manager.store.db.prepare(`UPDATE working_memory SET state = json_set(state, '$.updated_at', ?)`).run(
        new Date(Date.now() - 60_000).toISOString(),
      );
      manager.ingestOnly(
        'claude',
        [
          {
            hook_event_name: 'PostToolUse',
            session_id: 's2',
            tool_name: 'Bash',
            tool_input: { command: 'git add -A && git commit -m "feat: contextd"' },
            tool_response: { stdout: '[main 33c097c] feat: contextd\n 90 files changed', stderr: '', interrupted: false },
          },
          {
            hook_event_name: 'PostToolUse',
            session_id: 's2',
            tool_name: 'Bash',
            tool_input: { command: 'ls src' },
            tool_response: { stdout: 'cli\ncore', stderr: '', interrupted: false },
          },
        ],
        { sessionId: 's2', cwd: manager.projectRoot },
      );

      // Queued, not closed as tool traffic: a worker decides what it finished.
      const pending = manager.store.pendingEvents('s2', 10);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.payload.command).toContain('git commit');

      const text = manager.bootstrapContext().text;
      expect(text).toContain('1 milestone since - verify before relying on it');
      expect(text).toContain('(feat: contextd)');
    } finally {
      cleanup();
    }
  });
});

describe('the always-on slice stays small per item', () => {
  it('clips a paragraph-long item in the bootstrap but serves it whole to a query', async () => {
    const { BOOTSTRAP_ITEM_CHARS } = await import('../src/retrieval/context-builder.js');
    const { manager, cleanup } = withGoal();
    try {
      const long = 'Agent-initiated queries use hybrid retrieval over keyword and semantic ranking. '.repeat(8);
      manager.remember({
        add: [{ id: 'd9', category: 'decisions', text: long, reason: 'because it is long', source: 'agent', importance: 'high', confidence: 0.8 }],
      });
      const line = manager.bootstrapContext().text.split('\n').find((l) => l.includes('[d9]'))!;
      expect(line).toContain('(full: memory_explain d9)');
      expect(line.length).toBeLessThan(BOOTSTRAP_ITEM_CHARS + 60);
      expect(manager.queryContext('hybrid retrieval semantic', { record: false }).text).toContain(long.trim());
    } finally {
      cleanup();
    }
  });
});

describe('a worker and a task set by hand', () => {
  it('does not overwrite a task set after the events it read', async () => {
    // A worker processing an older backlog put "Commit: blocked" back over a task set by hand.
    const { manager, cleanup } = withGoal();
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'please commit the repository' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      await new Promise((r) => setTimeout(r, 5));
      manager.setTask({ current_task: 'Review the goal-closing work', task_status: 'review' });

      const provider = new ScriptedProvider([
        JSON.stringify({
          working: { current_task: 'Commit project repository', task_status: 'blocked' },
          add: [{ category: 'goals', text: 'Commit the repository' }],
        }),
      ]);
      const out = await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      expect(out.status).toBe('ok');
      expect(manager.store.workingMemory().current_task).toBe('Review the goal-closing work');
      // The rest of the patch still lands.
      expect(manager.store.allItems(false).some((i) => i.text === 'Commit the repository')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('still lets a later batch of the same backlog update the task a worker set', async () => {
    const { manager, cleanup } = withGoal();
    try {
      const msgs = ['start on the export', 'now write the CSV header test'];
      for (const [n, text] of msgs.entries()) {
        manager.ingestOnly('claude', [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: text }], {
          sessionId: 's1',
          cwd: manager.projectRoot,
        });
        const provider = new ScriptedProvider([JSON.stringify({ working: { current_task: `task ${n}` } })]);
        await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      }
      expect(manager.store.workingMemory().current_task).toBe('task 1');
    } finally {
      cleanup();
    }
  });
});
