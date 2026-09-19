import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { collectBenefits } from '../metrics/benefits.js';
import { collectMetrics } from '../metrics/index.js';
import { MEMORY_CATEGORIES } from '../core/state.js';
import type { ContextManager } from '../daemon/manager.js';
import { renderPage } from './page.js';

/**
 * PRD 41 - the developer UI.
 *
 * Read-only and bound to loopback. The memory contains project internals and, despite
 * redaction, possibly more; a dashboard that could mutate state or answer on the network
 * would be a much larger surface than the value justifies.
 *
 * No framework and no build step: one HTML page and a handful of JSON endpoints, served
 * from the same process that owns the store.
 */

export interface UiOptions {
  port?: number;
  /** Loopback only unless deliberately overridden. */
  host?: string;
}

export interface UiHandle {
  url: string;
  close(): Promise<void>;
}

export function startUi(manager: ContextManager, opts: UiOptions = {}): Promise<UiHandle> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    void handle(manager, req, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(
  manager: ContextManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Read-only by construction: anything but GET is refused before routing.
  if (req.method !== 'GET') {
    send(res, 405, { error: 'this dashboard is read-only' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    switch (url.pathname) {
      case '/':
        // The tool gets rebuilt while the dashboard is open; a cached page would then be
        // serving stale JavaScript against a newer API.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(renderPage());
        return;

      case '/favicon.svg': {
        // Inline so the page never reaches for an external asset, and the console stays clean.
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
          '<rect width="32" height="32" rx="7" fill="#161a21"/>' +
          '<circle cx="16" cy="9" r="3.2" fill="#6ea8fe"/>' +
          '<circle cx="8" cy="22" r="3.2" fill="#e0a33e"/>' +
          '<circle cx="24" cy="22" r="3.2" fill="#7cc379"/>' +
          '<path d="M16 9 8 22M16 9l8 13M8 22h16" stroke="#3a4452" stroke-width="1.6" fill="none"/>' +
          '</svg>';
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
        res.end(svg);
        return;
      }

      case '/api/overview':
        send(res, 200, overview(manager));
        return;

      case '/api/benefits': {
        const metrics = collectMetrics(manager.store, manager.config, null);
        send(res, 200, {
          root: manager.projectRoot,
          metrics,
          benefits: collectBenefits(manager.store, manager.config, metrics),
        });
        return;
      }

      case '/api/memory':
        send(res, 200, memoryPayload(manager, url));
        return;

      case '/api/conflicts':
        send(res, 200, manager.conflicts({ maxPairs: 50 }).map(serializeConflict));
        return;

      case '/api/graph':
        send(res, 200, graphPayload(manager));
        return;

      case '/api/events':
        send(res, 200, eventsPayload(manager, url));
        return;

      case '/api/patches':
        send(res, 200, manager.store.listPatches(50));
        return;

      case '/api/context': {
        const q = url.searchParams.get('q');
        const built = q ? manager.queryContext(q, { limit: 15, record: false }) : manager.bootstrapContext();
        send(res, 200, { query: q, ...built });
        return;
      }

      default:
        send(res, 404, { error: 'not found' });
    }
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function overview(manager: ContextManager) {
  const metrics = collectMetrics(manager.store, manager.config, null);
  return {
    project: manager.config.project.name ?? null,
    root: manager.projectRoot,
    metrics,
    sessions: manager.store.listSessions(10),
    edges: manager.store.edgeCount(),
    embeddings: { enabled: manager.embeddings.enabled, count: manager.embeddings.count() },
    conflicts: manager.conflicts({ maxPairs: 50 }).length,
    machine: manager.config.limits,
  };
}

function memoryPayload(manager: ContextManager, url: URL) {
  const category = url.searchParams.get('category');
  const includeDead = url.searchParams.get('all') === '1';
  const items = manager.store
    .allItems(includeDead)
    .filter((i) => (category ? i.category === category : true))
    .filter((i) => (includeDead ? true : i.status === 'active'));
  return { categories: MEMORY_CATEGORIES, items, working: manager.store.workingMemory() };
}

function graphPayload(manager: ContextManager) {
  const edges = manager.store.allEdges();
  const ids = new Set(edges.flatMap((e) => [e.from, e.to]));
  const nodes = [...ids]
    .map((id) => manager.store.getItem(id))
    .filter((i): i is NonNullable<typeof i> => i != null)
    .map((i) => ({
      id: i.id,
      category: i.category,
      text: i.text,
      importance: i.importance,
      status: i.status,
    }));
  return { nodes, edges };
}

function eventsPayload(manager: ContextManager, url: URL) {
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
  const events = manager.store.recentEvents(null, limit, 'low');
  return events.map((e) => ({
    id: e.id,
    session_id: e.session_id,
    timestamp: e.timestamp,
    type: e.type,
    importance: e.importance,
    action: e.action,
    reasons: e.reasons,
    tokens: e.tokens,
    processed: e.processed_at != null,
    // The payload can hold a lot; the dashboard only needs a glance.
    preview: previewOf(e.payload),
  }));
}

function previewOf(payload: Record<string, unknown>): string {
  for (const key of ['text', 'command', 'error', 'path', 'output']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.slice(0, 200);
  }
  return '';
}

function serializeConflict(c: ReturnType<ContextManager['conflicts']>[number]) {
  return {
    reason: c.reason,
    similarity: c.similarity,
    newer: c.newer,
    a: { id: c.a.id, text: c.a.text, category: c.a.category, importance: c.a.importance, source: c.a.source },
    b: { id: c.b.id, text: c.b.text, category: c.b.category, importance: c.b.importance, source: c.b.source },
  };
}
