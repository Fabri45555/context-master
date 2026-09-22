import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter, codexAdapter, type CommandRunner, type HostEnv } from '../src/adapters/index.js';
import { claudeHookInstaller } from '../src/adapters/claude/hooks.js';
import { claudeJsonPath, claudeMcp } from '../src/adapters/claude/mcp.js';
import { CODEX_MARKERS, codexConfigPath, codexMcp } from '../src/adapters/codex/mcp.js';
import { claudeNativeMemory, parseFrontmatter } from '../src/adapters/claude/memory.js';
import { extractBlock, removeBlock, upsertBlock } from '../src/core/markers.js';
import { MAX_INFERRED_CONFIDENCE } from '../src/core/patch.js';
import { diagnose } from '../src/daemon/doctor.js';
import { ContextManager } from '../src/daemon/manager.js';
import { applyNativeImport, planNativeImport } from '../src/ops/import-native.js';
import { MCP_SERVER_NAME, mcpInstall, mcpStatus, uninstallWiring } from '../src/ops/install.js';
import {
  checkMirror,
  MIRROR_MARKERS,
  mirrorCreatedFiles,
  removeMirror,
  resolveMirrorTarget,
  writeMirror,
} from '../src/ops/mirror.js';
import { formatOverview, summarizeProject } from '../src/ops/overview.js';
import { entryIsLive, filterRegistry, readRegistry, registerProject, registryPath, unregisterProject } from '../src/ops/registry.js';
import { dbPath } from '../src/store/db.js';
import { isOurHookCommand, resolveCommand } from '../src/ops/self.js';
import type { EmbeddingProvider } from '../src/store/embeddings.js';
import { makeManager } from './helpers.js';

/**
 * Install, uninstall, mirror, import and the machine-wide status. Every path is a temp dir: a
 * test that touched the real ~/.claude.json or ~/.codex/config.toml would be editing the
 * developer's own agents.
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

/** No `which`: installers never reach for a real binary. */
function host(projectRoot: string, extra: Partial<HostEnv> = {}): HostEnv {
  return { projectRoot, home: tmp('home'), ...extra };
}

const LAUNCH = { command: 'node', args: ['/opt/contextd/dist/cli/index.js'] };

describe('marker blocks', () => {
  const m = { start: '<!-- s -->', end: '<!-- e -->' };

  it('appends, replaces in place, and removes without touching anything else', () => {
    const original = '# Notes\n\nmine, keep me\n';
    const once = upsertBlock(original, m, 'v1');
    expect(once).toBe('# Notes\n\nmine, keep me\n\n<!-- s -->\nv1\n<!-- e -->\n');
    const twice = upsertBlock(`${once}trailing line\n`, m, 'v2');
    expect(twice).toContain('<!-- s -->\nv2\n<!-- e -->\ntrailing line');
    expect(twice.match(/<!-- s -->/g)).toHaveLength(1);
    expect(extractBlock(twice, m)).toBe('\nv2\n');
    expect(removeBlock(once, m)).toBe(original);
    expect(removeBlock(original, m)).toBeNull();
  });

  it('treats an unterminated start marker as absent rather than guessing where it ends', () => {
    const broken = 'a\n<!-- s -->\nb\n';
    expect(extractBlock(broken, m)).toBeNull();
    expect(removeBlock(broken, m)).toBeNull();
  });
});

describe('claude MCP registration', () => {
  it('writes each scope to its own file, idempotently, pinned with -C', () => {
    const root = tmp('proj');
    const env = host(root);
    const first = claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'local');
    expect(first.status).toBe('registered');
    const cfg = JSON.parse(readFileSync(claudeJsonPath(env), 'utf8'));
    expect(cfg.projects[root].mcpServers.contextd.args).toEqual([...LAUNCH.args, '-C', root, 'mcp']);
    expect(claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'local').status).toBe('already');

    expect(claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'project').status).toBe('registered');
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect(claudeMcp.get(env, MCP_SERVER_NAME).map((e) => e.scope).sort()).toEqual(['local', 'project']);
  });

  it('keeps everything else in ~/.claude.json and refuses to rewrite one it cannot parse', () => {
    const root = tmp('proj');
    const env = host(root);
    writeFileSync(claudeJsonPath(env), JSON.stringify({ oauthAccount: { id: 'x' }, mcpServers: { other: { command: 'o' } } }));
    claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'user');
    const cfg = JSON.parse(readFileSync(claudeJsonPath(env), 'utf8'));
    expect(cfg.oauthAccount).toEqual({ id: 'x' });
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['contextd', 'other']);

    const env2 = host(root);
    writeFileSync(claudeJsonPath(env2), '{ not json');
    const r = claudeMcp.register(env2, MCP_SERVER_NAME, LAUNCH, 'user');
    expect(r.status).toBe('failed');
    expect(readFileSync(claudeJsonPath(env2), 'utf8')).toBe('{ not json');
  });

  it('reports a different command as a conflict unless forced', () => {
    const root = tmp('proj');
    const env = host(root);
    claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'local');
    const moved = { command: 'node', args: ['/new/place/dist/cli/index.js'] };
    expect(claudeMcp.register(env, MCP_SERVER_NAME, moved, 'local').status).toBe('conflict');
    expect(claudeMcp.register(env, MCP_SERVER_NAME, moved, 'local', { force: true }).status).toBe('updated');
    expect(claudeMcp.get(env, MCP_SERVER_NAME, 'local')[0]?.args[0]).toBe('/new/place/dist/cli/index.js');
  });

  it('prefers `claude mcp add` when the binary is found, and falls back to the file when it fails', () => {
    const root = tmp('proj');
    const calls: string[][] = [];
    const exec: CommandRunner = (_bin, args) => {
      calls.push([...args]);
      if (args[1] === 'add') {
        // What the real CLI does for --scope project.
        const sep = args.indexOf('--');
        writeFileSync(
          join(root, '.mcp.json'),
          JSON.stringify({ mcpServers: { [args[4]!]: { type: 'stdio', command: args[sep + 1], args: args.slice(sep + 2) } } }),
        );
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const env = host(root, { which: (b) => (b === 'claude' ? '/fake/claude' : null), exec });
    const r = claudeMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'project');
    expect(r.status).toBe('registered');
    expect(r.detail).toContain('claude mcp add');
    expect(calls[0]).toEqual(['mcp', 'add', '--scope', 'project', 'contextd', '--', 'node', LAUNCH.args[0], '-C', root, 'mcp']);

    const failing = host(tmp('proj2'), {
      which: () => '/fake/claude',
      exec: () => ({ status: 1, stdout: '', stderr: 'boom' }),
    });
    const f = claudeMcp.register(failing, MCP_SERVER_NAME, LAUNCH, 'local');
    expect(f.status).toBe('registered');
    expect(f.detail).toContain('boom');
    expect(claudeMcp.get(failing, MCP_SERVER_NAME, 'local')).toHaveLength(1);
  });
});

describe('codex MCP registration', () => {
  const userConfig = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n# a comment the user wrote\n';

  it('writes only inside its markers and leaves the rest byte-for-byte', () => {
    const env = host(tmp('proj'));
    const path = codexConfigPath(env);
    mkdirSync(join(env.home, '.codex'), { recursive: true });
    writeFileSync(path, userConfig);
    expect(codexMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'user').status).toBe('registered');
    const written = readFileSync(path, 'utf8');
    expect(written.startsWith(userConfig)).toBe(true);
    expect(written).toContain(`${CODEX_MARKERS.start}\n[mcp_servers.contextd]\ncommand = "node"\nargs = ["${LAUNCH.args[0]}", "mcp"]\n${CODEX_MARKERS.end}`);
    // Global to every project: never pinned.
    expect(written).not.toContain('-C');

    expect(codexMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'user').status).toBe('already');
    expect(readFileSync(path, 'utf8')).toBe(written);
    expect(codexMcp.register(env, MCP_SERVER_NAME, { command: 'contextd', args: [] }, 'user').status).toBe('conflict');
    expect(codexMcp.register(env, MCP_SERVER_NAME, { command: 'contextd', args: [] }, 'user', { force: true }).status).toBe('updated');
    expect(readFileSync(path, 'utf8').match(/contextd MCP server/g)).toHaveLength(1);

    expect(codexMcp.unregister(env, MCP_SERVER_NAME, 'user').status).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe(userConfig);
  });

  it('never touches a same-named table the user wrote themselves', () => {
    const env = host(tmp('proj'));
    const path = codexConfigPath(env);
    mkdirSync(join(env.home, '.codex'), { recursive: true });
    const theirs = '[mcp_servers.contextd]\ncommand = "mine"\n';
    writeFileSync(path, theirs);
    expect(codexMcp.register(env, MCP_SERVER_NAME, LAUNCH, 'user', { force: true }).status).toBe('conflict');
    expect(codexMcp.unregister(env, MCP_SERVER_NAME, 'user').status).toBe('absent');
    expect(readFileSync(path, 'utf8')).toBe(theirs);
    expect(codexMcp.get(env, MCP_SERVER_NAME)).toEqual([expect.objectContaining({ managed: false })]);
  });
});

describe('hooks and uninstall', () => {
  it('removes only the hook entries contextd wrote for this project', () => {
    const root = tmp('proj');
    const env = host(root);
    const ours = `node /x/dist/cli/index.js -C ${root} hook`;
    claudeHookInstaller.install(env, { command: ours });
    const path = join(root, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'say done' });
    settings.permissions = { allow: ['Bash(ls)'] };
    writeFileSync(path, JSON.stringify(settings));

    expect(claudeHookInstaller.installed(env).map((h) => h.command).sort()).toEqual([ours, 'say done'].sort());
    const removed = claudeHookInstaller.uninstall(env, (c) => isOurHookCommand(c, root, null));
    expect(removed[0]?.events).toHaveLength(6);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(Object.keys(after.hooks)).toEqual(['Stop']);
    expect(after.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'say done' }]);
  });

  it('recognises our hook by the recorded command or by shape, and nobody else\'s', () => {
    expect(isOurHookCommand('node /a/dist/cli/index.js -C /p hook', '/p', null)).toBe(true);
    expect(isOurHookCommand('contextd -C /p hook', '/p', null)).toBe(true);
    expect(isOurHookCommand('contextd -C /other hook', '/p', null)).toBe(false);
    expect(isOurHookCommand('my-tool hook', '/p', 'my-tool hook')).toBe(true);
    expect(isOurHookCommand('my-tool -C /p hook', '/p', null)).toBe(false);
  });

  it('uninstall removes hooks, this project\'s MCP entries and mirror blocks - and keeps what is not ours', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const env = host(root);
      claudeHookInstaller.install(env, { command: `node /x/index.js -C ${root} hook` });
      mcpInstall(env, claudeAdapter, LAUNCH, { scope: 'local' });
      mcpInstall(env, codexAdapter, LAUNCH);
      // Pinned to another project: someone else's install.
      writeFileSync(
        claudeJsonPath(env),
        JSON.stringify({
          ...JSON.parse(readFileSync(claudeJsonPath(env), 'utf8')),
          mcpServers: { contextd: { command: 'node', args: ['/x', '-C', '/elsewhere', 'mcp'] } },
        }),
      );
      const mirror = resolveMirrorTarget('claude-local', root);
      writeFileSync(mirror, '# my notes\n');
      writeMirror(manager, mirror);

      const report = uninstallWiring({ env, adapters: [claudeAdapter, codexAdapter], recordedHook: null, mirrorFiles: [mirror] });
      expect(report.hooks).toHaveLength(1);
      const removed = report.mcp.filter((r) => r.change.status === 'removed').map((r) => `${r.adapter}:${r.change.scope}`);
      expect(removed.sort()).toEqual(['claude:local', 'codex:user']);
      expect(claudeMcp.get(env, MCP_SERVER_NAME, 'user')).toHaveLength(1);
      expect(readFileSync(mirror, 'utf8')).toBe('# my notes\n');
      expect(existsSync(join(root, '.context'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('resolving an installed command', () => {
  it('notices a script that was moved or never built', () => {
    const root = tmp('proj');
    const script = join(root, 'index.js');
    writeFileSync(script, '');
    expect(resolveCommand(`node ${script} -C /p hook`, {}).problem).toBeNull();
    expect(resolveCommand(`node ${join(root, 'gone.js')} -C /p hook`, {}).problem).toContain('does not exist');
    expect(resolveCommand('contextd -C /p hook', { which: () => null }).problem).toContain('not on PATH');
    // No way to look: not a failure.
    expect(resolveCommand('contextd -C /p hook', {}).problem).toBeNull();
  });
});

class OneAxis implements EmbeddingProvider {
  readonly name = 'scripted';
  readonly isLocal = true;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, 1]);
  }
}

describe('doctor', () => {
  const find = (checks: ReturnType<typeof diagnose>, name: string) => checks.find((c) => c.name === name);

  it('fails a hook whose script no longer exists, and an MCP entry that cannot start', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const env = host(root);
      const command = `node ${join(root, 'moved', 'index.js')} -C ${root} hook`;
      claudeHookInstaller.install(env, { command });
      manager.noteInstalledHookCommand(command);
      let checks = diagnose(manager, { host: env });
      expect(find(checks, 'claude: hooks')?.status).toBe('ok');
      expect(find(checks, 'claude: hook command')?.status).toBe('fail');
      // Hooks wired but no MCP: the agent can be pushed a bootstrap, never pull.
      expect(find(checks, 'claude: mcp')?.status).toBe('warn');
      expect(find(checks, 'codex: mcp')?.status).toBe('skip');

      mcpInstall(env, claudeAdapter, { command: 'node', args: [join(root, 'moved', 'index.js')] });
      checks = diagnose(manager, { host: env });
      expect(find(checks, 'claude: mcp')?.status).toBe('fail');
      expect(find(checks, 'claude: mcp')?.fix).toContain('--force');

      const script = join(root, 'index.js');
      writeFileSync(script, '');
      mcpInstall(env, claudeAdapter, { command: 'node', args: [script] }, { force: true });
      expect(find(diagnose(manager, { host: env }), 'claude: mcp')?.status).toBe('ok');
    } finally {
      cleanup();
    }
  });

  it('warns when sessions happen and memory is never pulled, and a mirror write does not count', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const env = host(root);
      claudeHookInstaller.install(env, { command: `contextd -C ${root} hook` });
      manager.remember({ add: [{ category: 'constraints', text: 'Never push to main', source: 'user' }] });
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'fix the login bug please' }],
        { sessionId: 's1', cwd: root },
      );
      expect(find(diagnose(manager, { host: env }), 'memory pulled')?.status).toBe('warn');
      writeMirror(manager, join(root, 'CLAUDE.local.md'));
      expect(find(diagnose(manager, { host: env }), 'memory pulled')?.status).toBe('warn');
      manager.serveBootstrap('s1');
      const ok = find(diagnose(manager, { host: env }), 'memory pulled');
      expect(ok?.status).toBe('ok');
      expect(ok?.detail).toContain('1 bootstrap');
    } finally {
      cleanup();
    }
  });

  it('reports embedding coverage without calling the provider', async () => {
    const { root, cleanup } = makeManager();
    const provider = new OneAxis();
    let calls = 0;
    const counting: EmbeddingProvider = { ...provider, name: 'scripted', isLocal: true, embed: (t, c) => { calls += 1; return provider.embed(t); } };
    const m = new ContextManager({
      cwd: root,
      configOverrides: { embeddings: { enabled: true, provider: 'ollama', model: 'm' } as never },
      embeddingProvider: counting,
    });
    try {
      m.remember({ add: [{ category: 'decisions', text: 'Use sqlite' }, { category: 'decisions', text: 'Use zod' }] });
      const env = host(root);
      const before = find(diagnose(m, { host: env }), 'embedding index');
      expect(before?.status).toBe('warn');
      expect(before?.detail).toContain('2 of 2');
      expect(calls).toBe(0);
      await m.embed();
      expect(find(diagnose(m, { host: env }), 'embedding index')?.status).toBe('ok');
    } finally {
      m.close();
      cleanup();
    }
  });
});

describe('mirror', () => {
  it('writes the bootstrap between markers, with dates rather than ages, and is serving', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ category: 'constraints', text: 'Never push to main', source: 'user' }] });
      manager.setTask({ current_task: 'Ship the importer', task_status: 'in_progress' });
      const path = resolveMirrorTarget('claude-local', root);
      expect(path).toBe(join(root, 'CLAUDE.local.md'));
      writeFileSync(path, '# Personal notes\n\nkeep this\n');

      const w = writeMirror(manager, path);
      expect(w.changed).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.startsWith('# Personal notes\n\nkeep this\n\n<!-- contextd:start -->')).toBe(true);
      expect(text).toContain('Never push to main');
      expect(text).toMatch(/generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC from state v\d+/);
      expect(text).toMatch(/recorded: at \d{4}-\d{2}-\d{2}/);
      expect(text).not.toMatch(/\d+[mh] ago|just now/);

      const log = () => manager.store.db.prepare(`SELECT query FROM retrieval_log`).all() as Array<{ query: string }>;
      expect(log().map((r) => r.query)).toEqual(['(mirror)']);
      expect(checkMirror(manager, path).stale).toBe(false);
      expect(log()).toHaveLength(1); // checking measures, it does not serve

      // Unchanged memory: nothing rewritten, nothing served again.
      expect(writeMirror(manager, path).changed).toBe(false);
      expect(log()).toHaveLength(1);

      manager.remember({ add: [{ category: 'decisions', text: 'Mirror into CLAUDE.local.md', source: 'user' }] });
      expect(checkMirror(manager, path).stale).toBe(true);
      writeMirror(manager, path);
      expect(checkMirror(manager, path).stale).toBe(false);
      expect(readFileSync(path, 'utf8').match(/contextd:start/g)).toHaveLength(1);

      expect(removeMirror(path)).toBe('removed');
      expect(readFileSync(path, 'utf8')).toBe('# Personal notes\n\nkeep this\n');
    } finally {
      cleanup();
    }
  });

  it('reports a missing block as stale, and deletes a file that held only the block', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const path = join(root, 'AGENTS.md');
      expect(checkMirror(manager, path).stale).toBe(true);
      expect(writeMirror(manager, path).created).toBe(true);
      expect(extractBlock(readFileSync(path, 'utf8'), MIRROR_MARKERS)).toContain('## Current task');
      expect(mirrorCreatedFiles(manager)).toEqual([path]);
      expect(removeMirror(path, true)).toBe('deleted');
      expect(existsSync(path)).toBe(false);

      // A file that existed before - even an empty, committed one - is the user's and stays.
      const theirs = join(root, 'CLAUDE.local.md');
      writeFileSync(theirs, '');
      writeMirror(manager, theirs);
      expect(mirrorCreatedFiles(manager)).not.toContain(theirs);
      expect(removeMirror(theirs, false)).toBe('removed');
      expect(readFileSync(theirs, 'utf8')).toBe('');
    } finally {
      cleanup();
    }
  });

  it('refreshes existing blocks during maintenance only when configured to', async () => {
    const { manager, root, cleanup } = makeManager({ mirror: { target: 'claude-local', refresh_on_maintenance: true } });
    const off = makeManager();
    try {
      const path = join(root, 'CLAUDE.local.md');
      writeMirror(manager, path);
      manager.remember({ add: [{ category: 'decisions', text: 'Refresh me', source: 'user' }] });
      const r = await manager.runLifecycle(null, { deterministicOnly: true });
      expect(r.mirrored).toEqual([path]);
      expect(readFileSync(path, 'utf8')).toContain('Refresh me');

      const offPath = join(off.root, 'CLAUDE.local.md');
      writeMirror(off.manager, offPath);
      off.manager.remember({ add: [{ category: 'decisions', text: 'Not refreshed', source: 'user' }] });
      expect((await off.manager.runLifecycle(null, { deterministicOnly: true })).mirrored).toEqual([]);
      expect(readFileSync(offPath, 'utf8')).not.toContain('Not refreshed');
    } finally {
      cleanup();
      off.cleanup();
    }
  });
});

describe('import from Claude auto-memory', () => {
  function memoryDir(): string {
    const dir = tmp('memory');
    writeFileSync(join(dir, 'MEMORY.md'), '# Index\n- [Skip brainstorming](feedback_skip.md)\n');
    writeFileSync(
      join(dir, 'feedback_skip.md'),
      '---\nname: Skip brainstorming\ndescription: Prefers direct implementation for small features\ntype: feedback\n---\nSkip brainstorming when the change is small and well defined.\n',
    );
    writeFileSync(
      join(dir, 'project_auth.md'),
      '---\nname: Auth rewrite\ndescription: "Auth moves to sessions"\nmetadata:\n  type: project\n---\nThe auth rewrite replaces JWT with server sessions.\n',
    );
    writeFileSync(join(dir, 'user_role.md'), '---\nname: Role\ntype: user\n---\nThe user is a backend engineer.\n');
    writeFileSync(join(dir, 'scratch.md'), 'just a note, no frontmatter\n');
    return dir;
  }

  it('parses frontmatter with a nested metadata.type', () => {
    const p = parseFrontmatter('---\nname: x\nmetadata:\n  type: reference\n---\nbody\n');
    expect(p?.fields).toEqual({ name: 'x', 'metadata.type': 'reference' });
    expect(p?.body).toBe('body');
  });

  it('imports as source import, below certainty, skipping the index, and is a no-op the second time', () => {
    const { manager, root, cleanup } = makeManager();
    try {
      const dir = memoryDir();
      expect(claudeNativeMemory.locate(root, '/home/me')).toContain('/.claude/projects/');
      const plan = planNativeImport(manager.store, claudeNativeMemory, dir);
      expect(plan.changes).toHaveLength(3);
      expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['no frontmatter', 'the index, not a memory']);
      const r = applyNativeImport(manager, plan);
      expect(r.ok).toBe(true);
      expect(r.added).toHaveLength(3);

      const items = manager.store.allItems(false).filter((i) => i.status === 'active');
      for (const i of items) {
        expect(i.source).toBe('import');
        expect(i.confidence).toBeLessThanOrEqual(MAX_INFERRED_CONFIDENCE);
      }
      const byText = (t: string) => items.find((i) => i.text.includes(t))!;
      expect(byText('Skip brainstorming').category).toBe('conventions');
      expect(byText('JWT').category).toBe('discoveries');
      expect(byText('JWT').fields.native_type).toBe('project');
      expect(byText('backend engineer').category).toBe('conventions');

      const again = planNativeImport(manager.store, claudeNativeMemory, dir);
      expect(again.changes).toHaveLength(0);
      expect(again.unchanged).toHaveLength(3);
      expect(applyNativeImport(manager, again).nothingNew).toBe(true);

      const replayed = manager.store.replay();
      expect(replayed.items.map((i) => i.id).sort()).toEqual(manager.store.currentState(true).items.map((i) => i.id).sort());
    } finally {
      cleanup();
    }
  });

  it('replaces what an edited file produced, and never resurrects a retired import', () => {
    const { manager, cleanup } = makeManager();
    try {
      const dir = memoryDir();
      applyNativeImport(manager, planNativeImport(manager.store, claudeNativeMemory, dir));
      const old = manager.store.allItems(false).find((i) => i.text.includes('JWT'))!;

      writeFileSync(
        join(dir, 'project_auth.md'),
        '---\nname: Auth rewrite\ntype: project\n---\nThe auth rewrite keeps JWT for the public API only.\n',
      );
      const plan = planNativeImport(manager.store, claudeNativeMemory, dir);
      expect(plan.changes.map((c) => c.action)).toEqual(['replace']);
      applyNativeImport(manager, plan);
      expect(manager.store.getItem(old.id)?.status).toBe('superseded');

      const role = manager.store.allItems(false).find((i) => i.text.includes('backend engineer'))!;
      expect(manager.retire([role.id], 'not project state').ok).toBe(true);
      expect(planNativeImport(manager.store, claudeNativeMemory, dir).changes).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('adds nothing when the same statement is already in memory', () => {
    const { manager, cleanup } = makeManager();
    try {
      const dir = tmp('memory');
      writeFileSync(join(dir, 'a.md'), '---\nname: a\ntype: feedback\n---\nAlways run the tests\n');
      manager.remember({ add: [{ category: 'conventions', text: 'Always run the tests', source: 'user' }] });
      const r = applyNativeImport(manager, planNativeImport(manager.store, claudeNativeMemory, dir));
      expect(r.ok).toBe(true);
      expect(manager.store.allItems(false).filter((i) => i.status === 'active')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe('status --all', () => {
  it('keeps a registry of roots and summarises each project read-only', () => {
    const home = tmp('home');
    const path = registryPath(home, {});
    expect(registryPath(home, { CONTEXTD_HOME: '/x' })).toBe('/x/projects.json');
    const { manager, root, cleanup } = makeManager();
    try {
      manager.remember({ add: [{ category: 'decisions', text: 'Use sqlite', source: 'user' }] });
      expect(registerProject(path, root, manager.storageDir)).toBe(true);
      expect(registerProject(path, root, manager.storageDir)).toBe(true);
      const ghost = join(tmp('gone'), 'nothing-here');
      registerProject(path, ghost, join(ghost, '.context'));
      const entries = readRegistry(path);
      expect(entries).toHaveLength(2);

      const rows = entries.map(summarizeProject);
      const mine = rows.find((r) => r.root === root)!;
      expect(mine.status).toBe('ok');
      expect(mine.items).toBe(1);
      expect(mine.lastActivity).not.toBeNull();
      expect(rows.find((r) => r.root === ghost)?.status).toBe('missing');
      // Read-only: a missing project is not created by being looked at.
      expect(existsSync(ghost)).toBe(false);
      expect(formatOverview(rows)).toContain('(storage missing)');
      expect(formatOverview(rows)).toContain('contextd projects prune');

      // Pruning keeps what still has memory and never touches that memory.
      expect(entries.filter((e) => !entryIsLive(e, dbPath)).map((e) => e.root)).toEqual([ghost]);
      const pruned = filterRegistry(path, (e) => entryIsLive(e, dbPath));
      expect(pruned.map((e) => e.root)).toEqual([ghost]);
      expect(filterRegistry(path, (e) => entryIsLive(e, dbPath))).toEqual([]);
      expect(existsSync(dbPath(manager.storageDir))).toBe(true);
      registerProject(path, ghost, join(ghost, '.context'));

      expect(unregisterProject(path, ghost)).toBe(true);
      expect(readRegistry(path)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe('mcp status', () => {
  it('lists registrations per adapter and flags the ones that serve another project', () => {
    const root = tmp('proj');
    const env = host(root);
    mcpInstall(env, claudeAdapter, LAUNCH, { scope: 'project' });
    const s = mcpStatus(env, [claudeAdapter, codexAdapter]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]?.servesThisProject).toBe(true);
    expect(s.rows[0]?.resolution?.problem).toContain('does not exist');
    expect(s.missing).toEqual(['codex']);
    expect(() => mcpInstall(env, codexAdapter, LAUNCH, { scope: 'project' })).toThrow(/no "project" scope/);
  });
});
