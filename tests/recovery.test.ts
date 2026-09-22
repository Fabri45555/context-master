import { describe, expect, it } from 'vitest';
import {
  commandsRelatedAsRetry,
  errorClass,
  firstBinary,
  pathsRelatedAsTypo,
} from '../src/core/recovery.js';
import type { MemoryItem } from '../src/core/state.js';
import type { ContextManager } from '../src/daemon/manager.js';
import { makeManager } from './helpers.js';

/**
 * Error -> recovery learning in the fold. Records are real Claude transcript shapes, and most are
 * ingested one per batch, which is what the hook path does: the failure and its fix never share a
 * batch there.
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

const FILE_BODY = 'export function deterministicFold() {\n  return null;\n}\n'.repeat(3);

function ingestEach(manager: ContextManager, records: unknown[], session = 's1'): void {
  for (const [n, r] of records.entries()) {
    manager.ingestOnly('claude', [r], { sessionId: session, cwd: manager.projectRoot, ordinal: n });
  }
}

function recoveries(manager: ContextManager): MemoryItem[] {
  return manager.store.allItems(true).filter((i) => i.tags.includes('recovery'));
}

function withManager(fn: (m: ContextManager, root: string) => void): void {
  const { manager, root, cleanup } = makeManager();
  try {
    fn(manager, root);
  } finally {
    cleanup();
  }
}

describe('path recovery', () => {
  it('learns the right path from a not-found read followed by a read of its typo fix', () => {
    withManager((m, root) => {
      ingestEach(m, [
        call('r1', 'Read', { file_path: `${root}/src/core/fold.js` }),
        result('r1', 'File does not exist. Note: your current working directory is ' + root, true),
        call('r2', 'Read', { file_path: `${root}/src/core/fold.ts` }),
        result('r2', FILE_BODY),
      ]);
      const [rule, ...rest] = recoveries(m);
      expect(rest).toHaveLength(0);
      expect(rule!.category).toBe('discoveries');
      expect(rule!.text).toBe('`src/core/fold.js` does not exist; the file is `src/core/fold.ts`.');
      expect(rule!.fields).toMatchObject({ references: ['src/core/fold.ts'], absent_references: ['src/core/fold.js'] });
      // Evidence is both outcomes, each correlated with its own call.
      const events = m.store.db
        .prepare(`SELECT id, type FROM events WHERE id IN (${rule!.evidence.map(() => '?').join(',')})`)
        .all(...rule!.evidence) as Array<{ id: string; type: string }>;
      expect(events.map((e) => e.type).sort()).toEqual(['ERROR_DETECTED', 'TOOL_RESULT']);
      // The patch log still reproduces the state (invariant 3).
      expect(m.store.replay().items.find((i) => i.id === rule!.id)?.text).toBe(rule!.text);
    });
  });

  it('does not pair two different files that happen to be a few edits apart', () => {
    // headroom's basename threshold, max(2, len/3), pairs these: three edits in twelve characters.
    expect(pathsRelatedAsTypo('tests/fold.test.ts', 'tests/core.test.ts')).toBe(false);
    withManager((m, root) => {
      ingestEach(m, [
        call('r1', 'Read', { file_path: `${root}/tests/fold.test.ts` }),
        result('r1', 'File does not exist.', true),
        call('r2', 'Read', { file_path: `${root}/tests/core.test.ts` }),
        result('r2', FILE_BODY),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('relates what is plausibly the same file, and nothing looser', () => {
    expect(pathsRelatedAsTypo('src/core/fold.js', 'src/core/fold.ts')).toBe(true);
    expect(pathsRelatedAsTypo('src/core/recovry.ts', 'src/core/recovery.ts')).toBe(true);
    expect(pathsRelatedAsTypo('src/fold.ts', 'src/core/fold.ts')).toBe(true);
    // Generic basenames are shared by unrelated files.
    expect(pathsRelatedAsTypo('web/src/index.ts', 'api/index.ts')).toBe(false);
    // Different directory, different name: two reads, not a correction.
    expect(pathsRelatedAsTypo('src/a/fold.ts', 'src/b/folds.ts')).toBe(false);
    expect(pathsRelatedAsTypo('src/a.ts', 'src/a.ts')).toBe(false);
  });

  it('ignores paths outside the project and artifacts that are not source', () => {
    withManager((m, root) => {
      ingestEach(m, [
        // A typo in the home directory, then the right absolute path in another checkout.
        call('r1', 'Read', { file_path: '/Users/someon/proj/src/a.ts' }),
        result('r1', 'File does not exist.', true),
        call('r2', 'Read', { file_path: '/Users/someone/proj/src/a.ts' }),
        result('r2', FILE_BODY),
        // A screenshot saved somewhere other than where the agent looked.
        call('r3', 'Read', { file_path: `${root}/.playwright-mcp/shot.png` }),
        result('r3', 'File does not exist.', true),
        call('r4', 'Read', { file_path: `${root}/shot.png` }),
        result('r4', 'image bytes '.repeat(10)),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('never pairs across sessions', () => {
    withManager((m, root) => {
      ingestEach(m, [call('r1', 'Read', { file_path: `${root}/src/fold.js` }, 's1'), result('r1', 'File does not exist.', true, 's1')], 's1');
      ingestEach(m, [call('r2', 'Read', { file_path: `${root}/src/fold.ts` }, 's2'), result('r2', FILE_BODY, false, 's2')], 's2');
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('does not treat a parallel call as a reaction to the failure', () => {
    withManager((m, root) => {
      // Both calls were issued in one assistant turn, before either result came back.
      ingestEach(m, [
        call('r1', 'Read', { file_path: `${root}/src/fold.js` }),
        call('r2', 'Read', { file_path: `${root}/src/fold.ts` }),
        result('r1', 'File does not exist.', true),
        result('r2', FILE_BODY),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('looks back only a few calls', () => {
    withManager((m, root) => {
      // Built in order: the timestamps are what orders history.
      const records: unknown[] = [call('r1', 'Read', { file_path: `${root}/src/fold.js` }), result('r1', 'File does not exist.', true)];
      for (let n = 0; n < 6; n++) {
        records.push(call(`b${n}`, 'Bash', { command: `ls dir${n}` }), result(`b${n}`, `listing of dir${n}\n`.repeat(3)));
      }
      records.push(call('r2', 'Read', { file_path: `${root}/src/fold.ts` }), result('r2', FILE_BODY));
      ingestEach(m, records);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('records a rule once, however often the mistake is repeated', () => {
    withManager((m, root) => {
      const pair = (a: string, b: string) => [
        call(a, 'Read', { file_path: `${root}/src/fold.js` }),
        result(a, 'File does not exist.', true),
        call(b, 'Read', { file_path: `${root}/src/fold.ts` }),
        result(b, FILE_BODY),
      ];
      ingestEach(m, [...pair('r1', 'r2'), ...pair('r3', 'r4')]);
      expect(recoveries(m).filter((i) => i.status === 'active')).toHaveLength(1);
    });
  });
});

describe('command recovery', () => {
  it('learns a corrected command from a malformed one', () => {
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'npm run tests' }),
        result('c1', 'Exit code 1\nnpm error Missing script: "tests"\nnpm error\nnpm error Did you mean this?\nnpm error   npm test', true),
        call('c2', 'Bash', { command: 'npm run test' }),
        result('c2', ' Test Files  13 passed (13)\n      Tests  239 passed (239)\n'),
      ]);
      const [rule, ...rest] = recoveries(m);
      expect(rest).toHaveLength(0);
      expect(rule!.category).toBe('conventions');
      expect(rule!.text).toBe('`npm run tests` fails (Missing script: "tests"); use `npm run test`.');
      expect(rule!.source).toBe('deterministic');
      // A measurement is not memory (invariant 28): the passing counts from the output are not in it.
      expect(rule!.text).not.toMatch(/passed|239/);
    });
  });

  it('pairs hook events, where call and outcome are one event', () => {
    withManager((m) => {
      const hook = (command: string, response: Record<string, unknown>) => ({
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: response,
      });
      ingestEach(m, [
        hook('python manage.py check', { exit_code: 127, stdout: '', stderr: '(eval):1: command not found: python' }),
        hook('python3 manage.py check', { stdout: 'System check identified no issues.', stderr: '', interrupted: false }),
      ]);
      expect(recoveries(m).map((i) => i.text)).toEqual([
        '`python manage.py check` fails (command not found: python); use `python3 manage.py check`.',
      ]);
    });
  });

  it('does not learn from a real failure fixed in the code', () => {
    // The misfire this guard exists for: tests fail, the agent fixes the code, then runs a narrower
    // command that passes. That is not "use the second command instead of the first".
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'npx vitest run tests/core.test.ts' }),
        result('c1', 'Exit code 1\nAssertionError: expected 2 to be 3\n 1 failing test in tests/core.test.ts', true),
        call('c2', 'Bash', { command: 'npx vitest run tests/core.test.ts -t fold' }),
        result('c2', 'Test Files  1 passed (1)\nall green for the fold suite\n'),
      ]);
      expect(recoveries(m)).toHaveLength(0);
      // The failure is still what it was: a known issue.
      expect(m.store.allItems().some((i) => i.category === 'known_issues')).toBe(true);
    });
  });

  it('does not learn the shell cwd of the moment', () => {
    // The most common Bash "recovery" on real transcripts: a relative `cd` from the wrong directory.
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'cd api && poetry run pytest tests/test_x.py' }),
        result('c1', 'Exit code 1\n(eval):cd:1: no such file or directory: api', true),
        call('c2', 'Bash', { command: 'cd /proj/api && poetry run pytest tests/test_x.py' }),
        result('c2', '12 passed in 3.2s and the rest of the output\n'),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('ignores scratch one-liners, harness refusals and unrelated commands', () => {
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'node -e "require(\'x\')"' }),
        result('c1', "Error: Cannot find module 'x'", true),
        call('c2', 'Bash', { command: 'node -e "require(\'./x\')"' }),
        result('c2', 'module loaded fine, printing its exports here\n'),
        call('c3', 'Bash', { command: 'git lg --oneline' }),
        result('c3', 'The user rejected this tool use. command not found', true),
        call('c4', 'Bash', { command: 'git log --oneline' }),
        result('c4', 'abc123 feat: something useful\ndef456 fix: another\n'),
        call('c5', 'Bash', { command: 'tac file.txt' }),
        result('c5', 'Exit code 127\n(eval):1: command not found: tac', true),
        call('c6', 'Bash', { command: 'ls -la src/core' }),
        result('c6', 'fold.ts\npatch.ts\nstate.ts\nrecovery.ts\n'),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('does not call a verbatim retry a recovery', () => {
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'pnpm lint' }),
        result('c1', 'Exit code 1\nerror: unknown option --fix-all', true),
        call('c2', 'Bash', { command: 'pnpm lint' }),
        result('c2', 'lint finished with no complaints at all\n'),
      ]);
      expect(recoveries(m)).toHaveLength(0);
    });
  });

  it('supersedes the known issue its failure recorded, in a later batch', () => {
    withManager((m) => {
      const failure = [
        call('c1', 'Bash', { command: 'node dist/cli.js status' }),
        result(
          'c1',
          "Exit code 1\nnode:internal/modules/cjs/loader:1228\nError: Cannot find module '/proj/dist/cli.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
          true,
        ),
      ];
      ingestEach(m, failure);
      const issue = m.store.allItems().find((i) => i.category === 'known_issues');
      expect(issue).toBeDefined();

      ingestEach(m, [call('c2', 'Bash', { command: 'node dist/cli/index.js status' }), result('c2', 'contextd status: memory v3, nothing pending\n')]);
      const [rule] = recoveries(m);
      expect(rule!.text).toContain("Cannot find module '/proj/dist/cli.js'");
      expect(rule!.supersedes).toEqual([issue!.id]);
      expect(m.store.getItem(issue!.id)!.status).toBe('superseded');
    });
  });

  it('never records the issue at all when the fix arrives in the same batch', () => {
    withManager((m) => {
      m.ingestOnly(
        'claude',
        [
          call('c1', 'Bash', { command: 'node dist/cli.js status' }),
          result('c1', "Exit code 1\nError: Cannot find module '/proj/dist/cli.js'\n    at Module._resolveFilename (node:internal)", true),
          call('c2', 'Bash', { command: 'node dist/cli/index.js status' }),
          result('c2', 'contextd status: memory v3, nothing pending\n'),
        ],
        { sessionId: 's1', cwd: m.projectRoot },
      );
      expect(recoveries(m)).toHaveLength(1);
      expect(m.store.allItems(true).filter((i) => i.category === 'known_issues')).toHaveLength(0);
    });
  });

  it('will not retire a protected item through the recovery path', () => {
    withManager((m) => {
      ingestEach(m, [
        call('c1', 'Bash', { command: 'node dist/cli.js status' }),
        result('c1', "Exit code 1\nError: Cannot find module '/proj/dist/cli.js'\n    at Module._resolveFilename (node:internal)", true),
      ]);
      const issue = m.store.allItems().find((i) => i.category === 'known_issues')!;
      // Promote it to user-critical by hand: from now on nothing automatic may retire it.
      expect(m.store.commitPatch({ update: [{ id: issue.id, importance: 'critical' }] }, 'user').ok).toBe(true);
      m.store.db.prepare(`UPDATE memory_items SET source = 'user' WHERE id = ?`).run(issue.id);

      ingestEach(m, [call('c2', 'Bash', { command: 'node dist/cli/index.js status' }), result('c2', 'contextd status: memory v3, nothing pending\n')]);
      expect(recoveries(m)).toHaveLength(1);
      expect(recoveries(m)[0]!.supersedes).toEqual([]);
      expect(m.store.getItem(issue.id)!.status).toBe('active');
    });
  });
});

describe('recovery helpers', () => {
  it('reads the binary past env assignments and a sourced venv', () => {
    expect(firstBinary('FOO=1 BAR=x npm test')).toBe('npm');
    expect(firstBinary('source .venv/bin/activate && pytest -q')).toBe('pytest');
  });

  it('relates retries by binary and substance, not by shared shell verbs', () => {
    expect(commandsRelatedAsRetry('python script.py', 'python3 script.py')).toBe(true);
    expect(commandsRelatedAsRetry('grep foo src/a.ts', 'grep bar lib/b.ts')).toBe(false);
    expect(commandsRelatedAsRetry('npm run tests', 'yarn test')).toBe(false);
  });

  it('names the error class without shell noise', () => {
    expect(errorClass('Exit code 127\n(eval):1: command not found: tac')).toBe('command not found: tac');
    expect(errorClass('Exit code 1\nAssertionError: boom')).toBeNull();
  });
});
