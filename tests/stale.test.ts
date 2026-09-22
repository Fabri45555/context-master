import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AddItem } from '../src/core/patch.js';
import { extractPathReferences, itemReferences } from '../src/core/references.js';
import type { MemoryItem } from '../src/core/state.js';
import type { ContextManager } from '../src/daemon/manager.js';
import { STALE_TAG, staleReferences } from '../src/daemon/stale.js';
import { diagnose } from '../src/daemon/doctor.js';
import { makeManager } from './helpers.js';

function touch(root: string, rel: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), '// file\n');
}

function add(m: ContextManager, item: AddItem & { id: string }, origin: 'worker' | 'user' = 'worker'): void {
  const r = m.store.commitPatch({ add: [item] }, origin);
  expect(r.ok, JSON.stringify(r.violations)).toBe(true);
}

function withManager(fn: (m: ContextManager, root: string) => void): void {
  const { manager, root, cleanup } = makeManager();
  try {
    fn(manager, root);
  } finally {
    cleanup();
  }
}

const item = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'x',
  category: 'decisions',
  text: '',
  fields: {},
  importance: 'medium',
  confidence: 0.8,
  status: 'active',
  source: 'worker',
  evidence: [],
  reason: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_used_at: null,
  last_validated_at: null,
  ttl_seconds: null,
  supersedes: [],
  superseded_by: null,
  tags: [],
  retrieved_count: 0,
  ...over,
});

describe('path extraction', () => {
  it('takes backticked paths and slash-paths with a known extension', () => {
    expect(
      extractPathReferences('The fold lives in `src/core/fold.ts`, tests in tests/core.test.ts.', '/proj').sort(),
    ).toEqual(['src/core/fold.ts', 'tests/core.test.ts']);
    expect(extractPathReferences('see /proj/src/a.ts:42 and `./src/b.ts#L10`', '/proj').sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('refuses what is not one file in this project', () => {
    const text = [
      'https://github.com/org/repo/blob/main/src/a.ts',
      '`src/**/*.ts`',
      '`src/{a,b}.ts`',
      '`index.ts`',
      '/etc/hosts.conf',
      '/Users/else/proj/src/a.ts',
      '`../other/src/a.ts`',
      '`npm run build`',
      '`@types/node`',
      'src/assets/logo.png',
      '`~/notes/todo.md`',
      '`$HOME/x/y.ts`',
    ].join(' ');
    expect(extractPathReferences(text, '/proj')).toEqual([]);
  });

  it('does not check history, closed work, quoted errors, or text about a file being gone', () => {
    expect(itemReferences(item({ category: 'completed_work', text: 'added `src/a.ts`' }), '/p')).toBeNull();
    expect(itemReferences(item({ text: 'removed `src/legacy.ts`; callers use the store' }), '/p')).toBeNull();
    expect(itemReferences(item({ category: 'goals', text: 'ship `src/a.ts`', fields: { closed_at: 'x' } }), '/p')).toBeNull();
    expect(
      itemReferences(item({ category: 'known_issues', source: 'deterministic', text: 'Error at src/a.ts:3' }), '/p'),
    ).toBeNull();
    expect(itemReferences(item({ text: 'The old parser in `src/p.ts` was removed.' }), '/p')).toBeNull();
  });

  it('reads a cue word in a file name as a file name', () => {
    // Found by the lifecycle test below: `src/gone.ts` matched the "gone" cue and was never checked.
    expect(itemReferences(item({ text: '`api/delete_user.py` is the only writer of the users table' }), '/p')).toEqual({
      present: ['api/delete_user.py'],
      absent: [],
    });
  });
});

describe('stale file references', () => {
  it('retires an item whose file is gone, and revives it when the file comes back', () => {
    withManager((m, root) => {
      touch(root, 'src/parser.ts');
      add(m, { id: 'f1', category: 'important_files', text: 'src/parser.ts', fields: { path: 'src/parser.ts', purpose: 'parses' } });
      add(m, { id: 'd1', category: 'decisions', text: 'Parsing is centralised in `src/parser.ts` so errors carry positions.' });

      expect(m.verifyReferences({ force: true })!.stale).toHaveLength(0);

      rmSync(join(root, 'src/parser.ts'));
      const r = m.verifyReferences({ force: true })!;
      expect(r.stale.map((s) => s.id).sort()).toEqual(['d1', 'f1']);
      for (const id of ['d1', 'f1']) {
        const it = m.store.getItem(id)!;
        expect(it.status).toBe('stale');
        expect(it.fields.stale_paths).toEqual(['src/parser.ts']);
      }
      // Stale is not served (invariant 13), and nothing was deleted.
      expect(m.bootstrapContext().text).not.toContain('src/parser.ts');

      // A second check with nothing new writes nothing.
      const version = m.store.stateVersion();
      m.verifyReferences({ force: true });
      expect(m.store.stateVersion()).toBe(version);

      // A branch switch brought the file back: the verdict is undone.
      touch(root, 'src/parser.ts');
      expect(m.verifyReferences({ force: true })!.revived.sort()).toEqual(['d1', 'f1']);
      expect(m.store.getItem('f1')!.status).toBe('active');
      expect(m.store.getItem('f1')!.fields.stale_paths).toBeNull();

      // The patch log reproduces all of it (invariant 3).
      expect(m.store.replay().items.find((i) => i.id === 'd1')!.status).toBe('active');
    });
  });

  it('keeps an item that still names one live file', () => {
    withManager((m, root) => {
      touch(root, 'src/b.ts');
      add(m, { id: 'd1', category: 'architecture', text: 'The parser in `src/a.ts` feeds the checker in `src/b.ts`.' });
      expect(staleReferences(m.store, root).stale).toHaveLength(0);
    });
  });

  it('flags a protected item without retiring it', () => {
    withManager((m) => {
      add(
        m,
        { id: 'c1', category: 'constraints', text: 'Never edit `src/generated/schema.ts` by hand.', source: 'user', importance: 'critical' },
        'user',
      );
      const r = m.verifyReferences({ force: true })!;
      expect(r.stale[0]).toMatchObject({ id: 'c1', protected: true });
      expect(r.committed).toBe(true);
      const c1 = m.store.getItem('c1')!;
      expect(c1.status).toBe('active');
      expect(c1.importance).toBe('critical');
      expect(c1.tags).toContain(STALE_TAG);
    });
  });

  it('does not call build output or a package-relative path missing', () => {
    withManager((m, root) => {
      writeFileSync(join(root, '.gitignore'), 'dist/\n');
      touch(root, 'api/app/services/x.py');
      add(m, { id: 'd1', category: 'conventions', text: 'Run the CLI as `node dist/cli/index.js`.' });
      add(m, { id: 'd2', category: 'discoveries', text: 'Tender scoring lives in app/services/x.py.' });
      expect(staleReferences(m.store, root).stale).toHaveLength(0);
    });
  });

  it('retires a path recovery once the wrong path has become a real file', () => {
    withManager((m, root) => {
      touch(root, 'src/fold.ts');
      add(m, {
        id: 'r1',
        category: 'discoveries',
        text: '`src/fold.js` does not exist; the file is `src/fold.ts`.',
        fields: { recovery: 'path', references: ['src/fold.ts'], absent_references: ['src/fold.js'] },
      });
      // The text names a missing file on purpose; the declared references are what count.
      expect(staleReferences(m.store, root).stale).toHaveLength(0);
      touch(root, 'src/fold.js');
      expect(staleReferences(m.store, root).stale[0]).toMatchObject({ id: 'r1', appeared: ['src/fold.js'] });
    });
  });

  it('runs on the maintain rung, throttled on the hook path', async () => {
    withManager(() => undefined);
    const { manager: m, cleanup } = makeManager();
    try {
      add(m, { id: 'f1', category: 'important_files', text: 'src/gone.ts', fields: { path: 'src/gone.ts' } });
      m.ingestOnly('claude', [{ hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }], {
        sessionId: 's1',
        cwd: m.projectRoot,
      });
      const first = await m.runLifecycle('s1', { deterministicOnly: true });
      expect(first.performed.find((p) => p.action === 'verify_refs')?.detail).toMatch(/^1 items/);
      expect(m.store.getItem('f1')!.status).toBe('stale');
      const second = await m.runLifecycle('s1', { deterministicOnly: true });
      expect(second.performed.find((p) => p.action === 'verify_refs')?.detail).toBe('checked recently');
    } finally {
      cleanup();
    }
  });
});

describe('doctor: file references', () => {
  const check = (m: ContextManager, root: string) =>
    diagnose(m, { host: { projectRoot: root, home: join(root, '.home'), vars: {} } }).find(
      (c) => c.name === 'file references',
    );

  it('names a protected item whose file is gone and tells the user how to retire it', () => {
    withManager((m, root) => {
      touch(root, 'src/live.ts');
      add(m, { id: 'f1', category: 'important_files', text: '`src/live.ts` holds the parser.' });
      expect(check(m, root)?.status).toBe('ok');

      add(
        m,
        { id: 'c1', category: 'constraints', text: 'Never edit `src/generated/schema.ts` by hand.', source: 'user', importance: 'critical' },
        'user',
      );
      const c = check(m, root);
      expect(c?.status).toBe('warn');
      expect(c?.detail).toContain('c1 (src/generated/schema.ts)');
      expect(c?.fix).toContain('contextd forget c1');
    });
  });

  it('says nothing when no item names a file', () => {
    withManager((m, root) => {
      add(m, { id: 'd1', category: 'decisions', text: 'Prefer small modules.' });
      expect(check(m, root)).toBeUndefined();
    });
  });
});
