import { describe, expect, it } from 'vitest';
import { evaluateRetrieval } from '../src/bench/retrieval-eval.js';
import {
  formatJudgeReport,
  judgeRetrieval,
  JudgeRefused,
  parseVerdict,
  renderServedContext,
} from '../src/bench/retrieval-judge.js';
import type { ModelSpec } from '../src/core/config.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../src/workers/providers/types.js';

/** A judge that says yes when the context names SQLite, partial on WAL, no otherwise. Offline. */
class FixtureJudge implements Provider {
  readonly name = 'fixture-judge';
  calls: CompletionRequest[] = [];
  constructor(readonly isLocal = true, private reply?: (user: string) => string) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    const ctx = req.user.slice(req.user.indexOf('## retrieved context'));
    const text =
      this.reply?.(req.user) ??
      (/SQLite/.test(ctx)
        ? '{"verdict":"yes","reason":"an item names SQLite"}'
        : /WAL|FTS5/.test(ctx)
          ? '{"verdict":"partial","reason":"related"}'
          : '{"verdict":"no","reason":"nothing relevant"}');
    return { text, usage: { input_tokens: 200, output_tokens: 20 } };
  }
}

const SPEC: ModelSpec = {
  provider: 'anthropic',
  model: 'judge-model',
  input_cost_per_mtok: 1,
  output_cost_per_mtok: 5,
  max_output_tokens: 256,
};

describe('retrieval judge', () => {
  it('judges keyword and hybrid context per query, once per distinct context, and prices the calls', async () => {
    const e = await evaluateRetrieval();
    const judge = new FixtureJudge();
    const r = await judgeRetrieval(e, { provider: judge, spec: SPEC, localOnly: false });

    expect(r.per_query).toHaveLength(e.per_query.length * 2);
    // Identical contexts are not paid for twice.
    expect(r.calls).toBe(judge.calls.length);
    expect(r.calls).toBeLessThanOrEqual(e.per_query.length * 2);
    expect(r.usage.input_tokens).toBe(200 * r.calls);
    expect(r.cost_usd).toBeCloseTo((200 * r.calls * 1 + 20 * r.calls * 5) / 1_000_000, 10);

    for (const mode of [r.keyword, r.hybrid]) {
      expect(mode.judged + mode.errors).toBe(e.per_query.length);
      expect(mode.yes + mode.partial + mode.no).toBe(mode.judged);
      expect(mode.answer_rate).toBeCloseTo(mode.yes / mode.judged, 10);
    }
    // The sqlite query is answered by both modes' top-k.
    const sqlite = r.per_query.filter((q) => q.query === 'sqlite persistence');
    expect(sqlite.map((q) => q.verdict)).toEqual(['yes', 'yes']);

    const text = formatJudgeReport(r);
    expect(text).toMatch(/keyword only/);
    expect(text).toMatch(/judge calls \d+ {2}tokens \d+ in \/ \d+ out {2}cost \$/);
    expect(text).toContain('never stored');
  });

  it('refuses a non-local judge under local_only before any call', async () => {
    const e = await evaluateRetrieval();
    const judge = new FixtureJudge(false);
    await expect(judgeRetrieval(e, { provider: judge, spec: SPEC, localOnly: true })).rejects.toBeInstanceOf(JudgeRefused);
    expect(judge.calls).toHaveLength(0);
  });

  it('counts an unparsable or failed verdict as an error, not as an answer', async () => {
    const e = await evaluateRetrieval();
    const judge = new FixtureJudge(true, () => 'I think it is fine?');
    const r = await judgeRetrieval(e, { provider: judge, spec: SPEC, localOnly: false, limit: 2 });
    expect(r.per_query).toHaveLength(4);
    expect(r.keyword.errors).toBe(2);
    expect(r.keyword.answer_rate).toBe(0);
  });

  it('reads the verdict from JSON or a bare word, and renders only the top k', () => {
    expect(parseVerdict('```json\n{"verdict":"Partial","reason":"close"}\n```')).toEqual({ verdict: 'partial', reason: 'close' });
    expect(parseVerdict('no - nothing about it')).toEqual({ verdict: 'no', reason: '' });
    expect(parseVerdict('maybe')).toBeNull();
    const ctx = renderServedContext(['d_sqlite', 'd_fts', 'd_rrf'], [
      { id: 'd_sqlite', category: 'decisions', text: 'Use SQLite', reason: 'one file' },
      { id: 'd_fts', category: 'decisions', text: 'FTS5' },
      { id: 'd_rrf', category: 'decisions', text: 'RRF' },
    ], 2);
    expect(ctx).toBe('- [decisions] Use SQLite (why: one file)\n- [decisions] FTS5');
  });
});
