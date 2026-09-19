import { describe, expect, it } from 'vitest';
import { redactText, redactValue, isSensitivePath } from '../src/core/redact.js';
import { ASSISTANT_SUBSTANCE_CHARS, classifyImportance, looksLikePastedTerminal, needsSemantics } from '../src/core/importance.js';
import { DeterministicEngine, evaluateTriggers, adaptiveScale } from '../src/core/deterministic.js';
import { IgnoreMatcher } from '../src/core/ignore.js';
import { deterministicFold, isScratchCommand, isTransientToolError, looksLikeDump } from '../src/core/fold.js';
import { applyPatch, validatePatch, isProtected, normalizePatch, MAX_INFERRED_CONFIDENCE } from '../src/core/patch.js';
import { MemoryItemSchema, isLive, type ProjectState } from '../src/core/state.js';
import { emptyWorkingMemory } from '../src/core/state.js';
import { CostController, priceUsage } from '../src/core/budget.js';
import { event, testConfig } from './helpers.js';
import type { StoredEvent } from '../src/store/store.js';

describe('redaction', () => {
  it('masks provider keys, JWTs and credentialed URLs', () => {
    const input = [
      'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      'postgres://admin:hunter2@db.internal:5432/app',
    ].join('\n');
    const { text, count } = redactText(input);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[REDACTED]');
    // The non-secret part of a URL survives, so the fact stays useful.
    expect(text).toContain('db.internal:5432/app');
  });

  it('walks nested payloads', () => {
    const { value, count } = redactValue({
      env: { AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY' },
      list: ['AKIAIOSFODNN7EXAMPLE'],
    });
    expect(count).toBe(2);
    expect(JSON.stringify(value)).not.toContain('wJalrXUtnFEMI');
  });

  it('masks a value whose key names a secret, even when the value looks ordinary', () => {
    // The common shape for tool arguments: nothing in the value itself gives it away.
    const { value, count } = redactValue({ apiKey: 'a1b2c3d4e5f6', model: 'claude-opus-5' });
    expect(count).toBe(1);
    expect((value as Record<string, string>).apiKey).toBe('[REDACTED]');
    expect((value as Record<string, string>).model).toBe('claude-opus-5');
  });

  it('leaves a short value under a secret-ish key alone', () => {
    const { count } = redactValue({ token_type: 'jwt' });
    expect(count).toBe(0);
  });

  it('recognises secret-bearing paths', () => {
    expect(isSensitivePath('/app/.env')).toBe(true);
    expect(isSensitivePath('config/secrets.yaml')).toBe(true);
    expect(isSensitivePath('~/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('src/env.ts')).toBe(false);
  });
});

describe('importance classification', () => {
  it('treats an explicit prohibition as critical, in English and Italian', () => {
    expect(classifyImportance(event('USER_MESSAGE', { text: 'Do not change the public API' }))).toBe('critical');
    expect(classifyImportance(event('USER_MESSAGE', { text: 'Non modificare le migration' }))).toBe('critical');
  });

  it('keeps an ordinary user message high but not critical', () => {
    expect(classifyImportance(event('USER_MESSAGE', { text: 'how does login work?' }))).toBe('high');
  });

  it('discards a successful command with no residue', () => {
    const e = event('COMMAND_EXECUTED', { command: 'npm test', output: '12 passed', exit_code: 0 });
    expect(classifyImportance(e)).toBe('ephemeral');
  });

  it('raises a failed command', () => {
    const e = event('COMMAND_EXECUTED', { command: 'npm test', output: '1 failing', exit_code: 1 });
    expect(classifyImportance(e)).toBe('high');
  });

  it('only sends events that carry meaning to a model', () => {
    expect(needsSemantics(event('USER_MESSAGE', { text: 'hi' }))).toBe(true);
    expect(needsSemantics(event('TOOL_RESULT', { output: 'a file listing' }))).toBe(false);
    expect(
      needsSemantics(event('ASSISTANT_MESSAGE', { text: "We'll use PostgreSQL because Redis is unavailable" })),
    ).toBe(true);
    expect(needsSemantics(event('ASSISTANT_MESSAGE', { text: 'Reading the file now.' }))).toBe(false);
  });
});

describe('deterministic engine', () => {
  const engine = (over: Partial<Parameters<typeof makeEngine>[0]> = {}) => makeEngine(over);

  function makeEngine(over: {
    duplicate?: boolean;
    excluded?: boolean;
    fileHash?: string | null;
    config?: ReturnType<typeof testConfig>;
  }) {
    return new DeterministicEngine({
      config: over.config ?? testConfig(),
      isDuplicate: () => over.duplicate ?? false,
      knownFileHash: () => over.fileHash ?? null,
      isExcluded: () => over.excluded ?? false,
    });
  }

  it('discards duplicates before doing any other work', () => {
    const d = engine({ duplicate: true }).process(event('USER_MESSAGE', { text: 'Do not touch auth' }));
    expect(d.action).toBe('discard');
    expect(d.reasons).toEqual(['duplicate_event']);
  });

  it('never ingests a secret-bearing path', () => {
    const d = engine().process(event('FILE_CHANGED', { path: '/app/.env' }));
    expect(d.action).toBe('discard');
    expect(d.reasons[0]).toContain('excluded_path');
  });

  it('truncates and hashes oversized output instead of storing it whole', () => {
    const config = testConfig({ retention: { max_payload_chars: 200 } } as never);
    const big = 'x'.repeat(5000);
    const d = engine({ config }).process(event('TOOL_RESULT', { output: `${big} error` }));
    expect(d.reasons).toContain('payload_truncated');
    expect(String(d.event.payload.output).length).toBeLessThan(400);
    expect(d.event.payload.original_bytes).toBe(5006);
    expect(d.event.payload.original_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redacts before persisting', () => {
    const d = engine().process(
      event('TOOL_RESULT', { output: 'key=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa error happened' }),
    );
    expect(String(d.event.payload.output)).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(d.event.payload.redactions).toBeGreaterThan(0);
  });

  it('skips a file whose content has not changed', () => {
    const d = engine({ fileHash: 'abc' }).process(
      event('FILE_CHANGED', { path: 'src/a.ts', content_hash: 'abc' }),
    );
    expect(d.action).toBe('discard');
    expect(d.reasons).toContain('file_unchanged');
  });

  it('downgrades an event whose importance was merely the default', () => {
    // Regression: `makeEvent` defaults to medium, and treating that default as a claim by
    // the adapter made every downgrade a no-op - so nothing was ever discarded and a real
    // transcript persisted thousands of low-value tool results at medium.
    const e = event('TOOL_RESULT', { output: 'a directory listing of no consequence' });
    expect(e.importance).toBe('medium');
    expect(e.importance_source).toBe('default');
    const d = engine().process(e);
    expect(d.importance).toBe('low');
    expect(d.reasons).toContain('reclassified:medium->low');
  });

  it('honours an importance the adapter deliberately claimed', () => {
    const e = event('TOOL_RESULT', { output: 'listing' }, { importance: 'critical' });
    expect(e.importance_source).toBe('adapter');
    expect(engine().process(e).importance).toBe('critical');
  });

  it('discards an empty tool result outright', () => {
    const d = engine().process(event('TOOL_RESULT', { output: '' }));
    expect(d.action).toBe('discard');
    expect(d.reasons).toContain('ephemeral_no_residue');
  });

  it('routes a constraint to a worker and a tool listing to persistence only', () => {
    expect(engine().process(event('USER_MESSAGE', { text: 'Never use Redis' })).action).toBe(
      'persist_and_queue',
    );
    expect(engine().process(event('FILE_CHANGED', { path: 'src/a.ts', content_hash: 'z' })).action).toBe(
      'persist',
    );
  });
});

describe('triggers', () => {
  const config = testConfig();

  it('fires immediately on a critical event', () => {
    const v = evaluateTriggers(config, {
      pendingEvents: 1,
      pendingTokens: 10,
      highestPendingImportance: 'critical',
      secondsSinceLastWorker: 0,
      totalEventsThisSession: 1,
      compactionRequested: false,
    });
    expect(v.fire).toBe(true);
  });

  it('holds below the thresholds', () => {
    const v = evaluateTriggers(config, {
      pendingEvents: 3,
      pendingTokens: 100,
      highestPendingImportance: 'low',
      secondsSinceLastWorker: 5,
      totalEventsThisSession: 10,
      compactionRequested: false,
    });
    expect(v.fire).toBe(false);
  });

  it('relaxes thresholds as a session gets long', () => {
    expect(adaptiveScale(10)).toBe(1);
    expect(adaptiveScale(5000)).toBe(4);
    const long = evaluateTriggers(config, {
      pendingEvents: 45,
      pendingTokens: 100,
      highestPendingImportance: 'medium',
      secondsSinceLastWorker: 5,
      totalEventsThisSession: 5000,
      compactionRequested: false,
    });
    expect(long.fire).toBe(false);
  });

  it('always honours an explicit compaction request', () => {
    const v = evaluateTriggers(config, {
      pendingEvents: 1,
      pendingTokens: 1,
      highestPendingImportance: 'low',
      secondsSinceLastWorker: 0,
      totalEventsThisSession: 1,
      compactionRequested: true,
    });
    expect(v.fire).toBe(true);
    expect(v.reason).toBe('compaction_requested');
  });
});

describe('gitignore matching', () => {
  it('handles anchoring, directories, globs and negation', () => {
    const m = new IgnoreMatcher('/proj', [
      'node_modules/',
      '*.log',
      '/dist',
      'build/**/*.map',
      '!keep.log',
    ]);
    expect(m.ignores('/proj/node_modules/x/index.js')).toBe(true);
    expect(m.ignores('/proj/src/app.log')).toBe(true);
    expect(m.ignores('/proj/keep.log')).toBe(false);
    expect(m.ignores('/proj/dist/main.js')).toBe(true);
    expect(m.ignores('/proj/src/dist/main.js')).toBe(false);
    expect(m.ignores('/proj/build/a/b/x.map')).toBe(true);
    expect(m.ignores('/proj/src/index.ts')).toBe(false);
    expect(m.ignores('/elsewhere/node_modules/x')).toBe(false);
  });
});

describe('deterministic fold', () => {
  const stored = (e: ReturnType<typeof event>): StoredEvent => ({
    ...e,
    action: 'persist',
    reasons: [],
    tokens: 10,
    processed_at: null,
  });

  it('derives task state without a model', () => {
    const r = deterministicFold([
      stored(event('TASK_STARTED', { text: 'Refactor auth' })),
      stored(event('FILE_CHANGED', { path: 'src/auth.ts', content_hash: 'h1' })),
    ]);
    expect(r.patch.working?.current_task).toBe('Refactor auth');
    expect(r.patch.working?.task_status).toBe('in_progress');
    expect(r.fileNotes).toEqual([{ path: 'src/auth.ts', contentHash: 'h1' }]);
    expect(r.consumed).toHaveLength(2);
  });

  it('records a failed command as an expiring known issue', () => {
    const r = deterministicFold([
      stored(
        event('COMMAND_EXECUTED', {
          command: 'npm run build',
          exit_code: 2,
          output: "src/metrics.ts(140,32): error TS2339: Property 'input_tokens' does not exist",
        }),
      ),
    ]);
    const added = r.patch.add ?? [];
    expect(added).toHaveLength(1);
    expect(added[0]!.category).toBe('known_issues');
    expect(added[0]!.ttl_seconds).toBe(86_400);
    expect(added[0]!.source).toBe('deterministic');
  });

  it('does not record an agent guessing at a path as a project issue', () => {
    const r = deterministicFold([
      stored(event('ERROR_DETECTED', { error: 'sed: nope/file.ts: No such file or directory' })),
      stored(event('COMMAND_EXECUTED', { command: 'cat missing.ts', exit_code: 1, output: 'ENOENT' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    // Closed, but as inert: rejected noise must not be counted as state we derived.
    expect(r.inert).toHaveLength(2);
    expect(r.consumed).toHaveLength(0);
  });

  it('does not record the agent calling its own tools wrongly as a project issue', () => {
    // Found on a real session: the single "known issue" recorded was a schema complaint about
    // the agent's own tool call, which says nothing about the project.
    const r = deterministicFold([
      stored(
        event('ERROR_DETECTED', {
          error:
            'Invalid arguments for tool "browser_click":\n' +
            '\u2716 Invalid input: expected string, received undefined\n  \u2192 at target',
        }),
      ),
      stored(event('ERROR_DETECTED', { error: 'InputValidationError: tool schema mismatch on Write' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(2);
    expect(r.consumed).toHaveLength(0);
  });

  it('does not record agent platform errors as project memory', () => {
    // These dominate ERROR_DETECTED in a long real session and say nothing about the code.
    const r = deterministicFold([
      stored(event('ERROR_DETECTED', { error: "Agent terminated early due to an API error: You've hit your session limit" })),
      stored(event('ERROR_DETECTED', { error: 'API Error: 529 Overloaded. This is a server-side issue' })),
      stored(event('ERROR_DETECTED', { error: 'claude-sonnet-5 is temporarily unavailable' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(3);
    expect(r.consumed).toHaveLength(0);
  });

  it('does not record harness refusals or bare exit codes', () => {
    const r = deterministicFold([
      stored(event('ERROR_DETECTED', { error: '<tool_use_error>Blocked: sleep 45 is not allowed</tool_use_error>' })),
      stored(event('ERROR_DETECTED', { error: '[Request interrupted by user for tool use]' })),
      stored(event('ERROR_DETECTED', { error: 'Exit code 144' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(3);
    expect(r.consumed).toHaveLength(0);
  });

  it('still records a genuine failure that mentions a missing file', () => {
    const r = deterministicFold([
      stored(
        event('ERROR_DETECTED', {
          error: 'Traceback (most recent call last):\n  FileNotFoundError: no such file or directory',
        }),
      ),
    ]);
    expect(r.patch.add ?? []).toHaveLength(1);
  });

  it("closes a clean command as inert rather than as derived state", () => {
    const r = deterministicFold([
      stored(event('COMMAND_EXECUTED', { command: 'ls', exit_code: 0, output: 'a\nb' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(1);
    expect(r.consumed).toHaveLength(0);
  });
});

describe('state patches', () => {
  const base = (): ProjectState => ({ version: 3, working: emptyWorkingMemory(), items: [] });

  function withItem(over: Record<string, unknown> = {}): ProjectState {
    const now = new Date().toISOString();
    return {
      version: 3,
      working: emptyWorkingMemory(),
      items: [
        MemoryItemSchema.parse({
          id: 'mem_1',
          category: 'constraints',
          text: 'Do not change the public API',
          importance: 'critical',
          source: 'user',
          created_at: now,
          updated_at: now,
          ...over,
        }),
      ],
    };
  }

  it('rejects a patch built against a stale version', () => {
    const v = validatePatch({ base_version: 2, add: [{ category: 'goals', text: 'x' }] }, base());
    expect(v.map((x) => x.code)).toContain('version_conflict');
  });

  it('refuses to delete or weaken a user-critical constraint', () => {
    const state = withItem();
    expect(isProtected(state.items[0]!)).toBe(true);
    expect(validatePatch({ remove: ['mem_1'] }, state)[0]!.code).toBe('protected_item');
    expect(
      validatePatch({ update: [{ id: 'mem_1', importance: 'low' }] }, state)[0]!.code,
    ).toBe('protected_item');
    expect(
      validatePatch({ update: [{ id: 'mem_1', status: 'archived' }] }, state)[0]!.code,
    ).toBe('protected_item');
  });

  it('refuses to retire a protected item by superseding it', () => {
    // Regression: `remove` and `update` were guarded but `supersede` was not, so the K2
    // guarantee was bypassable with one different key.
    const state = withItem();
    const viaSupersede = validatePatch(
      { add: [{ id: 'mem_2', category: 'constraints', text: 'looser rule' }], supersede: [{ id: 'mem_1', by: 'mem_2' }] },
      state,
    );
    expect(viaSupersede.map((v) => v.code)).toContain('protected_item');

    const viaAdd = validatePatch(
      { add: [{ category: 'constraints', text: 'looser rule', supersedes: ['mem_1'] }] },
      state,
    );
    expect(viaAdd.map((v) => v.code)).toContain('protected_item');
  });

  it('allows a non-weakening update to a protected item', () => {
    expect(validatePatch({ update: [{ id: 'mem_1', reason: 'restated by user' }] }, withItem())).toEqual([]);
  });

  it('rejects references to items that do not exist', () => {
    expect(validatePatch({ update: [{ id: 'nope', text: 'x' }] }, base())[0]!.code).toBe('unknown_item');
    expect(validatePatch({ touch: ['nope'] }, base())[0]!.code).toBe('unknown_item');
  });

  it('applies adds, supersessions and working memory in one fold', () => {
    const state = withItem({ id: 'mem_old', importance: 'high', source: 'agent', text: 'Use Redis' });
    const result = applyPatch(state, {
      working: { current_task: 'swap the cache' },
      add: [
        {
          id: 'mem_new',
          category: 'decisions',
          text: 'Use PostgreSQL',
          reason: 'production does not run Redis',
          supersedes: ['mem_old'],
        },
      ],
    });
    expect(result.state.version).toBe(4);
    expect(result.state.working.current_task).toBe('swap the cache');
    const old = result.state.items.find((i) => i.id === 'mem_old')!;
    expect(old.status).toBe('superseded');
    expect(old.superseded_by).toBe('mem_new');
    // PRD 44: the replaced decision is retired, not erased.
    expect(result.state.items).toHaveLength(2);
  });

  it('soft-deletes so history survives', () => {
    const state = withItem({ source: 'agent', importance: 'medium' });
    const result = applyPatch(state, { remove: ['mem_1'] });
    expect(result.state.items[0]!.status).toBe('deleted');
  });
});

describe('memory decay', () => {
  it('treats an expired item as not live', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const item = MemoryItemSchema.parse({
      id: 'mem_x',
      category: 'known_issues',
      text: 'flaky test',
      created_at: old,
      updated_at: old,
      last_validated_at: old,
      ttl_seconds: 86_400,
    });
    expect(isLive(item)).toBe(false);
    expect(isLive({ ...item, ttl_seconds: null })).toBe(true);
    // Regression: `stale` is exactly what decay() assigns to stop an item being served, so
    // treating it as live made decay a no-op for keyword search and graph traversal.
    expect(isLive({ ...item, ttl_seconds: null, status: 'stale' })).toBe(false);
    expect(isLive({ ...item, ttl_seconds: null, status: 'superseded' })).toBe(false);
  });
});

describe('cost controller', () => {
  const spec = {
    provider: 'anthropic' as const,
    model: 'm',
    input_cost_per_mtok: 1,
    output_cost_per_mtok: 5,
    max_output_tokens: 1000,
  };

  it('prices from reported usage', () => {
    const cost = priceUsage(spec, { input_tokens: 1_000_000, output_tokens: 200_000 });
    expect(cost).toBeCloseTo(1 + 1, 5);
  });

  it('stops spawning workers once the session cap is reached', () => {
    const c = new CostController(testConfig({ budget: { max_cost_per_session_usd: 0.1 } } as never), {
      recentUsage: () => [],
      sessionCostUsd: () => 0.2,
    });
    const d = c.check(100);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain('session cost');
  });

  it('enforces the hourly token ceiling', () => {
    const c = new CostController(testConfig({ budget: { max_tokens_per_hour: 1000 } } as never), {
      recentUsage: () => [{ at: Date.now(), tokens: 900, cost_usd: 0 }],
      sessionCostUsd: () => 0,
    });
    expect(c.check(200).allowed).toBe(false);
    expect(c.check(50).allowed).toBe(true);
  });
});

describe('error text quality', () => {
  const stored = (e: ReturnType<typeof event>): StoredEvent => ({
    ...e,
    action: 'persist',
    reasons: [],
    tokens: 10,
    processed_at: null,
  });

  it('does not record a throwaway one-liner as a project issue', () => {
    // Live session: a `node -e` query against the database failed and its stack trace became a
    // known issue. Scratch exploration is not the project's build.
    expect(isScratchCommand(`node -e "const db=require('better-sqlite3'); db.prepare('...')"`)).toBe(true);
    expect(isScratchCommand('python3 -c "import json; print(1)"')).toBe(true);
    // The real thing stays.
    expect(isScratchCommand('npm test')).toBe(false);
    expect(isScratchCommand('node dist/cli/index.js status')).toBe(false);

    const r = deterministicFold([
      stored(
        event('COMMAND_EXECUTED', {
          command: 'node -e "db.prepare(\'SELECT version FROM patches\').all()"',
          exit_code: 1,
          output: 'SqliteError: no such column: version\n    at Database.prepare (wrappers.js:5:21)',
        }),
      ),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(1);
  });

  it('traces a tool error back to the call that caused it', () => {
    // A tool error carries only `tool_use_id`; the command lives on the matching call. Without
    // correlating the two, a failed `node -e` is indistinguishable from a failed build - and a
    // live session filed exactly that stack trace as a project known issue.
    const r = deterministicFold([
      stored(
        event('TOOL_CALL', {
          tool: 'Bash',
          tool_use_id: 'toolu_1',
          command: `node -e "db.prepare('SELECT version FROM patches').all()"`,
        }),
      ),
      stored(
        event('ERROR_DETECTED', {
          tool_use_id: 'toolu_1',
          error: 'Exit code 1\nSqliteError: no such column: version\n    at Database.prepare (wrappers.js:5:21)',
        }),
      ),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);

    // The same error from a real build still counts.
    const real = deterministicFold([
      stored(event('TOOL_CALL', { tool: 'Bash', tool_use_id: 'toolu_2', command: 'npm run build' })),
      stored(
        event('ERROR_DETECTED', {
          tool_use_id: 'toolu_2',
          error: "Exit code 1\nsrc/store.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'",
        }),
      ),
    ]);
    expect(real.patch.add ?? []).toHaveLength(1);
    expect(real.patch.add?.[0]?.category).toBe('known_issues');
  });

  it('does not record the agent mistyping a shell command', () => {
    // Real session: `(eval):1: bad substitution` from a command of my own was stored as a
    // known issue. A command that never parsed cannot say anything about the project.
    const r = deterministicFold([
      stored(event('COMMAND_EXECUTED', {
        command: 'for v in A B; do echo ${!v}; done',
        exit_code: 1,
        output: '(eval):1: bad substitution',
      })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(1);
  });

  it('does not store a minified dump as a known issue', () => {
    // Real session: a failing `npx tsx` call put 500 characters of a bundled vendor file into
    // memory. True, and useless - the precision failure, not the loss failure.
    const minified = `const a=1;${'x'.repeat(200)},b=u(e=>{if(F.has(e))return F.get(e)});${'y'.repeat(200)}`;
    expect(looksLikeDump(minified)).toBe(true);
    expect(isTransientToolError(`Exit code 1\n${minified}`)).toBe(true);
  });

  it('still keeps a readable stack trace', () => {
    const trace = [
      'Traceback (most recent call last):',
      '  File "src/auth.py", line 42, in refresh',
      '    token = store.get(user_id)',
      'KeyError: user_id',
    ].join('\n');
    expect(looksLikeDump(trace)).toBe(false);
    expect(isTransientToolError(trace)).toBe(false);
  });
});

describe('agent reasoning recall', () => {
  const assistant = (text: string) => event('ASSISTANT_MESSAGE', { text });

  it('queues a finding stated declaratively, with no decision cue in it', () => {
    // Real session: 102 of 106 agent messages were dropped, including this one. No "because",
    // no "we'll use" - and it is the single most valuable thing said in the session.
    const finding = assistant(
      'Found the real bug: the adapter default importance was treated as a deliberate claim, ' +
        'so the classifier could never downgrade anything and 3,401 tool results persisted.',
    );
    expect(needsSemantics(finding)).toBe(true);
    expect(classifyImportance(finding)).toBe('high');
  });

  it('queues a long message even when no cue matches at all', () => {
    const substantial = assistant('x'.repeat(ASSISTANT_SUBSTANCE_CHARS));
    expect(needsSemantics(substantial)).toBe(true);
    // Still medium: length is a reason to read it, not a reason to trust it.
    expect(classifyImportance(substantial)).toBe('medium');
  });

  it('still drops progress narration', () => {
    // The median agent message on that session was 79 characters of exactly this.
    for (const line of ['Core schemas first.', 'Typechecking the whole thing.', 'Now the docs.']) {
      expect(needsSemantics(assistant(line))).toBe(false);
    }
  });
});

describe('confidence is a claim to be earned', () => {
  it('clamps an inferred item to below certainty', () => {
    // A real run returned 18 items at 1.00, which makes the field carry no information.
    const p = normalizePatch({
      add: [{ category: 'decisions', text: 'Use SQLite', source: 'worker', confidence: 1 }],
    });
    expect(p.add?.[0]?.confidence).toBe(MAX_INFERRED_CONFIDENCE);
  });

  it('leaves what the user said alone', () => {
    const p = normalizePatch({
      add: [{ category: 'constraints', text: 'Never touch the public API', source: 'user', confidence: 1 }],
    });
    expect(p.add?.[0]?.confidence).toBe(1);
  });

  it('does not invent a confidence the model omitted', () => {
    const p = normalizePatch({ add: [{ category: 'decisions', text: 'Use SQLite', source: 'worker' }] });
    expect(p.add?.[0]?.confidence).toBeUndefined();
  });
});

describe('what may become a protected constraint', () => {
  it('promotes a real prohibition', () => {
    const e = event('USER_MESSAGE', { text: 'Never store refresh tokens in Redis.' });
    expect(classifyImportance(e)).toBe('critical');
  });

  it('does not promote a cue found inside pasted terminal output', () => {
    // Real session: a pasted shell transcript became a critical constraint, and `critical` is
    // the one level `isProtected` makes permanent.
    const pasted = [
      '(base) dev@host project % node cli.js compact',
      'ok        patch_applied      events 33  v2',
      'you must not rely on this output',
    ].join('\n');
    expect(looksLikePastedTerminal(pasted)).toBe(true);
    expect(classifyImportance(event('USER_MESSAGE', { text: pasted }))).toBe('high');
  });

  it('does not mistake ordinary prose for a terminal paste', () => {
    expect(looksLikePastedTerminal('Run npm test and never skip the typecheck.')).toBe(false);
  });
});

describe('harness refusals are not project issues', () => {
  const stored2 = (e: ReturnType<typeof event>): StoredEvent => ({
    ...e,
    action: 'persist',
    reasons: [],
    tokens: 10,
    processed_at: null,
  });

  it('does not record a denied tool call as a known issue', () => {
    // Real session: recorded four times, guidance text and all.
    const r = deterministicFold([
      stored2(
        event('ERROR_DETECTED', {
          error:
            'Permission for this action was denied by the Claude Code auto mode classifier. ' +
            'Reason: [Data Exfiltration]. If you have other tasks that do not depend on this action, continue.',
        }),
      ),
      stored2(event('ERROR_DETECTED', { error: 'Permission denied by the user for the Write tool' })),
    ]);
    expect(r.patch.add ?? []).toHaveLength(0);
    expect(r.inert).toHaveLength(2);
  });
});
