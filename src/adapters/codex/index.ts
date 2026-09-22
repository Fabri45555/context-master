import { makeEvent, type ContextEvent, type EventType } from '../../core/events.js';
import { contentHash } from '../../core/ids.js';
import { join } from 'node:path';
import type { Adapter, AdapterContext, AdapterSurface, InstructionFile, TranslateResult } from '../types.js';
import { codexMcp } from './mcp.js';
import { candidatesIn, firstRecord } from '../discover.js';

/**
 * Codex adapter, reading the rollout JSONL under ~/.codex/sessions.
 *
 * Proves the agent-agnostic claim of PRD 6/54.6: a different record vocabulary, the same
 * normalized events, and no change anywhere in the core.
 */

/** Developer-role turns are harness scaffolding, not the user speaking. */
const IGNORED_ROLES = new Set(['developer', 'system']);

const SHELL_TOOLS = new Set(['exec', 'shell', 'local_shell', 'container.exec']);

export class CodexAdapter implements Adapter {
  readonly name = 'codex';
  readonly agent = 'Codex';

  readonly surfaces: readonly AdapterSurface[] = [
    {
      kind: 'transcript',
      preferred: true,
      installable: true,
      description:
        'Rollout JSONL under ~/.codex/sessions/<y>/<m>/<d>/. Sessions are global, so each file is checked against the project cwd.',
      // Codex stores every project's sessions together, so locating means filtering by the
      // cwd recorded in each file's session_meta rather than trusting the directory.
      locate: (projectRoot, home) =>
        candidatesIn(join(home, '.codex', 'sessions'), 3).filter((c) =>
          sessionCwd(c.path) === projectRoot,
        ),
    },
  ];

  readonly mcp = codexMcp;

  readonly instructionFiles: readonly InstructionFile[] = [
    {
      target: 'agents',
      path: 'AGENTS.md',
      description:
        'Project instructions read by Codex, opencode and other agents following the AGENTS.md convention; usually committed',
      format: 'markdown',
      budget: 3000,
    },
  ];

  translate(raw: unknown, ctx: AdapterContext): TranslateResult {
    if (!raw || typeof raw !== 'object') return { events: [] };
    const rec = raw as Record<string, unknown>;
    const outer = str(rec.type);
    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    const ts = str(rec.timestamp) ?? new Date().toISOString();
    const ordinal = typeof rec.ordinal === 'number' ? rec.ordinal : (ctx.ordinal ?? null);
    const events: ContextEvent[] = [];
    const result: TranslateResult = { events };

    const push = (type: EventType, p: Record<string, unknown>, key: string) => {
      events.push(
        makeEvent({
          session_id: ctx.sessionId,
          source: this.name,
          timestamp: ts,
          type,
          payload: p,
          ordinal,
          dedupe_hash: contentHash(['codex', ctx.sessionId, ordinal ?? key, key]),
        }),
      );
    };

    if (outer === 'session_meta') {
      const cwd = str(payload.cwd);
      result.session = { id: str(payload.session_id) ?? ctx.sessionId, cwd, agent: 'codex' };
      push('SESSION_STARTED', {
        cwd,
        project: cwd ? cwd.split('/').filter(Boolean).pop() : null,
        originator: str(payload.originator),
      }, 'session_meta');
      return result;
    }

    if (outer === 'event_msg') {
      const kind = str(payload.type);
      if (kind === 'task_started') {
        push('TASK_STARTED', { turn_id: str(payload.turn_id) }, 'task_started');
      } else if (kind === 'task_complete') {
        push('TASK_COMPLETED', { text: str(payload.last_agent_message) }, 'task_complete');
      } else if (kind === 'token_count') {
        // Baseline accounting: this is the agent's own spend, not ours (PRD 28).
        const info = payload.info as Record<string, unknown> | undefined;
        const last = (info?.last_token_usage ?? info?.total_token_usage) as
          | Record<string, number>
          | undefined;
        if (last) {
          result.agentUsage = {
            input_tokens: last.input_tokens ?? 0,
            output_tokens: last.output_tokens ?? 0,
            cache_read_input_tokens: last.cached_input_tokens ?? 0,
            cache_creation_input_tokens: last.cache_write_input_tokens ?? 0,
          };
        }
      } else if (kind === 'error' || kind === 'stream_error') {
        const text = str(payload.message) ?? str(payload.error);
        if (text) push('ERROR_DETECTED', { error: text }, `error:${kind}`);
      }
      return result;
    }

    if (outer !== 'response_item') return result;

    const kind = str(payload.type);

    // Reasoning is the model's scratch space; PRD 2 wants it out of persistent memory.
    if (kind === 'reasoning' || kind === 'agent_message') return result;

    if (kind === 'message') {
      const role = str(payload.role) ?? 'user';
      if (IGNORED_ROLES.has(role)) return result;
      const text = collectText(payload.content);
      if (!text) return result;
      push(role === 'assistant' ? 'ASSISTANT_MESSAGE' : 'USER_MESSAGE', { text }, `message:${role}`);
      return result;
    }

    if (kind === 'custom_tool_call' || kind === 'function_call' || kind === 'local_shell_call') {
      const name = str(payload.name) ?? 'unknown';
      const input = str(payload.input) ?? str(payload.arguments) ?? '';
      const command = extractCommand(input);
      push(
        'TOOL_CALL',
        {
          tool: name,
          tool_use_id: str(payload.call_id),
          ...(command ? { command } : { args: input.slice(0, 2000) }),
        },
        `call:${str(payload.call_id) ?? kind}`,
      );
      return result;
    }

    if (
      kind === 'custom_tool_call_output' ||
      kind === 'function_call_output' ||
      kind === 'local_shell_call_output'
    ) {
      const output = collectText(payload.output) ?? str(payload.output) ?? '';
      const exit = inferExit(output);
      push(
        exit != null && exit !== 0 ? 'COMMAND_EXECUTED' : 'TOOL_RESULT',
        {
          tool_use_id: str(payload.call_id),
          output,
          ...(exit != null ? { exit_code: exit } : {}),
        },
        `output:${str(payload.call_id) ?? kind}`,
      );
      return result;
    }

    return result;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Codex content arrays mix input_text, output_text and encrypted blobs. Keep the text. */
function collectText(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const t = str(o.text);
    if (t) parts.push(t);
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

/** `exec` calls arrive as a JS snippet; pull the shell command out when it is there. */
export function extractCommand(input: string): string | null {
  const m =
    input.match(/exec_command\(\s*\{[^}]*?cmd\s*:\s*(["'`])([\s\S]*?)\1/) ??
    input.match(/"command"\s*:\s*\[?\s*(["'])([\s\S]*?)\1/);
  return m?.[2] ?? null;
}

/** Codex prints a wall-time/output preamble rather than an exit code; read what is there. */
export function inferExit(output: string): number | null {
  const m = output.match(/\bexit(?:ed with)?(?:\s+code)?\s+(\d{1,3})\b/i);
  if (m) return Number(m[1]);
  if (/^\s*Script completed\b/m.test(output)) return 0;
  if (/\b(command failed|non-zero exit)\b/i.test(output)) return 1;
  return null;
}

/** The cwd a rollout belongs to, from its session_meta line. */
function sessionCwd(path: string): string | null {
  const rec = firstRecord(path) as { payload?: { cwd?: unknown } } | null;
  const cwd = rec?.payload?.cwd;
  return typeof cwd === 'string' ? cwd : null;
}

export const codexAdapter = new CodexAdapter();
