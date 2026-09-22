import type { Config } from '../core/config.js';
import { estimateTokens } from '../core/events.js';
import { isClosed } from '../core/patch.js';
import type { MemoryCategory, MemoryItem } from '../core/state.js';
import type { ContextStore } from '../store/store.js';
import { RetrievalEngine, type ScoredItem } from '../store/retrieval.js';
import type { EmbeddingIndex } from '../store/embeddings.js';

export interface QueryOptions {
  limit?: number;
  sessionId?: string | null;
  /** false for a preview that never reaches an agent - see `serveQuery`. */
  record?: boolean;
  /** Restrict the hits to these categories; with an empty query, list them. */
  categories?: MemoryCategory[];
}

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
  /** Items shown only in part (see BOOTSTRAP_ITEM_CHARS); a query may render them again in full. */
  clippedIds?: string[];
  /**
   * The categories of the items that did not fit, in order of first appearance. Carried through
   * for the same reason as `itemIds`: the omitted marker names where to get the rest, and that
   * must not be recovered from the rendered text.
   */
  droppedCategories?: MemoryCategory[];
  /** Ids of the items that did not fit - named in the marker when there are few enough. */
  droppedIds?: string[];
  /** Which marker the section gets when something did not fit. Absent means bootstrap. */
  kind?: 'bootstrap' | 'query';
}

export interface BootstrapOptions {
  /**
   * Dates instead of "3h ago". For a copy written to a file: a relative age is true only at the
   * moment it is rendered, and a file is read long after.
   */
  absoluteTimes?: boolean;
  /**
   * Tokens the whole slice may take, when a reader has less room than the configured bootstrap -
   * an instruction file the agent loads on every turn. The section allowances shrink in
   * proportion, so what does not fit is dropped whole and named by the omitted marker, exactly as
   * over the configured budget; text is never cut to size. Never grows past the configured slice.
   */
  budget?: number;
}

export interface ServeBootstrapOptions extends BootstrapOptions {
  /**
   * What the retrieval log records as the query. `(bootstrap)` is a session start, and the
   * Benefits view counts those as resumes - so a copy served some other way must say so.
   */
  label?: string;
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

/**
 * The most one item may cost in the always-on slice, in characters.
 *
 * Every session pays for the bootstrap, so one item written as a paragraph taxes all of them: a
 * single 558-character decision plus its reason took the bootstrap from 425 to 775 tokens. Past
 * this, the bootstrap shows the start and the id; the whole item is one `memory_explain` away, and
 * queries still render it in full.
 */
export const BOOTSTRAP_ITEM_CHARS = 240;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`;
}

/** Whether the always-on slice would show only part of this item. */
function needsClip(i: MemoryItem, maxChars: number | undefined): boolean {
  if (maxChars == null || i.category === 'important_files') return false;
  const reason = i.category === 'decisions' && typeof i.fields.reason === 'string' ? i.fields.reason : i.reason;
  return (reason ? `${i.text} (why: ${reason})` : i.text).length > maxChars;
}

function renderItem(i: MemoryItem, tagCategory = false, maxChars?: number): string {
  if (maxChars != null && needsClip(i, maxChars)) {
    const marks = [i.importance === 'critical' ? '[critical]' : null, `[${i.id}]`].filter(Boolean);
    return `- ${clip(i.text, maxChars)} (full: memory_explain ${i.id}) ${marks.join(' ')}`;
  }
  const bits: string[] = [];
  if (i.category === 'important_files') {
    const purpose = typeof i.fields.purpose === 'string' ? i.fields.purpose : null;
    const path = typeof i.fields.path === 'string' ? i.fields.path : i.text;
    return `- ${path}${purpose ? ` — ${purpose}` : ''} [${i.id}]`;
  }
  const tag = `${CATEGORY_TAG[i.category] ?? i.category}${isClosed(i) ? ', done' : ''}`;
  bits.push(tagCategory ? `- (${tag}) ${i.text}` : `- ${i.text}`);
  if (tagCategory && isClosed(i) && typeof i.fields.closed_reason === 'string') {
    bits.push(`(closed: ${i.fields.closed_reason})`);
  }
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
function pack(
  title: string,
  items: MemoryItem[],
  allowance: number,
  tagCategory = false,
  maxChars?: number,
): ContextSection {
  const lines: string[] = [];
  const itemIds: string[] = [];
  const clippedIds: string[] = [];
  const droppedCategories: MemoryCategory[] = [];
  const droppedIds: string[] = [];
  let tokens = estimateTokens(title) + 2;
  let dropped = 0;
  for (const item of items) {
    const line = renderItem(item, tagCategory, maxChars);
    const cost = estimateTokens(line);
    if (tokens + cost > allowance) {
      dropped += 1;
      droppedIds.push(item.id);
      if (!droppedCategories.includes(item.category)) droppedCategories.push(item.category);
      continue;
    }
    lines.push(line);
    itemIds.push(item.id);
    if (needsClip(item, maxChars)) clippedIds.push(item.id);
    tokens += cost;
  }
  return { title, lines, tokens, dropped, itemIds, clippedIds, droppedCategories, droppedIds };
}

/** At most this many omitted ids are named in a query's marker; past it, the count is enough. */
export const OMITTED_IDS_SHOWN = 4;

/**
 * The line that says something did not fit - and how to get it, because "omitted" with no way
 * back is a dead end the agent can only re-derive around.
 *
 * A bootstrap section drops whole categories' tails, so it points at the category listing
 * (`memory_query` with `category`, which lists a category when the query is empty). A query's
 * section drops ranked hits, so a handful are named by id for `memory_explain`; more than that,
 * and a narrower query is the better advice than a longer marker.
 */
export function omittedMarker(s: Pick<ContextSection, 'dropped' | 'droppedCategories' | 'droppedIds'>, kind: 'bootstrap' | 'query'): string {
  if (s.dropped <= 0) return '';
  if (kind === 'query') {
    const ids = s.droppedIds ?? [];
    if (ids.length > 0 && ids.length <= OMITTED_IDS_SHOWN) {
      return `(+${s.dropped} more omitted for budget: ${ids.join(', ')} - memory_explain <id>)`;
    }
    return `(+${s.dropped} more omitted for budget - narrow the query or raise its limit)`;
  }
  const cats = s.droppedCategories ?? [];
  if (cats.length === 0) return `(+${s.dropped} more, omitted for context budget)`;
  return `(+${s.dropped} more omitted for budget - memory_query category="${cats.join('" / "')}")`;
}

function sectionText(s: ContextSection, kind: 'bootstrap' | 'query'): string {
  if (s.lines.length === 0) return '';
  const marker = omittedMarker(s, kind);
  const suffix = marker ? `\n  ${marker}` : '';
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
  bootstrap(opts: BootstrapOptions = {}): BuiltContext {
    const age = (iso: string) => (opts.absoluteTimes ? `at ${absoluteTime(iso)}` : describeAge(iso));
    const cb = this.config.context_budget;
    const working = this.store.workingMemory();
    const sections: ContextSection[] = [];

    const taskLines: string[] = [];
    if (working.project_name) taskLines.push(`- project: ${working.project_name}`);
    if (working.current_task) taskLines.push(`- task: ${working.current_task}`);
    taskLines.push(`- status: ${working.task_status}`);
    if (working.current_state) taskLines.push(`- state: ${working.current_state}`);
    if (working.next_action) taskLines.push(`- next action: ${working.next_action}`);
    // Stated so the reader can weigh it: a task recorded hours and many user turns ago is a claim
    // about the past. Without this a stale "blocked: waiting for commit" read as current.
    if (working.updated_at && (working.current_task || working.next_action)) {
      const since = this.store.userMessagesSince(working.updated_at);
      const milestones = this.store.milestonesSince(working.updated_at, 3);
      const after = [
        since > 0 ? `${since} user message${since === 1 ? '' : 's'}` : null,
        milestones.length > 0 ? `${milestones.length} milestone${milestones.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      taskLines.push(
        `- recorded: ${age(working.updated_at)}` +
          (after.length > 0 ? `, ${after.join(' and ')} since - verify before relying on it` : ''),
      );
      // A commit or a push after the task was written is the likeliest sign it is finished.
      for (const m of milestones) {
        taskLines.push(`- since then: \`${m.command.slice(0, 80)}\`${m.summary ? ` (${m.summary.slice(0, 80)})` : ''}, ${age(m.at)}`);
      }
    }
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

    const scale = sectionScale(cb.sections, sections[0]!.tokens, opts.budget);
    for (const s of BOOTSTRAP_SECTIONS) {
      const items = eligible(s.categories.flatMap((c) => this.retrieval.byCategory(c)));
      sections.push(pack(s.title, items, Math.floor(cb.sections[s.budget] * scale), false, BOOTSTRAP_ITEM_CHARS));
    }

    const configured = cb.total_tokens - cb.reserve_for_retrieval;
    return this.finish(sections, opts.budget != null ? Math.min(opts.budget, configured) : configured);
  }

  /**
   * The bootstrap as actually handed to an agent (SessionStart injection, `memory_bootstrap`).
   *
   * `bootstrap()` is also what status, pressure and the dashboard call to *measure* the slice,
   * so it cannot log anything. But serving it is a retrieval: counting only `forQuery` left
   * every always-on item looking never-retrieved even though every session start read it.
   */
  serveBootstrap(sessionId: string | null = null, opts: ServeBootstrapOptions = {}): BuiltContext {
    const built = this.bootstrap(opts);
    if (built.itemIds.length > 0 || built.text.length > 0) {
      this.store.logRetrieval(sessionId, opts.label ?? '(bootstrap)', built.itemIds, built.tokens);
      this.store.markUsed(built.itemIds);
    }
    return built;
  }

  /**
   * PRD 46 - query-scoped retrieval. Always-on critical items are included unconditionally
   * so a narrow query cannot accidentally hide a user constraint.
   */
  forQuery(query: string, opts: QueryOptions = {}): BuiltContext {
    const categories = opts.categories && opts.categories.length > 0 ? { categories: opts.categories } : {};
    return this.serveQuery(query, this.retrieval.search(query, { limit: opts.limit ?? 12, ...categories }), opts);
  }

  /**
   * `forQuery` with the semantic list fused in. Async because embedding the query is a provider
   * call, which is why the hook path never comes here (invariant 17).
   *
   * The index is brought up to date first, so an item written a minute ago is findable by
   * meaning without anyone running `contextd embed`. When that refresh reports the provider
   * unreachable, the query goes keyword-only at once rather than waiting out a second timeout.
   */
  async forQueryHybrid(query: string, index: EmbeddingIndex, opts: QueryOptions = {}): Promise<BuiltContext> {
    const limit = opts.limit ?? 12;
    // An empty query is a category listing: there is nothing to embed.
    if (!index.enabled || query.trim().length === 0) return this.forQuery(query, opts);
    const refreshed = await index.backfill();
    if (refreshed.error && refreshed.failed > 0) return this.forQuery(query, opts);
    const categories = opts.categories && opts.categories.length > 0 ? { categories: opts.categories } : {};
    return this.serveQuery(query, await this.retrieval.searchHybrid(query, index, { limit, ...categories }), opts);
  }

  private serveQuery(query: string, found: ScoredItem[], opts: QueryOptions): BuiltContext {
    const cb = this.config.context_budget;
    const base = this.bootstrap();

    // Already on screen - unless the bootstrap only showed the start of it.
    const clipped = new Set(base.sections.flatMap((s) => s.clippedIds ?? []));
    const alwaysIds = new Set(base.itemIds.filter((id) => !clipped.has(id)));
    const hits = found.filter((h) => !alwaysIds.has(h.item.id));

    const relevant: ContextSection = {
      ...pack(queryTitle(query, opts.categories), hits.map((h) => h.item), cb.reserve_for_retrieval, true),
      kind: 'query',
    };

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
    const text = kept.map((s) => sectionText(s, s.kind ?? 'bootstrap')).filter(Boolean).join('\n\n');
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
 * How much of its configured allowance each memory section keeps under an explicit budget: the
 * task section is working memory, always shown, so it is paid for first and the sections share
 * what is left in their configured proportions. `pack` does not count the omitted marker a
 * section gets when something did not fit, nor the separators, hence the reserve per section.
 */
const MARKER_RESERVE = 24;

function sectionScale(
  allowances: Record<(typeof BOOTSTRAP_SECTIONS)[number]['budget'], number>,
  taskTokens: number,
  budget: number | undefined,
): number {
  if (budget == null) return 1;
  const configured = BOOTSTRAP_SECTIONS.reduce((sum, s) => sum + allowances[s.budget], 0);
  if (configured <= 0) return 1;
  const left = budget - taskTokens - BOOTSTRAP_SECTIONS.length * MARKER_RESERVE;
  return Math.max(0, Math.min(1, left / configured));
}

function queryTitle(query: string, categories: MemoryCategory[] | undefined): string {
  const q = query.trim().slice(0, 120);
  const cats = categories && categories.length > 0 ? categories.join(', ') : null;
  if (!cats) return `Relevant memory for: ${q}`;
  return q.length > 0 ? `Relevant memory for: ${q} (in ${cats})` : `Memory in ${cats}`;
}

/** Minute precision, UTC: stable across renders of the same state. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : iso;
}

function describeAge(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Whether an item has earned a place in the slice every session pays for.
 *
 * Anything the user said, and anything critical, is in unconditionally - withholding those is
 * exactly the loss K2 forbids. A worker's low-confidence guess is not withheld either, only
 * moved: it stays retrievable by query, where its uncertainty is cheap.
 */
export function alwaysOnEligible(item: MemoryItem, minConfidence: number): boolean {
  // A met goal or an answered question is history: still findable by query, not orientation.
  // This comes before the user/critical rule on purpose - closing is the one way a protected
  // item leaves the slice without being weakened.
  if (isClosed(item)) return false;
  if (item.source === 'user' || item.importance === 'critical') return true;
  return item.confidence >= minConfidence;
}
