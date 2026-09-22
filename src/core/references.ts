import { isAbsolute, normalize, relative, sep } from 'node:path';
import type { MemoryItem } from './state.js';
import { isClosed } from './patch.js';

/**
 * Which repository files a memory item points at.
 *
 * Pure: it reads text and fields, never the filesystem. Deciding whether a reference still
 * resolves is the caller's job ([stale.ts](../daemon/stale.ts)), so this can be tested without a
 * project on disk and reused by the fold.
 *
 * Deliberately conservative. A reference wrongly extracted is an item wrongly retired, while a
 * reference missed only means one stale item keeps being served - so anything ambiguous (a bare
 * `index.ts`, a glob, a URL, a path outside the project) is not a reference.
 */

/** Extensions of files a project keeps in its tree. Media and archives are artifacts, not source. */
export const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'txt',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'cs', 'fs', 'c', 'h',
  'cc', 'cpp', 'hpp', 'm', 'mm', 'swift', 'dart', 'lua', 'ex', 'exs', 'erl', 'clj', 'hs',
  'sql', 'prisma', 'graphql', 'gql', 'proto', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'gradle', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'css', 'scss', 'sass', 'less', 'html',
  'vue', 'svelte', 'astro', 'tf', 'hcl', 'nix', 'lock', 'r', 'jl', 'ipynb', 'tex', 'rst',
]);

export function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function hasSourceExtension(path: string): boolean {
  const ext = extensionOf(path);
  return ext != null && SOURCE_EXTENSIONS.has(ext);
}

/**
 * A path as seen from the project root, or null when it is not a path inside the project.
 *
 * Absolute paths elsewhere (another checkout, a scratch dir, a home-directory typo) and relative
 * paths that climb out with `..` are not references to this repository.
 */
export function projectRelative(path: string, root: string | null): string | null {
  let p = path.trim();
  if (p.length === 0 || p.includes('\0')) return null;
  if (isAbsolute(p)) {
    if (!root) return null;
    const rel = relative(root, p);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
    p = rel;
  } else {
    p = normalize(p);
    if (p.startsWith('..') || isAbsolute(p)) return null;
  }
  p = p.split(sep).join('/').replace(/^\.\//, '');
  return p.length > 0 && p !== '.' ? p : null;
}

/** Characters that make a token a pattern, a template or a URL rather than one file. */
const NOT_A_PATH = /[*?{}[\]<>|$~`'"\s\\]|:\/\/|^(?:https?|www\.|mailto:|file:)/i;

/** `src/a.ts:42`, `src/a.ts:42:7`, `src/a.ts#L10` all name `src/a.ts`. */
function stripLocation(token: string): string {
  return token.replace(/(?::\d+){1,2}$/, '').replace(/#L?\d+(?:-L?\d+)?$/, '');
}

function candidate(raw: string, root: string | null, requireSlash: boolean): string | null {
  const token = stripLocation(raw.trim().replace(/[.,;:!?)]+$/, ''));
  if (token.length === 0 || token.length > 300 || NOT_A_PATH.test(token)) return null;
  // A bare `index.ts` could be any of a dozen files; only a path with a directory resolves.
  if (requireSlash && !token.includes('/')) return null;
  if (!hasSourceExtension(token)) return null;
  // Scoped package names (`@types/node`) have a slash and sometimes a dotted tail.
  if (token.startsWith('@') && !token.includes('/', token.indexOf('/') + 1)) return null;
  return projectRelative(token, root);
}

const BACKTICKED = /`([^`\n]{1,300})`/g;
/** A slash-containing token with a known extension, delimited by whitespace or punctuation. */
const BARE_PATH = /(?:^|[\s(["'])((?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)(?=$|[\s)\]"',;:!?]|\.(?:\s|$))/g;

/** Every project path mentioned in a piece of text. */
export function extractPathReferences(text: string, root: string | null): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BACKTICKED)) {
    const c = candidate(m[1]!, root, true);
    if (c) out.add(c);
  }
  // Outside backticks, with the backticked spans blanked so their contents are not read twice.
  const bare = text.replace(BACKTICKED, ' ');
  for (const m of bare.matchAll(BARE_PATH)) {
    const c = candidate(m[1]!, root, true);
    if (c) out.add(c);
  }
  return [...out];
}

/**
 * Text that talks about a file being gone. Such an item refers to the path *because* it no
 * longer exists - "removed `src/legacy.ts`, its callers use the store directly" - so a missing
 * file is its subject, not evidence that it went stale.
 */
const ABSENCE_CUE =
  /\b(?:delet|remov|renam|mov(?:e|ed|ing)\b|replac|drop(?:ped)?\b|obsolete|no longer|does not exist|doesn't exist|gone\b|was split|merged into|no such|not found|cannot find|can't find|missing\b|ENOENT)/i;

/** Categories that are history: a finished piece of work may name a file that later went away. */
const HISTORY_CATEGORIES = new Set(['completed_work']);

export interface ItemReferences {
  /** Paths the item needs to exist to still be true. */
  present: string[];
  /** Paths the item says do not exist: if one appears, the item is wrong. */
  absent: string[];
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * The references a staleness check may act on for this item, or null when it must not be checked.
 *
 * An item that declares `fields.references` (and `fields.absent_references`) is taken at its word:
 * the fold writes those for its recovery rules, whose text names the wrong path on purpose.
 */
export function itemReferences(item: MemoryItem, root: string | null): ItemReferences | null {
  if (HISTORY_CATEGORIES.has(item.category) || isClosed(item)) return null;
  // The fold's known issues are quoted error output. A path inside a stack trace is where the
  // error happened, not a claim that the file exists - and their TTL retires them anyway.
  if (item.category === 'known_issues' && item.source === 'deterministic') return null;

  const declared = stringArray(item.fields.references);
  const declaredAbsent = stringArray(item.fields.absent_references);
  if (declared || declaredAbsent) {
    const rel = (xs: string[] | null) =>
      (xs ?? []).map((p) => projectRelative(p, root)).filter((p): p is string => p != null);
    return { present: rel(declared), absent: rel(declaredAbsent) };
  }

  // Read the prose, not the paths: `src/gone.ts` or `api/remove_user.py` is a file name, not a cue.
  const prose = item.text.replace(BACKTICKED, ' ').replace(/\S*(?:\/|\.\w)\S*/g, ' ');
  if (ABSENCE_CUE.test(prose)) return null;
  const present = new Set(extractPathReferences(item.text, root));
  // An important file names itself in `fields.path`; a bare filename there is still that file.
  const own = typeof item.fields.path === 'string' ? item.fields.path : null;
  if (own) {
    const c = candidate(own, root, false);
    if (c) present.add(c);
  }
  return { present: [...present], absent: [] };
}
