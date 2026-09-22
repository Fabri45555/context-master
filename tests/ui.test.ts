import { afterEach, describe, expect, it } from 'vitest';
import { renderPage } from '../src/ui/page.js';
import { shortenHome, startUi, type UiHandle } from '../src/ui/server.js';
import { makeManager } from './helpers.js';

// Loopback only: the server binds 127.0.0.1 on an ephemeral port, so no test touches a network.
let handle: UiHandle | null = null;
let cleanup: (() => void) | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
  cleanup?.();
  cleanup = null;
});

async function serve() {
  const made = makeManager();
  cleanup = made.cleanup;
  handle = await startUi(made.manager, { port: 0 });
  return handle.url;
}

describe('dashboard server', () => {
  it('serves the doctor checks as /api/health', async () => {
    const url = await serve();
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-page-version')).toBeTruthy();
    const body = (await res.json()) as { status: string; checks: Array<{ name: string; status: string }> };
    expect(['ok', 'warn', 'fail']).toContain(body.status);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.checks.map((c) => c.name)).toContain('patch log');
    // The pill is the worst check, exactly as `contextd doctor` summarises it.
    const worst = body.checks.some((c) => c.status === 'fail')
      ? 'fail'
      : body.checks.some((c) => c.status === 'warn')
        ? 'warn'
        : 'ok';
    expect(body.status).toBe(worst);
  });

  it('stays read-only', async () => {
    const url = await serve();
    const res = await fetch(`${url}/api/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('gives the overview what the header and Memory card need', async () => {
    const url = await serve();
    const body = (await (await fetch(`${url}/api/overview`)).json()) as Record<string, unknown>;
    expect(typeof body.root_display).toBe('string');
    expect(body.working).toMatchObject({ task_status: expect.any(String) });
  });

  it('serves the page with the package version embedded', async () => {
    const url = await serve();
    const html = await (await fetch(`${url}/`)).text();
    expect(html).toMatch(/const APP_VERSION = "\d+\.\d+\.\d+"/);
  });

  it('keeps every endpoint the page calls', async () => {
    const url = await serve();
    for (const path of ['/api/overview', '/api/benefits', '/api/memory', '/api/conflicts', '/api/graph',
      '/api/events', '/api/patches', '/api/context', '/api/health']) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(200);
    }
  });
});

describe('dashboard page', () => {
  it('produces scripts that parse', () => {
    // The client script lives in a template literal; a stray backtick or dollar-brace would
    // still typecheck and only break in the browser.
    const html = renderPage('v', '1.2.3');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts.length).toBe(2);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  it('loads nothing from another host', () => {
    const html = renderPage();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    // The one external link is the documentation, opened by the user, never fetched by the page.
    expect(refs.filter((r) => /^https?:/.test(r))).toEqual(['https://github.com/Fabri45555/context-master#readme']);
    expect(html).not.toMatch(/@import|url\(http/);
  });

  it('maps every old tab hash to a view', () => {
    const html = renderPage();
    for (const old of ['benefits', 'conflicts', 'graph', 'context', 'events', 'patches']) {
      expect(html).toMatch(new RegExp(`\\b${old}: '`));
    }
  });
});

describe('shortenHome', () => {
  it('replaces the home directory with ~', () => {
    expect(shortenHome('/home/me/work/x', '/home/me')).toBe('~/work/x');
    expect(shortenHome('/home/me', '/home/me')).toBe('~');
    expect(shortenHome('/home/meadow/x', '/home/me')).toBe('/home/meadow/x');
  });
});
