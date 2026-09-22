import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepMerge } from '../../core/config.js';
import { isRecord, readJsonForWrite, readJsonLoose, writeJson } from '../host.js';
import type { HookInstaller, HostEnv, InstalledHook } from '../types.js';

/**
 * Wire contextd into Claude Code via its own hook system.
 *
 * This is how PRD 54.7 ("no changes to the main model") is met in practice: the agent is
 * untouched, its settings gain a few command hooks, and each hook is a short-lived process
 * that ingests and exits. Hooks are synchronous for the agent, so the handler must never
 * wait on a model - see `contextd hook`, which ingests and returns.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PreCompact',
  'Stop',
  'SessionEnd',
] as const;

export interface HookInstallOptions {
  /** Command that runs the handler, e.g. `contextd hook` or `node /path/dist/cli/index.js hook`. */
  command: string;
  /** Seconds before Claude Code gives up on the hook. Keep it small. */
  timeout?: number;
}

export function buildHookConfig(opts: HookInstallOptions): Record<string, unknown> {
  const entry = {
    type: 'command' as const,
    command: opts.command,
    timeout: opts.timeout ?? 10,
  };
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    // PostToolUse is the only one that benefits from a matcher; "*" keeps every tool.
    hooks[event] = [event === 'PostToolUse' ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }];
  }
  return { hooks };
}

export interface InstallResult {
  path: string;
  created: boolean;
  /** Hook events that were already present and were left alone. */
  preserved: string[];
}

/**
 * Merge the hook config into a settings file without clobbering hooks already there.
 *
 * An existing entry for an event is left untouched and reported, because silently replacing
 * a user's own hook would be the kind of destructive edit this tool should never make.
 */
export function installHooks(
  settingsDir: string,
  opts: HookInstallOptions,
  filename = 'settings.json',
): InstallResult {
  mkdirSync(settingsDir, { recursive: true });
  const path = join(settingsDir, filename);
  const created = !existsSync(path);
  const existing: Record<string, unknown> = created
    ? {}
    : (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);

  const desired = buildHookConfig(opts);
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown>;
  const desiredHooks = (desired.hooks ?? {}) as Record<string, unknown>;

  const preserved: string[] = [];
  const toAdd: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(desiredHooks)) {
    const current = existingHooks[event];
    if (Array.isArray(current) && current.length > 0) {
      if (JSON.stringify(current).includes(opts.command)) continue; // already ours
      preserved.push(event);
      continue;
    }
    toAdd[event] = value;
  }

  const merged = deepMerge(existing, { hooks: toAdd });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { path, created, preserved };
}

/**
 * Where Claude Code keeps a project's transcripts for a given working directory.
 * The slug replaces `/`, `.` and `_` with `-`, so /Users/me/my_app becomes -Users-me-my-app.
 */
export function claudeProjectDir(home: string, cwd: string): string {
  const slug = cwd.replace(/[/._]/g, '-');
  return join(home, '.claude', 'projects', slug);
}

/** Claude Code's user-level directory; CLAUDE_CONFIG_DIR relocates it. */
export function claudeUserDir(env: HostEnv): string {
  const relocated = env.vars?.CLAUDE_CONFIG_DIR?.trim();
  return relocated ? relocated : join(env.home, '.claude');
}

/** Every settings file Claude Code reads hooks from, project first. */
export function claudeSettingsFiles(env: HostEnv): string[] {
  const out: string[] = [];
  for (const dir of [join(env.projectRoot, '.claude'), claudeUserDir(env)]) {
    for (const file of ['settings.json', 'settings.local.json']) out.push(join(dir, file));
  }
  return out;
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<Record<string, unknown>>;
}

function hookCommands(settings: Record<string, unknown>): Map<string, string[]> {
  const byCommand = new Map<string, string[]>();
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups as HookGroup[]) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command !== 'string') continue;
        const events = byCommand.get(h.command) ?? [];
        if (!events.includes(event)) events.push(event);
        byCommand.set(h.command, events);
      }
    }
  }
  return byCommand;
}

export function installedHooks(env: HostEnv): InstalledHook[] {
  const out: InstalledHook[] = [];
  for (const path of claudeSettingsFiles(env)) {
    if (!existsSync(path)) continue;
    for (const [command, events] of hookCommands(readJsonLoose(path))) out.push({ path, command, events });
  }
  return out;
}

/**
 * Remove exactly the hook entries `isOurs` accepts. A group left empty goes, an event left empty
 * goes, and every other key in the file is written back as it was read.
 */
export function uninstallHooks(
  env: HostEnv,
  isOurs: (command: string) => boolean,
): Array<{ path: string; events: string[] }> {
  const changed: Array<{ path: string; events: string[] }> = [];
  for (const path of claudeSettingsFiles(env)) {
    if (!existsSync(path)) continue;
    let settings: Record<string, unknown>;
    try {
      settings = readJsonForWrite(path);
    } catch {
      continue; // Unparseable: not ours to repair, and rewriting it would lose the rest.
    }
    if (!isRecord(settings.hooks)) continue;
    const events: string[] = [];
    const hooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups;
        continue;
      }
      const kept: unknown[] = [];
      for (const g of groups as HookGroup[]) {
        if (!isRecord(g) || !Array.isArray(g.hooks)) {
          kept.push(g);
          continue;
        }
        const inner = g.hooks.filter((h) => !(typeof h?.command === 'string' && isOurs(h.command)));
        if (inner.length !== g.hooks.length && !events.includes(event)) events.push(event);
        if (inner.length > 0) kept.push({ ...g, hooks: inner });
      }
      if (kept.length > 0) hooks[event] = kept;
    }
    if (events.length === 0) continue;
    const next: Record<string, unknown> = { ...settings };
    if (Object.keys(hooks).length > 0) next.hooks = hooks;
    else delete next.hooks;
    writeJson(path, next);
    changed.push({ path, events });
  }
  return changed;
}

export const claudeHookInstaller: HookInstaller = {
  install(env, opts) {
    const dir = opts.global ? claudeUserDir(env) : join(env.projectRoot, '.claude');
    return installHooks(dir, { command: opts.command });
  },
  installed: installedHooks,
  uninstall: uninstallHooks,
};
