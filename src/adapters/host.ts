import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CommandRunner, HostEnv } from './types.js';

/**
 * The real machine, for the CLI. Tests build a `HostEnv` by hand instead, with a temp home and
 * no `which`, so no installer can reach a real agent config or run a real agent binary.
 */
export function realHost(projectRoot: string): HostEnv {
  return { projectRoot, home: homedir(), vars: process.env, which: whichOnPath, exec: spawnRunner };
}

export function whichOnPath(bin: string, pathVar = process.env.PATH ?? ''): string | null {
  if (isAbsolute(bin) || bin.includes('/')) return isExecutable(bin) ? bin : null;
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const spawnRunner: CommandRunner = (bin, args, opts) => {
  const r = spawnSync(bin, [...args], {
    encoding: 'utf8',
    timeout: 20_000,
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? '',
    stderr: r.error ? r.error.message : (r.stderr ?? ''),
  };
};

export class MalformedConfigError extends Error {}

/**
 * Read a JSON object that is about to be rewritten in full.
 *
 * Absent or empty means start fresh. Anything else that is not a JSON object throws: these files
 * hold the agent's own state (accounts, history, other servers), and rewriting an unparseable one
 * from `{}` would destroy it.
 */
export function readJsonForWrite(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MalformedConfigError(`${path} is not valid JSON (${(err as Error).message}); refusing to rewrite it`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedConfigError(`${path} does not hold a JSON object; refusing to rewrite it`);
  }
  return parsed as Record<string, unknown>;
}

/** Read-only: a missing or broken file reads as empty. Never use this before a write. */
export function readJsonLoose(path: string): Record<string, unknown> {
  try {
    return readJsonForWrite(path);
  } catch {
    return {};
  }
}

/** Write through a temp file and rename, so a crash cannot leave a half-written agent config. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.contextd-${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
