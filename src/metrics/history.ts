import type { Config } from '../core/config.js';
import { MIRROR_LABEL } from '../ops/mirror.js';
import { INERT_REASON, type ContextStore } from '../store/store.js';
import { avoidedFor, bootstrapServes, rebuildBaseline, resumesFrom } from './benefits.js';

/**
 * Savings over time, rebuilt from what is already logged rather than sampled.
 *
 * Every series here is a GROUP BY over a table that is written anyway: `retrieval_log` for
 * resumes and queries, `events` for what was observed and what code settled, `worker_runs` for
 * model spend. Nothing new is stored, so history exists from the first event, `status` cannot move
 * it, and a measurement never becomes a row of its own (invariant 28). The running total of
 * tokens avoided ends exactly at the Benefits figure because both are computed by the same
 * functions from the same rows.
 *
 * Days are UTC calendar days: the server does not know the viewer's timezone, and a bucket
 * boundary that moved with the browser would make two readers disagree about the same log.
 */
export interface ResumePoint {
  at: string;
  session_id: string | null;
  /** Bootstrap tokens served at this resume, as logged. */
  served_tokens: number;
  avoided_tokens: number;
  cumulative_avoided: number;
}

export interface HistoryBucket {
  /** First day of the bucket, YYYY-MM-DD (UTC). A week starts on Monday. */
  start: string;
  resumes: number;
  queries: number;
  /** Events stored that day. Events discarded at ingest are counted but carry no date. */
  events: number;
  /** Stored events closed without deriving state (the inert share of Benefits' "settled by code"). */
  settled_by_code: number;
  worker_runs: number;
  worker_tokens: number;
  worker_cost_usd: number;
  tokens_avoided: number;
}

export interface SavingsHistory {
  rebuild_tokens: number;
  rebuild_source: 'config' | 'documents';
  resumes: ResumePoint[];
  tokens_avoided: number;
  daily: HistoryBucket[];
  weekly: HistoryBucket[];
  /** Discarded events are a counter, not rows: in the totals, in no bucket. */
  discarded_undated: number;
  /** Earliest timestamp in any series, so a chart can start before the first resume. */
  first_at: string | null;
  worker_priced: boolean;
}

export function collectHistory(store: ContextStore, config: Config, projectRoot: string | null): SavingsHistory {
  const db = store.db;
  const rebuild = rebuildBaseline(config, projectRoot);

  let running = 0;
  const resumes: ResumePoint[] = resumesFrom(bootstrapServes(store)).map((r) => {
    const avoided = avoidedFor(r, rebuild.tokens);
    running += avoided;
    return {
      at: r.at,
      session_id: r.session_id,
      served_tokens: r.tokens,
      avoided_tokens: avoided,
      cumulative_avoided: running,
    };
  });

  const days = new Map<string, HistoryBucket>();
  const bucket = (day: string): HistoryBucket => {
    let b = days.get(day);
    if (!b) {
      b = {
        start: day,
        resumes: 0,
        queries: 0,
        events: 0,
        settled_by_code: 0,
        worker_runs: 0,
        worker_tokens: 0,
        worker_cost_usd: 0,
        tokens_avoided: 0,
      };
      days.set(day, b);
    }
    return b;
  };

  for (const r of resumes) {
    const b = bucket(r.at.slice(0, 10));
    b.resumes += 1;
    b.tokens_avoided += r.avoided_tokens;
  }
  const queries = db
    .prepare(
      `SELECT substr(at, 1, 10) d, COUNT(*) n FROM retrieval_log
       WHERE query NOT IN ('(bootstrap)', ?) GROUP BY d`,
    )
    .all(MIRROR_LABEL) as Array<{ d: string; n: number }>;
  for (const q of queries) bucket(q.d).queries += q.n;

  const events = db
    .prepare(
      `SELECT substr(ts, 1, 10) d, COUNT(*) n,
              COALESCE(SUM(CASE WHEN reasons LIKE '%${INERT_REASON}%' THEN 1 ELSE 0 END), 0) inert
       FROM events GROUP BY d`,
    )
    .all() as Array<{ d: string; n: number; inert: number }>;
  for (const e of events) {
    const b = bucket(e.d);
    b.events += e.n;
    b.settled_by_code += e.inert;
  }

  const workers = db
    .prepare(
      `SELECT substr(started_at, 1, 10) d, COUNT(*) n,
              COALESCE(SUM(input_tokens + output_tokens), 0) t, COALESCE(SUM(cost_usd), 0) c
       FROM worker_runs GROUP BY d`,
    )
    .all() as Array<{ d: string; n: number; t: number; c: number }>;
  for (const w of workers) {
    const b = bucket(w.d);
    b.worker_runs += w.n;
    b.worker_tokens += w.t;
    b.worker_cost_usd += w.c;
  }

  const daily = [...days.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
  const firsts = (
    db
      .prepare(
        `SELECT MIN(ts) t FROM events UNION ALL SELECT MIN(at) FROM retrieval_log
         UNION ALL SELECT MIN(started_at) FROM worker_runs`,
      )
      .all() as Array<{ t: string | null }>
  )
    .map((r) => r.t)
    .filter((t): t is string => typeof t === 'string');

  return {
    rebuild_tokens: rebuild.tokens,
    rebuild_source: rebuild.source,
    resumes,
    tokens_avoided: running,
    daily,
    weekly: toWeeks(daily),
    discarded_undated: store.countDiscarded(null),
    first_at: firsts.length ? firsts.sort()[0]! : null,
    worker_priced: Object.values(config.models.tiers).some(
      (t) => t && (t.input_cost_per_mtok > 0 || t.output_cost_per_mtok > 0),
    ),
  };
}

/** The Monday (UTC) of the week holding `day`. */
export function weekOf(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function toWeeks(daily: HistoryBucket[]): HistoryBucket[] {
  const weeks = new Map<string, HistoryBucket>();
  for (const day of daily) {
    const key = weekOf(day.start);
    const w = weeks.get(key);
    if (!w) {
      weeks.set(key, { ...day, start: key });
      continue;
    }
    w.resumes += day.resumes;
    w.queries += day.queries;
    w.events += day.events;
    w.settled_by_code += day.settled_by_code;
    w.worker_runs += day.worker_runs;
    w.worker_tokens += day.worker_tokens;
    w.worker_cost_usd += day.worker_cost_usd;
    w.tokens_avoided += day.tokens_avoided;
  }
  return [...weeks.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
}
