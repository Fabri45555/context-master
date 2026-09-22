import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec, ProviderName } from '../../core/config.js';
import { ProviderError, type CompletionRequest, type CompletionResponse, type Provider } from './types.js';

export { ProviderError };
export type { Provider, CompletionRequest, CompletionResponse };

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
  } catch (err) {
    // Network-level failures are worth one retry; a bad request is not.
    throw new ProviderError(`request failed: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(
      `${res.status} ${res.statusText}: ${text.slice(0, 400)}`,
      RETRYABLE_STATUS.has(res.status),
    );
  }
  return (await res.json()) as unknown;
}

function requireKey(spec: ModelSpec): string {
  const env = spec.api_key_env ?? 'ANTHROPIC_API_KEY';
  const key = process.env[env];
  if (!key) throw new ProviderError(`missing API key: set ${env}`, false);
  return key;
}

export const anthropicProvider: Provider = {
  name: 'anthropic',
  isLocal: false,
  async complete(req: CompletionRequest, spec: ModelSpec): Promise<CompletionResponse> {
    const base = spec.base_url ?? 'https://api.anthropic.com';
    const json = (await postJson(
      `${base}/v1/messages`,
      { 'x-api-key': requireKey(spec), 'anthropic-version': '2023-06-01' },
      {
        model: spec.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      req.signal,
    )) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: Record<string, number>;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return {
      text,
      usage: {
        input_tokens: json.usage?.input_tokens ?? 0,
        output_tokens: json.usage?.output_tokens ?? 0,
        cache_read_input_tokens: json.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: json.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  },
};

export const openaiProvider: Provider = {
  name: 'openai',
  isLocal: false,
  async complete(req: CompletionRequest, spec: ModelSpec): Promise<CompletionResponse> {
    const base = spec.base_url ?? 'https://api.openai.com/v1';
    const json = (await postJson(
      `${base}/chat/completions`,
      { authorization: `Bearer ${requireKey({ ...spec, api_key_env: spec.api_key_env ?? 'OPENAI_API_KEY' })}` },
      {
        model: spec.model,
        max_completion_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      req.signal,
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, number>;
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      usage: {
        input_tokens: json.usage?.prompt_tokens ?? 0,
        output_tokens: json.usage?.completion_tokens ?? 0,
      },
    };
  },
};

/** PRD 37 - a fully local option, so "no external LLM" is a real configuration. */
/** Loopback and nothing else: a base_url pointing elsewhere is a network call. */
function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export const ollamaProvider: Provider = {
  name: 'ollama',
  isLocal: true,
  /**
   * ollama itself is local, the model may not be. A `*-cloud` model is proxied to ollama.com,
   * so treating the provider as local let `privacy.local_only` pass while the prompt left the
   * machine - exactly the guarantee PRD 37 makes.
   */
  isLocalFor(spec) {
    if (/-cloud\b/i.test(spec.model) || /:.*-cloud$/i.test(spec.model)) return false;
    return isLoopbackUrl(spec.base_url);
  },
  async complete(req: CompletionRequest, spec: ModelSpec): Promise<CompletionResponse> {
    const base = spec.base_url ?? 'http://127.0.0.1:11434';
    const json = (await postJson(
      `${base}/api/chat`,
      {},
      {
        model: spec.model,
        stream: false,
        format: 'json',
        ...(spec.think === undefined ? {} : { think: spec.think }),
        options: { num_predict: req.maxTokens },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      req.signal,
    )) as {
      message?: { content?: string; thinking?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = json.message?.content ?? '';
    const thinking = json.message?.thinking ?? '';
    // A reasoning model can burn its whole output budget before emitting anything, and the
    // runner would only ever see "no JSON object found" - true, and useless for fixing it.
    if (text.trim().length === 0 && thinking.trim().length > 0) {
      throw new ProviderError(
        `${spec.model} produced ${json.eval_count ?? 0} output tokens of reasoning and no content; ` +
          'set think:false on this tier, or raise max_output_tokens',
        false,
      );
    }
    return {
      text,
      usage: {
        input_tokens: json.prompt_eval_count ?? 0,
        output_tokens: json.eval_count ?? 0,
      },
    };
  },
};

/**
 * Claude Code's own CLI as the model: `claude -p`, on the person's Claude account, with no API key.
 *
 * One non-interactive call per completion, so invariant 9 holds: `--tools ""` leaves the model
 * nothing to do but answer, and a single turn is all it gets. `--safe-mode` switches off hooks,
 * CLAUDE.md, plugins and MCP servers - without it the worker's own session would fire contextd's
 * hooks and be recorded as the person's work, a loop that feeds on itself. `CONTEXTD_WORKER=1` is
 * the second guard: `contextd hook` exits at once when it sees it. The call runs in an empty
 * temp directory and is never persisted as a session, so no transcript of it is ever attached.
 *
 * `--bare` would be simpler and is wrong: it never reads OAuth, so it only works with an API key -
 * the one thing this provider exists to do without.
 */
export const claudeCodeProvider: Provider = {
  name: 'claude-code',
  isLocal: false,
  async complete(req: CompletionRequest, spec: ModelSpec): Promise<CompletionResponse> {
    const bin = spec.base_url ?? process.env.CONTEXTD_CLAUDE_BIN ?? 'claude';
    const args = [
      '-p',
      '--safe-mode',
      '--output-format',
      'json',
      '--tools',
      '',
      '--no-session-persistence',
      '--system-prompt',
      req.system,
      ...(spec.model ? ['--model', spec.model] : []),
    ];
    const cwd = mkdtempSync(join(tmpdir(), 'contextd-worker-'));
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolveOut, reject) => {
        const child = spawn(bin, args, {
          cwd,
          env: { ...process.env, CONTEXTD_WORKER: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(req.signal ? { signal: req.signal } : {}),
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
        child.on('error', (e: NodeJS.ErrnoException) =>
          reject(
            new ProviderError(
              e.code === 'ENOENT' ? `\`${bin}\` not found: install Claude Code, or set CONTEXTD_CLAUDE_BIN` : `claude: ${e.message}`,
              e.code !== 'ENOENT',
            ),
          ),
        );
        child.on('close', (code) => {
          if (code === 0 || out.trim().startsWith('{')) resolveOut(out);
          else reject(new ProviderError(`claude exited ${code}: ${(err || out).trim().slice(0, 400)}`, true));
        });
        child.stdin.end(req.user);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    let json: {
      is_error?: boolean;
      result?: string;
      subtype?: string;
      api_error_status?: number | null;
      usage?: Record<string, unknown>;
    };
    try {
      json = JSON.parse(stdout) as typeof json;
    } catch {
      throw new ProviderError(`claude returned no JSON result: ${stdout.trim().slice(0, 200)}`, true);
    }
    if (json.is_error) {
      const status = typeof json.api_error_status === 'number' ? json.api_error_status : null;
      throw new ProviderError(
        `claude: ${json.subtype ?? 'error'}${status ? ` ${status}` : ''}: ${String(json.result ?? '').slice(0, 300)}`,
        status == null || RETRYABLE_STATUS.has(status),
      );
    }
    const n = (k: string) => (typeof json.usage?.[k] === 'number' ? (json.usage[k] as number) : 0);
    return {
      text: json.result ?? '',
      usage: {
        input_tokens: n('input_tokens'),
        output_tokens: n('output_tokens'),
        cache_read_input_tokens: n('cache_read_input_tokens'),
        cache_creation_input_tokens: n('cache_creation_input_tokens'),
      },
    };
  },
};

/**
 * PRD 37 "no external LLM" and the deterministic-only fallback of PRD 26/35: a provider
 * that always returns an empty patch. Deterministic maintenance still runs.
 */
export const noopProvider: Provider = {
  name: 'noop',
  isLocal: true,
  async complete(): Promise<CompletionResponse> {
    return { text: '{}', usage: { input_tokens: 0, output_tokens: 0 } };
  },
};

const REGISTRY: Record<ProviderName, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
  'claude-code': claudeCodeProvider,
  noop: noopProvider,
};

export function getProvider(name: ProviderName): Provider {
  const p = REGISTRY[name];
  if (!p) throw new ProviderError(`unknown provider: ${name}`, false);
  return p;
}
