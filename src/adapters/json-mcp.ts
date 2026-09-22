import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { isRecord, MalformedConfigError, readJsonForWrite, readJsonLoose, writeJson } from './host.js';
import type { HostEnv, Launch, McpChange, McpEntry, McpRegistrar } from './types.js';

/**
 * MCP registration for agents that keep their servers in a JSON object under one key (Cursor's
 * and Gemini CLI's `mcpServers`, opencode's `mcp`).
 *
 * JSON has no comments, so there is nowhere to put markers (invariant 45). What contextd owns is
 * one key - `<serversKey>.contextd` - and an entry under it counts as ours only when its command
 * has the shape contextd writes (`isContextdLaunch`). Anything else under that name belongs to
 * the person: it is reported, never replaced, `--force` or not. The rest of the file is read
 * and written back as parsed, and an unparseable file is refused rather than rewritten from `{}`.
 */

export interface JsonMcpScope {
  file(env: HostEnv): string;
  /** Pinned scopes carry `-C <root>`; see `McpRegistrar.pinsProject`. */
  pinned: boolean;
}

export interface JsonMcpSpec {
  description: string;
  scopes: Record<string, JsonMcpScope>;
  defaultScope: string;
  /** The top-level key holding the servers object. */
  serversKey: string;
  /** Our entry, in the agent's own shape. */
  render(entry: { command: string; args: string[] }): Record<string, unknown>;
  /** The command and arguments of an entry in the agent's shape, or null when it has none. */
  parse(raw: Record<string, unknown>): { command: string; args: string[] } | null;
}

/**
 * Whether a command is one contextd wrote: `contextd ... mcp`, or `node <.../cli/index.js> ... mcp`.
 * The same shape test `isOurHookCommand` uses for hooks, for the same reason: it also recognises
 * an entry from a build that has since moved, which is the one `--force` must be able to replace.
 */
export function isContextdLaunch(entry: { command: string; args: readonly string[] }): boolean {
  if (entry.args[entry.args.length - 1] !== 'mcp') return false;
  if (/^contextd(\.cmd|\.exe)?$/.test(basename(entry.command))) return true;
  return entry.args.some((a) => /contextd|cli[/\\]index\.js$/.test(a));
}

function same(a: { command: string; args: readonly string[] }, b: { command: string; args: readonly string[] }): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
}

export function jsonMcpRegistrar(spec: JsonMcpSpec): McpRegistrar {
  const scopeNames = Object.keys(spec.scopes);
  const scopeOf = (name: string): JsonMcpScope => {
    const s = spec.scopes[name];
    if (!s) throw new Error(`no "${name}" scope (available: ${scopeNames.join(', ')})`);
    return s;
  };

  const read = (env: HostEnv, name: string, scope: string): McpEntry | null => {
    const where = scopeOf(scope).file(env);
    if (!existsSync(where)) return null;
    const servers = readJsonLoose(where)[spec.serversKey];
    if (!isRecord(servers) || !(name in servers)) return null;
    const raw = servers[name];
    const parsed = isRecord(raw) ? spec.parse(raw) : null;
    if (!parsed) return { scope, where, command: '?', args: [], managed: false };
    return { scope, where, ...parsed, managed: isContextdLaunch(parsed) };
  };

  const registrar: McpRegistrar = {
    description: spec.description,
    scopes: scopeNames,
    defaultScope: spec.defaultScope,

    pinsProject: (scope) => spec.scopes[scope]?.pinned ?? false,

    entryFor(env, launch: Launch, scope) {
      const pin = scopeOf(scope).pinned ? ['-C', env.projectRoot] : [];
      return { command: launch.command, args: [...launch.args, ...pin, 'mcp'] };
    },

    get(env, name, scope) {
      return (scope ? [scope] : scopeNames).flatMap((s) => {
        const e = spec.scopes[s] ? read(env, name, s) : null;
        return e ? [e] : [];
      });
    },

    register(env, name, launch, scope, opts = {}) {
      const where = scopeOf(scope).file(env);
      const wanted = registrar.entryFor(env, launch, scope);
      const existing = read(env, name, scope);
      if (existing && !existing.managed) {
        return {
          status: 'conflict',
          scope,
          where,
          detail: `${where} already has a "${name}" server contextd did not write; remove or rename it by hand to let contextd manage it`,
        };
      }
      if (existing && same(existing, wanted)) {
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
        const config = readJsonForWrite(where);
        if (config[spec.serversKey] !== undefined && !isRecord(config[spec.serversKey])) {
          return { status: 'failed', scope, where, detail: `${where}: "${spec.serversKey}" is not an object; refusing to rewrite it` };
        }
        const servers = (config[spec.serversKey] ?? {}) as Record<string, unknown>;
        servers[name] = spec.render(wanted);
        config[spec.serversKey] = servers;
        mkdirSync(dirname(where), { recursive: true });
        writeJson(where, config);
      } catch (err) {
        const detail = err instanceof MalformedConfigError ? err.message : `could not write ${where}: ${(err as Error).message}`;
        return { status: 'failed', scope, where, detail };
      }
      return { status: existing ? 'updated' : 'registered', scope, where, detail: `wrote ${where}` };
    },

    unregister(env, name, scope) {
      const where = scopeOf(scope).file(env);
      const existing = read(env, name, scope);
      if (!existing) return { status: 'absent', scope, where, detail: 'not registered' };
      if (!existing.managed) {
        return { status: 'absent', scope, where, detail: `a "${name}" server contextd did not write was left alone` };
      }
      let config: Record<string, unknown>;
      try {
        config = readJsonForWrite(where);
      } catch (err) {
        return { status: 'failed', scope, where, detail: (err as Error).message };
      }
      const servers = config[spec.serversKey] as Record<string, unknown>;
      delete servers[name];
      // An empty servers object is what our entry left behind, not something the person wrote.
      if (Object.keys(servers).length === 0) delete config[spec.serversKey];
      writeJson(where, config);
      return { status: 'removed', scope, where, detail: `removed "${name}" from ${where}` } satisfies McpChange;
    },
  };
  return registrar;
}
