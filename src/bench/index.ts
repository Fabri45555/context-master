import { estimateTokens } from '../core/events.js';
import type { ContextManager } from '../daemon/manager.js';
import { collectMetrics } from '../metrics/index.js';

/**
 * PRD 53 - the experimental phase, as a command.
 *
 * The economic hypothesis has to be validated before the infrastructure is worth building,
 * so the comparison ships with the MVP rather than after it. Everything here is measured
 * from what was actually ingested; nothing is modelled or assumed.
 */

export interface BaselineTurn {
  /** Cumulative prompt tokens an unmanaged agent would carry at this turn. */
  cumulative: number;
  /** Prompt tokens the same turn would carry with a managed context. */
  managed: number;
}

export interface BenchResult {
  session_id: string | null;
  turns: number;
  /** Sum over turns of prompt tokens, unmanaged: history grows every turn. */
  baseline_prompt_tokens: number;
  /** Sum over turns of prompt tokens, managed: bootstrap + retrieval, roughly flat. */
  managed_prompt_tokens: number;
  /** Tokens the workers themselves consumed. */
  worker_tokens: number;
  worker_cost_usd: number;
  /** K1: effective reduction, i.e. the token ratio discounted by coverage. */
  final_context_reduction: number;
  /** K3: worker tokens as a share of the managed total. */
  overhead_ratio: number;
  /** Net token saving after paying for the workers. Negative means not worth it. */
  net_token_saving: number;
  observed_agent_tokens: number;
  series: BaselineTurn[];
  notes: string[];
}

/**
 * Replay what was ingested and compare two regimes turn by turn.
 *
 * Unmanaged: each turn re-sends every prior event. Managed: each turn sends the bootstrap
 * context plus a retrieval slice, which is bounded by the context budget.
 */
export function benchmark(manager: ContextManager, sessionId: string | null): BenchResult {
  const store = manager.store;
  const notes: string[] = [];

  const rows = store.db
    .prepare(
      sessionId
        ? `SELECT type, payload, LENGTH(payload) AS bytes, action FROM events WHERE session_id = ? ORDER BY ts ASC, ordinal ASC`
        : `SELECT type, payload, LENGTH(payload) AS bytes, action FROM events ORDER BY ts ASC, ordinal ASC`,
    )
    .all(...(sessionId ? [sessionId] : [])) as Array<{
    type: string;
    payload: string;
    bytes: number;
    action: string;
  }>;

  if (rows.length === 0) {
    notes.push('no events ingested yet; run a session first');
  }

  const managedPerTurn = manager.bootstrapContext().tokens + manager.config.context_budget.reserve_for_retrieval / 2;

  const series: BaselineTurn[] = [];
  let cumulative = 0;
  let baselineTotal = 0;
  let managedTotal = 0;
  let turns = 0;

  for (const r of rows) {
    // Only what a discard would have removed is counted as avoided: an unmanaged agent
    // carries everything, including the noise.
    cumulative += estimateTokens('x'.repeat(r.bytes));
    // A "turn" is an assistant message: that is when a prompt is actually re-sent.
    if (r.type !== 'ASSISTANT_MESSAGE') continue;
    turns += 1;
    baselineTotal += cumulative;
    managedTotal += managedPerTurn;
    series.push({ cumulative, managed: managedPerTurn });
  }

  const m = collectMetrics(store, manager.config, sessionId);
  const workerTokens = m.workers.input_tokens + m.workers.output_tokens;
  const observed = m.agent.input_tokens + m.agent.output_tokens;

  if (turns === 0 && rows.length > 0) {
    notes.push('no assistant turns observed; per-turn comparison unavailable');
  }
  if (observed === 0) {
    notes.push('no agent usage observed; baseline uses estimated payload sizes only');
  }

  return {
    session_id: sessionId,
    turns,
    baseline_prompt_tokens: baselineTotal,
    managed_prompt_tokens: managedTotal,
    worker_tokens: workerTokens,
    worker_cost_usd: m.workers.cost_usd,
    final_context_reduction: m.context.effective_reduction,
    overhead_ratio: managedTotal + workerTokens > 0 ? workerTokens / (managedTotal + workerTokens) : 0,
    net_token_saving: baselineTotal - managedTotal - workerTokens,
    observed_agent_tokens: observed,
    series,
    notes,
  };
}

export function formatBench(b: BenchResult): string {
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    'Baseline comparison',
    '',
    `Assistant turns:            ${n(b.turns)}`,
    `Baseline prompt tokens:     ${n(b.baseline_prompt_tokens)}   (full history every turn)`,
    `Managed prompt tokens:      ${n(b.managed_prompt_tokens)}   (bootstrap + retrieval)`,
    `Worker tokens:              ${n(b.worker_tokens)}`,
    `Worker cost:                $${b.worker_cost_usd.toFixed(4)}`,
    '',
    `Net token saving:           ${n(b.net_token_saving)}`,
    `Context reduction (K1):     ${pct(b.final_context_reduction)}   [target >70%]`,
    `Manager overhead (K3):      ${pct(b.overhead_ratio)}   [target <20%]`,
  ];
  if (b.observed_agent_tokens > 0) {
    lines.push('', `Observed agent tokens:      ${n(b.observed_agent_tokens)}`);
  }
  if (b.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const note of b.notes) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}
