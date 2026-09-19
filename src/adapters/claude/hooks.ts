import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepMerge } from '../../core/config.js';

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
