import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Importance } from '../../core/events.js';
import { sha256 } from '../../core/ids.js';
import type { MemoryCategory } from '../../core/state.js';
import type { NativeMemoryEntry, NativeMemorySource } from '../types.js';
import { claudeProjectDir } from './hooks.js';

/**
 * Claude Code's auto-memory: `~/.claude/projects/<slug>/memory/*.md`, one memory per file, with a
 * frontmatter of `name`, `description` and a `type` (top-level, or under `metadata:`).
 *
 * `MEMORY.md` is the index Claude keeps of those files - pointers, not memory - so it is never
 * imported. Neither is anything without frontmatter: a note someone dropped in the directory is
 * not something Claude decided to remember.
 */

/**
 * Claude's four types, placed where contextd would have put them.
 *
 * `user` and `feedback` are how to work with this person - conventions, served every session.
 * `project` is the state of some piece of work at the time it was written, which is history:
 * query-only, like any discovery. `reference` points somewhere (a dashboard, a doc) and is found
 * when relevant, not paid for every session.
 */
const TYPE_MAP: Record<string, { category: MemoryCategory; importance: Importance }> = {
  user: { category: 'conventions', importance: 'medium' },
  feedback: { category: 'conventions', importance: 'medium' },
  project: { category: 'discoveries', importance: 'medium' },
  reference: { category: 'discoveries', importance: 'low' },
};
const FALLBACK = { category: 'discoveries' as MemoryCategory, importance: 'low' as Importance };

/** Long enough for a real memory; past it the text is a document and only its summary is kept. */
const MAX_TEXT_CHARS = 600;

export function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    const value = unquote(raw!.trim());
    if (indent!.length === 0) {
      parent = value.length === 0 ? key! : null;
      if (value.length > 0) fields[key!] = value;
    } else if (parent) {
      fields[`${parent}.${key}`] = value;
    }
  }
  return { fields, body: m[2]!.trim() };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function readClaudeMemory(dir: string): ReturnType<NativeMemorySource['read']> {
  const entries: NativeMemoryEntry[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  if (!existsSync(dir)) return { entries, skipped };
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (!name.endsWith('.md')) continue;
    if (name === 'MEMORY.md') {
      skipped.push({ file, reason: 'the index, not a memory' });
      continue;
    }
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const content = readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      skipped.push({ file, reason: 'no frontmatter' });
      continue;
    }
    const { fields, body } = parsed;
    const nativeType = (fields.type ?? fields['metadata.type'] ?? '').toLowerCase() || null;
    const title = fields.name ?? null;
    const description = fields.description ?? null;
    const summary = description ?? title;
    let text: string;
    let detail: string | null = null;
    if (body.length > 0 && body.length <= MAX_TEXT_CHARS) {
      text = body;
    } else if (summary) {
      text = summary;
      detail = body.length > 0 ? body : null;
    } else if (body.length > 0) {
      text = `${body.slice(0, MAX_TEXT_CHARS).trimEnd()}…`;
      detail = body;
    } else {
      skipped.push({ file, reason: 'empty' });
      continue;
    }
    const mapped = (nativeType && TYPE_MAP[nativeType]) || FALLBACK;
    entries.push({
      file,
      key: name,
      hash: sha256(content),
      nativeType,
      title,
      category: mapped.category,
      importance: mapped.importance,
      text,
      detail,
    });
  }
  return { entries, skipped };
}

export const claudeNativeMemory: NativeMemorySource = {
  name: 'claude-memory',
  description: "Claude Code auto-memory: ~/.claude/projects/<slug>/memory/*.md (MEMORY.md, the index, is skipped)",
  locate: (projectRoot, home) => join(claudeProjectDir(home, projectRoot), 'memory'),
  read: readClaudeMemory,
};
