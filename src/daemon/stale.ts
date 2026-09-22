import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IgnoreMatcher } from '../core/ignore.js';
import type { StatePatch } from '../core/patch.js';
import { isProtected } from '../core/patch.js';
import { itemReferences } from '../core/references.js';
import type { MemoryItem } from '../core/state.js';
import type { ContextStore } from '../store/store.js';

/**
 * Memory that points at files which are no longer there.
 *
 * Borrowed from headroom's `_detect_staleness`: an `important_files` entry for a deleted module,
 * or a rule naming a path that was renamed, is served with full confidence and sends the agent to
 * look for something that does not exist. A stat per referenced path is free, so this runs on the
 * `maintain` rung, which the hook path takes (invariant 17). It does not shell out to
 * `git ls-files`: that is a process spawn on a path with a latency budget, and the filesystem is
 * the truth the agent will meet anyway.
 *
 * Never deletes. An unprotected item is marked `stale`, which stops it being served (invariant
 * 13) and is undone here if the file comes back - a branch switch must not cost memory. A
 * protected item (invariant 6) keeps its status and is only flagged: tag `stale_reference` plus
 * `fields.stale_paths`, for `doctor` to put in front of the user, who alone may retire it.
 */

export const STALE_TAG = 'stale_reference';

/** Bounds, so a large memory cannot make a hook slow. */
const MAX_ITEMS = 2000;
const MAX_REFS_PER_ITEM = 8;

export interface StaleFinding {
  id: string;
  category: MemoryItem['category'];
  text: string;
  /** Referenced paths that do not exist, and paths said not to exist that now do. */
  missing: string[];
  appeared: string[];
  /** Protected items are flagged, never retired. */
  protected: boolean;
}

export interface StaleReport {
  /** Items whose references no longer resolve. */
  stale: StaleFinding[];
  /** Items marked stale by an earlier check whose files are back. */
  revived: string[];
  checked: number;
}

function topLevelDirs(root: string, ignore: IgnoreMatcher): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !ignore.ignores(d.name))
      .map((d) => d.name)
      .slice(0, 50);
  } catch {
    return [];
  }
}

function stalePathsOf(item: MemoryItem): string[] {
  const v = item.fields.stale_paths;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Check every live item's file references against the working tree. Read-only.
 *
 * This is the function `doctor` should call: `staleReferences(manager.store, manager.projectRoot)`.
 */
export function staleReferences(store: ContextStore, root: string): StaleReport {
  // Build output, dependencies and scratch are ignored: a reference to `dist/cli/index.js` before
  // the first build is not a reference to a missing file.
  const ignore = IgnoreMatcher.fromProject(root, [], true);
  // A relative path in prose is often relative to a package, not to the repository: a monorepo's
  // items say `app/services/x.py` for `api/app/services/x.py`. One level of top-level directories
  // is tried before a path is called missing - bounded, and the direction of error that is safe.
  const topDirs = topLevelDirs(root, ignore);
  const exists = (rel: string) =>
    existsSync(join(root, rel)) || topDirs.some((d) => existsSync(join(root, d, rel)));
  const report: StaleReport = { stale: [], revived: [], checked: 0 };

  const items = store.allItems(false).slice(0, MAX_ITEMS);
  for (const item of items) {
    const ours = stalePathsOf(item).length > 0;
    // Only this check's own verdicts are revisited; TTL decay and retirements are not ours to undo.
    if (item.status !== 'active' && !(item.status === 'stale' && ours)) continue;
    const refs = itemReferences(item, root);
    if (!refs) continue;
    const present = refs.present.filter((p) => !ignore.ignores(p)).slice(0, MAX_REFS_PER_ITEM);
    const absent = refs.absent.filter((p) => !ignore.ignores(p)).slice(0, MAX_REFS_PER_ITEM);
    if (present.length === 0 && absent.length === 0) continue;
    report.checked += 1;

    const missing = present.filter((p) => !exists(p));
    const appeared = absent.filter((p) => exists(p));
    // Stale only when *every* file the item names is gone. "Moved the parser from `a.ts` to
    // `b.ts`" still names a live file, and one survivor means the item may still be true.
    const isStale = (present.length > 0 && missing.length === present.length) || appeared.length > 0;

    if (isStale) {
      report.stale.push({
        id: item.id,
        category: item.category,
        text: item.text,
        missing,
        appeared,
        protected: isProtected(item),
      });
    } else if (ours) {
      report.revived.push(item.id);
    }
  }
  return report;
}

/**
 * Turn a report into one deterministic patch and commit it (invariant 3).
 *
 * Items already carrying the same verdict are left alone, so a check that finds nothing new
 * writes nothing - this runs on every maintenance cycle.
 */
export function applyStaleReferences(store: ContextStore, root: string): StaleReport & { committed: boolean } {
  const report = staleReferences(store, root);
  const byId = new Map(store.allItems(false).map((i) => [i.id, i]));
  const update: NonNullable<StatePatch['update']> = [];

  for (const f of report.stale) {
    const item = byId.get(f.id);
    if (!item) continue;
    const paths = [...f.missing, ...f.appeared];
    const already = stalePathsOf(item).join('\n') === paths.join('\n');
    if (f.protected) {
      if (already && item.tags.includes(STALE_TAG)) continue;
      update.push({
        id: f.id,
        fields: { stale_paths: paths },
        tags: [...new Set([...item.tags, STALE_TAG])],
      });
    } else {
      if (already && item.status === 'stale') continue;
      update.push({ id: f.id, status: 'stale', fields: { stale_paths: paths } });
    }
  }
  for (const id of report.revived) {
    const item = byId.get(id);
    if (!item) continue;
    update.push({
      id,
      ...(item.status === 'stale' ? { status: 'active' as const } : {}),
      fields: { stale_paths: null },
      tags: item.tags.filter((t) => t !== STALE_TAG),
    });
  }

  if (update.length === 0) return { ...report, committed: false };
  const result = store.commitPatch(
    { update, note: 'stale file references: a referenced file is missing, or a file said to be missing exists' },
    'deterministic',
    {},
  );
  return { ...report, committed: result.ok };
}
