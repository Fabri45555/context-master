import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, readJsonForWrite, readJsonLoose, writeJson } from '../host.js';
import type { HostEnv, StatuslineSurface } from '../types.js';
import { claudeUserDir } from './hooks.js';

/**
 * Claude Code's status line: `statusLine: {type: "command", command}` in a settings file, run with
 * a JSON payload on stdin (session_id, cwd, workspace.project_dir, transcript_path, model, …) and
 * rendered from its first line of stdout.
 *
 * Installed in the project's .claude/settings.local.json: a status line is a personal preference,
 * and the committed settings.json would impose it on everyone who clones the repo. The local file
 * also wins over the project's and the user's, which is what lets `--chain` take over the line
 * someone already had without editing the file it lives in. An existing line that is not ours is
 * never overwritten (invariant 45): without `--chain` it is a conflict.
 */
function files(env: HostEnv): string[] {
  const out: string[] = [];
  for (const dir of [join(env.projectRoot, '.claude'), claudeUserDir(env)]) {
    for (const f of ['settings.local.json', 'settings.json']) out.push(join(dir, f));
  }
  return out;
}

function commandIn(settings: Record<string, unknown>): string | null {
  const s = settings.statusLine;
  return isRecord(s) && typeof s.command === 'string' ? s.command : null;
}

export const claudeStatusline: StatuslineSurface = {
  parse(stdin) {
    if (!isRecord(stdin)) return { projectDir: null, sessionId: null };
    const ws = isRecord(stdin.workspace) ? stdin.workspace : {};
    const dir =
      (typeof ws.project_dir === 'string' && ws.project_dir) ||
      (typeof ws.current_dir === 'string' && ws.current_dir) ||
      (typeof stdin.cwd === 'string' && stdin.cwd) ||
      null;
    return { projectDir: dir || null, sessionId: typeof stdin.session_id === 'string' ? stdin.session_id : null };
  },

  installed(env) {
    // Claude Code's precedence: the project's local file, then the project's, then the user's.
    for (const path of files(env)) {
      if (!existsSync(path)) continue;
      const command = commandIn(readJsonLoose(path));
      if (command) return { path, command };
    }
    return null;
  },

  install(env, command, opts = {}) {
    const path = join(env.projectRoot, '.claude', 'settings.local.json');
    const current = this.installed(env);
    if (current && current.command === command) {
      return { status: 'already', path: current.path, detail: 'already shows contextd' };
    }
    if (current && !opts.chain) {
      return {
        status: 'conflict',
        path: current.path,
        detail:
          `a status line is already configured (\`${current.command}\`) and was left as it is; ` +
          '`contextd statusline install --chain` keeps it and appends contextd\'s segment',
      };
    }
    mkdirSync(dirname(path), { recursive: true });
    const settings = readJsonForWrite(path);
    writeJson(path, { ...settings, statusLine: { type: 'command', command, padding: 0 } });
    return current
      ? { status: 'installed', path, detail: `yours (\`${current.command}\`) runs first, contextd's segment after it`, replaced: current }
      : { status: 'installed', path, detail: 'status line set; it appears on the next render' };
  },

  uninstall(env, isOurs, restore) {
    const changed: string[] = [];
    for (const path of files(env)) {
      if (!existsSync(path)) continue;
      let settings: Record<string, unknown>;
      try {
        settings = readJsonForWrite(path);
      } catch {
        continue;
      }
      const command = commandIn(settings);
      if (!command || !isOurs(command)) continue;
      const next = { ...settings };
      delete next.statusLine;
      if (restore && restore.path === path) next.statusLine = { type: 'command', command: restore.command };
      writeJson(path, next);
      changed.push(path);
    }
    return changed;
  },
};
