import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { looksLikePath, parseInstructionMarkdown } from '../src/core/instructions.js';
import { MAX_INFERRED_CONFIDENCE } from '../src/core/patch.js';
import { applyNativeImport } from '../src/ops/import-native.js';
import { planMarkdownImport } from '../src/ops/import-markdown.js';
import { MIRROR_MARKERS, writeMirror } from '../src/ops/mirror.js';
import { makeManager } from './helpers.js';

/**
 * `import --from markdown`: instruction files as memory. The fixtures are shaped like real ones -
 * this repository's own CLAUDE.md among them - because the failure to guard against is junk:
 * table rows, command listings and list preambles turned into "rules".
 */

const REPO_CLAUDE_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'CLAUDE.md');

const AGENTS_MD = `# Acme API

This service handles billing webhooks for Acme.

## Setup

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

- \`pnpm test\`
- pnpm lint --fix

## Code style

- Use named exports; default exports are not allowed in \`src/\`.
- Prefer \`zod\` schemas at every API boundary.
- TypeScript

## Rules

We keep a short list of hard rules:

1. Never log a full card number, even in debug builds.
2. Every migration must be reversible.
   Write the \`down\` step in the same file.

## Project structure

| Path | Purpose |
|------|---------|
| \`src/webhooks/\` | Stripe and Adyen webhook handlers |
| \`src/db/schema.ts\` | Drizzle schema, the single source of truth for tables |
| npm run build | compiles |

- \`src/jobs/retry.ts\` — retries failed deliveries with backoff
- docs/runbook.md: what to do when the queue backs up

## When changing the queue
- Before touching the retry logic:
  - read docs/queue.md first
  - run the soak test locally

## Known issues

- The Adyen sandbox drops every tenth webhook; tests retry around it.
`;

const CURSOR_MDC = `---
description: Frontend rules
globs: src/web/**
alwaysApply: false
---

# Frontend

- Components must be server components unless they need state.
- Tailwind only; do not add CSS modules.
`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'contextd-md-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('parsing instruction markdown', () => {
  const parsed = parseInstructionMarkdown(AGENTS_MD);
  const texts = parsed.rules.map((r) => r.text);
  const find = (s: string) => parsed.rules.find((r) => r.text.includes(s));

  it('keeps rules and files, with categories from headings and wording', () => {
    expect(find('named exports')?.category).toBe('conventions');
    expect(find('zod')?.category).toBe('conventions');
    expect(find('card number')?.category).toBe('constraints');
    expect(find('card number')?.importance).toBe('high');
    // A continuation line belongs to its item.
    expect(find('reversible')?.text).toBe('Every migration must be reversible. Write the `down` step in the same file.');
    expect(find('Adyen sandbox')?.category).toBe('known_issues');

    const files = parsed.rules.filter((r) => r.category === 'important_files');
    expect(files.map((f) => f.fields.path)).toEqual([
      'src/webhooks/',
      'src/db/schema.ts',
      'src/jobs/retry.ts',
      'docs/runbook.md',
    ]);
    expect(files[1]?.fields.purpose).toBe('Drizzle schema, the single source of truth for tables');
  });

  it('prefixes a nested item with the bullet that introduces it', () => {
    expect(texts).toContain('Before touching the retry logic: read docs/queue.md first');
    expect(texts).toContain('Before touching the retry logic: run the soak test locally');
  });

  it('drops code, commands, table headers, preambles and labels - and says why', () => {
    for (const t of texts) {
      expect(t).not.toMatch(/^\|/);
      expect(t).not.toMatch(/pnpm (install|dev|test|lint)/);
      expect(t).not.toContain('We keep a short list');
      expect(t).not.toBe('TypeScript');
      expect(t).not.toContain('handles billing webhooks');
    }
    const reasons = parsed.skipped.map((s) => s.reason);
    expect(reasons).toContain('code block');
    expect(reasons).toContain('a command, not a statement');
    expect(reasons).toContain('table row'); // `npm run build | compiles`
    expect(reasons).toContain('introduces what follows');
    expect(reasons).toContain('too short to be a statement');
  });

  it('reads a Cursor rule past its frontmatter', () => {
    const r = parseInstructionMarkdown(CURSOR_MDC).rules;
    expect(r.map((x) => x.text)).toEqual([
      'Components must be server components unless they need state.',
      'Tailwind only; do not add CSS modules.',
    ]);
    expect(r.every((x) => x.category === 'constraints')).toBe(true);
    expect(r[0]?.line).toBe(9);
  });

  it("skips contextd's own mirror block, which would feed memory back into itself", () => {
    const content = `# Notes\n\n- Always use UTC in logs.\n\n${MIRROR_MARKERS.start}\n## Active constraints\n- Never push to main [c1]\n${MIRROR_MARKERS.end}\n`;
    const r = parseInstructionMarkdown(content, { exclude: [MIRROR_MARKERS] }).rules;
    expect(r.map((x) => x.text)).toEqual(['Always use UTC in logs.']);
  });

  it('tells a path from a word with a dot in it', () => {
    expect(looksLikePath('src/core/')).toBe(true);
    expect(looksLikePath('package.json')).toBe(true);
    expect(looksLikePath('e.g.')).toBe(false);
    expect(looksLikePath('https://example.com/x')).toBe(false);
    expect(looksLikePath('Node 22')).toBe(false);
  });

  it("turns this repository's CLAUDE.md into rules, files and conventions - no junk", () => {
    const r = parseInstructionMarkdown(readFileSync(REPO_CLAUDE_MD, 'utf8'));
    const invariants = r.rules.filter((x) => x.headings.at(-1) === 'Invariants');
    expect(invariants.length).toBeGreaterThanOrEqual(40);
    expect(invariants.every((x) => x.category === 'constraints')).toBe(true);
    expect(invariants[0]?.text).toMatch(/^Deterministic first\. Every event passes `deterministic\.ts`/);

    const files = r.rules.filter((x) => x.category === 'important_files').map((x) => x.fields.path);
    expect(files).toContain('src/core/');
    expect(files).toContain('src/cli/');

    const always = r.rules.find((x) => x.text.startsWith('Always run `npm test`'));
    expect(always?.category).toBe('constraints');
    expect(r.rules.find((x) => x.text.startsWith('Memory has three levels'))?.category).toBe('architecture');

    for (const x of r.rules) {
      expect(x.text).not.toMatch(/^\|/); // table rows
      expect(x.text).not.toMatch(/^(node|npm) /); // command lines
      expect(x.text).not.toMatch(/# vitest|--no-hooks/); // code block contents
      expect(x.text).not.toMatch(/:$/); // list preambles
      expect(x.text).not.toMatch(/\*\*|\]\(/); // markup
    }
  });
});

describe('import --from markdown', () => {
  it('imports as source import below certainty, and is a no-op the second time', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      writeFileSync(join(root, 'AGENTS.md'), AGENTS_MD);
      mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
      writeFileSync(join(root, '.cursor', 'rules', 'web.mdc'), CURSOR_MDC);
      const files = ['AGENTS.md', '.cursor/rules/web.mdc'];

      const plan = planMarkdownImport(manager.store, files, root);
      expect(plan.dir).toBe('AGENTS.md, .cursor/rules/web.mdc');
      expect(plan.changes.every((c) => c.action === 'add')).toBe(true);
      const r = applyNativeImport(manager, plan);
      expect(r.ok).toBe(true);
      expect(r.added.length).toBe(plan.changes.length);

      const items = manager.store.allItems(false).filter((i) => i.status === 'active');
      for (const i of items) {
        expect(i.source).toBe('import');
        expect(i.confidence).toBeLessThanOrEqual(MAX_INFERRED_CONFIDENCE);
        expect(i.importance).not.toBe('critical');
      }
      const file = items.find((i) => i.fields.path === 'src/db/schema.ts');
      expect(file?.category).toBe('important_files');
      expect(file?.fields.purpose).toContain('Drizzle schema');
      expect(file?.fields.imported_from).toBe('markdown');
      expect(file?.fields.import_key).toBe('AGENTS.md#Acme API > Project structure');

      const again = planMarkdownImport(manager.store, files, root);
      expect(again.changes).toHaveLength(0);
      expect(again.unchanged).toHaveLength(plan.changes.length);

      const replayed = manager.store.replay();
      expect(replayed.items.map((i) => i.id).sort()).toEqual(manager.store.currentState(true).items.map((i) => i.id).sort());
    } finally {
      cleanup();
    }
  });

  it('replaces an edited rule, reports a removed one, and never resurrects a retired one', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const path = join(root, 'CLAUDE.md');
      writeFileSync(path, '# P\n\n## Rules\n\n- Never commit to main.\n- Every PR must have a test.\n- Secrets must stay in the vault.\n');
      applyNativeImport(manager, planMarkdownImport(manager.store, ['CLAUDE.md'], root));
      const byText = (t: string) => manager.store.allItems(true).find((i) => i.text.includes(t))!;
      const vault = byText('vault');
      expect(manager.retire([vault.id], 'not a rule here').ok).toBe(true);

      writeFileSync(path, '# P\n\n## Rules\n\n- Never commit to main; use a branch.\n- Secrets must stay in the vault.\n');
      const plan = planMarkdownImport(manager.store, ['CLAUDE.md'], root);
      // The edited rule replaces its predecessor; the retired one stays retired.
      expect(plan.changes.map((c) => [c.action, c.entry.text])).toEqual([['replace', 'Never commit to main; use a branch.']]);
      expect(plan.orphaned.map((o) => o.text)).toEqual(['Every PR must have a test.']);
      applyNativeImport(manager, plan);
      expect(manager.store.getItem(byText('Never commit to main.').id)?.status).toBe('superseded');
      expect(manager.store.getItem(vault.id)?.status).not.toBe('active');
      // Reported, not retired: removing a rule from the file is not a decision about memory.
      expect(byText('Every PR').status).toBe('active');
    } finally {
      cleanup();
    }
  });

  it('never imports its own mirror block from a file it has mirrored into', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ category: 'constraints', text: 'Never push to main without review', source: 'user' }] });
      const path = join(root, 'CLAUDE.local.md');
      writeFileSync(path, '# Mine\n\n- Always answer in English.\n');
      writeMirror(manager, path);
      expect(readFileSync(path, 'utf8')).toContain('Never push to main without review');
      const plan = planMarkdownImport(manager.store, ['CLAUDE.local.md'], root);
      expect(plan.changes.map((c) => c.entry.text)).toEqual(['Always answer in English.']);
    } finally {
      cleanup();
    }
  });

  it('redacts a secret an instruction file holds', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      writeFileSync(join(root, 'AGENTS.md'), '## Rules\n\n- Always use API_KEY=sk-live-abcdef123456 for staging.\n');
      const plan = planMarkdownImport(manager.store, ['AGENTS.md'], root);
      expect(plan.changes[0]?.entry.text).not.toContain('sk-live-abcdef123456');
    } finally {
      cleanup();
    }
  });

  it('skips a file that does not exist without failing the rest', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'GEMINI.md'), '- Never edit generated files in gen/.\n');
    const { manager, cleanup } = makeManager();
    try {
      const plan = planMarkdownImport(manager.store, [join(dir, 'GEMINI.md'), join(dir, 'nope.md')], dir);
      expect(plan.changes).toHaveLength(1);
      expect(plan.skipped.map((s) => s.reason)).toContain('not a file');
    } finally {
      cleanup();
    }
  });
});
