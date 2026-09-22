import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { NativeMemoryEntry } from '../adapters/index.js';
import { contentHash } from '../core/ids.js';
import { parseInstructionMarkdown } from '../core/instructions.js';
import { redactText } from '../core/redact.js';
import type { ContextStore } from '../store/store.js';
import { planImport, type ImportPlan } from './import-native.js';
import { MIRROR_MARKERS } from './mirror.js';

/**
 * `contextd import --from markdown <file...>`: the rules in instruction files (CLAUDE.md,
 * AGENTS.md, GEMINI.md, `.cursor/rules/*.mdc`, any markdown) as memory items.
 *
 * Everything the claude-memory import promises holds here (invariant 47): `source: import`,
 * confidence under certainty, one patch through `commitPatch`, idempotent by content hash across
 * retired items too. A file is keyed per section (file + heading path), so an edited rule
 * replaces what it produced before.
 *
 * contextd's own mirror block is skipped: it is memory rendered into the file, and importing it
 * would feed memory back into itself on every run.
 */

export const MARKDOWN_SOURCE = 'markdown';

/** The file as stored: relative to the project when it is inside it, so a moved checkout still matches. */
function label(file: string, projectRoot: string): string {
  const rel = relative(projectRoot, file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
}

export function readInstructionFiles(
  files: readonly string[],
  projectRoot: string,
): { entries: NativeMemoryEntry[]; skipped: Array<{ file: string; reason: string }> } {
  const entries: NativeMemoryEntry[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const given of files) {
    const file = resolve(projectRoot, given);
    if (!existsSync(file) || !statSync(file).isFile()) {
      skipped.push({ file, reason: 'not a file' });
      continue;
    }
    const name = label(file, projectRoot);
    const parsed = parseInstructionMarkdown(readFileSync(file, 'utf8'), { exclude: [MIRROR_MARKERS] });
    for (const s of parsed.skipped) skipped.push({ file: `${name}:${s.line}`, reason: `${s.reason}: ${s.text}` });
    for (const rule of parsed.rules) {
      // Invariant 7: an instruction file can hold a token as easily as a transcript can.
      const text = redactText(rule.text).text;
      const detail = rule.detail ? redactText(rule.detail).text : null;
      const section = rule.headings.join(' > ');
      entries.push({
        file,
        key: `${name}#${section}`,
        hash: contentHash([rule.category, text, detail]),
        nativeType: null,
        title: section || null,
        category: rule.category,
        importance: rule.importance,
        text,
        detail,
        fields: { ...rule.fields, source_line: rule.line },
      });
    }
  }
  return { entries, skipped };
}

export function planMarkdownImport(store: ContextStore, files: readonly string[], projectRoot: string): ImportPlan {
  return planImport(
    store,
    MARKDOWN_SOURCE,
    files.map((f) => label(resolve(projectRoot, f), projectRoot)).join(', '),
    readInstructionFiles(files, projectRoot),
  );
}
