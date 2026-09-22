import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractBlock, removeBlock, upsertBlock, type Markers } from '../../core/markers.js';
import { writeFileAtomic } from '../host.js';
import type { HostEnv, Launch, McpEntry, McpRegistrar } from '../types.js';

/**
 * Codex MCP registration: a `[mcp_servers.<name>]` table in `~/.codex/config.toml`
 * (`$CODEX_HOME/config.toml` when relocated).
 *
 * Codex has no command for this, so the file is edited - but only between contextd's markers.
 * Nothing outside them is parsed, rewritten or reformatted, which is why this needs no TOML
 * library: the only TOML it ever reads back is TOML it wrote. A table with the same name outside
 * the markers belongs to the person, and is reported, never touched.
 *
 * The file is global to every project, so the entry is not pinned with `-C`: it serves the
 * project Codex was started in.
 */

export const CODEX_MARKERS: Markers = {
  start: '# --- contextd MCP server ---',
  end: '# --- end contextd ---',
};

export function codexConfigPath(env: HostEnv): string {
  const relocated = env.vars?.CODEX_HOME?.trim();
  return join(relocated ? relocated : join(env.home, '.codex'), 'config.toml');
}

/** TOML basic strings share JSON's escapes for everything JSON.stringify emits. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function renderBlock(name: string, entry: { command: string; args: string[] }): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ].join('\n');
}

/** Read back a block this module rendered. Anything else in there reads as absent. */
function parseBlock(inner: string, name: string): { command: string; args: string[] } | null {
  if (!inner.includes(`[mcp_servers.${name}]`)) return null;
  const command = inner.match(/^command\s*=\s*(".*")\s*$/m)?.[1];
  const args = inner.match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1];
  try {
    const c = command ? (JSON.parse(command) as unknown) : null;
    const a = args ? (JSON.parse(args) as unknown) : [];
    if (typeof c !== 'string' || !Array.isArray(a)) return null;
    return { command: c, args: a.filter((x): x is string => typeof x === 'string') };
  } catch {
    return null;
  }
}

/** A `[mcp_servers.<name>]` table outside our markers: someone else's, left alone. */
function hasForeignTable(content: string, name: string): boolean {
  const outside = removeBlock(content, CODEX_MARKERS) ?? content;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|${escaped})\\s*\\]`, 'm').test(outside);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export const codexMcp: McpRegistrar = {
  description:
    'A [mcp_servers.contextd] table in ~/.codex/config.toml, inside "# --- contextd MCP server ---" markers. Global to every project, so not pinned with -C.',
  scopes: ['user'],
  defaultScope: 'user',

  pinsProject: () => false,

  entryFor(_env, launch: Launch) {
    return { command: launch.command, args: [...launch.args, 'mcp'] };
  },

  get(env, name, scope) {
    if (scope && scope !== 'user') return [];
    const where = codexConfigPath(env);
    const content = read(where);
    const out: McpEntry[] = [];
    const inner = extractBlock(content, CODEX_MARKERS);
    const ours = inner != null ? parseBlock(inner, name) : null;
    if (ours) out.push({ scope: 'user', where, ...ours, managed: true });
    if (hasForeignTable(content, name)) out.push({ scope: 'user', where, command: '?', args: [], managed: false });
    return out;
  },

  register(env, name, launch, scope, opts = {}) {
    const where = codexConfigPath(env);
    const wanted = codexMcp.entryFor(env, launch, scope);
    const content = read(where);
    if (hasForeignTable(content, name)) {
      // Even --force: a second table of the same name makes the whole file invalid TOML.
      return {
        status: 'conflict',
        scope,
        where,
        detail: `${where} already has a [mcp_servers.${name}] table outside contextd's markers; remove it by hand to let contextd manage it`,
      };
    }
    const inner = extractBlock(content, CODEX_MARKERS);
    const existing = inner != null ? parseBlock(inner, name) : null;
    if (existing && existing.command === wanted.command && existing.args.join('\0') === wanted.args.join('\0')) {
      return { status: 'already', scope, where, detail: 'already registered with this command' };
    }
    if (existing && !opts.force) {
      return {
        status: 'conflict',
        scope,
        where,
        detail: `registered as \`${[existing.command, ...existing.args].join(' ')}\`; re-run with --force to replace it`,
      };
    }
    try {
      mkdirSync(dirname(where), { recursive: true });
      writeFileAtomic(where, upsertBlock(content, CODEX_MARKERS, renderBlock(name, wanted)));
    } catch (err) {
      return { status: 'failed', scope, where, detail: `could not write ${where}: ${(err as Error).message}` };
    }
    return { status: existing || inner != null ? 'updated' : 'registered', scope, where, detail: `wrote ${where}` };
  },

  unregister(env, name, scope) {
    const where = codexConfigPath(env);
    const content = read(where);
    const next = removeBlock(content, CODEX_MARKERS);
    if (next == null) {
      const foreign = hasForeignTable(content, name);
      return {
        status: 'absent',
        scope,
        where,
        detail: foreign ? `a [mcp_servers.${name}] table outside contextd's markers was left alone` : 'not registered',
      };
    }
    writeFileAtomic(where, next);
    return { status: 'removed', scope, where, detail: `removed the contextd block from ${where}` };
  },
};
