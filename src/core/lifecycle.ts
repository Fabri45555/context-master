import type { Config } from './config.js';

/**
 * PRD 24 - continuous compaction, made into a ladder.
 *
 * The triggers in [deterministic.ts](./deterministic.ts) watch *our* backlog: how many events
 * are waiting for a worker. That is the wrong quantity for deciding when to escalate, because
 * the thing that hurts the user is the *agent's* context filling up. Nothing in the pipeline
 * was looking at that, even though every adapter already reports it per turn.
 *
 * So pressure is measured from observed occupancy and answered in stages, cheapest first:
 *
 *   steady      ingest and fold; nothing else is warranted
 *   maintain    deterministic only - drain what can be folded, decay, retire memory whose files
 *               are gone, apply retention
 *   consolidate spend a model: extract from the backlog, resolve contradictions
 *   reduce      whole-memory reconciliation; the agent is about to compact regardless
 *
 * A hard compaction by the agent is then the last line of defence rather than the normal
 * mechanism, and when it happens we record it: `hard_compactions` is the count of times this
 * ladder failed to prevent one, which is the only honest way to score it.
 */

export const LIFECYCLE_STAGES = ['steady', 'maintain', 'consolidate', 'reduce'] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export function stageRank(s: LifecycleStage): number {
  return LIFECYCLE_STAGES.indexOf(s);
}

/** What a stage authorises. Every action below `extract` is free and needs no provider. */
export const LIFECYCLE_ACTIONS = [
  'fold',
  'decay',
  /** Stat the files memory refers to; a stat is free, so this is a free rung. */
  'verify_refs',
  'prune',
  'extract',
  'resolve_conflicts',
  'reconcile',
  /** Lessons from failure -> success episodes. Not in any stage below: `learn.in_lifecycle` opts in. */
  'learn',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const STAGE_ACTIONS: Record<LifecycleStage, readonly LifecycleAction[]> = {
  steady: [],
  maintain: ['fold', 'decay', 'verify_refs'],
  consolidate: ['fold', 'decay', 'verify_refs', 'prune', 'extract', 'resolve_conflicts'],
  reduce: ['fold', 'decay', 'verify_refs', 'prune', 'extract', 'resolve_conflicts', 'reconcile'],
};

export function actionsFor(stage: LifecycleStage): readonly LifecycleAction[] {
  return STAGE_ACTIONS[stage];
}

export function needsProvider(action: LifecycleAction): boolean {
  return action === 'extract' || action === 'resolve_conflicts' || action === 'reconcile' || action === 'learn';
}

/**
 * Where the context window figure came from. Same discipline as `importance_source`: an
 * inferred number must never be indistinguishable from a known one, because the whole ladder
 * is calibrated against it.
 */
export type WindowSource = 'model' | 'config' | 'observed' | 'default';

/** Used only when the config says nothing and the model is unrecognised. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Windows worth asserting when observation has to pick one. Anything larger than the biggest
 * of these is taken at face value rather than rounded to a number nobody published.
 */
const CANDIDATE_WINDOWS = [200_000, 1_000_000] as const;

/**
 * Only patterns worth asserting. A model we do not recognise falls back to the configured
 * window rather than to a guess that would silently miscalibrate every threshold.
 *
 * Even these are only a starting point: a model id says nothing about the window the harness
 * actually granted. A real session reported `claude-opus-5` while occupying 512,598 tokens,
 * which disproves the 200k this function would otherwise assert, so observation overrides it.
 */
function windowForModel(model: string | null): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  // An explicit long-context variant is declared in the model id itself.
  if (m.includes('[1m]') || m.includes('-1m')) return 1_000_000;
  if (m.startsWith('claude')) return 200_000;
  return null;
}

export interface PressureInput {
  /** Most recent observed single-turn occupancy: fresh input plus cache reads. */
  occupiedTokens: number;
  /**
   * Largest occupancy ever observed for this scope. A turn that fitted is proof the window is
   * at least that large, which is the only hard evidence available about it.
   */
  observedPeakTokens: number;
  /** Model the agent reported on that turn, if any. */
  model: string | null;
  /** Unprocessed events, and their estimated token mass. */
  pendingEvents: number;
  pendingTokens: number;
  /** True once a `COMPACTION_REQUESTED` event has been seen for this session. */
  compactionRequested: boolean;
  /** Patch-log version. Zero means nothing has been derived yet. */
  stateVersion: number;
  /** Tokens the bootstrap context currently costs. Zero means nothing to recover with. */
  bootstrapTokens: number;
}

export interface PressureAssessment {
  stage: LifecycleStage;
  /** 0..1 of the window, or null when no turn has been observed yet. */
  ratio: number | null;
  occupied_tokens: number;
  window_tokens: number;
  window_source: WindowSource;
  actions: readonly LifecycleAction[];
  reasons: string[];
  /**
   * K5, asked before the fact: if the agent compacted right now, is there enough derived
   * state to carry on from? A high ratio with a large unprocessed backlog is the failure
   * case this exists to make visible.
   */
  recovery_ready: boolean;
  recovery_blockers: string[];
}

export function assessPressure(config: Config, input: PressureInput): PressureAssessment {
  const lc = config.lifecycle;

  const explicit = lc.context_window_tokens;
  let window = explicit ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  let windowSource: WindowSource = explicit != null ? 'config' : 'default';
  const fromModel = windowForModel(input.model);
  // A model-declared window beats the config default, but never an explicit setting: the
  // user may be running behind something that caps the window lower than the model allows.
  if (fromModel != null && windowSource !== 'config') {
    window = fromModel;
    windowSource = 'model';
  }

  // A turn that fitted proves the window is at least that big, so an observation always
  // beats an inference. Without this, a session at 512k against an inferred 200k window reads
  // as 256% occupancy and pins the ladder at its most expensive rung for the whole session.
  if (windowSource !== 'config' && input.observedPeakTokens > window) {
    window = CANDIDATE_WINDOWS.find((w) => w >= input.observedPeakTokens) ?? input.observedPeakTokens;
    windowSource = 'observed';
  }

  const ratio = input.occupiedTokens > 0 ? input.occupiedTokens / window : null;
  const reasons: string[] = [];
  let stage: LifecycleStage = 'steady';

  const escalate = (to: LifecycleStage, why: string): void => {
    if (stageRank(to) > stageRank(stage)) stage = to;
    reasons.push(why);
  };

  if (ratio != null) {
    if (ratio >= lc.pressure_critical) escalate('reduce', `occupancy>=${pct(lc.pressure_critical)}`);
    else if (ratio >= lc.pressure_high) escalate('consolidate', `occupancy>=${pct(lc.pressure_high)}`);
    else if (ratio >= lc.pressure_warn) escalate('maintain', `occupancy>=${pct(lc.pressure_warn)}`);
  }

  // The agent asking to compact means the ladder already lost; the only useful response is
  // to get everything derivable out of the backlog before the window is rewritten.
  if (input.compactionRequested) escalate('reduce', 'compaction_requested');

  // A backlog is pressure of its own kind: it is context we have stored but cannot yet serve.
  if (input.pendingTokens >= lc.backlog_token_threshold) {
    escalate('consolidate', `backlog_tokens>=${lc.backlog_token_threshold}`);
  } else if (input.pendingEvents >= lc.backlog_event_threshold) {
    escalate('maintain', `backlog_events>=${lc.backlog_event_threshold}`);
  }

  if (reasons.length === 0) reasons.push('below_thresholds');

  const blockers: string[] = [];
  if (input.stateVersion === 0) blockers.push('no derived state yet');
  if (input.bootstrapTokens === 0) blockers.push('bootstrap context is empty');
  if (input.pendingTokens >= lc.backlog_token_threshold) {
    blockers.push(`${input.pendingEvents} events unprocessed (${input.pendingTokens} tokens)`);
  }

  return {
    stage,
    ratio,
    occupied_tokens: input.occupiedTokens,
    window_tokens: window,
    window_source: windowSource,
    actions: actionsFor(stage),
    reasons,
    recovery_ready: blockers.length === 0,
    recovery_blockers: blockers,
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
