import type { StoredEvent } from '../store/store.js';
import { estimateTokens } from './events.js';
import { isHarnessError, isScratchCommand, isTransientToolError, looksLikeDump } from './fold.js';
import { collectAttempts, findRecoveries, firstBinary, levenshtein, type Attempt } from './recovery.js';

/**
 * Failure -> eventual-success episodes, for the model-backed `learn` task.
 *
 * The deterministic fold (recovery.ts, invariant 49) keeps only what code can prove: a path typo,
 * a command that was malformed. Everything else a session learned the hard way - "the API tests
 * need the database container up first" - needs a reading, so it goes to a model. This module
 * decides *what the model reads*, and it is pure: a session with no episode never costs a call.
 *
 * An episode is a failed shell command, the attempts that followed it, and the command that
 * finally succeeded - the same command again once something else was done, or a small edit of it.
 */

/** How far ahead a success may be, in tool calls, to count as the end of an episode. */
export const EPISODE_WINDOW = 12;

/** Most intermediate steps rendered per episode; the ones nearest the success are kept. */
const MAX_STEPS = 6;

/** Error text kept per failure, head and tail - the root cause of a trace is at its end. */
const ERROR_PREVIEW = 240;

/** Longest command rendered. A digest line the model cannot read at a glance teaches nothing. */
const MAX_COMMAND = 200;

/** Longest command kept on a step before rendering; the render decides what of it is shown. */
const MAX_COMMAND_RAW = 600;

/** Head kept when a command is clipped around what changed, so the line still names the binary. */
const DIVERGENCE_HEAD = 60;

/** Minimum substance for a failure to be worth a lesson; "Exit code 1" alone is a number. */
const MIN_FAILURE_SUBSTANCE = 24;

const EDIT_TOOL = /(?:edit|write)/i;

/** Statements in one command line beyond which it is exploration, not an operation to learn. */
const MAX_STATEMENTS = 2;

/**
 * A command that is itself a script - several statements, a newline - is the agent looking
 * around. On a real transcript every such failure was a `cat x; ls y; sqlite3 ...` probe, and
 * what "fixed" it was a different probe.
 */
function isCompound(command: string): boolean {
  if (command.includes('\n')) return true;
  return command.split(/;|&&|\|\|/).filter((s) => s.trim().length > 0).length > MAX_STATEMENTS;
}

/**
 * The success ends the episode only if it is the failed command again (after something else was
 * done) or a small edit of it. Stricter than the fold's `commandsRelatedAsRetry`, whose "shares a
 * substantive argument" arm paired two unrelated `cat` probes that both named the config file.
 */
function resolves(failed: string, success: string): boolean {
  if (failed === success) return true;
  const a = firstBinary(failed);
  if (!a || a !== firstBinary(success)) return false;
  return levenshtein(failed, success) / Math.max(failed.length, success.length) <= 0.4;
}

export interface EpisodeStep {
  eventId: string;
  tool: string;
  /** Command line, or project-relative path. */
  key: string;
  ok: boolean;
  /** Clipped error text, only for a failed step. */
  error: string | null;
}

export interface Episode {
  sessionId: string;
  failure: EpisodeStep;
  /** What was tried in between, oldest first - including repeats of the failure. */
  steps: EpisodeStep[];
  /** A short agent remark made during the episode, when there was one. */
  note: { eventId: string; text: string } | null;
  resolution: EpisodeStep;
  /** Timestamp of the resolving event: the learn watermark moves past it. */
  resolvedAt: string;
}

export function clipHeadTail(text: string, max = ERROR_PREVIEW): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const sep = ' … ';
  const keep = max - sep.length;
  const head = Math.floor(keep / 2);
  return `${flat.slice(0, head).trimEnd()}${sep}${flat.slice(flat.length - (keep - head)).trimStart()}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function step(a: Attempt): EpisodeStep {
  return {
    eventId: a.resultEventId,
    tool: a.tool,
    key: clip(a.key.replace(/\s+/g, ' ').trim(), MAX_COMMAND_RAW),
    ok: a.ok,
    error: a.ok ? null : clipHeadTail(a.output),
  };
}

/**
 * Failures that say something about the machine or the sandbox the agent ran in, not the project.
 * A real `ls` into another repository failed with "Operation not permitted" (macOS privacy
 * controls) and was "fixed" by the same `ls` once the user granted access.
 */
const ENVIRONMENT_NOISE = [/\bOperation not permitted\b/i, /\bsandbox\b/i];

/** `cd <dir> && <cmd>`: the command itself, once the shell's working directory is taken out. */
const CD_PREFIX = /^cd\s+\S+\s*&&\s*/;

/**
 * The episode was the shell standing in the wrong directory: a later step is the same binary run
 * after a `cd`. A fact about that moment's cwd (the invariant-49 finding), not the project.
 */
function wrongDirectory(failed: string, later: Attempt[]): boolean {
  const bin = firstBinary(failed.replace(CD_PREFIX, ''));
  return later.some((a) => a.kind === 'command' && CD_PREFIX.test(a.key) && firstBinary(a.key.replace(CD_PREFIX, '')) === bin);
}

function substantive(output: string): boolean {
  // Shell fumbling - a wrong cwd, a quoting slip, a missing binary - says nothing about the project
  // (invariant 11), and the command-shape part of it is the fold's job (invariant 49).
  if (isHarnessError(output) || isTransientToolError(output)) return false;
  if (ENVIRONMENT_NOISE.some((p) => p.test(output.slice(0, 600)))) return false;
  return output.replace(/\bexit code \d+\b/gi, '').trim().length >= MIN_FAILURE_SUBSTANCE;
}

/**
 * The episodes in one session's events, chronological.
 *
 * Deliberately narrower than "every failure followed by any success":
 * - only shell commands: a failed Read or Edit is the agent guessing (invariant 11);
 * - never a scratch one-liner, a multi-statement probe, a harness or sandbox refusal, shell
 *   fumbling, or a command that only needed a `cd` first (invariants 11, 27, 49);
 * - never an episode the fold already learned deterministically - code decided it (invariant 1);
 * - never one resolved by editing a file: a failing test fixed by changing the code is ordinary
 *   development, and teaching it would record the wrong lesson (the invariant-49 trap);
 * - never the same command re-run with nothing in between: that is a flaky call, not a lesson.
 */
export function collectEpisodes(
  events: StoredEvent[],
  root: string | null,
  opts: { after?: string | null } = {},
): Episode[] {
  const ordered = [...events];
  const attempts = collectAttempts(ordered, root);
  if (!attempts.some((a) => !a.ok)) return [];

  const learned = new Set(
    findRecoveries(attempts, new Set(attempts.map((a) => a.resultEventId)), { isScratchCommand, isHarnessError }).map(
      (r) => r.failed.resultEventId,
    ),
  );

  const byId = new Map(ordered.map((e) => [e.id, e]));
  const consumed = new Set<number>();
  const out: Episode[] = [];

  for (let i = 0; i < attempts.length; i += 1) {
    const failed = attempts[i]!;
    if (failed.ok || consumed.has(i) || failed.kind !== 'command') continue;
    if (isScratchCommand(failed.key) || isCompound(failed.key) || learned.has(failed.resultEventId)) continue;
    if (!substantive(failed.output)) continue;

    let end = -1;
    for (let j = i + 1; j < attempts.length && j <= i + EPISODE_WINDOW; j += 1) {
      const a = attempts[j]!;
      if (!a.ok || a.kind !== 'command' || a.callAt < failed.resultAt) continue;
      if (a.key === failed.key ? j > i + 1 : resolves(failed.key, a.key)) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;

    const between = attempts.slice(i + 1, end);
    // The fix was a code change: ordinary development, which the extraction worker already reads.
    if (between.some((a) => a.ok && a.kind === 'path' && EDIT_TOOL.test(a.tool))) continue;
    if (wrongDirectory(failed.key, attempts.slice(i + 1, end + 1))) continue;
    // Everything between belongs to this episode; a repeat of the failure must not start another.
    for (let k = i + 1; k <= end; k += 1) consumed.add(k);

    const success = attempts[end]!;
    const resolvedAt = byId.get(success.resultEventId)?.timestamp;
    if (!resolvedAt) continue;
    if (opts.after && resolvedAt <= opts.after) continue;

    out.push({
      sessionId: failed.sessionId,
      failure: step(failed),
      steps: between.filter((a) => a.kind === 'command' || !a.ok).slice(-MAX_STEPS).map(step),
      note: agentNote(ordered, failed.resultAt, success.callAt),
      resolution: step(success),
      resolvedAt,
    });
  }
  return out;
}

/** The last substantive thing the agent said between the failure and the fix: often the diagnosis. */
function agentNote(events: StoredEvent[], from: number, to: number): Episode['note'] {
  for (let n = to - 1; n > from; n -= 1) {
    const e = events[n]!;
    if (e.type !== 'ASSISTANT_MESSAGE') continue;
    const text = typeof e.payload.text === 'string' ? e.payload.text : '';
    if (text.trim().length < 20 || looksLikeDump(text)) continue;
    return { eventId: e.id, text: clipHeadTail(text, 240) };
  }
  return null;
}

export interface EpisodeDigest {
  text: string;
  /** Episodes that fit the budget, in the order rendered. */
  episodes: Episode[];
  /** Every event id the digest shows - the only ids a lesson may cite as evidence. */
  evidenceIds: Set<string>;
  /** Episodes left out by the caps; they stay for the next run (the watermark stops short of them). */
  omitted: number;
  tokens: number;
}

/**
 * A command clipped so that what makes it different from `reference` survives.
 *
 * A plain head clip lost the whole lesson on a real episode: a 300-character `npx eslint ... -f
 * unix` and its fix differed only in the flag at the end, so the digest showed the model two
 * identical lines and it - rightly - learned nothing. When two commands share a long prefix,
 * the head is kept (it names the binary) and the window moves to where they part.
 */
function clipAgainst(command: string, reference: string | null, max = MAX_COMMAND): string {
  if (command.length <= max) return command;
  if (!reference) return clip(command, max);
  let common = 0;
  while (common < command.length && common < reference.length && command[common] === reference[common]) common += 1;
  if (common < DIVERGENCE_HEAD) return clip(command, max);
  const sep = ' … ';
  const tail = max - DIVERGENCE_HEAD - sep.length;
  const from = Math.min(Math.max(0, common - 10), Math.max(0, command.length - tail));
  return `${command.slice(0, DIVERGENCE_HEAD)}${sep}${clip(command.slice(from), tail)}`;
}

function renderStep(label: string, s: EpisodeStep, reference: string | null = null): string[] {
  const lines = [`${label.padEnd(7)}[${s.eventId}] ${s.tool}: ${clipAgainst(s.key, reference)}${s.ok ? '  -> ok' : ''}`];
  if (!s.ok && s.error) lines.push(`         error: ${s.error}`);
  return lines;
}

/**
 * The compact text the learn worker reads. Never raw events: each step is one line plus a clipped
 * error, and the whole digest is capped by episodes and by estimated tokens (the budget module's
 * estimate), stopping at an episode boundary.
 */
export function renderEpisodeDigest(
  episodes: Episode[],
  limits: { maxEpisodes: number; maxTokens: number },
): EpisodeDigest {
  const lines: string[] = [];
  const kept: Episode[] = [];
  const evidenceIds = new Set<string>();
  let tokens = 0;

  for (const ep of episodes) {
    if (kept.length >= limits.maxEpisodes) break;
    const block: string[] = [`### episode ${kept.length + 1} (session ${ep.sessionId})`];
    // The failure is shown against its fix and everything after it against the failure: on a long
    // command the part that changed is the lesson, and a head clip is exactly what hides it.
    block.push(...renderStep('failed', ep.failure, ep.resolution.key));
    for (const s of ep.steps) block.push(...renderStep('tried', s, ep.failure.key));
    if (ep.note) block.push(`agent  [${ep.note.eventId}] "${ep.note.text.replace(/"/g, "'")}"`);
    block.push(...renderStep('worked', ep.resolution, ep.failure.key));
    block.push('');
    const cost = estimateTokens(block.join('\n'));
    // The first episode is always kept: a digest with nothing in it would be a wasted call.
    if (kept.length > 0 && tokens + cost > limits.maxTokens) break;
    tokens += cost;
    kept.push(ep);
    lines.push(...block);
    for (const id of [ep.failure.eventId, ...ep.steps.map((s) => s.eventId), ep.resolution.eventId]) {
      evidenceIds.add(id);
    }
    if (ep.note) evidenceIds.add(ep.note.eventId);
  }

  return {
    text: ['## failure -> success episodes', '', ...lines].join('\n').trimEnd(),
    episodes: kept,
    evidenceIds,
    omitted: episodes.length - kept.length,
    tokens,
  };
}
