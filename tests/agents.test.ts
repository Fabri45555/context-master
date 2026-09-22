import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  cursorAdapter,
  geminiAdapter,
  getIngestAdapter,
  INGEST_ADAPTER_NAMES,
  ingests,
  isContextdLaunch,
  opencodeAdapter,
  type HostEnv,
} from '../src/adapters/index.js';
import { claudeHookInstaller } from '../src/adapters/claude/hooks.js';
import { opencodeUserConfig } from '../src/adapters/opencode/index.js';
import { diagnose } from '../src/daemon/doctor.js';
import { buildDrift, newestSource } from '../src/daemon/drift.js';
import { mcpInstall, mcpStatus, mcpUninstall, uninstallWiring } from '../src/ops/install.js';
import {
  checkMirror,
  MDC_FRONTMATTER,
  mirrorCreatedFiles,
  mirrorTarget,
  removeMirror,
  resolveMirrorTarget,
  writeMirror,
} from '../src/ops/mirror.js';
import { makeManager } from './helpers.js';

/**
 * Per-agent mirror budgets, the agents contextd serves but cannot observe (Cursor, Gemini CLI,
 * opencode), and build drift. Every path is a temp dir and no binary is ever run (invariant 48).
 */

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `contextd-${prefix}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function host(projectRoot: string, extra: Partial<HostEnv> = {}): HostEnv {
  return { projectRoot, home: tmp('home'), ...extra };
}

const LAUNCH = { command: 'node', args: ['/opt/contextd/dist/cli/index.js'] };
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;

describe('the bootstrap under an explicit budget', () => {
  it('drops whole items to fit and names the way back; never cuts text', () => {
    const { manager, cleanup } = makeManager();
    try {
      const add = Array.from({ length: 40 }, (_, n) => ({
        category: 'constraints' as const,
        text: `Constraint number ${n} says the payment service must retry idempotently before failing over`,
        source: 'user' as const,
      }));
      manager.remember({ add });
      const full = manager.bootstrapContext();
      const small = manager.bootstrapContext({ budget: 400 });
      expect(small.tokens).toBeLessThanOrEqual(400);
      expect(small.budget).toBe(400);
      expect(small.itemIds.length).toBeGreaterThan(0);
      expect(small.itemIds.length).toBeLessThan(full.itemIds.length);
      expect(small.text).toContain('omitted for budget - memory_query category="constraints"');
      // Every item shown is shown whole.
      for (const line of small.text.split('\n').filter((l) => l.startsWith('- Constraint'))) {
        expect(line).toMatch(/failing over \[\w+\]$/);
      }
      // A budget larger than the configured slice does not grow it.
      expect(manager.bootstrapContext({ budget: 100_000 }).text).toBe(full.text);
    } finally {
      cleanup();
    }
  });
});

describe('per-agent mirror targets', () => {
  it('resolves declared targets, agent names and paths, with their format and budget', () => {
    const root = '/p';
    expect(mirrorTarget('claude-local', root)).toMatchObject({ path: '/p/CLAUDE.local.md', format: 'markdown', budget: 2000 });
    expect(mirrorTarget('claude', root).path).toBe('/p/CLAUDE.local.md');
    expect(mirrorTarget('agents', root)).toMatchObject({ path: '/p/AGENTS.md', budget: 3000 });
    expect(mirrorTarget('codex', root).path).toBe('/p/AGENTS.md');
    expect(mirrorTarget('gemini', root)).toMatchObject({ path: '/p/GEMINI.md', format: 'markdown', budget: 3000 });
    expect(mirrorTarget('cursor', root)).toMatchObject({ path: '/p/.cursor/rules/contextd.mdc', format: 'mdc', budget: 3000 });
    // A declared file named by path is the same target.
    expect(mirrorTarget('.cursor/rules/contextd.mdc', root).budget).toBe(3000);
    expect(mirrorTarget('notes/rules.mdc', root)).toMatchObject({ format: 'mdc', budget: null, declared: null });
    expect(mirrorTarget('AGENTS.md', root, { budget: 500 }).budget).toBe(500);
    // opencode reads AGENTS.md and declares nothing of its own: never a file called "opencode".
    expect(() => resolveMirrorTarget('opencode', root)).toThrow(/declares no instruction file/);
  });

  it('creates a Cursor rule with alwaysApply, fits it to the budget, and removes it whole', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      manager.remember({
        add: Array.from({ length: 30 }, (_, n) => ({
          category: 'decisions' as const,
          text: `Decision ${n}: the ingest queue is drained by a single writer so replay stays deterministic`,
          source: 'user' as const,
        })),
      });
      const target = mirrorTarget('cursor', root, { budget: 600 });
      const w = writeMirror(manager, target);
      expect(w.created).toBe(true);
      expect(w.tokens).toBeLessThanOrEqual(600);
      expect(w.omitted).toBeGreaterThan(0);
      const text = readFileSync(target.path, 'utf8');
      expect(text.startsWith(`${MDC_FRONTMATTER}\n<!-- contextd:start -->`)).toBe(true);
      expect(text).toContain('alwaysApply: true');
      expect(checkMirror(manager, target).stale).toBe(false);
      const log = manager.store.db.prepare(`SELECT query FROM retrieval_log`).all() as Array<{ query: string }>;
      expect(log.map((r) => r.query)).toEqual(['(mirror)']);

      // Refreshed by path alone (as maintenance does), it keeps the declared format and budget.
      expect(writeMirror(manager, target.path).budget).toBe(3000);

      expect(mirrorCreatedFiles(manager)).toContain(target.path);
      expect(removeMirror(target.path, true)).toBe('deleted');
      expect(existsSync(target.path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("adds a block to an existing rule file without touching its frontmatter", () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const path = join(root, '.cursor', 'rules', 'contextd.mdc');
      mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
      const theirs = '---\ndescription: mine\nalwaysApply: false\n---\n\nMy rule.\n';
      writeFileSync(path, theirs);
      writeMirror(manager, 'cursor');
      const text = readFileSync(path, 'utf8');
      expect(text.startsWith(theirs.trimEnd())).toBe(true);
      expect(text.match(/alwaysApply/g)).toHaveLength(1);
      expect(removeMirror(path, false)).toBe('removed');
      expect(readFileSync(path, 'utf8')).toBe(theirs);
    } finally {
      cleanup();
    }
  });
});

describe('agents contextd serves but cannot observe', () => {
  it('declare no ingestion surface, and refuse to ingest', async () => {
    for (const a of [cursorAdapter, geminiAdapter, opencodeAdapter]) {
      expect(ingests(a)).toBe(false);
      expect(a.surfaces).toEqual([expect.objectContaining({ kind: 'none', installable: false })]);
      expect(a.surfaces[0]?.description).toMatch(/^No ingestion/);
      expect(() => getIngestAdapter(a.name)).toThrow(/no ingestion surface/);
    }
    expect(INGEST_ADAPTER_NAMES).toEqual(['claude', 'codex', 'generic']);
    expect(Object.keys(ADAPTERS)).toEqual(expect.arrayContaining(['cursor', 'gemini', 'opencode']));
    const { manager, cleanup } = makeManager();
    try {
      await expect(manager.cycle('cursor', [{}], { sessionId: 's' })).rejects.toThrow(/no ingestion surface/);
    } finally {
      cleanup();
    }
  });

  it('recognise only commands with the shape contextd writes as theirs', () => {
    expect(isContextdLaunch({ command: 'contextd', args: ['mcp'] })).toBe(true);
    expect(isContextdLaunch({ command: 'node', args: ['/x/dist/cli/index.js', '-C', '/p', 'mcp'] })).toBe(true);
    expect(isContextdLaunch({ command: 'npx', args: ['-y', 'some-memory-server'] })).toBe(false);
    expect(isContextdLaunch({ command: 'contextd', args: ['serve'] })).toBe(false);
  });

  it('Cursor: project scope in .cursor/mcp.json, pinned, next to other servers', () => {
    const root = tmp('proj');
    const env = host(root);
    const file = join(root, '.cursor', 'mcp.json');
    mkdirSync(join(root, '.cursor'));
    writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } }));

    const r = mcpInstall(env, cursorAdapter, LAUNCH);
    expect(r).toMatchObject({ status: 'registered', scope: 'project', where: file });
    expect(json(file).mcpServers.contextd).toEqual({ command: 'node', args: [...LAUNCH.args, '-C', root, 'mcp'] });
    expect(json(file).mcpServers.github).toEqual({ command: 'gh-mcp', args: [] });
    expect(mcpInstall(env, cursorAdapter, LAUNCH).status).toBe('already');
    expect(mcpInstall(env, cursorAdapter, { command: 'contextd', args: [] }).status).toBe('conflict');
    expect(mcpInstall(env, cursorAdapter, { command: 'contextd', args: [] }, { force: true }).status).toBe('updated');

    const changes = mcpUninstall(env, cursorAdapter);
    expect(changes.map((c) => c.status)).toEqual(['removed']);
    expect(json(file)).toEqual({ mcpServers: { github: { command: 'gh-mcp', args: [] } } });
  });

  it('never replaces a same-named server it did not write, --force or not, and refuses a broken file', () => {
    const root = tmp('proj');
    const env = host(root);
    const file = join(env.home, '.gemini', 'settings.json');
    mkdirSync(join(env.home, '.gemini'));
    const theirs = { theme: 'dark', mcpServers: { contextd: { command: 'npx', args: ['someone-elses-contextd'] } } };
    writeFileSync(file, JSON.stringify(theirs));

    const r = mcpInstall(env, geminiAdapter, LAUNCH, { scope: 'user', force: true });
    expect(r.status).toBe('conflict');
    expect(r.detail).toContain('did not write');
    expect(json(file)).toEqual(theirs);
    expect(mcpUninstall(env, geminiAdapter).map((c) => c.status)).toEqual(['absent']);
    expect(json(file)).toEqual(theirs);
    expect(mcpStatus(env, [geminiAdapter]).rows[0]?.entry.managed).toBe(false);

    writeFileSync(file, '{ "theme": "dark", ');
    const broken = mcpInstall(env, geminiAdapter, LAUNCH, { scope: 'user' });
    expect(broken.status).toBe('failed');
    expect(broken.detail).toContain('refusing to rewrite');
    expect(readFileSync(file, 'utf8')).toBe('{ "theme": "dark", ');
  });

  it('Gemini: user scope keeps the rest of settings.json and is not pinned', () => {
    const root = tmp('proj');
    const env = host(root);
    const file = join(env.home, '.gemini', 'settings.json');
    mkdirSync(join(env.home, '.gemini'));
    writeFileSync(file, JSON.stringify({ theme: 'dark', selectedAuthType: 'oauth' }));
    expect(mcpInstall(env, geminiAdapter, LAUNCH, { scope: 'user' }).status).toBe('registered');
    expect(json(file)).toEqual({
      theme: 'dark',
      selectedAuthType: 'oauth',
      mcpServers: { contextd: { command: 'node', args: [...LAUNCH.args, 'mcp'] } },
    });
    // The project scope is the default, pinned, in .gemini/settings.json.
    expect(mcpInstall(env, geminiAdapter, LAUNCH).where).toBe(join(root, '.gemini', 'settings.json'));
    // Uninstall removes both, and leaves the settings as they were.
    const report = uninstallWiring({ env, adapters: Object.values(ADAPTERS), recordedHook: null, mirrorFiles: [] });
    expect(report.mcp.filter((m) => m.change.status === 'removed')).toHaveLength(2);
    expect(json(file)).toEqual({ theme: 'dark', selectedAuthType: 'oauth' });
  });

  it("opencode: its own entry shape under `mcp`, at the XDG or OPENCODE_CONFIG path", () => {
    const root = tmp('proj');
    const env = host(root);
    expect(opencodeUserConfig(env)).toBe(join(env.home, '.config', 'opencode', 'opencode.json'));
    expect(opencodeUserConfig({ ...env, vars: { XDG_CONFIG_HOME: '/xdg' } })).toBe('/xdg/opencode/opencode.json');
    expect(opencodeUserConfig({ ...env, vars: { OPENCODE_CONFIG: '/etc/oc.json' } })).toBe('/etc/oc.json');

    const file = opencodeUserConfig(env);
    mkdirSync(join(env.home, '.config', 'opencode'), { recursive: true });
    writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'x/y' }));
    expect(mcpInstall(env, opencodeAdapter, LAUNCH).status).toBe('registered');
    expect(json(file).mcp.contextd).toEqual({ type: 'local', command: ['node', ...LAUNCH.args, 'mcp'], enabled: true });
    expect(json(file).model).toBe('x/y');
    const status = mcpStatus(env, [opencodeAdapter]);
    expect(status.rows[0]).toMatchObject({ servesThisProject: true, entry: { managed: true, scope: 'user' } });
    expect(mcpUninstall(env, opencodeAdapter).map((c) => c.status)).toEqual(['removed']);
    expect(json(file)).toEqual({ $schema: 'https://opencode.ai/config.json', model: 'x/y' });
  });

  it('doctor checks one only where it is used, and says it is not observed', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const env = host(root);
      const names = () => diagnose(manager, { host: env, checkoutRoot: null }).map((c) => c.name);
      expect(names()).not.toContain('cursor: mcp');
      expect(names()).not.toContain('gemini: mcp');

      mkdirSync(join(env.home, '.cursor'));
      const checks = diagnose(manager, { host: env, checkoutRoot: null });
      expect(checks.find((c) => c.name === 'cursor: mcp')).toMatchObject({ status: 'skip' });
      expect(checks.find((c) => c.name === 'cursor: mcp')?.fix).toContain('--adapter cursor');
      expect(checks.find((c) => c.name === 'cursor: ingestion')).toMatchObject({ status: 'skip' });
      expect(checks.find((c) => c.name === 'cursor: transcript')).toBeUndefined();
      expect(checks.find((c) => c.name === 'cursor: hooks')).toBeUndefined();
      expect(names()).not.toContain('gemini: mcp');

      const script = join(root, 'index.js');
      writeFileSync(script, '');
      mcpInstall(env, cursorAdapter, { command: 'node', args: [script] });
      expect(diagnose(manager, { host: env, checkoutRoot: null }).find((c) => c.name === 'cursor: mcp')?.status).toBe('ok');
    } finally {
      cleanup();
    }
  });
});

describe('doctor: build drift', () => {
  /** A checkout: package.json, a build, and a source tree. */
  function checkout(version: string): { root: string; script: string; source: string } {
    const root = tmp('checkout');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'contextd', version }));
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    const script = join(root, 'dist', 'cli', 'index.js');
    const source = join(root, 'src', 'core', 'fold.ts');
    writeFileSync(script, '');
    writeFileSync(source, '');
    return { root, script, source };
  }
  const at = (p: string, ms: number) => utimesSync(p, new Date(ms), new Date(ms));

  it('finds the newest source file, skipping dependencies and declarations', () => {
    const c = checkout('0.1.0');
    const t = Date.now() - 60_000;
    at(c.source, t);
    mkdirSync(join(c.root, 'src', 'node_modules'));
    writeFileSync(join(c.root, 'src', 'node_modules', 'x.ts'), '');
    writeFileSync(join(c.root, 'src', 'types.d.ts'), '');
    expect(newestSource(join(c.root, 'src'))?.path).toBe(c.source);
  });

  it('warns when the source is newer than the build the hooks and MCP run, or the version differs', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const c = checkout('0.1.0');
      const env = host(root);
      const hook = `node ${c.script} -C ${root} hook`;
      claudeHookInstaller.install(env, { command: hook });
      manager.noteInstalledHookCommand(hook);
      mcpInstall(env, ADAPTERS.claude!, { command: 'node', args: [c.script] }, { scope: 'project' });
      const now = Date.now();
      at(c.script, now - 3_600_000);
      at(c.source, now);

      const build = () => diagnose(manager, { host: env, checkoutRoot: c.root }).filter((x) => x.name === 'build');
      let checks = build();
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: 'warn', fix: `rebuild: npm run build (in ${c.root})` });
      expect(checks[0]?.detail).toContain('claude hooks, claude mcp');
      expect(checks[0]?.detail).toContain('src/core/fold.ts is 60m newer than the build');

      at(c.script, now + 1000);
      checks = build();
      expect(checks[0]).toMatchObject({ status: 'ok' });
      expect(checks[0]?.detail).toContain('is current, v0.1.0');

      // A different checkout runs doctor: the installed build is another version.
      const other = checkout('0.2.0');
      const drift = diagnose(manager, { host: env, checkoutRoot: other.root }).find((x) => x.name === 'build');
      expect(drift?.status).toBe('warn');
      expect(drift?.detail).toContain('it is v0.1.0, this checkout is v0.2.0');
    } finally {
      cleanup();
    }
  });

  it('says nothing about a build with no source beside it, or one that is gone', () => {
    const pkg = tmp('pkg');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    mkdirSync(join(pkg, 'dist'));
    writeFileSync(join(pkg, 'dist', 'index.js'), '');
    expect(buildDrift(join(pkg, 'dist', 'index.js'), pkg)).toMatchObject({ newerSource: null, versionMismatch: null });
    expect(buildDrift(join(pkg, 'dist', 'gone.js'), pkg)).toBeNull();
  });
});
