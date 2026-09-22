import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../adapters/host.js';

/**
 * The projects contextd knows on this machine, for `contextd status --all`.
 *
 * Storage is per project (`<root>/.context`), so nothing else can answer "which projects": the
 * agents' own directories name projects by a lossy slug, and scanning the disk for `.context`
 * directories is slow and finds other tools' folders of the same name. So `init`, `attach` and
 * `mcp install` add the root to one small file. It holds paths only - never memory - and a
 * failure to write it never fails the command that tried.
 */

export interface RegistryEntry {
  root: string;
  storage_dir: string;
  registered_at: string;
}

/** `$CONTEXTD_HOME/projects.json`, default `~/.contextd/projects.json`. */
export function registryPath(home: string, vars: Readonly<Record<string, string | undefined>> = {}): string {
  const base = vars.CONTEXTD_HOME?.trim() || join(home, '.contextd');
  return join(base, 'projects.json');
}

export function readRegistry(path: string): RegistryEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: unknown };
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];
    return list.filter(
      (e): e is RegistryEntry =>
        !!e && typeof e === 'object' && typeof (e as RegistryEntry).root === 'string' && typeof (e as RegistryEntry).storage_dir === 'string',
    );
  } catch {
    return [];
  }
}

function write(path: string, entries: RegistryEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({ version: 1, projects: entries }, null, 2)}\n`);
}

/** Add or refresh a project. Returns false (never throws) when the file could not be written. */
export function registerProject(path: string, root: string, storageDir: string): boolean {
  try {
    const entries = readRegistry(path);
    const existing = entries.find((e) => e.root === root);
    if (existing && existing.storage_dir === storageDir) return true;
    const next = entries.filter((e) => e.root !== root);
    next.push({ root, storage_dir: storageDir, registered_at: existing?.registered_at ?? new Date().toISOString() });
    next.sort((a, b) => a.root.localeCompare(b.root));
    write(path, next);
    return true;
  } catch {
    return false;
  }
}

export function unregisterProject(path: string, root: string): boolean {
  try {
    const entries = readRegistry(path);
    const next = entries.filter((e) => e.root !== root);
    if (next.length === entries.length) return false;
    write(path, next);
    return true;
  } catch {
    return false;
  }
}
