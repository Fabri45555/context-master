import { collectEpisodes, renderEpisodeDigest, type EpisodeDigest } from '../core/episodes.js';
import type { Config } from '../core/config.js';
import { atLeast } from '../core/events.js';
import type { AddItem, PatchViolation, StatePatch } from '../core/patch.js';
import type { MemoryItem } from '../core/state.js';
import { getMeta, setMeta } from '../store/db.js';
import type { ContextStore } from '../store/store.js';

/**
 * The deterministic half of the `learn` task: what the model reads, and what of its answer is kept.
 *
 * Both sides are code, not prompt. The input is a digest built from stored events with no model
 * involved, and a session without an episode never reaches a provider (invariant 1). The output is
 * cut down to what the task is for - lessons, cited, uncertain, from the worker - before
 * `commitPatch` sees it, because a prompt can ask for that but only code can guarantee it.
 */

export const LEARN_CATEGORIES = ['conventions', 'discoveries'] as const;

/** Tag on every learned item, so `memory` / the dashboard can tell a lesson from an extraction. */
export const LEARN_TAG = 'learned';

/** The lessons held already, shown to the model so it does not learn them twice. */
const MAX_EXISTING_LESSONS = 40;

/** Most events read per session to find episodes: bounded, and served by the session index. */
const MAX_SESSION_EVENTS = 4000;

export function watermarkKey(sessionId: string): string {
  return `learn_until:${sessionId}`;
}

export function learnWatermark(store: ContextStore, sessionId: string): string | null {
  return getMeta(store.db, watermarkKey(sessionId));
}

/**
 * Advance past the episodes a run looked at. Called on `ok` and on an empty answer - the model
 * was asked and said nothing, and asking again would cost the same for the same answer - but never
 * on an error, a rejection or a deferral, which leave those episodes for the next run (invariant 8).
 */
export function advanceWatermark(store: ContextStore, sessionId: string, until: string): void {
  const prev = learnWatermark(store, sessionId);
  if (prev == null || until > prev) setMeta(store.db, watermarkKey(sessionId), until);
}

export interface LearnInput {
  sessionId: string;
  digest: EpisodeDigest;
  existing: MemoryItem[];
  /** Where the watermark moves on success: the last rendered episode's resolution. */
  until: string;
}

/**
 * The digest for one session, or null when it has no new episode - in which case no model is
 * called at all.
 */
export function buildLearnInput(
  store: ContextStore,
  config: Config,
  sessionId: string,
  root: string | null,
): LearnInput | null {
  const events = store.sessionToolEvents(sessionId, MAX_SESSION_EVENTS);
  const episodes = collectEpisodes(events, root, { after: learnWatermark(store, sessionId) });
  if (episodes.length === 0) return null;
  const digest = renderEpisodeDigest(episodes, {
    maxEpisodes: config.learn.max_episodes,
    maxTokens: config.learn.max_digest_tokens,
  });
  const last = digest.episodes[digest.episodes.length - 1];
  if (!last) return null;
  const existing = store
    .allItems()
    .filter((i) => (LEARN_CATEGORIES as readonly string[]).includes(i.category))
    .sort((a, b) => Number(b.tags.includes(LEARN_TAG)) - Number(a.tags.includes(LEARN_TAG)))
    .slice(0, MAX_EXISTING_LESSONS);
  return { sessionId, digest, existing, until: last.resolvedAt };
}

/**
 * A stored number that describes one run - "failed 3 times", "took 40s", "12 tests" - is false the
 * next time it runs (invariant 28). Version numbers, ports and flags are not measurements and pass.
 */
const MEASUREMENT =
  /\b\d+(?:\.\d+)?\s*(?:%|percent\b|ms\b|milliseconds?\b|s\b|secs?\b|seconds?\b|minutes?\b|mins?\b|tokens?\b|tests?\b|times\b|attempts?\b|tries\b|retries\b|failures?\b|errors?\b)/i;

/** Source code or pasted output: a fence, or several lines that read like code (invariant 10). */
function looksLikeCode(text: string): boolean {
  if (text.includes('```')) return true;
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length > 3) return true;
  return lines.filter((l) => /[;{}]\s*$/.test(l.trim()) || /^\s*(?:at |Traceback|File ")/.test(l)).length >= 2;
}

export interface RestrictedPatch {
  patch: StatePatch;
  /** One line per dropped entry or stripped key, recorded in the patch note. */
  dropped: string[];
  violations: PatchViolation[];
}

/**
 * Cut a learn worker's patch down to what the task may write.
 *
 * - Only `add` survives; `working`, `update`, retirements and closes are stripped. A lesson never
 *   edits the task or retires memory, and `add.supersedes` is a retirement too (invariant 12).
 * - An item must be a convention or a discovery, and cite at least one event the digest showed.
 *   Unknown ids are removed from its evidence; an item left with none is dropped.
 * - `source` is always `worker`: the digest contains no user message, so a user attribution can
 *   never be proven (invariant 26). Critical importance is lowered to high, since the worker is
 *   reading an episode, not quoting an instruction; confidence is clamped later by `normalizePatch`.
 * - Measurements and code are dropped (invariants 28, 10).
 *
 * One bad entry does not sink the rest (invariant 25). If the model wrote lessons and none
 * survived, that is a violation - the runner's one repair pass - not a silent empty success.
 */
export function restrictLearnPatch(raw: StatePatch, evidenceIds: Set<string>): RestrictedPatch {
  const dropped: string[] = [];
  for (const key of ['working', 'update', 'remove', 'supersede', 'touch', 'link', 'unlink', 'close', 'reopen', 'release_protected'] as const) {
    const v = raw[key];
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    dropped.push(`${key}: not part of the learn task`);
  }

  const kept: AddItem[] = [];
  for (const [n, a] of (raw.add ?? []).entries()) {
    const why = rejectLesson(a, evidenceIds);
    if (why) {
      dropped.push(`add[${n}]: ${why}`);
      continue;
    }
    const { supersedes: _retire, id: _id, ...rest } = a;
    kept.push({
      ...rest,
      source: 'worker',
      importance: a.importance && atLeast(a.importance, 'critical') ? 'high' : (a.importance ?? 'medium'),
      evidence: [...new Set((a.evidence ?? []).filter((id) => evidenceIds.has(id)))],
      tags: [...new Set([...(a.tags ?? []), LEARN_TAG])],
    });
  }

  const violations: PatchViolation[] = [];
  if ((raw.add?.length ?? 0) > 0 && kept.length === 0) {
    violations.push({
      code: 'out_of_scope',
      message: `no lesson was usable: ${dropped.filter((d) => d.startsWith('add[')).join('; ').slice(0, 600)}`,
    });
  }

  const patch: StatePatch = {};
  if (kept.length > 0) patch.add = kept;
  const note = [raw.note, dropped.length > 0 ? `learn dropped: ${dropped.join(', ')}` : null]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(' | ');
  if (kept.length > 0 && note) patch.note = note.slice(0, 1200);
  return { patch, dropped, violations };
}

function rejectLesson(a: AddItem, evidenceIds: Set<string>): string | null {
  if (!(LEARN_CATEGORIES as readonly string[]).includes(a.category)) return `category ${a.category} is not a lesson`;
  if (!(a.evidence ?? []).some((id) => evidenceIds.has(id))) return 'no evidence from the digest';
  if (MEASUREMENT.test(a.text)) return 'states a measurement';
  if (looksLikeCode(a.text)) return 'contains code or pasted output';
  return null;
}
