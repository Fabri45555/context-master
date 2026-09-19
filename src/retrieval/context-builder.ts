import type { Config } from '../core/config.js';
import { estimateTokens } from '../core/events.js';
import type { MemoryCategory, MemoryItem } from '../core/state.js';
import type { ContextStore } from '../store/store.js';
import { RetrievalEngine, type ScoredItem } from '../store/retrieval.js';

/**
 * PRD 21 / 45 - the context builder.
 *
 * Context is a budget, not a bucket. Each section gets an allowance; anything that does
 * not fit is dropped rather than silently inflating the prompt, and what remains is
 * reported so the caller can see the cost it is paying.
 */

export interface ContextSection {
  title: string;
  lines: string[];
  tokens: number;
  dropped: number;
  /**
   * Ids of the items this section actually rendered.
   *
   * Carried through rather than recovered from the text. `finish` used to scrape the rendered
   * output for `[mem_...]`, which silently stopped matching the moment workers began assigning
   * short ids like `d3` - and with it `markUsed` received an empty list, so `never_retrieved`
   * could never move off 100%.
   */
  itemIds: string[];
}

export interface BuiltContext {
  text: string;
  tokens: number;
  itemIds: string[];
  sections: ContextSection[];
  budget: number;
}

/**
 * Every category is either served in the bootstrap or deliberately left to query. There is no
 * third option, because a category in neither list is stored and never shown unless something
 * happens to search for it: `goals` and then `requirements` were both extracted correctly and
 * absent from every session start. The test suite checks that the two lists cover everything.
 */
export const BOOTSTRAP_SECTIONS: ReadonlyArray<{
  title: string;
  categories: readonly MemoryCategory[];
  budget: 'goals' | 'constraints' | 'decisions' | 'important_files' | 'open_issues';
}> = [
  { title: 'Goals and requirements', categories: ['goals', 'requirements'], budget: 'goals' },
  { title: 'Active constraints', categories: ['constraints', 'conventions'], budget: 'constraints' },
  { title: 'Decisions', categories: ['decisions', 'architecture'], budget: 'decisions' },
  { title: 'Important files', categories: ['important_files'], budget: 'important_files' },
  { title: 'Open issues and questions', categories: ['known_issues', 'open_questions'], budget: 'open_issues' },
];

/** History rather than orientation: worth finding when relevant, not worth paying for every session. */
export const QUERY_ONLY_CATEGORIES: readonly MemoryCategory[] = ['discoveries', 'completed_work'];

/**
 * Category tags for sections that mix categories. A query result is one list; without the tag a
 * discovery - "the fold recorded ENOENT as an issue" - reads as a live problem, and a real session
 * proposed retiring a fixed bug's history as an open issue.
 */
const CATEGORY_TAG: Record<string, string> = {
  goals: 'goal',
  requirements: 'requirement',
  constraints: 'constraint',
  decisions: 'decision',
  architecture: 'architecture',
  conventions: 'convention',
  discoveries: 'discovery, historical',
  completed_work: 'done',
  known_issues: 'open issue',
  open_questions: 'open question',
  important_files: 'file',
};

function renderItem(i: MemoryItem, tagCategory = false): string {
  const bits: string[] = [];
  if (i.category === 'important_files') {
    const purpose = typeof i.fields.purpose === 'string' ? i.fields.purpose : null;
    const path = typeof i.fields.path === 'string' ? i.fields.path : i.text;
    return `- ${path}${purpose ? ` — ${purpose}` : ''} [${i.id}]`;
  }
  bits.push(tagCategory ? `- (${CATEGORY_TAG[i.category] ?? i.category}) ${i.text}` : `- ${i.text}`);
  if (i.category === 'decisions' && typeof i.fields.reason === 'string') {
    bits.push(`(why: ${i.fields.reason})`);
  } else if (i.reason) {
    bits.push(`(why: ${i.reason})`);
  }
  if (i.importance === 'critical') bits.push('[critical]');
  if (i.confidence < 0.6) bits.push(`[confidence ${i.confidence.toFixed(2)}]`);
  bits.push(`[${i.id}]`);
  return bits.join(' ');
}

/** Fill a section up to its token allowance, reporting what did not fit. */
function pack(title: string, items: MemoryItem[], allowance: number, tagCategory = false): ContextSection {
  const lines: string[] = [];
  const itemIds: string[] = [];
  let tokens = estimateTokens(title) + 2;
  let dropped = 0;
  for (const item of items) {
    const line = renderItem(item, tagCategory);
    const cost = estimateTokens(line);
    if (tokens + cost > allowance) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    itemIds.push(item.id);
    tokens += cost;
  }
  return { title, lines, tokens, dropped, itemIds };
}

function sectionText(s: ContextSection): string {
  if (s.lines.length === 0) return '';
  const suffix = s.dropped > 0 ? `\n  (+${s.dropped} more, omitted for context budget)` : '';
  return `## ${s.title}\n${s.lines.join('\n')}${suffix}`;
}

export class ContextBuilder {
  private retrieval: RetrievalEngine;

  constructor(
    private store: ContextStore,
    private config: Config,
  ) {
    this.retrieval = new RetrievalEngine(store);
  }

  /**
   * PRD 21 - the small always-available header. This is what a fresh agent reads to
   * satisfy K5: resume from repository plus memory, without the original conversation.
   */
  bootstrap(): BuiltContext {
    const cb = this.config.context_budget;
    const working = this.store.workingMemory();
    const sections: ContextSection[] = [];

    const taskLines: string[] = [];
    if (working.project_name) taskLines.push(`- project: ${working.project_name}`);
    if (working.current_task) taskLines.push(`- task: ${working.current_task}`);
    taskLines.push(`- status: ${working.task_status}`);
    if (working.current_state) taskLines.push(`- state: ${working.current_state}`);
    if (working.next_action) taskLines.push(`- next action: ${working.next_action}`);
    if (working.current_plan.length > 0) {
      taskLines.push(...working.current_plan.map((p, n) => `- plan ${n + 1}. ${p}`));
    }
    sections.push({
      title: 'Current task',
      lines: taskLines,
      tokens: taskLines.reduce((s, l) => s + estimateTokens(l), 4),
      dropped: 0,
      // Working memory is a single row, not memory items: nothing here is retrievable.
      itemIds: [],
    });

    const eligible = (items: MemoryItem[]) =>
      items.filter((i) => alwaysOnEligible(i, cb.min_bootstrap_confidence));

    for (const s of BOOTSTRAP_SECTIONS) {
      const items = eligible(s.categories.flatMap((c) => this.retrieval.byCategory(c)));
      sections.push(pack(s.title, items, cb.sections[s.budget]));
    }

    return this.finish(sections, cb.total_tokens - cb.reserve_for_retrieval);
  }

  /**
   * The bootstrap as actually handed to an agent (SessionStart injection, `memory_bootstrap`).
   *
   * `bootstrap()` is also what status, pressure and the dashboard call to *measure* the slice,
   * so it cannot log anything. But serving it is a retrieval: counting only `forQuery` left
   * every always-on item looking never-retrieved even though every session start read it.
   */
  serveBootstrap(sessionId: string | null = null): BuiltContext {
    const built = this.bootstrap();
    if (built.itemIds.length > 0 || built.text.length > 0) {
      this.store.logRetrieval(sessionId, '(bootstrap)', built.itemIds, built.tokens);
      this.store.markUsed(built.itemIds);
    }
    return built;
  }

  /**
   * PRD 46 - query-scoped retrieval. Always-on critical items are included unconditionally
   * so a narrow query cannot accidentally hide a user constraint.
   */
  forQuery(
    query: string,
    opts: { limit?: number; sessionId?: string | null; record?: boolean } = {},
  ): BuiltContext {
    const cb = this.config.context_budget;
    const base = this.bootstrap();

    const alwaysIds = new Set(base.itemIds);
    const hits: ScoredItem[] = this.retrieval
      .search(query, { limit: opts.limit ?? 12 })
      .filter((h) => !alwaysIds.has(h.item.id));

    const relevant = pack(
      `Relevant memory for: ${query.slice(0, 120)}`,
      hits.map((h) => h.item),
      cb.reserve_for_retrieval,
      true,
    );

    const sections = [...base.sections, relevant];
    const built = this.finish(sections, cb.total_tokens);

    // A person previewing a query in the dashboard is not memory reaching an agent; counting it
    // would let the page that reports never_retrieved move that number by being looked at.
    if (opts.record !== false) {
      this.store.logRetrieval(opts.sessionId ?? null, query, built.itemIds, built.tokens);
      this.store.markUsed(built.itemIds);
    }
    return built;
  }

  private finish(sections: ContextSection[], budget: number): BuiltContext {
    const kept = sections.filter((s) => s.lines.length > 0);
    const text = kept.map(sectionText).filter(Boolean).join('\n\n');
    return {
      text,
      tokens: estimateTokens(text),
      itemIds: [...new Set(kept.flatMap((s) => s.itemIds))],
      sections: kept,
      budget,
    };
  }
}

/**
 * Whether an item has earned a place in the slice every session pays for.
 *
 * Anything the user said, and anything critical, is in unconditionally - withholding those is
 * exactly the loss K2 forbids. A worker's low-confidence guess is not withheld either, only
 * moved: it stays retrievable by query, where its uncertainty is cheap.
 */
export function alwaysOnEligible(item: MemoryItem, minConfidence: number): boolean {
  if (item.source === 'user' || item.importance === 'critical') return true;
  return item.confidence >= minConfidence;
}
