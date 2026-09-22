import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectToolCalls,
  detectLoops,
  isMutatingCommand,
  isPollingCommand,
  normalizeCommand,
  normalizeOutcome,
} from '../src/core/loops.js';
import type { ContextManager } from '../src/daemon/manager.js';
import { diagnose } from '../src/daemon/doctor.js';
import { makeManager } from './helpers.js';

/**
 * Loop detection: the same call, the same answer, nothing changed in between. A signal reported by
 * status and doctor, never memory (invariant 28). Records are real Claude transcript shapes, run
 * through the real ingest so that what is discarded there (benign output, duplicates) is discarded
 * here too.
 */

let seq = 0;

function call(id: string, name: string, input: Record<string, unknown>, session = 's1') {
  seq += 1;
  return {
    type: 'assistant',
    sessionId: session,
    uuid: `a${seq}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

function result(id: string, content: string, isError = false, session = 's1') {
  seq += 1;
  return {
    type: 'user',
    sessionId: session,
    uuid: `u${seq}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  };
}

function said(text: string, session = 's1') {
  seq += 1;
  return {
    type: 'user',
    sessionId: session,
    uuid: `u${seq}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    message: { content: text },
  };
}

const BODY = 'export function deterministicFold() {\n  return null;\n}\n'.repeat(3);

function withManager(fn: (m: ContextManager, root: string) => void): void {
  const { manager, root, cleanup } = makeManager();
  try {
    fn(manager, root);
  } finally {
    cleanup();
  }
}

function ingest(m: ContextManager, records: unknown[], session = 's1'): void {
  m.ingestOnly('claude', records, { sessionId: session, cwd: m.projectRoot });
}

function loopsOf(m: ContextManager, session: string | null = 's1') {
  return detectLoops(collectToolCalls(m.store.sessionTraffic(session), m.projectRoot));
}

/** `n` calls of one tool with one input, each answered by `answer(i)`. */
function repeat(n: number, name: string, input: Record<string, unknown>, answer: (i: number) => string, isError = false, session = 's1') {
  seq += 1;
  const tag = `rep${seq}`;
  return Array.from({ length: n }, (_, i) => [call(`${tag}-${i}`, name, input, session), result(`${tag}-${i}`, answer(i), isError, session)]).flat();
}

describe('loop detection', () => {
  it('finds the same read, answered the same, three times with nothing changed', () => {
    withManager((m, root) => {
      ingest(m, repeat(3, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY));
      const [loop, ...rest] = loopsOf(m);
      expect(rest).toHaveLength(0);
      expect(loop).toMatchObject({ tool: 'Read', repeats: 3, errorLoop: false });
      // Nothing about it is memory (invariant 28).
      expect(m.store.allItems(true)).toHaveLength(0);
    });
  });

  it('calls a command that fails the same way each time an error loop', () => {
    withManager((m) => {
      const error = 'Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:5432 while running the seed script';
      ingest(m, repeat(3, 'Bash', { command: 'node scripts/seed.js' }, () => error, true));
      expect(loopsOf(m)[0]).toMatchObject({ repeats: 3, errorLoop: true });
    });
  });

  it('needs three repetitions: one retry is not a loop', () => {
    withManager((m, root) => {
      ingest(m, repeat(2, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY));
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('is not a loop when something was written in between', () => {
    withManager((m, root) => {
      const read = () => repeat(1, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY);
      const edit = (id: string) => [
        call(id, 'Edit', { file_path: `${root}/src/fold.ts`, old_string: 'a', new_string: 'b' }),
        result(id, 'The file has been updated.'),
      ];
      ingest(m, [...read(), ...edit('e1'), ...read(), ...edit('e2'), ...read()]);
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('is not a loop when the answer changed: a job made progress', () => {
    withManager((m) => {
      ingest(m, repeat(4, 'Bash', { command: 'python scripts/purge.py --batch 500' }, (i) => `purged 500 rows, ${9000 - i * 500} remaining in the table`));
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('ignores timings when comparing answers', () => {
    expect(normalizeOutcome('done in 12.3s at 2026-01-01T10:00:00Z')).toBe(normalizeOutcome('done in 9.8s at 2026-01-02T11:30:00Z'));
    expect(normalizeOutcome('purged 500, 9000 left')).not.toBe(normalizeOutcome('purged 500, 8500 left'));
  });

  it('is not a loop when the user spoke in between ("I reconnected it, try again")', () => {
    withManager((m) => {
      const error = 'Error: net::ERR_NAME_NOT_RESOLVED while calling the issue tracker for the ticket';
      const once = () => repeat(1, 'mcp__tracker__get_issue', { id: 'USE-29' }, () => error, true);
      ingest(m, [...once(), ...once(), said('I gave you access now, try again'), ...once()]);
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('does not blame the agent for the harness refusing a call', () => {
    withManager((m) => {
      const refusal = 'claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this again.';
      ingest(m, repeat(3, 'Bash', { command: 'node scripts/migrate.js' }, () => refusal, true));
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('leaves polling alone: status, test runs, sleeps, background output, browsers', () => {
    for (const c of ['git status --short', 'npm test 2>&1 | tail -5', 'cd api && poetry run pytest -q', 'sleep 30 && curl localhost:3000/health', 'cat /private/tmp/x/tasks/b1.output', 'for i in $(seq 1 5); do sleep 2; done']) {
      expect(isPollingCommand(c), c).toBe(true);
    }
    expect(isPollingCommand('node scripts/seed.js')).toBe(false);
    withManager((m) => {
      ingest(m, [
        ...repeat(4, 'Bash', { command: 'git status --short' }, () => ' M src/core/fold.ts\n M src/core/loops.ts'),
        ...repeat(4, 'mcp__Claude_Browser__computer', { action: 'screenshot' }, () => 'screenshot taken of the current tab'),
      ]);
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('treats a shell command that changes the project as a write', () => {
    expect(isMutatingCommand('git commit -m "x"')).toBe(true);
    expect(isMutatingCommand('cd api && sed -i "" s/a/b/ f.py')).toBe(true);
    expect(isMutatingCommand('echo hi > notes.txt')).toBe(true);
    expect(isMutatingCommand('npm test 2>&1 | grep -v "^>"')).toBe(false);
    expect(isMutatingCommand('grep -n "key => value" src/a.ts')).toBe(false);
    expect(isMutatingCommand('ls -la >/dev/null')).toBe(false);
  });

  it('treats an output window as the same command, and paging as a different one', () => {
    expect(normalizeCommand('grep -rn foo src | head -50')).toBe(normalizeCommand('grep -rn foo src | head -100'));
    expect(normalizeCommand("sed -n '1,80p' a.ts")).not.toBe(normalizeCommand("sed -n '80,160p' a.ts"));
  });

  it('counts a replayed call once', () => {
    withManager((m, root) => {
      const records = repeat(2, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY);
      // A resumed transcript writes the same turns again, under the same tool_use ids.
      ingest(m, [...records, ...records.map((r) => ({ ...r, uuid: `${r.uuid}-replay` }))]);
      expect(loopsOf(m)).toHaveLength(0);
    });
  });

  it('shows in status and warns in doctor, and writes nothing to memory', () => {
    withManager((m, root) => {
      ingest(m, repeat(3, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY));
      const metrics = m.metrics(null);
      expect(metrics.loops).toMatchObject({ sessions_scanned: 1, sessions_with_loops: 1, worst: { session: 's1', tool: 'Read', repeats: 3 } });
      const check = diagnose(m, { host: { projectRoot: root, home: join(root, '.home'), vars: {} } }).find((c) => c.name === 'agent loops');
      expect(check?.status).toBe('warn');
      expect(check?.detail).toContain('Read');
      expect(m.store.stateVersion()).toBe(0);
    });
  });

  it('reads only the latest session for doctor', () => {
    withManager((m, root) => {
      ingest(m, repeat(3, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY, false, 'old'), 'old');
      ingest(m, repeat(1, 'Read', { file_path: `${root}/src/fold.ts` }, () => BODY, false, 'new'), 'new');
      const check = diagnose(m, { host: { projectRoot: root, home: join(root, '.home'), vars: {} } }).find((c) => c.name === 'agent loops');
      expect(check?.status).toBe('ok');
      expect(m.metrics(null).loops.sessions_with_loops).toBe(1);
    });
  });
});
