import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCodeProvider } from '../src/workers/providers/index.js';

/**
 * The claude-code provider runs `claude -p` on the person's own login. A stand-in script plays the
 * CLI, so no test ever reaches a model; what matters is how it is called - a worker that fired
 * contextd's own hooks, or could use tools, would break invariants 9 and 22 at once.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeClaude(body: string): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'contextd-fakeclaude-'));
  dirs.push(dir);
  const log = join(dir, 'call.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, worker: process.env.CONTEXTD_WORKER, cwd: process.cwd() }));
  ${body}
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const spec = (bin: string) => ({
  provider: 'claude-code' as const,
  model: 'haiku',
  base_url: bin,
  input_cost_per_mtok: 0,
  output_cost_per_mtok: 0,
  max_output_tokens: 4096,
});

describe('claude-code provider', () => {
  it('asks Claude Code for one answer with no tools, no hooks, no project, no saved session', async () => {
    const { bin, log } = fakeClaude(
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"add": []}', usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 4 } }));`,
    );
    const res = await claudeCodeProvider.complete({ system: 'SYSTEM', user: 'USER PROMPT', maxTokens: 100 }, spec(bin));
    expect(res.text).toBe('{"add": []}');
    expect(res.usage).toMatchObject({ input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 4 });

    const call = JSON.parse(readFileSync(log, 'utf8'));
    expect(call.input).toBe('USER PROMPT');
    expect(call.worker).toBe('1');
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--safe-mode', '--no-session-persistence', '--output-format', 'json']));
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('');
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe('SYSTEM');
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('haiku');
    expect(call.args).not.toContain('--bare'); // --bare never reads OAuth: it would need an API key
    expect(call.cwd).toContain('contextd-worker-');
  });

  it('turns an error result into a ProviderError, retryable when the API was only busy', async () => {
    const { bin } = fakeClaude(
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 529, result: 'Overloaded' }));`,
    );
    await expect(claudeCodeProvider.complete({ system: 's', user: 'u', maxTokens: 10 }, spec(bin))).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
    });
  });

  it('says how to fix a missing CLI instead of failing obscurely', async () => {
    await expect(
      claudeCodeProvider.complete({ system: 's', user: 'u', maxTokens: 10 }, spec('/nonexistent/claude')),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('CONTEXTD_CLAUDE_BIN') });
  });

  it('is not local: the prompt goes to Anthropic', () => {
    expect(claudeCodeProvider.isLocal).toBe(false);
  });
});
