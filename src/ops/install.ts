import { existsSync, rmSync } from 'node:fs';
import {
  hookInstaller,
  type Adapter,
  type HostEnv,
  type Launch,
  type McpChange,
  type McpEntry,
} from '../adapters/index.js';
import { isOurHookCommand, resolveCommand, type CommandResolution } from './self.js';
import { removeMirror } from './mirror.js';

/**
 * MCP registration and uninstall, across whichever adapters declare the surface. Nothing here
 * names an agent: each adapter's `mcp` registrar and hook installer knows its own files.
 */

export const MCP_SERVER_NAME = 'contextd';

/** Whether a registration would serve this project's memory. */
export function servesProject(adapter: Adapter, entry: McpEntry, projectRoot: string): boolean {
  if (!adapter.mcp) return false;
  if (!adapter.mcp.pinsProject(entry.scope)) return entry.managed;
  const at = entry.args.indexOf('-C');
  return at !== -1 && entry.args[at + 1] === projectRoot;
}

export interface McpStatusRow {
  adapter: string;
  agent: string;
  entry: McpEntry;
  servesThisProject: boolean;
  resolution: CommandResolution | null;
}

export function mcpStatus(env: HostEnv, adapters: readonly Adapter[]): { rows: McpStatusRow[]; missing: string[] } {
  const rows: McpStatusRow[] = [];
  const missing: string[] = [];
  for (const adapter of adapters) {
    if (!adapter.mcp) continue;
    const entries = adapter.mcp.get(env, MCP_SERVER_NAME);
    if (entries.length === 0) missing.push(adapter.name);
    for (const entry of entries) {
      rows.push({
        adapter: adapter.name,
        agent: adapter.agent,
        entry,
        servesThisProject: servesProject(adapter, entry, env.projectRoot),
        resolution: entry.managed ? resolveCommand(entry, env) : null,
      });
    }
  }
  return { rows, missing };
}

export function mcpInstall(
  env: HostEnv,
  adapter: Adapter,
  launch: Launch,
  opts: { scope?: string; force?: boolean } = {},
): McpChange {
  const mcp = adapter.mcp;
  if (!mcp) throw new Error(`${adapter.name} has no MCP registration surface`);
  const scope = opts.scope ?? mcp.defaultScope;
  if (!mcp.scopes.includes(scope)) {
    throw new Error(`${adapter.name} has no "${scope}" scope (available: ${mcp.scopes.join(', ')})`);
  }
  return mcp.register(env, MCP_SERVER_NAME, launch, scope, { force: opts.force === true });
}

/**
 * Remove the registrations that serve this project. One pinned to another project is someone
 * else's install and stays; an unpinned one (a global config) is removed, and the caller says so.
 */
export function mcpUninstall(env: HostEnv, adapter: Adapter, scope?: string): McpChange[] {
  const mcp = adapter.mcp;
  if (!mcp) return [];
  const out: McpChange[] = [];
  for (const entry of mcp.get(env, MCP_SERVER_NAME, scope)) {
    if (!entry.managed) {
      out.push({ status: 'absent', scope: entry.scope, where: entry.where, detail: 'an entry contextd did not write was left alone' });
      continue;
    }
    if (!servesProject(adapter, entry, env.projectRoot)) {
      out.push({ status: 'absent', scope: entry.scope, where: entry.where, detail: 'registered for another project; left alone' });
      continue;
    }
    const change = mcp.unregister(env, MCP_SERVER_NAME, entry.scope);
    out.push(
      mcp.pinsProject(entry.scope)
        ? change
        : { ...change, detail: `${change.detail} (user-level: it served every project)` },
    );
  }
  return out;
}

export interface UninstallInput {
  env: HostEnv;
  adapters: readonly Adapter[];
  /** The hook command `init` recorded, if the store still has it. */
  recordedHook: string | null;
  /** Files that may hold a mirror block, and which of them `mirror` created. */
  mirrorFiles: readonly string[];
  mirrorCreated?: readonly string[];
}

export interface UninstallReport {
  hooks: Array<{ adapter: string; path: string; events: string[] }>;
  mcp: Array<{ adapter: string; change: McpChange }>;
  mirrors: Array<{ path: string; result: 'removed' | 'deleted' }>;
}

/** Undo what contextd wrote outside its own storage. Project data is untouched. */
export function uninstallWiring(input: UninstallInput): UninstallReport {
  const { env } = input;
  const report: UninstallReport = { hooks: [], mcp: [], mirrors: [] };
  for (const adapter of input.adapters) {
    const installer = hookInstaller(adapter);
    if (installer) {
      const isOurs = (cmd: string) => isOurHookCommand(cmd, env.projectRoot, input.recordedHook);
      for (const r of installer.uninstall(env, isOurs)) report.hooks.push({ adapter: adapter.name, ...r });
    }
    for (const change of mcpUninstall(env, adapter)) report.mcp.push({ adapter: adapter.name, change });
  }
  for (const path of input.mirrorFiles) {
    const result = removeMirror(path, input.mirrorCreated?.includes(path) ?? false);
    if (result !== 'absent') report.mirrors.push({ path, result });
  }
  return report;
}

/** What `--purge` deletes, listed before anything is deleted. */
export function purgeTargets(storageDir: string, configPath: string | null): string[] {
  return [storageDir, ...(configPath ? [configPath] : [])].filter((p) => existsSync(p));
}

export function purge(paths: readonly string[]): void {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}
