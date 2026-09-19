import { z } from 'zod';
import { ImportanceSchema, atLeast } from './events.js';
import {
  MemoryCategorySchema,
  MemoryItemSchema,
  MemoryStatusSchema,
  MemorySourceSchema,
  WorkingMemorySchema,
  type MemoryItem,
  type ProjectState,
} from './state.js';
import { newId } from './ids.js';
import { EdgeKindSchema, MemoryEdgeSchema, type MemoryEdge } from './graph.js';

/**
 * PRD 16 / 34 - workers emit patches, never whole summaries. The patch log is the source
 * of truth; a snapshot is just a fold over it, which is what makes rollback, diff and
 * audit (PRD 33) fall out for free instead of needing separate machinery.
 */

export const AddItemSchema = z.object({
  /** Optional caller-chosen id; lets a worker reference its own additions in one patch. */
  id: z.string().optional(),
  category: MemoryCategorySchema,
  text: z.string().min(1),
  fields: z.record(z.unknown()).optional(),
  importance: ImportanceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: MemorySourceSchema.optional(),
  evidence: z.array(z.string()).optional(),
  reason: z.string().nullable().optional(),
  ttl_seconds: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).optional(),
  supersedes: z.array(z.string()).optional(),
});

export const UpdateItemSchema = z.object({
  id: z.string(),
  text: z.string().min(1).optional(),
  fields: z.record(z.unknown()).optional(),
  importance: ImportanceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: MemoryStatusSchema.optional(),
  reason: z.string().nullable().optional(),
  ttl_seconds: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
});

export const SupersedeSchema = z.object({
  /** The item being replaced. */
  id: z.string(),
  /** The item that replaces it - may be an id created earlier in the same patch. */
  by: z.string(),
  reason: z.string().optional(),
});

export const LinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  reason: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const UnlinkSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Omit to drop every relation between the two items. */
  kind: EdgeKindSchema.optional(),
});

export const StatePatchSchema = z.object({
  /** Optimistic concurrency: reject if state moved on since the worker read it. */
  base_version: z.number().int().nonnegative().optional(),
  working: WorkingMemorySchema.partial().optional(),
  add: z.array(AddItemSchema).optional(),
  update: z.array(UpdateItemSchema).optional(),
  /** Soft delete - sets status to `deleted`, the row stays for audit (PRD 10). */
  remove: z.array(z.string()).optional(),
  supersede: z.array(SupersedeSchema).optional(),
  /** Bump last_validated_at: "still true as of now" (PRD 43). */
  touch: z.array(z.string()).optional(),
  /** PRD 56 - state a typed relation between two items. */
  link: z.array(LinkSchema).optional(),
  unlink: z.array(UnlinkSchema).optional(),
  /** Free-form note explaining the patch, shown in `contextd inspect`. */
  note: z.string().optional(),
});

export type StatePatch = z.infer<typeof StatePatchSchema>;
export type AddItem = z.infer<typeof AddItemSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type Unlink = z.infer<typeof UnlinkSchema>;

export interface PatchViolation {
  code:
    | 'unknown_item'
    | 'protected_item'
    | 'version_conflict'
    | 'empty_patch'
    | 'duplicate_id'
    | 'self_supersede'
    | 'self_link'
    /** The response was not a patch at all: no JSON, bad JSON, or a shape nothing can fix. */
    | 'unparsable_response';
  message: string;
  ref?: string;
}

/**
 * Give every `add` an explicit id before the patch is stored.
 *
 * Ids are otherwise minted inside `applyPatch`, so replaying the log would mint different
 * ones and the fold would no longer reproduce the materialized state - which would quietly
 * cost us the rollback, diff and audit guarantees the patch log exists for (PRD 33).
 */
/**
 * The highest confidence a model may claim for something it inferred.
 *
 * A real extraction run returned 18 items all at 1.00, which makes confidence carry no
 * information at all and stops `min_bootstrap_confidence` from ever firing. Certainty belongs to
 * what the user actually said; everything else is a reading of the evidence.
 */
export const MAX_INFERRED_CONFIDENCE = 0.9;

export function normalizePatch(patch: StatePatch): StatePatch {
  if (!patch.add?.length) return patch;
  return {
    ...patch,
    add: patch.add.map((a) => {
      const withId = a.id ? a : { ...a, id: newId('mem') };
      // Same discipline as `importance_source`: a worker may not assert a certainty it cannot
      // have. User-authored items keep whatever confidence they were given.
      if (withId.source === 'user' || withId.confidence == null) return withId;
      return { ...withId, confidence: Math.min(withId.confidence, MAX_INFERRED_CONFIDENCE) };
    }),
  };
}

export function isEmptyPatch(p: StatePatch): boolean {
  return (
    !p.working &&
    !p.add?.length &&
    !p.update?.length &&
    !p.remove?.length &&
    !p.supersede?.length &&
    !p.touch?.length &&
    !p.link?.length &&
    !p.unlink?.length
  );
}

/**
 * A memory item that a worker is not allowed to weaken.
 *
 * PRD 18 gives explicit user instructions special priority, and K2 targets ~0% loss of
 * critical information. Relying on the worker prompt alone for that would make the
 * guarantee probabilistic, so it is enforced here, deterministically.
 */
export function isProtected(item: MemoryItem): boolean {
  return item.source === 'user' && atLeast(item.importance, 'critical');
}

/**
 * Drop operations that cannot change anything, because their target does not exist.
 *
 * A `remove` of an unknown id removes nothing; a `link` to an unknown id links nothing. Keeping
 * them only means the whole patch is rejected, and a real run lost 45 events of extracted memory
 * because the model invented three link targets — one of them a file path. Dropping a provable
 * no-op is exactly equivalent to the model not having written it.
 *
 * Deliberately narrow: `update` and `supersede` are never dropped. A mistyped `update` target
 * means the model intended to change something real, and silently discarding that is a change of
 * intent rather than a normalization.
 *
 * An `add` restating an active item word for word is the same kind of no-op, and is dropped with
 * its id aliased to the existing item so that links the model drew to it still land. A real run
 * re-extracted seven items verbatim, under new ids, from a pasted `contextd memory` listing: the
 * memory quoting itself back into the queue.
 */
export function pruneInertOperations(
  patch: StatePatch,
  state: ProjectState,
): { patch: StatePatch; dropped: string[] } {
  const dropped: string[] = [];
  const out: StatePatch = { ...patch };

  const alias = new Map<string, string>();
  if (patch.add?.length) {
    const seen = new Map<string, string>();
    for (const i of state.items) if (i.status === 'active') seen.set(sameText(i.category, i.text), i.id);
    const keep: typeof patch.add = [];
    for (const a of patch.add) {
      const key = sameText(a.category, a.text);
      const existing = seen.get(key);
      if (existing && !(a.supersedes?.length)) {
        dropped.push(`add ${a.id ?? '(no id)'} duplicates ${existing}`);
        if (a.id) alias.set(a.id, existing);
        continue;
      }
      keep.push(a);
      if (a.id) seen.set(key, a.id);
    }
    out.add = keep;
  }
  const resolve = (id: string) => alias.get(id) ?? id;
  if (alias.size > 0) {
    if (out.link) out.link = out.link.map((e) => ({ ...e, from: resolve(e.from), to: resolve(e.to) }));
    if (out.unlink) out.unlink = out.unlink.map((e) => ({ ...e, from: resolve(e.from), to: resolve(e.to) }));
    if (out.touch) out.touch = out.touch.map(resolve);
    if (out.update) out.update = out.update.map((u) => ({ ...u, id: resolve(u.id) }));
    if (out.supersede) out.supersede = out.supersede.map((s) => ({ ...s, id: resolve(s.id), by: resolve(s.by) }));
  }

  const known = new Set(state.items.map((i) => i.id));
  for (const a of out.add ?? []) if (a.id) known.add(a.id);
  patch = out;

  if (patch.remove?.length) {
    const keep = patch.remove.filter((id) => known.has(id));
    for (const id of patch.remove) if (!known.has(id)) dropped.push(`remove ${id}`);
    out.remove = keep;
  }
  const bothEndsKnown = (e: { from: string; to: string }) => known.has(e.from) && known.has(e.to);
  if (patch.link?.length) {
    for (const e of patch.link) if (!bothEndsKnown(e)) dropped.push(`link ${e.from}->${e.to}`);
    out.link = patch.link.filter(bothEndsKnown);
  }
  if (patch.unlink?.length) {
    for (const e of patch.unlink) if (!bothEndsKnown(e)) dropped.push(`unlink ${e.from}->${e.to}`);
    out.unlink = patch.unlink.filter(bothEndsKnown);
  }
  if (patch.touch?.length) {
    const keep = patch.touch.filter((id) => known.has(id));
    for (const id of patch.touch) if (!known.has(id)) dropped.push(`touch ${id}`);
    out.touch = keep;
  }

  return { patch: out, dropped };
}

/** Equality up to case, whitespace and closing punctuation - the ways a verbatim copy drifts. */
function sameText(category: string, text: string): string {
  return `${category}\u0000${text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;:!\s]+$/, '')}`;
}

/** Structural + semantic validation of a patch against the state it will be applied to. */
export function validatePatch(patch: StatePatch, state: ProjectState): PatchViolation[] {
  const violations: PatchViolation[] = [];

  if (patch.base_version != null && patch.base_version !== state.version) {
    violations.push({
      code: 'version_conflict',
      message: `patch was built against version ${patch.base_version}, state is at ${state.version}`,
    });
  }

  if (isEmptyPatch(patch)) {
    violations.push({ code: 'empty_patch', message: 'patch contains no operations' });
    return violations;
  }

  const byId = new Map(state.items.map((i) => [i.id, i]));
  const introduced = new Set<string>();
  for (const a of patch.add ?? []) {
    if (!a.id) continue;
    if (byId.has(a.id) || introduced.has(a.id)) {
      violations.push({ code: 'duplicate_id', message: `id already exists: ${a.id}`, ref: a.id });
    }
    introduced.add(a.id);
  }

  const known = (id: string) => byId.has(id) || introduced.has(id);

  for (const u of patch.update ?? []) {
    const existing = byId.get(u.id);
    if (!existing && !introduced.has(u.id)) {
      violations.push({ code: 'unknown_item', message: `update targets unknown id ${u.id}`, ref: u.id });
      continue;
    }
    if (!existing) continue;
    if (isProtected(existing)) {
      const weakens =
        (u.importance != null && !atLeast(u.importance, 'critical')) ||
        (u.status != null && u.status !== 'active') ||
        (u.confidence != null && u.confidence < existing.confidence);
      if (weakens) {
        violations.push({
          code: 'protected_item',
          message: `cannot weaken user-critical item ${u.id}`,
          ref: u.id,
        });
      }
    }
  }

  for (const id of patch.remove ?? []) {
    const existing = byId.get(id);
    if (!existing && !introduced.has(id)) {
      violations.push({ code: 'unknown_item', message: `remove targets unknown id ${id}`, ref: id });
      continue;
    }
    if (existing && isProtected(existing)) {
      violations.push({
        code: 'protected_item',
        message: `cannot remove user-critical item ${id}`,
        ref: id,
      });
    }
  }

  for (const s of patch.supersede ?? []) {
    if (s.id === s.by) {
      violations.push({ code: 'self_supersede', message: `item ${s.id} cannot supersede itself`, ref: s.id });
    }
    if (!known(s.id)) {
      violations.push({ code: 'unknown_item', message: `supersede target unknown: ${s.id}`, ref: s.id });
    }
    if (!known(s.by)) {
      violations.push({ code: 'unknown_item', message: `supersede replacement unknown: ${s.by}`, ref: s.by });
    }
    // Superseding retires an item just as surely as removing it. Guarding `remove` and
    // `update` but not this left the whole K2 guarantee bypassable by one extra key.
    const target = byId.get(s.id);
    if (target && isProtected(target)) {
      violations.push({
        code: 'protected_item',
        message: `cannot supersede user-critical item ${s.id}`,
        ref: s.id,
      });
    }
  }

  // An `add` that declares `supersedes` retires those items too, by the same argument.
  for (const a of patch.add ?? []) {
    for (const oldId of a.supersedes ?? []) {
      const target = byId.get(oldId);
      if (target && isProtected(target)) {
        violations.push({
          code: 'protected_item',
          message: `cannot supersede user-critical item ${oldId}`,
          ref: oldId,
        });
      } else if (!known(oldId)) {
        violations.push({
          code: 'unknown_item',
          message: `supersedes references unknown id ${oldId}`,
          ref: oldId,
        });
      }
    }
  }

  for (const id of patch.touch ?? []) {
    if (!known(id)) {
      violations.push({ code: 'unknown_item', message: `touch targets unknown id ${id}`, ref: id });
    }
  }

  for (const l of patch.link ?? []) {
    if (l.from === l.to) {
      violations.push({ code: 'self_link', message: `item ${l.from} cannot link to itself`, ref: l.from });
    }
    for (const id of [l.from, l.to]) {
      if (!known(id)) {
        violations.push({ code: 'unknown_item', message: `link references unknown id ${id}`, ref: id });
      }
    }
  }

  return violations;
}

export interface ApplyResult {
  state: ProjectState;
  added: string[];
  updated: string[];
  removed: string[];
  superseded: string[];
  touched: string[];
  /** Edges to write and to drop. The store persists these; items carry no edge state. */
  linked: MemoryEdge[];
  unlinked: Unlink[];
}

/**
 * Pure fold of a patch onto a state. Persistence is the store's job; keeping this pure is
 * what lets `contextd replay` rebuild any historical version from the patch log.
 */
export function applyPatch(state: ProjectState, patch: StatePatch, now = new Date()): ApplyResult {
  const iso = now.toISOString();
  const items = state.items.map((i) => ({ ...i }));
  const index = new Map(items.map((i, n) => [i.id, n]));

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const superseded: string[] = [];
  const touched: string[] = [];

  for (const a of patch.add ?? []) {
    const item = MemoryItemSchema.parse({
      id: a.id ?? newId('mem'),
      category: a.category,
      text: a.text,
      fields: a.fields ?? {},
      importance: a.importance ?? 'medium',
      confidence: a.confidence ?? 0.8,
      status: 'active',
      source: a.source ?? 'worker',
      evidence: a.evidence ?? [],
      reason: a.reason ?? null,
      created_at: iso,
      updated_at: iso,
      last_used_at: null,
      last_validated_at: iso,
      ttl_seconds: a.ttl_seconds ?? null,
      supersedes: a.supersedes ?? [],
      superseded_by: null,
      tags: a.tags ?? [],
    });
    index.set(item.id, items.push(item) - 1);
    added.push(item.id);
    // An add that declares `supersedes` retires the old items in the same step (PRD 44).
    for (const oldId of item.supersedes) {
      const n = index.get(oldId);
      if (n == null) continue;
      const prev = items[n]!;
      if (isProtected(prev)) continue;
      items[n] = { ...prev, status: 'superseded', superseded_by: item.id, updated_at: iso };
      superseded.push(oldId);
    }
  }

  for (const u of patch.update ?? []) {
    const n = index.get(u.id);
    if (n == null) continue;
    const prev = items[n]!;
    const next: MemoryItem = { ...prev, updated_at: iso };
    if (u.text != null) next.text = u.text;
    if (u.fields != null) next.fields = { ...prev.fields, ...u.fields };
    if (u.importance != null) next.importance = u.importance;
    if (u.confidence != null) next.confidence = u.confidence;
    if (u.status != null) next.status = u.status;
    if (u.reason !== undefined) next.reason = u.reason;
    if (u.ttl_seconds !== undefined) next.ttl_seconds = u.ttl_seconds;
    if (u.tags != null) next.tags = u.tags;
    if (u.evidence != null) next.evidence = [...new Set([...prev.evidence, ...u.evidence])];
    items[n] = next;
    updated.push(u.id);
  }

  for (const id of patch.remove ?? []) {
    const n = index.get(id);
    if (n == null) continue;
    items[n] = { ...items[n]!, status: 'deleted', updated_at: iso };
    removed.push(id);
  }

  for (const s of patch.supersede ?? []) {
    const n = index.get(s.id);
    if (n == null) continue;
    items[n] = {
      ...items[n]!,
      status: 'superseded',
      superseded_by: s.by,
      reason: s.reason ?? items[n]!.reason,
      updated_at: iso,
    };
    superseded.push(s.id);
    const m = index.get(s.by);
    if (m != null) {
      items[m] = {
        ...items[m]!,
        supersedes: [...new Set([...items[m]!.supersedes, s.id])],
        updated_at: iso,
      };
    }
  }

  for (const id of patch.touch ?? []) {
    const n = index.get(id);
    if (n == null) continue;
    items[n] = { ...items[n]!, last_validated_at: iso };
    touched.push(id);
  }

  const working = patch.working
    ? WorkingMemorySchema.parse({ ...state.working, ...patch.working, updated_at: iso })
    : state.working;

  const linked: MemoryEdge[] = (patch.link ?? []).map((l) =>
    MemoryEdgeSchema.parse({
      from: l.from,
      to: l.to,
      kind: l.kind,
      reason: l.reason ?? null,
      confidence: l.confidence ?? 0.8,
      created_at: iso,
    }),
  );

  return {
    state: { version: state.version + 1, working, items },
    added,
    updated,
    removed,
    superseded,
    touched,
    linked,
    unlinked: patch.unlink ?? [],
  };
}
