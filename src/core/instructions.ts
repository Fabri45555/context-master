import type { Importance } from './events.js';
import { removeBlock, type Markers } from './markers.js';
import type { MemoryCategory } from './state.js';

/**
 * Instruction markdown (CLAUDE.md, AGENTS.md, GEMINI.md, a Cursor `.mdc` rule) as candidate
 * memory items. Pure: the caller reads the file and commits the result.
 *
 * An instruction file is written for an agent to read top to bottom, so most of it is not a rule:
 * headings, intros to lists, command listings, tables of contents, links to other documents. The
 * parser keeps what stands on its own as one statement - a bullet, a numbered item, a paragraph
 * that says what must or must not happen - and drops the rest, saying why. Code blocks are never
 * memory (invariant 10); neither is a command on its own line. A table row survives only as what
 * it is when its first cell is a path and the second a purpose: an important file.
 */

export interface InstructionRule {
  /** Headings above the statement, outermost first. */
  headings: string[];
  category: MemoryCategory;
  importance: Importance;
  text: string;
  /** The whole statement when `text` had to be shortened to a summary. */
  detail: string | null;
  /** `path` and `purpose` for an important file. */
  fields: Record<string, unknown>;
  /** 1-based line where the statement starts, in the file as given. */
  line: number;
}

export interface SkippedBlock {
  line: number;
  reason: string;
  text: string;
}

export interface ParsedInstructions {
  rules: InstructionRule[];
  skipped: SkippedBlock[];
}

/** A statement longer than this keeps its first sentences as text and the whole as detail. */
const MAX_TEXT_CHARS = 600;
/** Shorter than this, a bullet is a label ("TypeScript"), not a statement. */
const MIN_WORDS = 3;

/**
 * Words that make a sentence a rule rather than a description. Not "only": "serves back only the
 * context that is relevant" is this repository's own one-line description.
 */
const RULE_CUE = /\b(must|never|should|shall|do not|don't|avoid|prefer|required)\b|(^|[.;:]\s+)always\b/i;
/**
 * The subset that makes it a hard constraint. "Always" counts only where it opens a sentence -
 * an order - because "working memory, always injected" describes the design.
 */
const CONSTRAINT_CUE = /\b(must|never|do not|don't|required|forbidden|mandatory|under no circumstances)\b|(^|[.;:]\s+)always\b/i;
const IMPERATIVE = /(^|[.;:]\s+)(never|always|do not|don't|must)\b/i;

/**
 * Heading words, nearest heading first. Order matters: "Architecture decisions" is decisions.
 * "Gotchas" is conventions, not known issues - a trap to avoid is how to work, not an open bug.
 */
const HEADING_CATEGORIES: ReadonlyArray<[RegExp, MemoryCategory]> = [
  [/\b(invariants?|constraints?|rules?|guardrails?|security|never|must|don'?t|do not|forbidden|restrictions?)\b/i, 'constraints'],
  [/\b(requirements?)\b/i, 'requirements'],
  [/\b(decisions?|adrs?|rationale)\b/i, 'decisions'],
  [/\b(goals?|roadmap|objectives?|milestones?)\b/i, 'goals'],
  [/\b(known issues?|bugs?|limitations?|todo|open questions?)\b/i, 'known_issues'],
  [/\b(architecture|design|overview|layout|structure|components?|modules?|stack|how it works|data model)\b/i, 'architecture'],
  [/\b(conventions?|style|guidelines?|practices|workflow|standards?|testing|tests|commits?|review|naming|formatting|gotchas?|pitfalls?|caveats?|tips)\b/i, 'conventions'],
];

/** Categories a heading decides over the text's own wording. */
const HEADING_WINS: ReadonlySet<MemoryCategory> = new Set(['constraints', 'requirements', 'decisions', 'goals', 'known_issues']);
/** Categories whose sections hold descriptions worth keeping even without a rule cue. */
const DESCRIPTIVE: ReadonlySet<MemoryCategory> = new Set(['architecture', 'decisions', 'constraints', 'requirements', 'goals']);

const FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|md|mdc|json|jsonl|toml|ya?ml|sql|sh|css|scss|html|lock|txt|env|ini|cfg|xml|proto|graphql)$/i;

/** A path as written in a list or table: has a slash, or ends in a known extension. */
export function looksLikePath(token: string): boolean {
  const t = token.trim();
  if (t.length < 2 || /\s/.test(t) || /^[a-z]+:\/\//i.test(t)) return false;
  if (!/^[\w.@~/\\*-]+\/?$/.test(t)) return false;
  return t.includes('/') || FILE_EXT.test(t);
}

/** A line that is a command someone runs, not a statement about the project. */
const COMMAND = /^(\$ |npm |npx |pnpm |yarn |node |git |cd |make |cargo |go |python3? |pip3? |uv |docker |kubectl |bash |sh |curl |brew )/;

interface Block {
  kind: 'bullet' | 'paragraph' | 'table' | 'code';
  lines: string[];
  line: number;
  indent: number;
  headings: string[];
}

/** Strip the markup a reader does not need; keep inline code, which names things exactly. */
export function cleanInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^\s*][^*]*?[^\s*]|[^\s*])\*(?=[\s.,;:!?)]|$)/g, '$1$2')
    // Named tags only: `<slugged-cwd>` in a path is a placeholder the reader needs.
    .replace(/<\/?(br|p|div|span|b|i|em|strong|code|kbd|sup|sub|details|summary|img|a)\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  // Keep the line count, so reported line numbers still point into the file.
  return m ? '\n'.repeat(m[0].split('\n').length - 1) + content.slice(m[0].length) : content;
}

function blankOut(content: string, from: number, to: number): string {
  const removed = content.slice(from, to);
  return content.slice(0, from) + removed.replace(/[^\n]/g, '') + content.slice(to);
}

/** Remove every block between `markers`, keeping line numbers. */
function stripBlocks(content: string, markers: readonly Markers[]): string {
  let out = content;
  for (const m of markers) {
    for (;;) {
      const from = out.indexOf(m.start);
      const end = from === -1 ? -1 : out.indexOf(m.end, from + m.start.length);
      if (from === -1 || end === -1) break;
      out = blankOut(out, from, end + m.end.length);
    }
    // An unterminated start marker: removeBlock would leave it; nothing after it is trusted either.
    if (removeBlock(out, m) == null && out.includes(m.start)) out = out.slice(0, out.indexOf(m.start));
  }
  return out;
}

function stripComments(content: string): string {
  let out = content;
  for (;;) {
    const from = out.indexOf('<!--');
    if (from === -1) return out;
    const end = out.indexOf('-->', from + 4);
    if (end === -1) return out.slice(0, from);
    out = blankOut(out, from, end + 3);
  }
}

function tokenize(content: string): Block[] {
  const blocks: Block[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  const headings = () => headingStack.map((h) => h.text);
  let current: Block | null = null;
  let fence: string | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  const lines = content.split(/\r?\n/);
  lines.forEach((raw, n) => {
    const lineNo = n + 1;
    if (fence) {
      if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    const fenceOpen = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fenceOpen) {
      flush();
      fence = fenceOpen[1]!;
      blocks.push({ kind: 'code', lines: [], line: lineNo, indent: 0, headings: headings() });
      return;
    }
    if (raw.trim() === '') {
      flush();
      return;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, text: cleanInline(heading[2]!) });
      return;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flush();
      return;
    }
    if (/^\s*\|/.test(raw)) {
      if (current?.kind !== 'table') {
        flush();
        current = { kind: 'table', lines: [], line: lineNo, indent: 0, headings: headings() };
      }
      current.lines.push(raw.trim());
      return;
    }
    const bullet = raw.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      current = { kind: 'bullet', lines: [bullet[2]!], line: lineNo, indent: bullet[1]!.length, headings: headings() };
      return;
    }
    const text = raw.replace(/^\s*>\s?/, '').trim();
    if (current && (current.kind === 'bullet' || current.kind === 'paragraph')) {
      current.lines.push(text);
      return;
    }
    flush();
    current = { kind: 'paragraph', lines: [text], line: lineNo, indent: 0, headings: headings() };
  });
  flush();
  return blocks;
}

function headingCategory(headings: readonly string[]): MemoryCategory | null {
  for (let i = headings.length - 1; i >= 0; i -= 1) {
    for (const [re, category] of HEADING_CATEGORIES) if (re.test(headings[i]!)) return category;
  }
  return null;
}

/** `path — purpose`, `path: purpose`, `path - purpose`, with the path optionally in backticks. */
function asFile(text: string): { path: string; purpose: string } | null {
  const m = text.match(/^`?([^\s`]+)`?\s*(?:—|–|-|:)\s+(.{3,})$/);
  if (!m || !looksLikePath(m[1]!)) return null;
  return { path: m[1]!, purpose: m[2]!.trim() };
}

function summarize(text: string): { text: string; detail: string | null } {
  if (text.length <= MAX_TEXT_CHARS) return { text, detail: null };
  const head = text.slice(0, MAX_TEXT_CHARS);
  const stop = head.lastIndexOf('. ');
  const cut = stop > MAX_TEXT_CHARS / 3 ? head.slice(0, stop + 1) : `${head.slice(0, head.lastIndexOf(' ')).trimEnd()}…`;
  return { text: cut, detail: text };
}

function classify(text: string, headings: readonly string[]): { category: MemoryCategory; importance: Importance } {
  const fromHeading = headingCategory(headings);
  let category: MemoryCategory;
  if (fromHeading && HEADING_WINS.has(fromHeading)) category = fromHeading;
  // Under an architecture heading a "never" usually describes the design ("raw events, never
  // prompted"); only an order opening a sentence makes it a constraint there.
  else if ((fromHeading === 'architecture' ? IMPERATIVE : CONSTRAINT_CUE).test(text)) category = 'constraints';
  else category = fromHeading ?? 'conventions';
  // High, not critical: critical is what the user said is non-negotiable, and a file an agent may
  // have written does not prove that (invariant 47).
  return { category, importance: category === 'constraints' || category === 'requirements' ? 'high' : 'medium' };
}

function tableRules(block: Block, skipped: SkippedBlock[]): InstructionRule[] {
  const out: InstructionRule[] = [];
  const cells = (row: string) => row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => cleanInline(c));
  block.lines.forEach((row, n) => {
    const line = block.line + n;
    const c = cells(row);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) return;
    // The header row is the one directly above the separator.
    if (n === 0 && block.lines[1] && /^\|?\s*:?-{2,}/.test(block.lines[1])) return;
    const path = c[0]?.replace(/^`|`$/g, '') ?? '';
    const purpose = c.slice(1).filter(Boolean).join('; ');
    if (c.length >= 2 && looksLikePath(path) && purpose.split(' ').length >= 2) {
      out.push({
        headings: block.headings,
        category: 'important_files',
        importance: 'medium',
        text: `${path} — ${purpose}`,
        detail: null,
        fields: { path, purpose },
        line,
      });
    } else {
      skipped.push({ line, reason: 'table row', text: row.slice(0, 80) });
    }
  });
  return out;
}

export interface ParseOptions {
  /** Blocks to leave out entirely - contextd's own mirror, which importing would loop. */
  exclude?: readonly Markers[];
}

export function parseInstructionMarkdown(content: string, opts: ParseOptions = {}): ParsedInstructions {
  const prepared = stripComments(stripBlocks(stripFrontmatter(content), opts.exclude ?? []));
  const blocks = tokenize(prepared);
  const rules: InstructionRule[] = [];
  const skipped: SkippedBlock[] = [];
  /** Bullets ending in ':' introduce their children, which read as "<intro>: <child>". */
  const intros: Array<{ indent: number; text: string }> = [];

  blocks.forEach((block, n) => {
    const skip = (reason: string, text = block.lines.join(' ')) =>
      skipped.push({ line: block.line, reason, text: text.slice(0, 80) });
    if (block.kind === 'code') return skip('code block', '```');
    if (block.kind === 'table') {
      rules.push(...tableRules(block, skipped));
      return;
    }

    if (block.kind === 'bullet') {
      while (intros.length > 0 && intros[intros.length - 1]!.indent >= block.indent) intros.pop();
    } else {
      intros.length = 0;
    }

    let text = cleanInline(block.lines.join(' ')).replace(/^\[[ xX]\]\s+/, '');
    if (text.length === 0) return;

    if (text.endsWith(':')) {
      if (block.kind === 'bullet') intros.push({ indent: block.indent, text: text.slice(0, -1) });
      return skip('introduces what follows', text);
    }
    if (/^`[^`]+`$/.test(text) || COMMAND.test(text)) return skip('a command, not a statement', text);

    const file = asFile(text);
    if (file) {
      rules.push({
        headings: block.headings,
        category: 'important_files',
        importance: 'medium',
        text: `${file.path} — ${file.purpose}`,
        detail: null,
        fields: { path: file.path, purpose: file.purpose },
        line: block.line,
      });
      return;
    }

    if (text.split(/\s+/).length < MIN_WORDS) return skip('too short to be a statement', text);

    const { category, importance } = classify(text, block.headings);
    if (block.kind === 'paragraph') {
      // A paragraph directly above a list is its preamble: the list carries the content.
      const next = blocks[n + 1];
      if (next?.kind === 'bullet' && next.headings.join('\0') === block.headings.join('\0')) {
        return skip('introduces a list', text);
      }
      if (!RULE_CUE.test(text) && !DESCRIPTIVE.has(category)) return skip('description, not a rule', text);
    }

    const intro = block.kind === 'bullet' ? intros[intros.length - 1] : undefined;
    if (intro && intro.indent < block.indent && intro.text.length <= 80) text = `${intro.text}: ${text}`;

    rules.push({ headings: block.headings, category, importance, ...summarize(text), fields: {}, line: block.line });
  });

  return { rules, skipped };
}
