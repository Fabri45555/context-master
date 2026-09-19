import { z } from 'zod';
import { ImportanceSchema } from './events.js';

/**
 * PRD 9 - L1 categories. Modelled as one flat item table with a `category` discriminator
 * rather than per-category arrays: one FTS index, one decay policy, one patch shape.
 */
export const MEMORY_CATEGORIES = [
  'goals',
  'requirements',
  'constraints',
  'decisions',
  'architecture',
  'conventions',
  'discoveries',
  'completed_work',
  'known_issues',
  'open_questions',
  'important_files',
] as const;

export const MemoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

/** PRD 43 - lifecycle states for memory decay. */
export const MEMORY_STATUSES = ['active', 'stale', 'superseded', 'archived', 'deleted'] as const;
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MEMORY_SOURCES = ['user', 'agent', 'worker', 'deterministic', 'import'] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/**
 * A single unit of project memory.
 *
 * `text` is the canonical, human-readable statement. `fields` carries category-specific
 * structure (a decision's reason, a file's purpose) without forking the schema per
 * category - PRD 18 requires the *semantics* be preserved, not a particular shape.
 */
export const MemoryItemSchema = z.object({
  id: z.string(),
  category: MemoryCategorySchema,
  text: z.string().min(1),
  fields: z.record(z.unknown()).default({}),

  importance: ImportanceSchema.default('medium'),
  /** How sure we are this is true. Workers must lower it when inferring (PRD 43). */
  confidence: z.number().min(0).max(1).default(0.8),
  status: MemoryStatusSchema.default('active'),

  source: MemorySourceSchema.default('worker'),
  /** PRD 42 - explainability. Event ids / message refs that justify this item. */
  evidence: z.array(z.string()).default([]),
  reason: z.string().nullable().default(null),

  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().nullable().default(null),
  last_validated_at: z.string().nullable().default(null),
  /** Seconds. null means "no automatic expiry". */
  ttl_seconds: z.number().int().positive().nullable().default(null),

  /** PRD 44 - contradiction handling keeps history instead of deleting it. */
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().default(null),

  tags: z.array(z.string()).default([]),

  /**
   * How many times retrieval has served this item.
   *
   * PRD 29 measures memory loss and false memory but has no metric for memory that is true
   * and worthless, which is the failure mode that actually showed up. An item never
   * retrieved is the cheapest signal that storing it was not worth it.
   */
  retrieved_count: z.number().int().nonnegative().default(0),
});

export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/** PRD 8 - L0 working memory. Few tokens, maximum value. */
export const WorkingMemorySchema = z.object({
  project_name: z.string().nullable().default(null),
  current_task: z.string().nullable().default(null),
  task_status: z
    .enum(['unknown', 'planning', 'in_progress', 'blocked', 'review', 'done'])
    .default('unknown'),
  current_plan: z.array(z.string()).default([]),
  current_state: z.string().nullable().default(null),
  next_action: z.string().nullable().default(null),
  last_important_event: z.string().nullable().default(null),
  /** Free-form notes the worker wants carried forward but that are not yet L1 items. */
  scratch: z.array(z.string()).default([]),
  updated_at: z.string().nullable().default(null),
});

export type WorkingMemory = z.infer<typeof WorkingMemorySchema>;

export function emptyWorkingMemory(): WorkingMemory {
  return WorkingMemorySchema.parse({});
}

/** PRD 52 - the full materialized state a retrieval or a snapshot speaks in terms of. */
export interface ProjectState {
  version: number;
  working: WorkingMemory;
  items: MemoryItem[];
}

export function groupByCategory(items: MemoryItem[]): Record<MemoryCategory, MemoryItem[]> {
  const out = {} as Record<MemoryCategory, MemoryItem[]>;
  for (const c of MEMORY_CATEGORIES) out[c] = [];
  for (const it of items) out[it.category].push(it);
  return out;
}

/**
 * True when the item may still be injected into context.
 *
 * Only `active` qualifies. `stale` is what TTL decay assigns precisely so an item stops
 * being served, so treating it as live made `decay()` a no-op for keyword retrieval and for
 * graph traversal - the SQL paths filtered on status and hid the inconsistency.
 */
export function isLive(item: MemoryItem, now = Date.now()): boolean {
  if (item.status !== 'active') return false;
  if (item.ttl_seconds != null) {
    const base = Date.parse(item.last_validated_at ?? item.updated_at ?? item.created_at);
    if (Number.isFinite(base) && now - base > item.ttl_seconds * 1000) return false;
  }
  return true;
}
