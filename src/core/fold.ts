import type { StoredEvent } from '../store/store.js';
import type { StatePatch, AddItem } from './patch.js';
import { isSuccessfulMilestone, looksLikeError } from './importance.js';
import { isSensitivePath } from './redact.js';

/**
 * PRD 13 - the deterministic fold.
 *
 * Runs before any worker. Everything that can be derived from an event's shape rather than
 * its meaning is turned into a patch here, for free. What the fold consumes never reaches
 * the model, so this is where most of the cost saving actually lands.
 */

export interface FoldResult {
  patch: StatePatch;
  /** Files to fingerprint in the index (PRD 19 - code lives in the repo). */
  fileNotes: Array<{ path: string; contentHash: string | null }>;
  /** Event ids the fold derived state from. These are what `coverage` counts. */
  consumed: string[];
  /**
   * Event ids the fold closed without deriving anything: noise it deliberately rejected, or a
   * command that simply succeeded. Resolved, but not coverage - counting a rejected error as
   * derived state is the same flattery `markInert` exists to prevent.
   */
  inert: string[];
}

export function deterministicFold(events: StoredEvent[]): FoldResult {
  const working: NonNullable<StatePatch['working']> = {};
  const add: AddItem[] = [];
  const fileNotes: FoldResult['fileNotes'] = [];
  const consumed: string[] = [];
  const inert: string[] = [];
  const notes: string[] = [];

  /**
   * Which call produced which result.
   *
   * A tool error arrives as `ERROR_DETECTED` carrying only `tool_use_id` and the output — the
   * command that failed lives on the matching `TOOL_CALL`. Without the correlation a failed
   * throwaway one-liner is indistinguishable from a failed build, and a live session duly filed a
   * `node -e` stack trace as a project known issue.
   */
  const commandOfCall = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'TOOL_CALL' && e.type !== 'COMMAND_EXECUTED') continue;
    const id = firstString(e.payload.tool_use_id);
    const cmd = firstString(e.payload.command);
    if (id && cmd) commandOfCall.set(id, cmd);
  }

  // Later events win for single-valued working memory fields, so iterate in order.
  for (const e of events) {
    switch (e.type) {
      case 'SESSION_STARTED': {
        const name = firstString(e.payload.project, e.payload.project_name);
        if (name) {
          working.project_name = name;
          consumed.push(e.id);
          notes.push('session_started');
        } else {
          inert.push(e.id);
        }
        break;
      }

      case 'TASK_STARTED': {
        const text = firstString(e.payload.text, e.payload.task);
        if (text) {
          working.current_task = text;
          working.task_status = 'in_progress';
          working.next_action = null;
          consumed.push(e.id);
          notes.push('task_started');
        }
        break;
      }

      case 'TASK_COMPLETED': {
        working.task_status = 'done';
        const text = firstString(e.payload.text, e.payload.task);
        if (text) {
          add.push({
            category: 'completed_work',
            text,
            importance: 'medium',
            confidence: 1,
            source: 'deterministic',
            evidence: [e.id],
            reason: 'task reported complete by the agent',
          });
        }
        consumed.push(e.id);
        notes.push('task_completed');
        break;
      }

      case 'FILE_CHANGED': {
        const path = firstString(e.payload.path);
        const hash = firstString(e.payload.content_hash);
        if (path && !isSensitivePath(path)) {
          fileNotes.push({ path, contentHash: hash ?? null });
          consumed.push(e.id);
        }
        break;
      }

      case 'ERROR_DETECTED': {
        // The error text is quoted verbatim, so no model is needed to record it. It gets a
        // TTL because a fixed error must not linger as a known issue forever (PRD 43).
        const text = firstString(e.payload.error, e.payload.text, e.payload.output);
        const origin = firstString(e.payload.tool_use_id);
        const originCommand = origin ? commandOfCall.get(origin) : undefined;
        if (originCommand && isScratchCommand(originCommand)) {
          // The failure of a throwaway one-liner belongs to the exploration, not the project.
          inert.push(e.id);
          break;
        }
        if (text && isTransientToolError(text)) {
          // An agent guessing at a path is not a project issue. Recording these buried the
          // real findings under dozens of near-identical "No such file" entries.
          inert.push(e.id);
          break;
        }
        if (text) {
          add.push({
            category: 'known_issues',
            text: text.slice(0, 500),
            importance: 'high',
            confidence: 0.6,
            source: 'deterministic',
            evidence: [e.id],
            reason: 'error observed during the session; unverified as still present',
            ttl_seconds: 86_400,
            tags: ['unverified'],
          });
          notes.push('error_recorded');
          // Consumed here so the same error cannot also be recorded by a worker later. A
          // worker can still supersede this item once it understands the cause.
          consumed.push(e.id);
        }
        break;
      }

      case 'COMMAND_EXECUTED': {
        const code = e.payload.exit_code;
        if (typeof code === 'number' && code !== 0) {
          const cmd = firstString(e.payload.command) ?? '(unknown command)';
          const out = firstString(e.payload.output, e.payload.error) ?? '';
          if (isTransientToolError(out) || isScratchCommand(cmd)) {
            inert.push(e.id);
            break;
          }
          add.push({
            category: 'known_issues',
            text: `Command failed (exit ${code}): ${cmd}`,
            fields: { command: cmd, exit_code: code, output_excerpt: out.slice(0, 400) },
            importance: 'high',
            confidence: 0.7,
            source: 'deterministic',
            evidence: [e.id],
            reason: 'non-zero exit status',
            ttl_seconds: 86_400,
            tags: ['unverified'],
          });
          consumed.push(e.id);
          notes.push('command_failed');
        } else if (isSuccessfulMilestone(e)) {
          // Left pending for a worker: it can tell which task or goal this finished, and the
          // bootstrap reports it against the recorded task in the meantime.
          notes.push('milestone');
        } else if (typeof code === 'number') {
          // Succeeded with nothing else derivable: the event has served its purpose.
          if (!looksLikeError(firstString(e.payload.output) ?? '')) inert.push(e.id);
        }
        break;
      }

      default:
        break;
    }
  }

  const patch: StatePatch = {};
  if (Object.keys(working).length > 0) patch.working = working;
  if (add.length > 0) patch.add = add;
  if (notes.length > 0) patch.note = `deterministic fold: ${[...new Set(notes)].join(', ')}`;

  return { patch, fileNotes, consumed, inert };
}

/**
 * Errors that say the agent guessed wrong, not that the project is broken.
 *
 * These dominate a real transcript: an agent exploring a codebase produces dozens of
 * "No such file" results, and recording each one as a known issue makes the bootstrap
 * context useless. A genuine failure (a test, a build, an exception) does not match.
 */
const TRANSIENT_TOOL_ERROR = [
  /\bENOENT\b/,
  /\bno such file or directory\b/i,
  /\bcommand not found\b/i,
  /\bno matches found\b/i,
  /\bdid you mean\b/i,
  /\bunknown (?:option|flag|command)\b/i,
  /\bfile (?:does not exist|not found)\b/i,
  /\bis a directory\b/i,
  /^\s*usage:/i,
  // Shell syntax the agent got wrong. Unambiguously fumbling: a malformed command never ran,
  // so it says nothing about the project. Found when `(eval):1: bad substitution` from a
  // mistyped command of my own was recorded as a known issue.
  /\bbad substitution\b/i,
  /\bsyntax error near unexpected token\b/i,
  /\bunexpected EOF while looking for\b/i,
  /\bparse error near\b/i,
];

/**
 * Errors from the agent platform itself: rate limits, overloaded endpoints, model outages.
 *
 * They are the single largest source of ERROR_DETECTED in a long real session and they say
 * nothing whatsoever about the project, so they must never become project memory.
 */
const HARNESS_ERROR = [
  // Provider and rate-limit failures.
  /\bAPI Error\b/i,
  /\b(?:429|529|503)\b.*\b(?:overloaded|rate.?limit|unavailable)\b/i,
  /\boverloaded\b/i,
  /\brate.?limit(?:ed|s)?\b/i,
  /\b(?:session|usage) limit\b/i,
  /\btemporarily unavailable\b/i,
  /\bterminated early\b/i,
  /\bcontext (?:window )?(?:limit|exceeded)\b/i,
  /\brequest (?:timed out|timeout)\b/i,
  // Permission refusals and interruptions: the harness said no, the project is fine.
  /<tool_use_error>/i,
  /^\s*\[Request interrupted/i,
  /\bBlocked:/,
  /\bprotocol is blocked\b/i,
  /\buser (?:rejected|denied|declined|interrupted)\b/i,
  /\bpermission (?:to use|denied by)\b/i,
  /\brequires? approval\b/i,
  // A tool the harness would not run. Recorded four times as a project "known issue" on a real
  // session, complete with the guidance text explaining what the agent may do instead.
  /\bpermission for this action was denied\b/i,
  /\bdenied by the .{0,40}classifier\b/i,
  /\bpermission denied by the user\b/i,
  // The agent calling its own tools wrongly. Found on a real session, where the single
  // recorded "known issue" was `Invalid arguments for tool "browser_click"` - a schema
  // complaint about the agent's call, not a fact about the project.
  /\bInvalid arguments for tool\b/i,
  /\bInvalid input:\s*✖?\s*(?:expected|too )/i,
  /\bexpected \w+, received (?:undefined|null)\b/i,
  /\bUnknown tool\b/i,
  /\bNo such tool available\b/i,
  /\btool .* not found\b/i,
  /\bInputValidationError\b/,
];

export function isHarnessError(text: string): boolean {
  return HARNESS_ERROR.some((p) => p.test(text.slice(0, 400)));
}

/** Minimum substance for an error to be worth remembering at all. */
const MIN_ERROR_SUBSTANCE = 24;

/**
 * An inline one-liner the agent wrote to look at something.
 *
 * Found on a live session: a throwaway `node -e` query against the database failed, and its stack
 * trace was recorded as a project known issue. Scratch exploration is not the project's build or
 * test suite, and its failures say nothing about the code. Only inline-code forms count - a plain
 * `node script.js` or `npm test` is the real thing and stays.
 */
const SCRATCH_COMMAND = /(?:^|[;&|]\s*)(?:node|python3?|perl|ruby|deno)\s+(?:-\w+\s+)*-(?:e|c)\b/;

export function isScratchCommand(command: string): boolean {
  return SCRATCH_COMMAND.test(command);
}

/**
 * Whether the text is a dump rather than a message.
 *
 * A failing `npx` call pasted 500 characters of a minified bundle into memory as a "known
 * issue": true, useless, and the exact precision failure `never_retrieved_ratio` measures. A
 * message is written for a human and has spaces; minified code does not.
 */
export function looksLikeDump(text: string): boolean {
  for (const line of text.split('\n', 40)) {
    if (line.length < 300) continue;
    const whitespace = (line.match(/\s/g) ?? []).length / line.length;
    if (whitespace < 0.08) return true;
  }
  return false;
}

export function isTransientToolError(text: string): boolean {
  const head = text.slice(0, 400);
  // Checked before the stack-trace exemption below: a minified bundle can contain anything,
  // including the word "traceback", and must not buy its way into memory with it.
  if (looksLikeDump(text)) return true;
  // A stack trace or a failing test alongside the message means it is not mere fumbling.
  if (/\b(traceback|assertionerror|test(?:s)? failed|\d+ failing|panic:)\b/i.test(head)) return false;
  if (TRANSIENT_TOOL_ERROR.some((p) => p.test(head)) || isHarnessError(head)) return true;
  // "Exit code 144" on its own is not a known issue, it is a number.
  const substance = head.replace(/\bexit code \d+\b/gi, '').trim();
  return substance.length < MIN_ERROR_SUBSTANCE;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}
