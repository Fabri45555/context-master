import { existsSync } from 'node:fs';
import { dbPath } from '../store/db.js';
import { ContextManager } from '../daemon/manager.js';
import type { RegistryEntry } from './registry.js';

/**
 * `contextd status --all`: one line per registered project. Read-only - a project whose storage
 * is gone is reported as missing rather than opened, because opening creates it.
 */

export interface ProjectSummary {
  root: string;
  storageDir: string;
  status: 'ok' | 'missing' | 'error';
  items: number;
  pending: number;
  recoveryReady: boolean | null;
  stage: string | null;
  hardCompactions: number;
  lastActivity: string | null;
  error?: string;
}

export function summarizeProject(entry: RegistryEntry): ProjectSummary {
  const base: ProjectSummary = {
    root: entry.root,
    storageDir: entry.storage_dir,
    status: 'missing',
    items: 0,
    pending: 0,
    recoveryReady: null,
    stage: null,
    hardCompactions: 0,
    lastActivity: null,
  };
  if (!existsSync(entry.root) || !existsSync(dbPath(entry.storage_dir))) return base;
  let m: ContextManager | null = null;
  try {
    m = new ContextManager({ cwd: entry.root });
    // Config may have moved storage since registration; the registry is only a pointer.
    if (!existsSync(dbPath(m.storageDir))) return base;
    const pressure = m.pressure(null);
    return {
      ...base,
      storageDir: m.storageDir,
      status: 'ok',
      items: m.store.allItems(false).filter((i) => i.status === 'active').length,
      pending: m.store.pendingSummary(null).count,
      recoveryReady: pressure.recovery_ready,
      stage: pressure.stage,
      hardCompactions: m.hardCompactions(null),
      lastActivity: m.store.lastActivity(),
    };
  } catch (err) {
    return { ...base, status: 'error', error: (err as Error).message };
  } finally {
    m?.close();
  }
}

export function formatOverview(rows: readonly ProjectSummary[], now = Date.now()): string {
  if (rows.length === 0) return 'no projects registered yet; `contextd init` or `contextd attach` registers one';
  const lines = [
    `${'project'.padEnd(44)} ${'items'.padStart(6)} ${'pending'.padStart(8)}  ${'recovery'.padEnd(9)} ${'hard'.padStart(5)}  last activity`,
  ];
  for (const r of rows) {
    const root = r.root.length > 44 ? `…${r.root.slice(-43)}` : r.root;
    if (r.status !== 'ok') {
      lines.push(`${root.padEnd(44)} ${r.status === 'missing' ? '(storage missing)' : `(error: ${r.error ?? 'unknown'})`}`);
      continue;
    }
    lines.push(
      `${root.padEnd(44)} ${String(r.items).padStart(6)} ${String(r.pending).padStart(8)}  ` +
        `${(r.recoveryReady ? 'ready' : 'not ready').padEnd(9)} ${String(r.hardCompactions).padStart(5)}  ` +
        `${r.lastActivity ? ago(r.lastActivity, now) : 'never'}`,
    );
  }
  return lines.join('\n');
}

function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(mins)) return iso;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
