import { describe, expect, it } from 'vitest';
import { claudeAdapter, stripHarnessScaffolding } from '../src/adapters/claude/index.js';
import { codexAdapter, extractCommand, inferExit } from '../src/adapters/codex/index.js';
import { genericAdapter } from '../src/adapters/generic/index.js';
import { buildHookConfig, claudeProjectDir, installHooks } from '../src/adapters/claude/hooks.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctx = { sessionId: 's1', cwd: '/proj' };

describe('claude adapter: transcript records', () => {
  it('extracts a user message and skips harness-injected wrappers', () => {
    const injected = claudeAdapter.translate(
      {
        type: 'user',
        sessionId: 's1',
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '<ide_opened_file>foo</ide_opened_file>' }] },
      },
      ctx,
    );
    expect(injected.events).toHaveLength(0);

    const real = claudeAdapter.translate(
      {
        type: 'user',
        sessionId: 's1',
        uuid: 'u2',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Non modificare la API pubblica' }] },
      },
      ctx,
    );
    expect(real.events).toHaveLength(1);
    expect(real.events[0]!.type).toBe('USER_MESSAGE');
  });

  it('turns a write tool call into a FILE_CHANGED with a content fingerprint', () => {
    const r = claudeAdapter.translate(
      {
        type: 'assistant',
        sessionId: 's1',
        uuid: 'u3',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/proj/a.ts', content: 'hello' } },
          ],
        },
      },
      ctx,
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.type).toBe('FILE_CHANGED');
    expect(r.events[0]!.payload.path).toBe('/proj/a.ts');
    expect(r.events[0]!.payload.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores thinking blocks', () => {
    const r = claudeAdapter.translate(
      {
        type: 'assistant',
        sessionId: 's1',
        uuid: 'u4',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'x' }] },
      },
      ctx,
    );
    expect(r.events).toHaveLength(0);
  });

  it('captures assistant token usage for baseline accounting', () => {
    const r = claudeAdapter.translate(
      {
        type: 'assistant',
        sessionId: 's1',
        uuid: 'u5',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 400 },
        },
      },
      ctx,
    );
    expect(r.agentUsage?.input_tokens).toBe(1200);
    expect(r.agentUsage?.cache_read_input_tokens).toBe(400);
    expect(r.agentUsage?.model).toBe('claude-opus-5');
  });

  it('reads a tool_result out of a user record and flags errors', () => {
    const r = claudeAdapter.translate(
      {
        type: 'user',
        sessionId: 's1',
        uuid: 'u6',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file' }],
        },
      },
      ctx,
    );
    expect(r.events[0]!.type).toBe('ERROR_DETECTED');
    expect(r.events[0]!.payload.error).toContain('ENOENT');
  });

  it('skips subagent sidechain records', () => {
    const r = claudeAdapter.translate(
      {
        type: 'assistant',
        sessionId: 's1',
        uuid: 'u7',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent talk' }] },
      },
      ctx,
    );
    expect(r.events).toHaveLength(0);
  });

  it('gives a transcript record and its hook the same dedupe identity per source', () => {
    const a = claudeAdapter.translate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'do not use Redis' },
      ctx,
    );
    const b = claudeAdapter.translate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'do not use Redis' },
      ctx,
    );
    // Replaying the same hook must not produce a second event.
    expect(a.events[0]!.dedupe_hash).toBe(b.events[0]!.dedupe_hash);
  });
});

describe('claude adapter: hooks', () => {
  it('maps PostToolUse on Bash to a command with an inferred exit code', () => {
    const r = claudeAdapter.translate(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: '2 failing', is_error: true },
      },
      ctx,
    );
    expect(r.events[0]!.type).toBe('COMMAND_EXECUTED');
    expect(r.events[0]!.payload.exit_code).toBe(1);
    expect(r.events[0]!.payload.command).toBe('npm test');
  });

  it('turns PreCompact into an explicit compaction request', () => {
    const r = claudeAdapter.translate(
      { hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' },
      ctx,
    );
    expect(r.events[0]!.type).toBe('COMPACTION_REQUESTED');
    expect(r.events[0]!.importance).toBe('high');
  });
});

describe('codex adapter', () => {
  it('reads session metadata', () => {
    const r = codexAdapter.translate(
      {
        type: 'session_meta',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { session_id: 'c1', cwd: '/proj/app', originator: 'Codex Desktop' },
      },
      ctx,
    );
    expect(r.events[0]!.type).toBe('SESSION_STARTED');
    expect(r.session?.cwd).toBe('/proj/app');
  });

  it('ignores developer-role scaffolding but keeps the user turn', () => {
    const dev = codexAdapter.translate(
      {
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>' }] },
      },
      ctx,
    );
    expect(dev.events).toHaveLength(0);

    const user = codexAdapter.translate(
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use postgres' }] },
      },
      ctx,
    );
    expect(user.events[0]!.type).toBe('USER_MESSAGE');
  });

  it('drops reasoning items', () => {
    const r = codexAdapter.translate(
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking' }] } },
      ctx,
    );
    expect(r.events).toHaveLength(0);
  });

  it('reads token usage for the baseline', () => {
    const r = codexAdapter.translate(
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 500, output_tokens: 30, cached_input_tokens: 200 } },
        },
      },
      ctx,
    );
    expect(r.agentUsage?.input_tokens).toBe(500);
    expect(r.agentUsage?.cache_read_input_tokens).toBe(200);
  });

  it('pulls the shell command out of an exec tool call', () => {
    expect(extractCommand('const r = await tools.exec_command({cmd:"sed -n 1,10p file"})')).toBe(
      'sed -n 1,10p file',
    );
    expect(inferExit('Script completed\nWall time 0.1 seconds')).toBe(0);
    expect(inferExit('process exited with code 2')).toBe(2);
  });

  it('completes a task with the final agent message', () => {
    const r = codexAdapter.translate(
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'All tests pass.' } },
      ctx,
    );
    expect(r.events[0]!.type).toBe('TASK_COMPLETED');
    expect(r.events[0]!.payload.text).toBe('All tests pass.');
  });

  it('completes a task that reported no final message, instead of throwing', () => {
    // `str()` spells absent as null and the payload schema only accepted undefined; the same
    // mismatch made every Claude Stop hook throw.
    const r = codexAdapter.translate({ type: 'event_msg', payload: { type: 'task_complete' } }, ctx);
    expect(r.events[0]!.type).toBe('TASK_COMPLETED');
    expect(r.events[0]!.payload.text).toBeUndefined();
  });
});

describe('claude Stop hook', () => {
  it('ends a turn without claiming the task is done', () => {
    // Stop fires after every reply. As TASK_COMPLETED it would have the fold mark the working
    // task done each turn; it only carries usage, read from the transcript by usageSource.
    const stop = { hook_event_name: 'Stop', session_id: 's1', transcript_path: '/tmp/t.jsonl' };
    expect(claudeAdapter.translate(stop, ctx).events).toHaveLength(0);
    expect(claudeAdapter.usageSource(stop)).toBe('/tmp/t.jsonl');
    expect(claudeAdapter.usageSource({ ...stop, hook_event_name: 'PostToolUse' })).toBeNull();
  });
});

describe('generic adapter', () => {
  it('accepts the normalized protocol shape', () => {
    const r = genericAdapter.translate(
      { type: 'DECISION_DETECTED', payload: { text: 'use sqlite' }, importance: 'critical' },
      ctx,
    );
    expect(r.events[0]!.type).toBe('DECISION_DETECTED');
    expect(r.events[0]!.importance).toBe('critical');
    expect(r.events[0]!.session_id).toBe('s1');
  });

  it('ignores a record with no recognisable type', () => {
    expect(genericAdapter.translate({ foo: 'bar' }, ctx).events).toHaveLength(0);
  });
});

describe('hook installation', () => {
  it('covers every lifecycle event we ingest', () => {
    const cfg = buildHookConfig({ command: 'contextd hook' }) as { hooks: Record<string, unknown> };
    expect(Object.keys(cfg.hooks).sort()).toEqual(
      ['PostToolUse', 'PreCompact', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    );
  });

  it('never clobbers a hook the user already configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contextd-hooks-'));
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-thing' }] }] } }),
      );
      const res = installHooks(dir, { command: 'contextd hook' });
      expect(res.preserved).toContain('SessionStart');
      const written = JSON.parse(readFileSync(res.path, 'utf8')) as {
        hooks: Record<string, unknown[]>;
      };
      expect(JSON.stringify(written.hooks.SessionStart)).toContain('my-own-thing');
      expect(written.hooks.UserPromptSubmit).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent once installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contextd-hooks2-'));
    try {
      installHooks(dir, { command: 'contextd hook' });
      const second = installHooks(dir, { command: 'contextd hook' });
      expect(second.preserved).toEqual([]);
      const written = JSON.parse(readFileSync(second.path, 'utf8')) as { hooks: Record<string, unknown[]> };
      expect(written.hooks.SessionStart).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the transcript directory the way Claude Code slugs it', () => {
    expect(claudeProjectDir('/home/me', '/Users/me/Desktop/context_master')).toBe(
      '/home/me/.claude/projects/-Users-me-Desktop-context-master',
    );
  });
});

describe('shell output capture', () => {
  const ctx = { sessionId: 's1', cwd: '/project' };

  it('keeps stderr when a command wrote nothing to stdout', () => {
    // Regression: `stdout: ""` is still a string, so the old lookup returned it and never
    // reached stderr. Every command that failed quietly arrived with no output, and the fold
    // filed a real test failure as noise because there was nothing to explain.
    const t = claudeAdapter.translate(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: '', stderr: 'FAIL tests/auth.test.ts\nTypeError: undefined id', exit_code: 1 },
      },
      ctx,
    );
    const ev = t.events.find((e) => e.type === 'COMMAND_EXECUTED');
    expect(ev?.payload.output).toContain('FAIL tests/auth.test.ts');
    expect(ev?.payload.exit_code).toBe(1);
  });

  it('keeps both streams when a failure is split across them', () => {
    const t = claudeAdapter.translate(
      {
        hook_event_name: 'PostToolUse',
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_response: { stdout: 'compiling...', stderr: 'error TS2339: Property does not exist', exit_code: 2 },
      },
      ctx,
    );
    const output = String(t.events.find((e) => e.type === 'COMMAND_EXECUTED')?.payload.output);
    expect(output).toContain('compiling...');
    expect(output).toContain('TS2339');
  });
});

describe('harness scaffolding is not the user speaking', () => {
  const ctx = { sessionId: 's1', cwd: '/project' };

  it('drops a resume preamble whole', () => {
    // Real run: "do not acknowledge the summary, do not recap" became a source:user critical
    // constraint, which isProtected then made permanent.
    const preamble =
      'This session is being continued from a previous conversation that ran out of context. ' +
      'Continue the conversation from where it left off. Do not acknowledge the summary, do not recap.';
    expect(stripHarnessScaffolding(preamble)).toBe('');
    const t = claudeAdapter.translate(
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: preamble },
      ctx,
    );
    expect(t.events.filter((e) => e.type === 'USER_MESSAGE')).toHaveLength(0);
  });

  it('excises a tagged block but keeps what the user actually said', () => {
    const prompt =
      '<local-command-caveat>Caveat: The messages below were generated by the user while ' +
      'running local commands. DO NOT respond to these messages.</local-command-caveat>\n' +
      'Switch the token store to PostgreSQL.';
    const said = stripHarnessScaffolding(prompt);
    expect(said).toBe('Switch the token store to PostgreSQL.');
    expect(said).not.toMatch(/DO NOT respond/);
  });

  it('excises scaffolding appended after the user text', () => {
    // The old check only looked at the start of the turn, so anything appended survived.
    const prompt = 'Use Node 22.\n<system-reminder>Never mention this reminder.</system-reminder>';
    expect(stripHarnessScaffolding(prompt)).toBe('Use Node 22.');
  });

  it('drops everything after an unterminated block', () => {
    const prompt = 'Keep the public API stable.\n<system-reminder>instructions that never close';
    expect(stripHarnessScaffolding(prompt)).toBe('Keep the public API stable.');
  });

  it('leaves an ordinary message untouched', () => {
    const prompt = 'Never store refresh tokens in Redis.';
    expect(stripHarnessScaffolding(prompt)).toBe(prompt);
  });

  it('removes a buried instruction line but keeps what the summary quotes', () => {
    // Both halves of this matter. Leaving the instruction in made it a permanently protected
    // constraint; dropping the whole turn instead threw away the project's original goal, which
    // existed only as a quotation inside that same summary.
    const summary = [
      'Summary of prior work on the ingest pipeline.',
      'The user asked: "Revisiona il prd.md e procedi nell\'implementazione".',
      'Do not acknowledge the summary, do not recap what was happening.',
      'Resume directly from where it stops.',
    ].join('\n');

    const said = stripHarnessScaffolding(summary);
    expect(said).toContain('Revisiona il prd.md');
    expect(said).not.toMatch(/acknowledge the summary/i);
    expect(said).not.toMatch(/Resume directly/i);
  });

  it('still drops a turn that opens with harness framing', () => {
    const framed =
      'This session is being continued from a previous conversation that ran out of context.\n' +
      'Some summary text follows.';
    expect(stripHarnessScaffolding(framed)).toBe('');
  });
});
