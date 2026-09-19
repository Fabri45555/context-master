import type { Config } from '../core/config.js';
import type { ContextStore } from '../store/store.js';
import type { Metrics } from './index.js';

/**
 * What contextd has bought this project, stated so that each number can be checked.
 *
 * A benefits page is the easiest place in a tool like this to start flattering itself, so every
 * figure here is either measured or labelled with the baseline it is compared against, and the
 * page carries its own caveats: a claim with no counterweight on the same screen is marketing.
 */
export interface Benefits {
  /** Resuming after a compaction or in a new session, measured against what the agent held. */
  resume: {
    bootstrap_tokens: number;
    /** Largest context the agent actually reported. The measured "without" side. */
    agent_peak_tokens: number;
    /** Tokens of stored history the memory was derived from. */
    history_tokens: number;
    /** agent_peak / bootstrap; null until both exist. */
    smaller_by: number | null;
  };
  /** How often memory reached the agent, and what it cost to deliver. */
  delivery: {
    total: number;
    bootstrap: number;
    query: number;
    empty: number;
    tokens_served: number;
    /** Tokens not re-read: per delivery, the agent's peak minus what was served. Upper bound. */
    tokens_avoided: number;
    /** tokens_avoided priced at the configured agent rate; null when no rate is configured. */
    usd_avoided: number | null;
  };
  /** Deterministic first (invariant 1): how much work never reached a model at all. */
  triage: {
    events: number;
    handled_by_code: number;
    derived_by_model: number;
    pending: number;
    share_by_code: number;
    worker_runs: number;
    worker_tokens: number;
    worker_cost_usd: number;
    worker_priced: boolean;
  };
  /** K2: what code, not a prompt, refused to let happen. */
  protection: {
    user_critical_items: number;
    attributions_refused: number;
    invented_operations_dropped: number;
    rejected_patches: number;
  };
  continuity: {
    recovery_ready: boolean;
    recovery_blockers: string[];
    hard_compactions: number;
    sessions: number;
    hook_p95_ms: number | null;
    hook_budget_ms: number;
  };
  quality: {
    active_items: number;
    used_items: number;
    used_share: number;
    retired_items: number;
  };
  caveats: string[];
}

export function collectBenefits(store: ContextStore, config: Config, m: Metrics): Benefits {
  const db = store.db;
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;

  const delivery = one<{ n: number; b: number; e: number; t: number }>(
    `SELECT COUNT(*) n,
            COALESCE(SUM(CASE WHEN query = '(bootstrap)' THEN 1 ELSE 0 END), 0) b,
            COALESCE(SUM(CASE WHEN item_ids = '[]' THEN 1 ELSE 0 END), 0) e,
            COALESCE(SUM(tokens), 0) t
     FROM retrieval_log`,
  );
  const perDelivery = db
    // An empty retrieval served nothing, so it cannot have saved anything either.
    .prepare(`SELECT tokens FROM retrieval_log WHERE item_ids <> '[]'`)
    .all() as Array<{ tokens: number }>;

  const peak = m.agent.peak_input_tokens;
  // The baseline is the context the agent was really carrying, not the raw history: nobody
  // replays 200k tokens of transcript to resume, but a session that loses its memory does pay
  // to rebuild what it held. It is an upper bound and the page says so.
  const tokensAvoided = peak > 0 ? perDelivery.reduce((s, r) => s + Math.max(0, peak - r.tokens), 0) : 0;
  const rate = config.accounting.agent_input_cost_per_mtok;

  const notes = one<{ prov: number; inert: number }>(
    `SELECT COALESCE(SUM(CASE WHEN note LIKE '%downgraded to agent%' THEN 1 ELSE 0 END), 0) prov,
            COALESCE(SUM(CASE WHEN note LIKE '%dropped inert%' THEN 1 ELSE 0 END), 0) inert
     FROM patches`,
  );
  const rejected = one<{ n: number }>(`SELECT COUNT(*) n FROM worker_runs WHERE status = 'invalid'`).n;
  const items = one<{ uc: number; used: number; retired: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'active' AND source = 'user' AND importance = 'critical' THEN 1 ELSE 0 END), 0) uc,
            COALESCE(SUM(CASE WHEN status = 'active' AND retrieved_count > 0 THEN 1 ELSE 0 END), 0) used,
            COALESCE(SUM(CASE WHEN status <> 'active' THEN 1 ELSE 0 END), 0) retired
     FROM memory_items`,
  );
  const sessions = one<{ n: number }>(`SELECT COUNT(*) n FROM sessions`).n;

  const handledByCode = m.events.discarded + m.events.inert;
  const derived = Math.max(0, m.events.stored - m.events.pending - m.events.inert);
  const workerPriced = Object.values(config.models.tiers).some(
    (t) => t && (t.input_cost_per_mtok > 0 || t.output_cost_per_mtok > 0),
  );

  const b: Benefits = {
    resume: {
      bootstrap_tokens: m.context.active_tokens,
      agent_peak_tokens: peak,
      history_tokens: m.context.raw_equivalent_tokens,
      smaller_by: peak > 0 && m.context.active_tokens > 0 ? peak / m.context.active_tokens : null,
    },
    delivery: {
      total: delivery.n,
      bootstrap: delivery.b,
      query: delivery.n - delivery.b,
      empty: delivery.e,
      tokens_served: delivery.t,
      tokens_avoided: tokensAvoided,
      usd_avoided: rate != null ? (tokensAvoided / 1_000_000) * rate : null,
    },
    triage: {
      events: m.events.total,
      handled_by_code: handledByCode,
      derived_by_model: derived,
      pending: m.events.pending,
      share_by_code: m.events.total > 0 ? handledByCode / m.events.total : 0,
      worker_runs: m.workers.runs,
      worker_tokens: m.workers.input_tokens + m.workers.output_tokens,
      worker_cost_usd: m.workers.cost_usd,
      worker_priced: workerPriced,
    },
    protection: {
      user_critical_items: items.uc,
      attributions_refused: notes.prov,
      invented_operations_dropped: notes.inert,
      rejected_patches: rejected,
    },
    continuity: {
      recovery_ready: m.lifecycle.pressure.recovery_ready,
      recovery_blockers: m.lifecycle.pressure.recovery_blockers,
      hard_compactions: m.lifecycle.hard_compactions,
      sessions,
      hook_p95_ms: m.latency.hook?.p95 ?? null,
      hook_budget_ms: m.latency.budget_ms,
    },
    quality: {
      active_items: m.memory.active,
      used_items: items.used,
      used_share: m.memory.active > 0 ? items.used / m.memory.active : 0,
      retired_items: items.retired,
    },
    caveats: [],
  };
  b.caveats = caveatsFor(b, m);
  return b;
}

/** The counterweight. Each line names a way the figures above could be read too generously. */
function caveatsFor(b: Benefits, m: Metrics): string[] {
  const out: string[] = [];
  if (b.delivery.total === 0) {
    out.push('Memory has never been delivered to an agent, so every saving on this page is potential, not realised.');
  }
  if (b.resume.agent_peak_tokens > 0) {
    out.push(
      'Tokens avoided compare each delivery with the largest context the agent reported. That is an upper bound: a session that lost its memory would not necessarily rebuild all of it.',
    );
  }
  if (b.delivery.usd_avoided == null) {
    out.push('No agent price is configured (accounting.agent_input_cost_per_mtok), so savings are shown in tokens only.');
  } else if (m.agent.cached_tokens > m.agent.input_tokens) {
    // A live session's context is mostly prompt-cache reads, billed at a fraction of the input
    // rate. Rebuilding it in a fresh session is paid in full, which is what the figure prices.
    out.push(
      'The dollar figure prices avoided tokens at the full input rate. That is what rebuilding context in a fresh session costs; context kept warm in the prompt cache within one session costs a fraction of it.',
    );
  }
  if (!b.triage.worker_priced && b.triage.worker_runs > 0) {
    out.push('Worker models have no price configured, so worker cost reads $0 and K3 overhead is understated.');
  }
  if (b.triage.pending > 0) {
    out.push(`${b.triage.pending} events are still waiting for a worker; memory does not reflect them yet.`);
  }
  if (b.quality.active_items > 0 && b.quality.used_share < 0.5) {
    out.push(
      `${Math.round((1 - b.quality.used_share) * 100)}% of active memory has never been served. A true fact nobody needs is still a cost.`,
    );
  }
  if (b.continuity.hard_compactions > 0) {
    out.push(
      `The agent compacted ${b.continuity.hard_compactions} time(s) anyway. The ladder is meant to make that unnecessary.`,
    );
  }
  if (m.context.coverage < 0.7 && m.events.pending > 0) {
    out.push('Coverage is below 70%: the reduction figure is mostly backlog, not compression.');
  }
  return out;
}
