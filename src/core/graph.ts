import { z } from 'zod';

/**
 * PRD 56 / Phase 6 - typed relations between memory items.
 *
 * Keyword retrieval finds items whose *text* matches. It cannot find "the constraint that
 * governs this file" when the constraint never names the file. Edges close that gap: a hit
 * pulls in its neighbours, so one good match reaches the reasoning around it.
 *
 * Deliberately a small labelled graph, not a knowledge graph in the ontology sense. There
 * is no schema for entities and no inference - just relations a worker can state and
 * retrieval can walk.
 */

export const EDGE_KINDS = [
  /** A governs B: a constraint over a decision, a requirement over a component. */
  'governs',
  /** A cannot hold at the same time as B, but neither has been retired yet. */
  'contradicts',
  /** A is the reason B was chosen. */
  'motivates',
  /** A is realised by B: a decision by a file, a requirement by a component. */
  'implemented_by',
  /** A cannot proceed until B is resolved. */
  'blocked_by',
  /** A makes B more precise without replacing it. */
  'refines',
  /** A concerns the same subject as B, with nothing stronger to say. */
  'relates_to',
] as const;

export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const MemoryEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  reason: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.8),
  created_at: z.string(),
});

export type MemoryEdge = z.infer<typeof MemoryEdgeSchema>;

/** Edges worth following during retrieval, and how much score survives the hop. */
const TRAVERSAL_WEIGHT: Record<EdgeKind, number> = {
  // A governing constraint is the single most valuable thing to pull in alongside a hit.
  governs: 0.9,
  contradicts: 0.85,
  motivates: 0.7,
  blocked_by: 0.65,
  implemented_by: 0.6,
  refines: 0.6,
  relates_to: 0.4,
};

export function traversalWeight(kind: EdgeKind): number {
  return TRAVERSAL_WEIGHT[kind];
}

/**
 * Whether the relation reads the same in both directions.
 *
 * `contradicts` and `relates_to` are symmetric; the rest are not, and following `governs`
 * backwards from a decision to its constraint is exactly the useful direction, so traversal
 * walks both ways and lets the weight express the asymmetry.
 */
export function isSymmetric(kind: EdgeKind): boolean {
  return kind === 'contradicts' || kind === 'relates_to';
}

export function describeEdge(edge: MemoryEdge, direction: 'out' | 'in'): string {
  const arrow = direction === 'out' ? '->' : '<-';
  const other = direction === 'out' ? edge.to : edge.from;
  return `${arrow} ${edge.kind} ${other}${edge.reason ? ` (${edge.reason})` : ''}`;
}

/** Canonical key so a symmetric edge is not stored twice. */
export function edgeKey(from: string, to: string, kind: EdgeKind): string {
  if (isSymmetric(kind) && to < from) return `${to}|${from}|${kind}`;
  return `${from}|${to}|${kind}`;
}
