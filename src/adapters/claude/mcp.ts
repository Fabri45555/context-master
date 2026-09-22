import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, MalformedConfigError, readJsonForWrite, readJsonLoose, writeJson } from '../host.js';
import type { HostEnv, Launch, McpChange, McpEntry, McpRegistrar } from '../types.js';

/**
 * Claude Code MCP registration.
 *
 * `claude mcp add` owns these files and is preferred when the binary is on PATH; the JSON is
 * edited directly only when it is not, or when it failed. Reads always go to the files: their
 * format is stabler than the CLI's human output. Where each scope lives:
 *
 *   local    ~/.claude.json  projects[<root>].mcpServers   (just you, just this project)
 *   project  <root>/.mcp.json mcpServers                  (committed; everyone who clones)
 *   user     ~/.claude.json  mcpServers                   (everywhere)
 *
 * Every scope is pinned with `-C <root>`: Claude Code starts a server with an unpredictable
 * working directory, so an unpinned one serves whatever memory it happens to land in.
 */

const SCOPES = ['local', 'project', 'user'] as const;

/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when relocated. */
export function claudeJsonPath(env: HostEnv): string {
  const relocated = env.vars?.CLAUDE_CONFIG_DIR?.trim();
  return join(relocated ? relocated : env.home, '.claude.json');
}

function fileFor(env: HostEnv, scope: string): string {
  return scope === 'project' ? join(env.projectRoot, '.mcp.json') : claudeJsonPath(env);
}

/** The `mcpServers` object for a scope, inside an already-parsed config. */
function serversIn(config: Record<string, unknown>, env: HostEnv, scope: string, create: boolean): Record<string, unknown> | null {
  let holder: Record<string, unknown> = config;
  if (scope === 'local') {
    if (!isRecord(config.projects)) {
      if (!create) return null;
      config.projects = {};
    }
    const projects = config.projects as Record<string, unknown>;
    if (!isRecord(projects[env.projectRoot])) {
      if (!create) return null;
      projects[env.projectRoot] = {};
    }
    holder = projects[env.projectRoot] as Record<string, unknown>;
  }
  if (!isRecord(holder.mcpServers)) {
    if (!create) return null;
    holder.mcpServers = {};
  }
  return holder.mcpServers as Record<string, unknown>;
}

function readEntry(env: HostEnv, name: string, scope: string): McpEntry | null {
  const where = fileFor(env, scope);
  if (!existsSync(where)) return null;
  const servers = serversIn(readJsonLoose(where), env, scope, false);
  const e = servers?.[name];
  if (!isRecord(e) || typeof e.command !== 'string') return null;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [];
  // Claude's config has no markers; an entry under our name that `get` can read is treated as ours.
  return { scope, where, command: e.command, args, managed: true };
}

function sameEntry(a: { command: string; args: readonly string[] }, b: { command: string; args: readonly string[] }): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
}

function writeViaFile(env: HostEnv, name: string, entry: { command: string; args: string[] }, scope: string): McpChange {
  const where = fileFor(env, scope);
  try {
    const config = readJsonForWrite(where);
    const servers = serversIn(config, env, scope, true)!;
    servers[name] = { type: 'stdio', command: entry.command, args: entry.args, env: {} };
    mkdirSync(dirname(where), { recursive: true });
    writeJson(where, config);
    return { status: 'registered', scope, where, detail: `wrote ${where}` };
  } catch (err) {
    const detail = err instanceof MalformedConfigError ? err.message : `could not write ${where}: ${(err as Error).message}`;
    return { status: 'failed', scope, where, detail };
  }
}

function removeViaFile(env: HostEnv, name: string, scope: string): boolean {
  const where = fileFor(env, scope);
  if (!existsSync(where)) return false;
  let config: Record<string, unknown>;
  try {
    config = readJsonForWrite(where);
  } catch {
    return false;
  }
  const servers = serversIn(config, env, scope, false);
  if (!servers || !(name in servers)) return false;
  delete servers[name];
  writeJson(where, config);
  return true;
}

export const claudeMcp: McpRegistrar = {
  description:
    'Registered with `claude mcp add` when the binary is on PATH, else written to ~/.claude.json (local, user) or .mcp.json (project). Pinned to the project with -C.',
  scopes: SCOPES,
  defaultScope: 'local',

  pinsProject: () => true,

  entryFor(env, launch: Launch) {
    return { command: launch.command, args: [...launch.args, '-C', env.projectRoot, 'mcp'] };
  },

  get(env, name, scope) {
    const scopes = scope ? [scope] : SCOPES;
    return scopes.flatMap((s) => {
      const e = readEntry(env, name, s);
      return e ? [e] : [];
    });
  },

  register(env, name, launch, scope, opts = {}) {
    const wanted = claudeMcp.entryFor(env, launch, scope);
    const where = fileFor(env, scope);
    const existing = readEntry(env, name, scope);
    if (existing && sameEntry(existing, wanted)) {
      return { status: 'already', scope, where, detail: 'already registered with this command' };
    }
    if (existing && !opts.force) {
      return {
        status: 'conflict',
        scope,
        where,
        detail: `"${name}" is registered as \`${[existing.command, ...existing.args].join(' ')}\`; re-run with --force to replace it`,
      };
    }
    if (existing) claudeMcp.unregister(env, name, scope);

    const bin = env.which?.('claude') ?? null;
    if (bin && env.exec) {
      const r = env.exec(bin, ['mcp', 'add', '--scope', scope, name, '--', wanted.command, ...wanted.args], {
        cwd: env.projectRoot,
      });
      const landed = readEntry(env, name, scope);
      if (r.status === 0 && landed && sameEntry(landed, wanted)) {
        return { status: existing ? 'updated' : 'registered', scope, where, detail: `via \`claude mcp add --scope ${scope}\`` };
      }
      // The CLI failing (or writing somewhere unexpected) is not a reason to give up.
      const fallback = writeViaFile(env, name, wanted, scope);
      return fallback.status === 'registered'
        ? { ...fallback, status: existing ? 'updated' : 'registered', detail: `${fallback.detail} (claude mcp add failed: ${r.stderr.trim() || `exit ${r.status}`})` }
        : fallback;
    }
    const written = writeViaFile(env, name, wanted, scope);
    return written.status === 'registered' && existing ? { ...written, status: 'updated' } : written;
  },

  unregister(env, name, scope) {
    const where = fileFor(env, scope);
    const existing = readEntry(env, name, scope);
    if (!existing) return { status: 'absent', scope, where, detail: 'not registered' };
    const bin = env.which?.('claude') ?? null;
    if (bin && env.exec) env.exec(bin, ['mcp', 'remove', '--scope', scope, name], { cwd: env.projectRoot });
    // Whatever the CLI did, the file is the truth: remove there too if it is still present.
    if (readEntry(env, name, scope)) removeViaFile(env, name, scope);
    return readEntry(env, name, scope)
      ? { status: 'failed', scope, where, detail: `could not remove "${name}" from ${where}` }
      : { status: 'removed', scope, where, detail: `removed from ${where}` };
  },
};
