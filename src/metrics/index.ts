import { estimateTokens } from '../core/events.js';
import type { Config } from '../core/config.js';
import { assessPressure, type PressureAssessment } from '../core/lifecycle.js';
import { ContextBuilder } from '../retrieval/context-builder.js';
import { INERT_REASON, type ContextStore } from '../store/store.js';

/**
 * PRD 29 / 30 / 38 - the metrics that decide whether the project is worth having.
 *
 * The headline number is not what the manager costs, it is total cost versus baseline
 * (PRD 28), so this module measures both sides: what the agent actually spent, and what it
 * would have spent carrying the whole history.
 */

export interface Metrics {
  session_id: string | null;
  events: {
    total: number;
    stored: number;
    discarded: number;
    pending: number;
    /** Stored, resolved, and derived nothing: history rather than state. */
    inert: number;
    by_importance: Record<string, number>;
  };
  memory: {
    items: number;
    active: number;
    by_category: Record<string, number>;
    state_version: number;
    patches: number;
  };
  context: {
    /** Tokens the bootstrap context costs right now. */
    active_tokens: number;
    /** Tokens the same information would cost as raw history. */
    raw_equivalent_tokens: number;
    /**
     * K1, part one: the token ratio. Cheap to measure and says nothing about meaning.
     */
    token_reduction: number;
    /**
     * K1, part two: the share of stored events that something has actually derived state
     * from. A high token_reduction with low coverage means a backlog, not compression.
     */
    coverage: number;
    /**
     * The honest headline: token_reduction discounted by coverage. Quoting
     * token_reduction alone is how a 100% figure ends up on an untouched backlog.
     */
    effective_reduction: number;
    budget: number;
  };
  workers: {
    runs: number;
    ok: number;
    failed: number;
    invalid: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  agent: {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    /** Largest single-turn context occupancy: fresh input plus cache reads. */
    peak_input_tokens: number;
  };
  retrieval: { count: number; avg_tokens: number; empty: number };
  /** PRD 29, extended: is the memory we keep actually worth keeping? */
  precision: {
    items: number;
    never_retrieved_ratio: number;
    short_lived_ratio: number;
    low_confidence_ratio: number;
    unverified_ratio: number;
  };
  /**
   * PRD 24 - where the session sits on the compaction ladder, and how often the agent
   * compacted anyway. `hard_compactions` is the score of this whole mechanism.
   */
  lifecycle: {
    pressure: PressureAssessment;
    hard_compactions: number;
  };
  /** PRD 31 - the latency budget and what was measured against it. */
  latency: {
    hook: { count: number; p50: number; p95: number; max: number } | null;
    ingest: { count: number; p50: number; p95: number; max: number } | null;
    budget_ms: number;
    within_budget: boolean | null;
  };
  /** K3 - worker cost as a share of total measured spend. */
  overhead_ratio: number | null;
}

export function collectMetrics(
  store: ContextStore,
  config: Config,
  sessionId: string | null,
): Metrics {
  const db = store.db;
  const scope = sessionId ? ` WHERE session_id = ?` : '';
  const args = sessionId ? [sessionId] : [];

  const evTotals = db
    .prepare(
      `SELECT COUNT(*) n,
              COALESCE(SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END), 0) p,
              COALESCE(SUM(CASE WHEN reasons LIKE '%${INERT_REASON}%' THEN 1 ELSE 0 END), 0) inert,
              COALESCE(SUM(tokens), 0) t
       FROM events${scope}`,
    )
    .get(...args) as { n: number; p: number; inert: number; t: number };
  // Discarded events are never rows, so the tally comes from the counter, not a COUNT.
  const discarded = store.countDiscarded(sessionId);

  const byImportance = Object.fromEntries(
    (
      db
        .prepare(`SELECT importance, COUNT(*) n FROM events${scope} GROUP BY importance`)
        .all(...args) as Array<{ importance: string; n: number }>
    ).map((r) => [r.importance, r.n]),
  );

  const byCategory = Object.fromEntries(
    (
      db
        .prepare(
          `SELECT category, COUNT(*) n FROM memory_items WHERE status = 'active' GROUP BY category`,
        )
        .all() as Array<{ category: string; n: number }>
    ).map((r) => [r.category, r.n]),
  );

  const memTotals = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) a
       FROM memory_items`,
    )
    .get() as { n: number; a: number };

  const patchCount = (db.prepare(`SELECT COUNT(*) n FROM patches`).get() as { n: number }).n;

  const workers = db
    .prepare(
      `SELECT COUNT(*) n,
              COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) ok,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) err,
              COALESCE(SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END), 0) inv,
              COALESCE(SUM(input_tokens), 0) i, COALESCE(SUM(output_tokens), 0) o,
              COALESCE(SUM(cost_usd), 0) c
       FROM worker_runs${scope}`,
    )
    .get(...args) as {
    n: number;
    ok: number;
    err: number;
    inv: number;
    i: number;
    o: number;
    c: number;
  };

  const agent = store.agentUsageTotals(sessionId);
  const built = new ContextBuilder(store, config).bootstrap();

  // The baseline counts only events already folded into memory. Including the pending
  // queue would credit the manager for compressing history it has not yet read, which is
  // how a reduction figure ends up reading 100% on an untouched backlog.
  const processedScope = sessionId
    ? ` WHERE processed_at IS NOT NULL AND session_id = ?`
    : ` WHERE processed_at IS NOT NULL`;
  const rawRow = db
    .prepare(`SELECT COALESCE(SUM(LENGTH(payload)), 0) b FROM events${processedScope}`)
    .get(...args) as { b: number };
  const rawEquivalent = estimateTokens('x'.repeat(rawRow.b));

  const latestUsage = store.latestAgentUsage(sessionId);
  const pendingSummary = store.pendingSummary(sessionId);
  const pressure = assessPressure(config, {
    occupiedTokens: latestUsage?.occupied ?? 0,
    observedPeakTokens: agent.peakInput,
    model: latestUsage?.model ?? null,
    pendingEvents: pendingSummary.count,
    pendingTokens: pendingSummary.tokens,
    compactionRequested: pendingSummary.compactionRequested,
    stateVersion: store.stateVersion(),
    bootstrapTokens: built.tokens,
  });

  const retrieval = store.retrievalStats();
  const precision = store.precisionStats();
  const hookLatency = store.latencyStats('hook');
  const ingestLatency = store.latencyStats('ingest');

  const derived = Math.max(0, evTotals.n - evTotals.p - evTotals.inert);
  // Coverage asks: of the events that were ever going to produce state, how many have?
  //
  // Dividing by *every* stored event was the same conflation this codebase keeps tripping over.
  // An inert event is one we deliberately closed without deriving anything - tool traffic, a
  // rejected error - and it was never a candidate. Counting it against us made a session that
  // discarded correctly read 18.9% while nothing at all was outstanding. A pending event is a
  // candidate we have not looked at yet, and that is the thing worth penalising.
  //
  // The `derived === 0` case stays at zero on purpose: a model returning empty patches closes its
  // batches as inert, so without it a broken worker would drive coverage to 1.0 with an empty
  // memory - the exact flattery this metric exists to prevent.
  const candidates = derived + evTotals.p;
  const coverage = derived > 0 && candidates > 0 ? derived / candidates : 0;
  const tokenReduction = rawEquivalent > 0 ? 1 - built.tokens / rawEquivalent : 0;
  const share = (part: number) => (precision.total > 0 ? part / precision.total : 0);

  // K3 is a share of measured spend. Without agent usage there is no denominator, so report
  // null rather than a number that looks meaningful and is not.
  const agentCostProxy = agent.input + agent.output + agent.cached;
  const overhead =
    agentCostProxy > 0 ? workers.i + workers.o > 0 ? (workers.i + workers.o) / (agentCostProxy + workers.i + workers.o) : 0 : null;

  return {
    session_id: sessionId,
    events: {
      total: evTotals.n + discarded,
      stored: evTotals.n,
      discarded,
      pending: evTotals.p,
      inert: evTotals.inert,
      by_importance: byImportance,
    },
    memory: {
      items: memTotals.n,
      active: memTotals.a,
      by_category: byCategory,
      state_version: store.stateVersion(),
      patches: patchCount,
    },
    context: {
      active_tokens: built.tokens,
      raw_equivalent_tokens: rawEquivalent,
      token_reduction: tokenReduction,
      coverage,
      effective_reduction: tokenReduction * coverage,
      budget: config.context_budget.total_tokens,
    },
    workers: {
      runs: workers.n,
      ok: workers.ok,
      failed: workers.err,
      invalid: workers.inv,
      input_tokens: workers.i,
      output_tokens: workers.o,
      cost_usd: workers.c,
    },
    agent: {
      turns: agent.turns,
      input_tokens: agent.input,
      output_tokens: agent.output,
      cached_tokens: agent.cached,
      peak_input_tokens: agent.peakInput,
    },
    retrieval: { count: retrieval.count, avg_tokens: retrieval.avgTokens, empty: retrieval.emptyCount },
    precision: {
      items: precision.total,
      never_retrieved_ratio: share(precision.neverRetrieved),
      short_lived_ratio: share(precision.shortLived),
      low_confidence_ratio: share(precision.lowConfidence),
      unverified_ratio: share(precision.unverified),
    },
    lifecycle: {
      pressure,
      hard_compactions: store.countHardCompactions(sessionId),
    },
    latency: {
      hook: hookLatency,
      ingest: ingestLatency,
      budget_ms: config.limits.hook_latency_ms,
      within_budget: hookLatency ? hookLatency.p95 <= config.limits.hook_latency_ms : null,
    },
    overhead_ratio: overhead,
  };
}

/** PRD 38 - the human-readable dashboard. */
export function formatMetrics(m: Metrics): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const n = (x: number) => x.toLocaleString('en-US');
  const lines: string[] = [];

  lines.push('Context Manager');
  lines.push('');
  if (m.session_id) lines.push(`Session:              ${m.session_id}`);
  lines.push(`State version:        ${m.memory.state_version} (${n(m.memory.patches)} patches)`);
  lines.push('');
  lines.push(`Events:               ${n(m.events.total)}`);
  lines.push(`  stored:             ${n(m.events.stored)}`);
  lines.push(`  discarded:          ${n(m.events.discarded)}`);
  lines.push(`  pending:            ${n(m.events.pending)}`);
  lines.push(`  inert:              ${n(m.events.inert)} (kept as history, derived nothing)`);
  lines.push('');
  lines.push(`Memory items:         ${n(m.memory.active)} active / ${n(m.memory.items)} total`);
  for (const [cat, count] of Object.entries(m.memory.by_category).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cat.padEnd(18)}${n(count)}`);
  }
  lines.push('');
  lines.push(`Active context:       ${n(m.context.active_tokens)} tokens (budget ${n(m.context.budget)})`);
  lines.push(`Raw equivalent:       ${n(m.context.raw_equivalent_tokens)} tokens`);
  lines.push(`Token reduction:      ${pct(m.context.token_reduction)}`);
  lines.push(
    `Coverage:             ${pct(m.context.coverage)}  ` +
      `(of events that could produce state; ${n(m.events.inert)} were never candidates)`,
  );
  lines.push(`Effective (K1):       ${pct(m.context.effective_reduction)}  [target >70%]`);
  if (m.events.pending > 0) {
    lines.push(
      `                      ${n(m.events.pending)} events still awaiting a worker; run "contextd compact"`,
    );
  }
  lines.push('');
  lines.push(`Workers spawned:      ${n(m.workers.runs)} (ok ${m.workers.ok}, invalid ${m.workers.invalid}, error ${m.workers.failed})`);
  lines.push(`Worker tokens:        ${n(m.workers.input_tokens)} in / ${n(m.workers.output_tokens)} out`);
  lines.push(`Worker cost:          $${m.workers.cost_usd.toFixed(4)}`);
  if (m.agent.turns > 0) {
    lines.push('');
    lines.push(`Agent turns observed: ${n(m.agent.turns)}`);
    lines.push(`Agent tokens:         ${n(m.agent.input_tokens)} in / ${n(m.agent.output_tokens)} out`);
    lines.push(`Agent peak context:   ${n(m.agent.peak_input_tokens)} tokens`);
  }
  if (m.overhead_ratio != null) {
    lines.push(`Overhead (K3):        ${pct(m.overhead_ratio)}  [target <20%]`);
  }
  lines.push('');
  lines.push(formatPressure(m.lifecycle.pressure, m.lifecycle.hard_compactions));
  if (m.precision.items > 0) {
    lines.push('');
    lines.push('Memory precision');
    lines.push(`  never retrieved:    ${pct(m.precision.never_retrieved_ratio)}`);
    lines.push(`  short lived:        ${pct(m.precision.short_lived_ratio)}`);
    lines.push(`  low confidence:     ${pct(m.precision.low_confidence_ratio)}`);
    lines.push(`  unverified:         ${pct(m.precision.unverified_ratio)}`);
  }
  if (m.latency.hook || m.latency.ingest) {
    lines.push('');
    lines.push(`Latency budget:       ${m.latency.budget_ms}ms (hook path)`);
    for (const [label, s] of [['hook', m.latency.hook], ['ingest', m.latency.ingest]] as const) {
      if (!s) continue;
      lines.push(
        `  ${label.padEnd(18)}p50 ${s.p50.toFixed(0)}ms · p95 ${s.p95.toFixed(0)}ms · max ${s.max.toFixed(0)}ms (n=${s.count})`,
      );
    }
    if (m.latency.within_budget === false) {
      lines.push('  hook p95 is OVER budget: the agent is waiting on us');
    }
  }
  if (m.retrieval.count > 0) {
    lines.push('');
    lines.push(
      `Retrievals:           ${n(m.retrieval.count)} (avg ${Math.round(m.retrieval.avg_tokens)} tokens, ${m.retrieval.empty} empty)`,
    );
  }
  return lines.join('\n');
}

/** PRD 24 - the ladder, stated so that a high occupancy with an empty memory is visible. */
export function formatPressure(p: PressureAssessment, hardCompactions: number): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const lines: string[] = [];
  lines.push('Context pressure');
  if (p.ratio == null) {
    lines.push('  occupancy:          no agent turn observed yet');
  } else {
    lines.push(
      `  occupancy:          ${(p.ratio * 100).toFixed(1)}% ` +
        `(${n(p.occupied_tokens)} / ${n(p.window_tokens)} tokens, window ${p.window_source})`,
    );
  }
  lines.push(`  stage:              ${p.stage} (${p.reasons.join(', ')})`);
  if (p.actions.length > 0) {
    lines.push(`  authorised:         ${p.actions.join(', ')}`);
  }
  lines.push(
    p.recovery_ready
      ? '  recovery (K5):      ready'
      : `  recovery (K5):      NOT ready - ${p.recovery_blockers.join('; ')}`,
  );
  lines.push(
    hardCompactions === 0
      ? '  hard compactions:   0'
      : `  hard compactions:   ${n(hardCompactions)}  (times the agent compacted anyway)`,
  );
  return lines.join('\n');
}
