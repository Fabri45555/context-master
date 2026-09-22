import { priceUsage, type TokenUsage } from '../core/budget.js';
import type { ModelSpec } from '../core/config.js';
import { providerIsLocal, type Provider } from '../workers/providers/types.js';
import { GOLDEN_ITEMS, type GoldenItem, type RetrievalEval } from './retrieval-eval.js';

/**
 * `contextd bench --retrieval --judge`: does the served context actually answer the question?
 *
 * recall@k and MRR say whether the *expected* ids came back. They cannot say whether what came
 * back is enough to answer - a paraphrase item can be ranked first and still not say the thing, or
 * an unexpected neighbour can answer it better. So a model reads each query's top-k context, as
 * keyword and as hybrid retrieval served it, and says yes / partial / no with a one-line reason.
 * Borrowed from headroom's LLM-as-judge memory evals.
 *
 * Opt-in only: it spends a model call per distinct (query, context) pair. It respects `local_only`
 * (invariant 21), prints what it cost, and stores nothing - not in memory, not in the worker log
 * (invariant 28): a judge's verdict on a fixture is a measurement.
 */

export const JUDGE_VERDICTS = ['yes', 'partial', 'no'] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const JUDGE_SYSTEM = `You grade a retrieval system for a software project's memory.

You are given a question and the context the system retrieved for it: a short list of memory
items. Decide whether the context, on its own, answers the question.

- "yes": an item states the answer directly.
- "partial": the context is relevant and points at the answer, but a reader would still need
  to look something up.
- "no": nothing in the context answers the question.

Judge only the context given. Do not use your own knowledge of the project or of software in
general to fill a gap: if the answer is not in the items, it is not there.

Reply with a single JSON object and nothing else:
{"verdict": "yes"|"partial"|"no", "reason": "<one sentence>"}`;

export type JudgeMode = 'keyword' | 'hybrid';

export interface JudgedQuery {
  query: string;
  mode: JudgeMode;
  verdict: JudgeVerdict | 'error';
  reason: string;
}

export interface ModeRate {
  judged: number;
  yes: number;
  partial: number;
  no: number;
  errors: number;
  /** yes / judged. Partial counts half in `weighted_rate`, never here. */
  answer_rate: number;
  weighted_rate: number;
}

export interface JudgeReport {
  model: string;
  k: number;
  keyword: ModeRate;
  hybrid: ModeRate;
  per_query: JudgedQuery[];
  calls: number;
  usage: TokenUsage;
  cost_usd: number;
}

export interface JudgeOptions {
  provider: Provider;
  spec: ModelSpec;
  /** `privacy.local_only`: a non-local judge is refused before any call. */
  localOnly: boolean;
  timeoutMs?: number;
  items?: readonly GoldenItem[];
  /** Judge only the first n queries - a cheap smoke run. */
  limit?: number;
}

export class JudgeRefused extends Error {}

/** The context a query was served, as the judge reads it: the top-k items, category and text. */
export function renderServedContext(ids: string[], items: readonly GoldenItem[], k: number): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = ids
    .slice(0, k)
    .map((id) => byId.get(id))
    .filter((i): i is GoldenItem => i != null)
    .map((i) => `- [${i.category}] ${i.text}${i.reason ? ` (why: ${i.reason})` : ''}`);
  return lines.length > 0 ? lines.join('\n') : '(nothing retrieved)';
}

export function parseVerdict(raw: string): { verdict: JudgeVerdict; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(raw.slice(start, end + 1)) as { verdict?: unknown; reason?: unknown };
      const v = typeof j.verdict === 'string' ? j.verdict.trim().toLowerCase() : '';
      if ((JUDGE_VERDICTS as readonly string[]).includes(v)) {
        return { verdict: v as JudgeVerdict, reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 200) : '' };
      }
    } catch {
      // fall through to the plain-text reading
    }
  }
  // A model that ignored the format but said one clear word is still an answer.
  const word = raw.trim().toLowerCase().match(/^(yes|partial|no)\b/);
  return word ? { verdict: word[1] as JudgeVerdict, reason: '' } : null;
}

function rate(results: JudgedQuery[]): ModeRate {
  const judged = results.filter((r) => r.verdict !== 'error');
  const count = (v: JudgeVerdict) => judged.filter((r) => r.verdict === v).length;
  const yes = count('yes');
  const partial = count('partial');
  const n = judged.length;
  return {
    judged: n,
    yes,
    partial,
    no: count('no'),
    errors: results.length - n,
    answer_rate: n > 0 ? yes / n : 0,
    weighted_rate: n > 0 ? (yes + partial / 2) / n : 0,
  };
}

/**
 * Judge the contexts an evaluation served. Identical contexts for one query (keyword and hybrid
 * often agree) are judged once, so the cost is per distinct answer, not per mode.
 */
export async function judgeRetrieval(e: RetrievalEval, opts: JudgeOptions): Promise<JudgeReport> {
  if (opts.localOnly && !providerIsLocal(opts.provider, opts.spec)) {
    throw new JudgeRefused(
      `local_only is set and ${opts.provider.name}:${opts.spec.model} is not local; the judge was not called`,
    );
  }
  const items = opts.items ?? GOLDEN_ITEMS;
  const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  const cache = new Map<string, { verdict: JudgeVerdict | 'error'; reason: string }>();
  const perQuery: JudgedQuery[] = [];
  let calls = 0;

  const queries = opts.limit != null ? e.per_query.slice(0, opts.limit) : e.per_query;
  for (const q of queries) {
    for (const mode of ['keyword', 'hybrid'] as const) {
      const context = renderServedContext(q[mode], items, e.k);
      const key = `${q.query}\u0000${context}`;
      let judged = cache.get(key);
      if (!judged) {
        judged = await judgeOne(q.query, context, opts, usage);
        calls += 1;
        cache.set(key, judged);
      }
      perQuery.push({ query: q.query, mode, ...judged });
    }
  }

  return {
    model: `${opts.provider.name}:${opts.spec.model}`,
    k: e.k,
    keyword: rate(perQuery.filter((r) => r.mode === 'keyword')),
    hybrid: rate(perQuery.filter((r) => r.mode === 'hybrid')),
    per_query: perQuery,
    calls,
    usage,
    cost_usd: priceUsage(opts.spec, usage),
  };
}

async function judgeOne(
  query: string,
  context: string,
  opts: JudgeOptions,
  usage: TokenUsage,
): Promise<{ verdict: JudgeVerdict | 'error'; reason: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await opts.provider.complete(
      {
        system: JUDGE_SYSTEM,
        user: `## question\n${query}\n\n## retrieved context\n${context}\n\nReturn the verdict as JSON.`,
        maxTokens: 200,
        signal: ac.signal,
      },
      opts.spec,
    );
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    const parsed = parseVerdict(res.text);
    return parsed ?? { verdict: 'error', reason: 'unparsable verdict' };
  } catch (err) {
    // One failed call is one unjudged query, not a failed benchmark.
    return { verdict: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

export function formatJudgeReport(r: JudgeReport, verbose = false): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const row = (name: string, m: ModeRate) =>
    `${name.padEnd(26)}${pct(m.answer_rate).padStart(9)}${pct(m.weighted_rate).padStart(10)}` +
    `${String(m.yes).padStart(5)}${String(m.partial).padStart(5)}${String(m.no).padStart(5)}${String(m.errors).padStart(5)}`;
  const lines = [
    `LLM judge (${r.model}, top ${r.k})`,
    '',
    `${''.padEnd(26)}${'answered'.padStart(9)}${'weighted'.padStart(10)}${'yes'.padStart(5)}${'part'.padStart(5)}${'no'.padStart(5)}${'err'.padStart(5)}`,
    row('keyword only (FTS5 BM25)', r.keyword),
    row('hybrid, adaptive weight', r.hybrid),
    '',
    `judge calls ${r.calls}  tokens ${r.usage.input_tokens} in / ${r.usage.output_tokens} out  cost $${r.cost_usd.toFixed(5)}`,
  ];
  if (verbose) {
    lines.push('', 'Per query:');
    for (const q of r.per_query) lines.push(`  ${q.mode.padEnd(8)} ${q.verdict.padEnd(8)} ${q.query}  - ${q.reason}`);
  }
  lines.push('', 'A judgement of the fixture, not of this project: printed, never stored.');
  return lines.join('\n');
}
