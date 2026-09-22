import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Whether the build an agent runs is the build the checkout would produce.
 *
 * Hooks and MCP entries name a file (`node <checkout>/dist/cli/index.js`). Editing `src/` and not
 * rebuilding leaves every agent on the old code, and nothing says so: the hook still starts, the
 * server still answers, and a fix "that works in the tests" does nothing. Stat only - no process,
 * no hashing - so it is free to run in `doctor`.
 */

/** Modification times closer than this are one build, not a stale one (file systems round). */
const SLACK_MS = 2000;
/** How far above a script to look for its package.json: `dist/cli/index.js` is two levels down. */
const MAX_DEPTH = 6;

export function packageRootOf(file: string): string | null {
  let dir = dirname(file);
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function packageVersion(root: string | null): string | null {
  if (!root) return null;
  try {
    const v = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The most recently modified `.ts` under `dir`, skipping dependencies and build output. */
export function newestSource(dir: string): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(dir);
  return best;
}

/** The script behind a command: the interpreter's argument, or what a `contextd` binary links to. */
export function scriptBehind(resolution: { script: string | null; binaryPath: string | null }): string | null {
  if (resolution.script) return resolution.script;
  if (!resolution.binaryPath) return null;
  try {
    const real = realpathSync(resolution.binaryPath);
    return real.endsWith('.js') ? real : null;
  } catch {
    return null;
  }
}

export interface BuildDrift {
  script: string;
  packageRoot: string | null;
  version: string | null;
  /** Set when a source file is newer than the build. */
  newerSource: { path: string; aheadMs: number } | null;
  /** Set when the build's package version differs from the running checkout's. */
  versionMismatch: { installed: string; checkout: string } | null;
}

export function buildDrift(script: string, checkoutRoot: string | null): BuildDrift | null {
  let builtAt: number;
  try {
    builtAt = statSync(script).mtimeMs;
  } catch {
    return null;
  }
  const packageRoot = packageRootOf(script);
  const version = packageVersion(packageRoot);
  let newerSource: BuildDrift['newerSource'] = null;
  const src = packageRoot ? join(packageRoot, 'src') : null;
  // Only a checkout has a src/ next to its build; an installed package has nothing to compare.
  if (src && existsSync(src)) {
    const newest = newestSource(src);
    if (newest && newest.mtime - builtAt > SLACK_MS) newerSource = { path: newest.path, aheadMs: newest.mtime - builtAt };
  }
  const checkout = packageVersion(checkoutRoot);
  const versionMismatch = version && checkout && version !== checkout ? { installed: version, checkout } : null;
  return { script, packageRoot, version, newerSource, versionMismatch };
}
