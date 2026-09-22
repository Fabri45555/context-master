import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../core/config.js';
import { clearAdvice } from '../core/lifecycle.js';
import { ContextManager } from '../daemon/manager.js';
import { dbPath } from '../store/db.js';

/**
 * One status-line segment: how full the agent's window is, and whether clearing it is safe.
 *
 * The status line is redrawn constantly, in every directory the agent is opened in, so this is
 * read-only and silent by design: no storage is created where there is none, nothing is logged
 * as a retrieval (invariant 30), and any failure prints nothing rather than an error in the
 * person's prompt.
 */
export interface StatuslineState {
  ratio: number | null;
  items: number;
  advice: 'ready' | 'blocked' | null;
  /** The person's own status-line command, run first (`statusline.chain`). */
  chain: string | null;
}

export function readStatusline(projectDir: string, sessionId: string | null): StatuslineState | null {
  const root = resolve(projectDir);
  const loaded = loadConfig(root);
  if (!existsSync(dbPath(loaded.storageDir))) return null;
  const m = new ContextManager({ cwd: root });
  try {
    const p = m.pressure(sessionId);
    const advice = clearAdvice(m.config, p, 0);
    return {
      ratio: p.ratio,
      items: m.store.allItems(false).filter((i) => i.status === 'active').length,
      advice: advice ? (advice.ready ? 'ready' : 'blocked') : null,
      chain: m.statuslineChain()?.command ?? null,
    };
  } finally {
    m.close();
  }
}

/**
 * Run the chained command with the payload the agent sent. Bounded: a status line that hangs
 * would freeze the agent's prompt, so after a second its output is simply missing.
 */
export function runChained(command: string, payload: string): string {
  const r = spawnSync(command, { shell: true, input: payload, encoding: 'utf8', timeout: 1000 });
  if (r.error || typeof r.stdout !== 'string') return '';
  return r.stdout.split('\n')[0]?.trimEnd() ?? '';
}

const C = { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' };

export function formatStatusline(s: StatuslineState, color = true): string {
  const paint = (code: string, t: string) => (color ? `${code}${t}${C.reset}` : t);
  const parts = [paint(C.dim, 'contextd')];
  if (s.ratio != null) parts.push(`ctx ${Math.round(s.ratio * 100)}%`);
  if (s.advice === 'ready') parts.push(paint(C.green, 'memory ready: /clear is safe'));
  else if (s.advice === 'blocked') parts.push(paint(C.yellow, 'memory catching up: contextd compact'));
  else if (s.ratio != null || s.items > 0) parts.push(`${s.items} items`);
  return parts.length > 1 ? parts.join(' · ') : '';
}

/** The person's line, then contextd's, on one line. */
export function joinStatusline(theirs: string, ours: string, color = true): string {
  if (!theirs) return ours;
  if (!ours) return theirs;
  return `${theirs} ${color ? C.dim + '│' + C.reset : '|'} ${ours}`;
}
