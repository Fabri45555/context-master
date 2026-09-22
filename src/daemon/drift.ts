import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

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

/** The most recently modified file under `dir` that `accept`s, skipping dependencies and dot dirs. */
function newestUnder(dir: string, accept: (name: string) => boolean): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Build output never holds sources, and a source tree never holds the build.
        if (name !== 'dist') walk(p);
      } else if (accept(name) && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(dir);
  return best;
}

/** The most recently modified `.ts` under `dir`, skipping dependencies and build output. */
export function newestSource(dir: string): { path: string; mtime: number } | null {
  return newestUnder(dir, (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
}

/** The most recently emitted `.js` of a build. Declarations and source maps are not what runs. */
export function newestBuilt(dir: string): { path: string; mtime: number } | null {
  return newestUnder(dir, (name) => name.endsWith('.js'));
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

/**
 * The other half of build drift: a process that has outlived the build it loaded.
 *
 * `buildDrift` catches source newer than the build. This catches source built and still not
 * running: Node holds the modules it imported at startup, so `contextd ui` left open across a
 * rebuild keeps serving the old behaviour while the CLI, the tests and the files all show the
 * new one. It cost a session: the dashboard reported contradictions the fix had just silenced,
 * and every other surface disagreed with it. Stat only, like the rest of this file.
 */
export interface RunDrift {
  /** The build directory the running entry came out of. */
  buildDir: string;
  /** The file that proves the build moved on, and when it was written. */
  newest: string;
  builtAt: number;
  startedAt: number;
  /** How much newer the build is than the process. */
  behindMs: number;
}

/** When this process started, from its own uptime: no ps, no /proc, same answer everywhere. */
export function processStartedAt(now = Date.now(), uptimeSeconds = process.uptime()): number {
  return now - uptimeSeconds * 1000;
}

/**
 * The build a running entry belongs to: the first directory below its package root, which is
 * `dist` for anything contextd installs. A file straight under the root has only its own directory.
 */
export function buildDirOf(entry: string): string {
  const root = packageRootOf(entry);
  if (!root) return dirname(entry);
  const first = relative(root, entry).split(sep)[0];
  if (!first) return dirname(entry);
  const candidate = join(root, first);
  try {
    if (statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Unreadable: fall back to the directory the entry itself sits in.
  }
  return dirname(entry);
}

export function runDrift(
  opts: { entry?: string | null; startedAt?: number; slackMs?: number } = {},
): RunDrift | null {
  const entry = opts.entry ?? process.argv[1] ?? null;
  if (!entry || !existsSync(entry)) return null;
  const buildDir = buildDirOf(entry);
  // Run from source (`npm run dev`, tsx) there is no build to be behind, and nothing to warn about.
  const newest = newestBuilt(buildDir);
  if (!newest) return null;
  const startedAt = opts.startedAt ?? processStartedAt();
  const behindMs = newest.mtime - startedAt;
  if (behindMs <= (opts.slackMs ?? SLACK_MS)) return null;
  return { buildDir, newest: newest.path, builtAt: newest.mtime, startedAt, behindMs };
}
