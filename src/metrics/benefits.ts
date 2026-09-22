import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    /**
     * Times an agent started from memory: a new session, or the same one after a compaction.
     * Bootstrap deliveries within RESUME_WINDOW_MS of each other are one resume (the hook and
     * `memory_bootstrap` both serve it).
     */
    resumes: number;
    /** What re-orienting from the project's own documents would cost, per resume. */
    rebuild_tokens: number;
    rebuild_source: 'config' | 'documents';
    /** Per resume, rebuild_tokens minus what the bootstrap cost. */
    tokens_avoided: number;
    /** tokens_avoided priced at the configured agent rate; null when no rate is configured. */
    usd_avoided: number | null;
    /** Worker spend as recorded (0 for an unpriced tier), so the page can show the net. */
    worker_usd: number;
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

export function collectBenefits(
  store: ContextStore,
  config: Config,
  m: Metrics,
  projectRoot: string | null = null,
): Benefits {
  const db = store.db;
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;

  const delivery = one<{ n: number; b: number; e: number; t: number }>(
    `SELECT COUNT(*) n,
            COALESCE(SUM(CASE WHEN query = '(bootstrap)' THEN 1 ELSE 0 END), 0) b,
            COALESCE(SUM(CASE WHEN item_ids = '[]' THEN 1 ELSE 0 END), 0) e,
            COALESCE(SUM(tokens), 0) t
     FROM retrieval_log`,
  );
  const bootstraps = db
    .prepare(`SELECT at, session_id, tokens FROM retrieval_log WHERE query = '(bootstrap)' AND item_ids <> '[]' ORDER BY at`)
    .all() as Array<{ at: string; session_id: string | null; tokens: number }>;
  const resumes = countResumes(bootstraps);

  const peak = m.agent.peak_input_tokens;
  // The first version compared every delivery with the agent's 519k peak and printed 1.0M tokens
  // saved. Nobody re-reads a whole transcript to resume, and a query inside a session that already
  // holds its context avoids nothing. What a resume without memory really costs is re-reading the
  // project's documents - and even that does not recover what the user asked for, which the
  // documents do not contain. So: count resumes only, and price them against the documents.
  const rebuild = rebuildBaseline(config, projectRoot);
  const tokensAvoided = resumes * Math.max(0, rebuild.tokens - m.context.active_tokens);
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
      resumes,
      rebuild_tokens: rebuild.tokens,
      rebuild_source: rebuild.source,
      tokens_avoided: tokensAvoided,
      usd_avoided: rate != null ? (tokensAvoided / 1_000_000) * rate : null,
      worker_usd: m.workers.cost_usd,
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

/** Bootstrap deliveries this close together are one resume, served twice (hook and MCP). */
const RESUME_WINDOW_MS = 10 * 60_000;

export function countResumes(rows: Array<{ at: string; session_id: string | null }>): number {
  let resumes = 0;
  let last: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.at);
    // Session ids are not compared: the MCP call carried none until recently, and a compaction
    // resumes the *same* session id. Time is what separates two resumes.
    if (last == null || t - last > RESUME_WINDOW_MS) resumes += 1;
    last = t;
  }
  return resumes;
}

/**
 * What re-orienting without memory would cost: reading the project's markdown documents.
 *
 * Measured, not guessed: the root and `docs/` .md files, minus the instructions file the agent
 * loads every session regardless. `accounting.rebuild_baseline_tokens` overrides it for a project
 * whose documentation is not where its context lives.
 */
function rebuildBaseline(config: Config, root: string | null): { tokens: number; source: 'config' | 'documents' } {
  const configured = config.accounting.rebuild_baseline_tokens;
  if (configured != null) return { tokens: configured, source: 'config' };
  if (!root) return { tokens: 0, source: 'documents' };
  const ALWAYS_LOADED = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);
  let bytes = 0;
  for (const dir of [root, join(root, 'docs')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || ALWAYS_LOADED.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isFile()) bytes += statSync(path).size;
    }
  }
  return { tokens: Math.ceil(bytes / 4), source: 'documents' };
}

/** The counterweight. Each line names a way the figures above could be read too generously. */
function caveatsFor(b: Benefits, m: Metrics): string[] {
  const out: string[] = [];
  if (b.delivery.total === 0) {
    out.push('Memory has never been delivered to an agent, so every saving on this page is potential, not realised.');
  }
  if (b.delivery.resumes > 0) {
    out.push(
      `Savings count only resumes (${b.delivery.resumes}), each against re-reading the project's documents (${b.delivery.rebuild_tokens.toLocaleString('en-US')} tokens, ${b.delivery.rebuild_source === 'config' ? 'as configured' : 'measured from the .md files'}). What the user asked for is in none of those documents, so the real alternative to memory is not cheaper - it is incomplete.`,
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
