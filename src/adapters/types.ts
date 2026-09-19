import type { ContextEvent } from '../core/events.js';

/**
 * PRD 22 - the adapter layer. Everything agent-specific lives behind this interface so the
 * core never learns what a "Bash tool" or a "codex rollout" is.
 */
export interface AdapterContext {
  sessionId: string;
  /** Ordering hint from the source (transcript line number, codex ordinal). */
  ordinal?: number;
  cwd?: string | null;
}

export interface TranslateResult {
  events: ContextEvent[];
  /** Provider token usage observed on this record, for baseline accounting (PRD 28). */
  agentUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    model?: string | null;
    /** Provider message id, so the same turn read twice (hook and transcript) counts once. */
    message_id?: string | null;
  };
  /** Session metadata discovered in the record. */
  session?: { id?: string; cwd?: string | null; agent?: string | null };
}

/**
 * How events get out of a given agent.
 *
 * "Agent agnostic" (PRD 6) hides a real asymmetry: each agent has one good ingestion
 * surface and several bad ones, and which one is chosen decides whether PRD 54.7 ("no
 * changes to the main model") actually holds. Declaring the surfaces makes that choice
 * explicit and inspectable instead of buried in the CLI.
 */
export type SurfaceKind =
  /** The agent invokes us on lifecycle events. Low latency, synchronous, must not block. */
  | 'hook'
  /** We tail an append-only log the agent writes. Complete, slightly delayed. */
  | 'transcript'
  /** Something else pipes normalized events to us. */
  | 'stdin';

export interface TranscriptCandidate {
  path: string;
  /** Epoch ms of last modification, for picking the live session. */
  mtime: number;
  /** Session id if it can be derived from the file itself. */
  sessionId?: string;
}

export interface AdapterSurface {
  kind: SurfaceKind;
  /** The recommended path for this agent. Exactly one surface should set this. */
  preferred: boolean;
  description: string;
  /** True when `contextd init` can wire this surface up without manual steps. */
  installable: boolean;
  /**
   * Locate transcripts belonging to a project, newest first. Only for `transcript`
   * surfaces. Keeping this on the adapter is what stops the CLI from knowing where any
   * particular agent stores its logs.
   */
  locate?(projectRoot: string, home: string): TranscriptCandidate[];
}

export interface Adapter {
  readonly name: string;
  /** Human-facing name of the agent this adapter serves. */
  readonly agent: string;
  readonly surfaces: readonly AdapterSurface[];
  /** Translate one raw record (a transcript line, or a hook payload) into events. */
  translate(raw: unknown, ctx: AdapterContext): TranslateResult;
  /**
   * Where the agent's latest token usage can be read, given a hook payload - or null.
   *
   * Hook payloads carry no usage, so a hook-only installation never saw occupancy change: after
   * a compaction the ladder kept reading the pre-compaction peak and stayed at its most expensive
   * rung. The manager reads the tail of this file generically; only the adapter knows it exists.
   */
  usageSource?(hookPayload: unknown): string | null;
}

export function noEvents(): TranslateResult {
  return { events: [] };
}

export function preferredSurface(adapter: Adapter): AdapterSurface | null {
  return adapter.surfaces.find((s) => s.preferred) ?? adapter.surfaces[0] ?? null;
}

/** Newest transcript across every transcript surface this adapter declares. */
export function newestTranscript(
  adapter: Adapter,
  projectRoot: string,
  home: string,
): TranscriptCandidate | null {
  let best: TranscriptCandidate | null = null;
  for (const surface of adapter.surfaces) {
    if (!surface.locate) continue;
    for (const candidate of surface.locate(projectRoot, home)) {
      if (!best || candidate.mtime > best.mtime) best = candidate;
    }
  }
  return best;
}
