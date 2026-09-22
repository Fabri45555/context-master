import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index.js';
import { claudeStatusline } from '../src/adapters/claude/statusline.js';
import type { HostEnv } from '../src/adapters/types.js';
import { assessPressure, clearAdvice, type PressureInput } from '../src/core/lifecycle.js';
import { formatStatusline, joinStatusline, readStatusline, runChained } from '../src/ops/statusline.js';
import { makeManager, testConfig } from './helpers.js';

const DEFAULT_CONFIG = testConfig();

/**
 * contextd cannot clear the agent's window, and clearing it piece by piece would defeat the prompt
 * cache. What it can do is say, once and to the person, when throwing the conversation away has
 * become safe - before the agent hits its limit and compacts on its own.
 */
const input = (over: Partial<PressureInput>): PressureInput => ({
  occupiedTokens: 0,
  observedPeakTokens: 0,
  model: null,
  pendingEvents: 0,
  pendingTokens: 0,
  compactionRequested: false,
  stateVersion: 5,
  bootstrapTokens: 700,
  ...over,
});

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `contextd-${p}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('clear advice', () => {
  const at = (tokens: number, over: Partial<PressureInput> = {}) =>
    clearAdvice(DEFAULT_CONFIG, assessPressure(DEFAULT_CONFIG, input({ occupiedTokens: tokens, ...over })), 700);

  it('says nothing until the window is past pressure_high', () => {
    expect(at(0)).toBeNull();
    expect(at(120_000)).toBeNull(); // 60% of the default 200k window
  });

  it('says /clear is safe when memory is ready, and says it louder near the limit', () => {
    const high = at(160_000)!;
    expect(high).toMatchObject({ level: 'high', ready: true });
    expect(high.text).toContain('context at 80%');
    expect(high.text).toContain('/clear now');
    expect(high.text).toContain('700-token bootstrap');
    expect(at(190_000)).toMatchObject({ level: 'critical', ready: true });
    expect(at(190_000)!.text).toContain('before the agent compacts on its own');
  });

  it('says what to run first when memory could not carry the session', () => {
    const blocked = at(160_000, { pendingEvents: 400, pendingTokens: 200_000 })!;
    expect(blocked.ready).toBe(false);
    expect(blocked.text).toContain('not ready');
    expect(blocked.text).toContain('contextd compact');
  });

  it('keys on occupancy, not on a stage a backlog alone raised', () => {
    const p = assessPressure(DEFAULT_CONFIG, input({ occupiedTokens: 20_000, pendingTokens: 200_000, pendingEvents: 400 }));
    expect(p.stage).toBe('consolidate');
    expect(clearAdvice(DEFAULT_CONFIG, p, 700)).toBeNull();
  });

  it('is said once per level per session, and again when it changes', () => {
    const { manager, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });
      manager.store.recordAgentUsage('s1', { input_tokens: 160_000 }, 'some-model');
      expect(manager.clearAdviceOnce('s1')?.level).toBe('high');
      expect(manager.clearAdviceOnce('s1')).toBeNull();
      expect(manager.clearAdviceOnce('s2')).toBeNull(); // no usage observed for s2
      manager.store.recordAgentUsage('s1', { input_tokens: 190_000 }, 'some-model');
      expect(manager.clearAdviceOnce('s1')?.level).toBe('critical');
      expect(manager.clearAdviceOnce('s1')).toBeNull();
      // Reading it for the dashboard or the status line never marks it said.
      expect(manager.clearAdviceNow('s1')?.level).toBe('critical');
    } finally {
      cleanup();
    }
  });
});

describe('claude hook reply', () => {
  it('puts the bootstrap in the model context and the notice in front of the person only', () => {
    const start = JSON.parse(claudeAdapter.hookReply('session_start', { context: 'memory' })!);
    expect(start.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'memory' });
    const prompt = JSON.parse(claudeAdapter.hookReply('user_prompt', { notice: 'clear now' })!);
    expect(prompt).toEqual({ systemMessage: 'clear now' });
    expect(claudeAdapter.hookReply('other', {})).toBeNull();
    expect(claudeAdapter.hookMoment({ hook_event_name: 'UserPromptSubmit' })).toBe('user_prompt');
    expect(claudeAdapter.hookMoment({ hook_event_name: 'PostToolUse' })).toBe('other');
  });
});

describe('status line', () => {
  const host = (root: string): HostEnv => ({ projectRoot: root, home: tmp('home') });
  const ours = (c: string) => /\bstatusline\s*$/.test(c);

  it('reads the project and session from the payload', () => {
    expect(claudeStatusline.parse({ session_id: 's1', workspace: { project_dir: '/p', current_dir: '/p/src' } })).toEqual({
      projectDir: '/p',
      sessionId: 's1',
    });
    expect(claudeStatusline.parse({ cwd: '/q' }).projectDir).toBe('/q');
    expect(claudeStatusline.parse(null)).toEqual({ projectDir: null, sessionId: null });
  });

  it('installs into the personal local settings, and never overwrites a line it did not write', () => {
    const root = tmp('proj');
    mkdirSync(join(root, '.claude'));
    const shared = join(root, '.claude', 'settings.json');
    const local = join(root, '.claude', 'settings.local.json');
    writeFileSync(shared, JSON.stringify({ hooks: { Stop: [] }, model: 'x' }));
    const env = host(root);
    expect(claudeStatusline.install(env, 'contextd statusline').status).toBe('installed');
    expect(claudeStatusline.install(env, 'contextd statusline').status).toBe('already');
    // A status line is a preference: the committed settings are not touched.
    expect(JSON.parse(readFileSync(shared, 'utf8'))).toEqual({ hooks: { Stop: [] }, model: 'x' });
    expect(JSON.parse(readFileSync(local, 'utf8')).statusLine).toMatchObject({ type: 'command', command: 'contextd statusline' });

    expect(claudeStatusline.uninstall(env, ours)).toEqual([local]);
    expect(JSON.parse(readFileSync(local, 'utf8')).statusLine).toBeUndefined();

    writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: '~/bin/my-line.sh' } }));
    const conflict = claudeStatusline.install(env, 'contextd statusline');
    expect(conflict.status).toBe('conflict');
    expect(conflict.detail).toContain('--chain');
    expect(claudeStatusline.uninstall(env, ours)).toEqual([]);
    expect(JSON.parse(readFileSync(shared, 'utf8')).statusLine.command).toBe('~/bin/my-line.sh');
  });

  it('--chain keeps the line someone had, and uninstall puts it back where it was', () => {
    const root = tmp('proj');
    mkdirSync(join(root, '.claude'));
    const local = join(root, '.claude', 'settings.local.json');
    writeFileSync(local, JSON.stringify({ statusLine: { type: 'command', command: 'my-line.sh' }, other: 1 }));
    const env = host(root);
    const r = claudeStatusline.install(env, 'contextd statusline', { chain: true });
    expect(r.status).toBe('installed');
    expect(r.replaced).toEqual({ path: local, command: 'my-line.sh' });
    expect(JSON.parse(readFileSync(local, 'utf8'))).toMatchObject({ other: 1, statusLine: { command: 'contextd statusline' } });
    expect(claudeStatusline.uninstall(env, ours, r.replaced)).toEqual([local]);
    expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({ other: 1, statusLine: { type: 'command', command: 'my-line.sh' } });
  });

  it('runs the chained line with the same payload, and joins the two', () => {
    expect(runChained('cat', '{"a":1}')).toBe('{"a":1}');
    expect(runChained('sleep 5', '')).toBe(''); // bounded: a hanging line is dropped, not waited on
    expect(joinStatusline('mine', 'contextd · 3 items', false)).toBe('mine | contextd · 3 items');
    expect(joinStatusline('', 'ours', false)).toBe('ours');
    expect(joinStatusline('theirs', '', false)).toBe('theirs');
  });

  it('shows occupancy and when /clear is safe, and creates nothing where there is no memory', () => {
    const empty = tmp('empty');
    expect(readStatusline(empty, null)).toBeNull();
    expect(existsSync(join(empty, '.context'))).toBe(false);

    const { manager, root, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer synchronous' }] });
      manager.store.recordAgentUsage('s1', { input_tokens: 160_000 }, 'some-model');
      const state = readStatusline(root, 's1')!;
      expect(state).toMatchObject({ advice: 'ready', items: 1 });
      expect(formatStatusline(state, false)).toBe('contextd · ctx 80% · memory ready: /clear is safe');
      expect(formatStatusline({ ratio: 0.3, items: 12, advice: null, chain: null }, false)).toBe('contextd · ctx 30% · 12 items');
      expect(formatStatusline({ ratio: null, items: 3, advice: null, chain: null }, false)).toBe('contextd · 3 items');
    } finally {
      cleanup();
    }
  });
});
