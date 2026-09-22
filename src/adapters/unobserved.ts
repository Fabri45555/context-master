import type { AdapterSurface, TranslateResult } from './types.js';

/**
 * The surface of an agent contextd serves but cannot observe.
 *
 * Cursor, Gemini CLI and opencode keep their conversations where no supported surface reaches
 * them, so there is nothing to ingest. Saying so is the point: a `transcript` surface that never
 * finds anything reads, in `doctor`, exactly like an idle project. Memory still reaches these
 * agents - by MCP, and by `contextd mirror` - and events recorded by other means can be piped in
 * through the generic adapter.
 */
export function unobservedSurface(agent: string, where: string): AdapterSurface {
  return {
    kind: 'none',
    preferred: true,
    installable: false,
    description:
      `No ingestion: ${agent} keeps its sessions ${where}, which contextd does not read. ` +
      'Memory reaches it through MCP and `contextd mirror`; nothing it does is recorded unless piped to `contextd ingest`.',
  };
}

export function nothingToTranslate(): TranslateResult {
  return { events: [] };
}

/** `command`/`args` entries, the shape Cursor and Gemini CLI share. */
export function parseCommandArgs(raw: Record<string, unknown>): { command: string; args: string[] } | null {
  if (typeof raw.command !== 'string') return null;
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
  return { command: raw.command, args };
}
