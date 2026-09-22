import type { NativeMemoryEntry, NativeMemorySource } from '../adapters/index.js';
import { MAX_INFERRED_CONFIDENCE, type AddItem, type StatePatch } from '../core/patch.js';
import type { MemoryItem } from '../core/state.js';
import type { ContextStore } from '../store/store.js';
import type { ContextManager } from '../daemon/manager.js';

/**
 * One-way import of an agent's own memory (`contextd import --from <source>`).
 *
 * The agent wrote these files, not the user, and nothing proves which parts the user said - so
 * every item is `source: import`, never `user` (invariant 26), and its confidence stays under
 * `MAX_INFERRED_CONFIDENCE` (invariant 23). It all goes through `commitPatch` (invariant 3), so
 * an import is one reviewable, replayable patch.
 *
 * Idempotent by content hash, not by text. The verbatim re-add rule (invariant 35) only compares
 * against *active* items, so it would resurrect an import the user had retired with `forget`, and
 * it cannot tell an edited file from a new one. The hash is looked up across every item, retired
 * or not; a file whose hash changed replaces what it produced before.
 */

/** Below certainty, above `min_bootstrap_confidence`: a reading of the agent's notes, not a fact. */
export const IMPORT_CONFIDENCE = 0.8;

export interface ImportPlanEntry {
  entry: NativeMemoryEntry;
  action: 'add' | 'replace' | 'refresh';
  /** The item a changed file produced before. */
  previous: MemoryItem | null;
}

export interface ImportPlan {
  source: string;
  dir: string;
  changes: ImportPlanEntry[];
  unchanged: NativeMemoryEntry[];
  skipped: Array<{ file: string; reason: string }>;
}

function importedFrom(item: MemoryItem, source: string): boolean {
  return item.fields.imported_from === source;
}

export function planNativeImport(store: ContextStore, source: NativeMemorySource, dir: string): ImportPlan {
  const { entries, skipped } = source.read(dir);
  const mine = store.allItems(true).filter((i) => importedFrom(i, source.name));
  const byHash = new Set(mine.map((i) => i.fields.import_hash));
  const plan: ImportPlan = { source: source.name, dir, changes: [], unchanged: [], skipped };
  for (const entry of entries) {
    if (byHash.has(entry.hash)) {
      plan.unchanged.push(entry);
      continue;
    }
    const previous = mine.find((i) => i.status === 'active' && i.fields.import_key === entry.key) ?? null;
    if (!previous) plan.changes.push({ entry, action: 'add', previous: null });
    // Same statement, different file (a detail edited): update the record, do not mint a twin -
    // a verbatim re-add would be dropped anyway and the new hash never stored.
    else if (previous.text === entry.text && previous.category === entry.category) plan.changes.push({ entry, action: 'refresh', previous });
    else plan.changes.push({ entry, action: 'replace', previous });
  }
  return plan;
}

function fieldsFor(source: string, entry: NativeMemoryEntry): Record<string, unknown> {
  return {
    imported_from: source,
    import_key: entry.key,
    import_hash: entry.hash,
    source_file: entry.file,
    ...(entry.nativeType ? { native_type: entry.nativeType } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
  };
}

export function patchForPlan(plan: ImportPlan): StatePatch | null {
  if (plan.changes.length === 0) return null;
  const add: AddItem[] = [];
  const update: NonNullable<StatePatch['update']> = [];
  for (const c of plan.changes) {
    const fields = fieldsFor(plan.source, c.entry);
    if (c.action === 'refresh' && c.previous) {
      update.push({ id: c.previous.id, fields });
      continue;
    }
    add.push({
      category: c.entry.category,
      text: c.entry.text,
      fields,
      importance: c.entry.importance,
      confidence: Math.min(IMPORT_CONFIDENCE, MAX_INFERRED_CONFIDENCE),
      source: 'import',
      evidence: [],
      tags: ['imported', plan.source],
      ...(c.previous ? { supersedes: [c.previous.id] } : {}),
    });
  }
  return {
    ...(add.length > 0 ? { add } : {}),
    ...(update.length > 0 ? { update } : {}),
    note: `imported ${plan.changes.length} from ${plan.source} (${plan.dir})`,
  };
}

export interface ImportResult {
  ok: boolean;
  version: number;
  added: string[];
  updated: string[];
  /** Everything pruned as a verbatim duplicate of memory already held. */
  nothingNew: boolean;
  violations: string[];
}

export function applyNativeImport(manager: ContextManager, plan: ImportPlan): ImportResult {
  const patch = patchForPlan(plan);
  if (!patch) {
    return { ok: true, version: manager.store.stateVersion(), added: [], updated: [], nothingNew: true, violations: [] };
  }
  const r = manager.store.commitPatch(patch, 'import', {});
  // A patch whose every add duplicated memory already held is pruned to nothing (invariant 35).
  if (!r.ok && r.violations.every((v) => v.code === 'empty_patch')) {
    return { ok: true, version: r.version, added: [], updated: [], nothingNew: true, violations: [] };
  }
  return {
    ok: r.ok,
    version: r.version,
    added: r.added,
    updated: r.updated,
    nothingNew: false,
    violations: r.violations.map((v) => `${v.code}: ${v.message}`),
  };
}
