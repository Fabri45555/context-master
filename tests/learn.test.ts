import { describe, expect, it } from 'vitest';
import { needsProvider } from '../src/core/lifecycle.js';
import { MAX_INFERRED_CONFIDENCE } from '../src/core/patch.js';
import type { ContextManager } from '../src/daemon/manager.js';
import { buildLearnInput, learnWatermark, restrictLearnPatch } from '../src/workers/learn.js';
import { makeManager, ScriptedProvider } from './helpers.js';

/** A scripted provider whose answer is written after ingest, when the event ids are known. */
class LateProvider extends ScriptedProvider {
  answer = '{}';
  constructor() {
    super([]);
  }
  override async complete(req: { user: string }) {
    this.calls.push(req.user);
    return { text: this.answer, usage: { input_tokens: 100, output_tokens: 50 } };
  }
}

/**
 * The model-backed `learn` task. Records are Claude transcript shapes, ingested one per batch as
 * the hook path does. Every provider is scripted.
 */

let seq = 0;
/** Recent on purpose: the prune rung drops raw events past `retention.raw_events_days`. */
const BASE = Date.now() - 3_600_000;

function ts(): string {
  seq += 1;
  return new Date(BASE + seq * 1000).toISOString();
}

function call(id: string, command: string, session = 's1') {
  return {
    type: 'assistant',
    sessionId: session,
    uuid: `a${++seq}`,
    timestamp: ts(),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  };
}

function edit(id: string, path: string, session = 's1') {
  return {
    type: 'assistant',
    sessionId: session,
    uuid: `a${++seq}`,
    timestamp: ts(),
    message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' } }] },
  };
}

function say(text: string, session = 's1') {
  return { type: 'assistant', sessionId: session, uuid: `a${++seq}`, timestamp: ts(), message: { content: [{ type: 'text', text }] } };
}

function result(id: string, content: string, isError = false, session = 's1') {
  return {
    type: 'user',
    sessionId: session,
    uuid: `u${++seq}`,
    timestamp: ts(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  };
}

const ECONNREFUSED =
  'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnectWrap (node:net:1555:16)\n' +
  '  FAIL tests/api/users.test.ts > creates a user\nExit code 1';

/** The canonical lesson: the API tests fail until the database container is up. */
function dockerEpisode(session = 's1'): unknown[] {
  return [
    call(`${session}-c1`, 'npm run test:api', session),
    result(`${session}-c1`, ECONNREFUSED, true, session),
    say('The database container is not running, so the API tests cannot connect. Starting it first.', session),
    call(`${session}-c2`, 'docker compose up -d db', session),
    result(`${session}-c2`, 'Container app-db-1  Started', false, session),
    call(`${session}-c3`, 'npm run test:api', session),
    result(`${session}-c3`, 'Test Files  4 passed\nTests  31 passed', false, session),
  ];
}

function ingestEach(m: ContextManager, records: unknown[], session = 's1'): void {
  for (const [n, r] of records.entries()) m.ingestOnly('claude', [r], { sessionId: session, cwd: m.projectRoot, ordinal: n });
}

function eventId(m: ContextManager, type: string, contains: string): string {
  const row = m.store.db
    .prepare(`SELECT id FROM events WHERE type = ? AND payload LIKE ? ORDER BY ts LIMIT 1`)
    .get(type, `%${contains}%`) as { id: string } | undefined;
  if (!row) throw new Error(`no ${type} event containing ${contains}`);
  return row.id;
}

function learned(m: ContextManager) {
  return m.store.allItems(true).filter((i) => i.tags.includes('learned'));
}

function withManager(provider: ScriptedProvider | undefined, fn: (m: ContextManager) => Promise<void> | void, config = {}) {
  return async () => {
    const { manager, cleanup } = makeManager(config, provider);
    try {
      await fn(manager);
    } finally {
      cleanup();
    }
  };
}

describe('episode digest', () => {
  it(
    'builds one compact episode: the failure, what was tried, the agent note, what worked',
    withManager(undefined, (m) => {
      ingestEach(m, dockerEpisode());
      const input = buildLearnInput(m.store, m.config, 's1', m.projectRoot);
      expect(input).not.toBeNull();
      const d = input!.digest;
      expect(d.episodes).toHaveLength(1);
      const failId = eventId(m, 'ERROR_DETECTED', 'ECONNREFUSED');
      expect(d.text).toContain(`failed [${failId}] Bash: npm run test:api`);
      expect(d.text).toMatch(/tried\s+\[\S+\] Bash: docker compose up -d db {2}-> ok/);
      expect(d.text).toMatch(/worked\s+\[\S+\] Bash: npm run test:api {2}-> ok/);
      expect(d.text).toContain('database container is not running');
      // Every id the digest shows is citable, and nothing else.
      for (const id of d.evidenceIds) expect(d.text).toContain(`[${id}]`);
      expect(d.evidenceIds.has(failId)).toBe(true);
      // Never a raw dump: the error is clipped to one line, and the success output is not shown.
      expect(d.text).not.toContain('31 passed');
      expect(d.text.split('\n').every((l) => l.length < 320)).toBe(true);
    }),
  );

  it(
    'clips a long command around what changed, not at its head',
    withManager(undefined, (m) => {
      // Real episode: `npx eslint <many long paths> -f unix | head -40` failed because the unix
      // formatter is no longer in core ESLint, and the same call without it worked. Clipped at the
      // head, both lines read identically and the model learned nothing - it returned an empty patch.
      const files = Array.from({ length: 8 }, (_, i) => `src/components/market-intelligence/LongComponentName${i}.tsx`).join(' ');
      ingestEach(m, [
        call('c1', `npx eslint ${files} -f unix | head -40`),
        result('c1', 'The unix formatter is no longer part of core ESLint. Install it manually with `npm install -D eslint-formatter-unix`\nExit code 1', true),
        call('c2', `npx eslint ${files} | head -40`),
        result('c2', '0 problems'),
      ]);
      const d = buildLearnInput(m.store, m.config, 's1', m.projectRoot)!.digest;
      expect(d.episodes).toHaveLength(1);
      const failed = d.text.split('\n').find((l) => l.startsWith('failed'))!;
      const worked = d.text.split('\n').find((l) => l.startsWith('worked'))!;
      expect(failed).toContain('npx eslint');
      expect(worked).toContain('npx eslint');
      // What the two commands do not share is what the lesson is about.
      expect(failed).toContain('-f unix');
      expect(worked).not.toContain('-f unix');
      expect(d.text.split('\n').every((l) => l.length < 320)).toBe(true);
    }),
  );

  it(
    'walks a session longer than one window instead of reading only its newest end',
    withManager(
      undefined,
      (m) => {
        // A real 5700-event session kept its only episode in the older half, and learn reported
        // "no new episodes" for it every time: the window was taken from the newest end.
        for (let n = 0; n < 10; n += 1) {
          ingestEach(m, [call(`f${n}`, `git status ${n}`), result(`f${n}`, 'clean')]);
        }
        ingestEach(m, dockerEpisode());
        const input = buildLearnInput(m.store, m.config, 's1', m.projectRoot);
        expect(input).not.toBeNull();
        expect(input!.digest.text).toContain('npm run test:api');
        // The barren windows it walked past are marked read, so the next run starts after them.
        expect(learnWatermark(m.store, 's1')).not.toBeNull();
      },
      { learn: { max_session_events: 12 } },
    ),
  );

  it(
    'leaves the watermark alone while only looking (--dry-run)',
    withManager(
      undefined,
      (m) => {
        ingestEach(m, [call('x1', 'ls /nowhere'), result('x1', 'ls: /nowhere: No such file or directory', true)]);
        for (let n = 0; n < 6; n += 1) {
          ingestEach(m, [call(`g${n}`, `git status ${n}`), result(`g${n}`, 'clean')]);
        }
        expect(buildLearnInput(m.store, m.config, 's1', m.projectRoot, { advance: false })).toBeNull();
        expect(learnWatermark(m.store, 's1')).toBeNull();
      },
      { learn: { max_session_events: 8 } },
    ),
  );

  it(
    'finds no episode in ordinary development, a flaky rerun, or scratch exploration',
    withManager(undefined, (m) => {
      ingestEach(m, [
        // A failing test fixed by editing the code: development, not a lesson.
        call('d1', 'npm test'),
        result('d1', 'FAIL tests/core.test.ts > folds events\nAssertionError: expected 2 to be 3', true),
        edit('d2', `${m.projectRoot}/src/core/fold.ts`),
        result('d2', 'The file has been updated.'),
        call('d3', 'npm test'),
        result('d3', 'all passed'),
        // The same command again, nothing in between: flaky.
        call('f1', 'npm run build'),
        result('f1', 'error TS2307: Cannot find type definitions for the project, exit 2', true),
        call('f2', 'npm run build'),
        result('f2', 'built'),
        // A throwaway one-liner.
        call('x1', "node -e 'require(\"./dist/x.js\")'"),
        result('x1', 'Error: Cannot find module ./dist/x.js from the scratch one-liner', true),
        call('x2', 'ls dist'),
        result('x2', 'index.js'),
        call('x3', "node -e 'require(\"./dist/index.js\")'"),
        result('x3', 'ok'),
      ]);
      expect(buildLearnInput(m.store, m.config, 's1', m.projectRoot)).toBeNull();
    }),
  );

  it(
    'caps the digest by episodes and leaves the rest for the next run',
    withManager(undefined, (m) => {
      ingestEach(m, [...dockerEpisode('s1').map((r) => r), ...dockerEpisode('s1b').map((r) => ({ ...(r as object), sessionId: 's1' }))]);
      const capped = buildLearnInput(m.store, { ...m.config, learn: { ...m.config.learn, max_episodes: 1 } }, 's1', m.projectRoot);
      expect(capped!.digest.episodes).toHaveLength(1);
      expect(capped!.digest.omitted).toBe(1);
      expect(capped!.until).toBe(capped!.digest.episodes[0]!.resolvedAt);
    }),
  );
});

describe('learn worker', () => {
  it('skips a session with no episode without calling a model', async () => {
    const provider = new ScriptedProvider([]);
    await withManager(provider, async (m) => {
      ingestEach(m, [call('c1', 'ls'), result('c1', 'README.md')]);
      const [r] = await m.learn({ sessionId: 's1' });
      expect(r!.input).toBeNull();
      expect(provider.calls).toHaveLength(0);
    })();
  });

  it('keeps only cited lessons, as the worker, uncertain, and never touches working memory', async () => {
    const provider = new LateProvider();
    await withManager(provider, async (m) => {
      ingestEach(m, dockerEpisode());
      const failId = eventId(m, 'ERROR_DETECTED', 'ECONNREFUSED');
      const fixId = eventId(m, 'TOOL_RESULT', 'Started');
      const before = m.store.workingMemory();
      const processedBefore = m.store.db.prepare(`SELECT id, processed_at FROM events ORDER BY id`).all();
      provider.answer = JSON.stringify({
          working: { current_task: 'hijacked' },
          add: [
            {
              category: 'conventions',
              text: 'The API tests need the database container running first: docker compose up -d db.',
              reason: 'npm run test:api fails with ECONNREFUSED on the database port otherwise',
              importance: 'critical',
              confidence: 1,
              source: 'user',
              evidence: [failId, fixId, 'evt_invented'],
              supersedes: ['mem_whatever'],
            },
            { category: 'discoveries', text: 'An uncited guess about the build.', evidence: [] },
            { category: 'decisions', text: 'We decided to use docker.', evidence: [failId] },
            { category: 'discoveries', text: 'The API tests failed 1 times before passing.', evidence: [failId] },
          ],
          update: [{ id: 'mem_x', text: 'nope' }],
        });

      const [r] = await m.learn({ sessionId: 's1' });
      expect(r!.outcome!.status).toBe('ok');
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]).toContain('## failure -> success episodes');

      const items = learned(m);
      expect(items).toHaveLength(1);
      const lesson = items[0]!;
      expect(lesson.category).toBe('conventions');
      expect(lesson.source).toBe('worker');
      expect(lesson.importance).toBe('high');
      expect(lesson.confidence).toBeLessThanOrEqual(MAX_INFERRED_CONFIDENCE);
      expect(lesson.evidence.sort()).toEqual([failId, fixId].sort());
      expect(m.store.workingMemory().current_task).toBe(before.current_task);
      // The episode's events are read, not consumed: processed_at is untouched (invariant 5).
      expect(m.store.db.prepare(`SELECT id, processed_at FROM events ORDER BY id`).all()).toEqual(processedBefore);

      // The watermark moved: the same episode is not paid for twice.
      expect(learnWatermark(m.store, 's1')).not.toBeNull();
      const [again] = await m.learn({ sessionId: 's1' });
      expect(again!.input).toBeNull();
      expect(provider.calls).toHaveLength(1);
    })();
  });

  it('asks once more when no lesson cites the digest, then records nothing', async () => {
    const uncited = JSON.stringify({ add: [{ category: 'conventions', text: 'Start the database first.', evidence: ['evt_nope'] }] });
    const provider = new ScriptedProvider([uncited, '{}']);
    await withManager(provider, async (m) => {
      ingestEach(m, dockerEpisode());
      const version = m.store.stateVersion();
      const [r] = await m.learn({ sessionId: 's1' });
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1]).toContain('out_of_scope');
      expect(r!.outcome!.status).toBe('noop');
      expect(learned(m)).toHaveLength(0);
      expect(m.store.stateVersion()).toBe(version);
    })();
  });

  it('dry-run builds the digest and writes nothing', async () => {
    const provider = new ScriptedProvider([]);
    await withManager(provider, async (m) => {
      ingestEach(m, dockerEpisode());
      const version = m.store.stateVersion();
      const runs = (m.store.db.prepare(`SELECT COUNT(*) n FROM worker_runs`).get() as { n: number }).n;
      const [r] = await m.learn({ sessionId: 's1', dryRun: true });
      expect(r!.input!.digest.episodes).toHaveLength(1);
      expect(r!.outcome).toBeNull();
      expect(provider.calls).toHaveLength(0);
      expect(m.store.stateVersion()).toBe(version);
      expect(learnWatermark(m.store, 's1')).toBeNull();
      expect((m.store.db.prepare(`SELECT COUNT(*) n FROM worker_runs`).get() as { n: number }).n).toBe(runs);
    })();
  });

  it('a failing provider leaves state and the watermark untouched', async () => {
    const provider = new ScriptedProvider([new Error('provider down'), new Error('provider down')]);
    await withManager(provider, async (m) => {
      ingestEach(m, dockerEpisode());
      const version = m.store.stateVersion();
      const [r] = await m.learn({ sessionId: 's1' });
      expect(r!.outcome!.status).toBe('error');
      expect(m.store.stateVersion()).toBe(version);
      expect(learnWatermark(m.store, 's1')).toBeNull();
      // Still there for the next run.
      expect(buildLearnInput(m.store, m.config, 's1', m.projectRoot)).not.toBeNull();
    })();
  });

  it('local_only defers a non-local provider before any call', async () => {
    const provider = new ScriptedProvider([]);
    (provider as unknown as { isLocal: boolean }).isLocal = false;
    await withManager(
      provider,
      async (m) => {
        ingestEach(m, dockerEpisode());
        const [r] = await m.learn({ sessionId: 's1' });
        expect(r!.outcome!.status).toBe('deferred');
        expect(provider.calls).toHaveLength(0);
      },
      { privacy: { local_only: true } },
    )();
  });

  it('is never a free rung, and stays out of the lifecycle unless opted in', async () => {
    expect(needsProvider('learn')).toBe(true);
    const provider = new ScriptedProvider([]);
    await withManager(provider, async (m) => {
      ingestEach(m, dockerEpisode());
      m.ingestOnly('claude', [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }], {
        sessionId: 's1',
        cwd: m.projectRoot,
      });
      const { performed } = await m.runLifecycle('s1');
      expect(performed.map((p) => p.action)).not.toContain('learn');
      expect(provider.calls.some((c) => c.includes('failure -> success episodes'))).toBe(false);
    })();
  });

  it('runs at the consolidate rung when learn.in_lifecycle opts in, but never on the hook path', async () => {
    const provider = new LateProvider();
    await withManager(
      provider,
      async (m) => {
        ingestEach(m, dockerEpisode());
        m.ingestOnly('claude', [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }], {
          sessionId: 's1',
          cwd: m.projectRoot,
        });
        const hook = await m.runLifecycle('s1', { deterministicOnly: true });
        expect(hook.performed.map((p) => p.action)).not.toContain('learn');
        expect(provider.calls).toHaveLength(0);

        const { performed } = await m.runLifecycle('s1');
        expect(performed.map((p) => p.action)).toContain('learn');
        expect(provider.calls.some((c) => c.includes('failure -> success episodes'))).toBe(true);
      },
      { learn: { in_lifecycle: true } },
    )();
  });
});

describe('restrictLearnPatch', () => {
  it('drops code and keeps the rest of the batch', () => {
    const ids = new Set(['e1', 'e2']);
    const r = restrictLearnPatch(
      {
        add: [
          { category: 'conventions', text: 'Run migrations before the seed script.', evidence: ['e1'] },
          { category: 'discoveries', text: '```ts\nconst x = 1;\n```', evidence: ['e2'] },
        ],
      },
      ids,
    );
    expect(r.violations).toHaveLength(0);
    expect(r.patch.add).toHaveLength(1);
    expect(r.patch.note).toContain('contains code');
  });
});
