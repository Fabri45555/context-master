import type { StoredEvent } from '../store/store.js';
import type { StatePatch, AddItem } from './patch.js';
import { isSuccessfulMilestone, looksLikeError } from './importance.js';
import { isSensitivePath } from './redact.js';
import { collectAttempts, findRecoveries, type Recovery } from './recovery.js';
import type { MemoryItem } from './state.js';

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

/**
 * What the fold may see beyond its own batch. Everything here is optional and read-only: the
 * fold stays a pure function of its inputs.
 */
export interface FoldContext {
  /**
   * Earlier events of the batch's sessions, oldest first, excluding the batch itself. On the
   * hook path every batch is a single event, so without this a failure and the success that
   * recovers from it would never be seen together.
   */
  history?: StoredEvent[];
  /** The active, unprotected known issue recorded from this failure event, if any. */
  issueForEvent?: (eventId: string) => string | null;
  /** Project root: a recovery rule is only about paths inside it. */
  root?: string | null;
  /**
   * The unprotected recovery rules, active or stale, already learned about this wrong path or
   * command. Asked only when a recovery was learned, so the hook path pays nothing otherwise.
   */
  recoveryRules?: (kind: 'path' | 'command', failedKey: string) => MemoryItem[];
}

export function deterministicFold(events: StoredEvent[], ctx: FoldContext = {}): FoldResult {
  const working: NonNullable<StatePatch['working']> = {};
  const add: AddItem[] = [];
  const fileNotes: FoldResult['fileNotes'] = [];
  const consumed: string[] = [];
  const inert: string[] = [];
  const notes: string[] = [];
  /** Known issues this batch records, by the failure they came from - a recovery may replace one. */
  const issueOfEvent = new Map<string, AddItem>();

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
          const issue: AddItem = {
            category: 'known_issues',
            text: text.slice(0, 500),
            importance: 'high',
            confidence: 0.6,
            source: 'deterministic',
            evidence: [e.id],
            reason: 'error observed during the session; unverified as still present',
            ttl_seconds: 86_400,
            tags: ['unverified'],
          };
          add.push(issue);
          issueOfEvent.set(e.id, issue);
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
          const issue: AddItem = {
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
          };
          add.push(issue);
          issueOfEvent.set(e.id, issue);
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

  const learned = learnRecoveries(events, ctx);
  const ruleOps: RuleOps = { add: [], update: [], touch: [], supersede: [] };
  for (const group of groupRecoveries(learned)) {
    const issues: string[] = [];
    for (const r of group) {
      const failedId = r.failed.resultEventId;
      const sameBatchIssue = issueOfEvent.get(failedId);
      // The failure was recorded as an issue in this very batch: the fix arrived with it, so the
      // issue is never written rather than written and retired.
      if (sameBatchIssue) add.splice(add.indexOf(sameBatchIssue), 1);
      const olderIssue = sameBatchIssue ? null : (ctx.issueForEvent?.(failedId) ?? null);
      if (olderIssue && !issues.includes(olderIssue)) issues.push(olderIssue);
      notes.push(r.kind === 'path' ? 'path_recovery' : 'command_recovery');
      // Both ends are now evidence of derived state. The failure is only re-classified when it is
      // in this batch; an older one keeps whatever status it was closed with.
      consumed.push(r.success.resultEventId);
      if (inert.includes(failedId)) consumed.push(failedId);
    }
    const head = group[0]!;
    const existing = ctx.recoveryRules?.(head.kind, head.failed.key) ?? [];
    planRecoveryRules(group, existing, issues, ruleOps);
  }
  add.push(...ruleOps.add);
  if (learned.length > 0) {
    // A success the fold had closed as inert (a plain exit 0) is now what state was derived from.
    const derived = new Set(consumed);
    const stillInert = inert.filter((id) => !derived.has(id));
    inert.length = 0;
    inert.push(...stillInert);
  }

  const patch: StatePatch = {};
  if (Object.keys(working).length > 0) patch.working = working;
  if (add.length > 0) patch.add = add;
  if (ruleOps.update.length > 0) patch.update = ruleOps.update;
  if (ruleOps.touch.length > 0) patch.touch = ruleOps.touch;
  if (ruleOps.supersede.length > 0) patch.supersede = ruleOps.supersede;
  if (notes.length > 0) patch.note = `deterministic fold: ${[...new Set(notes)].join(', ')}`;

  return { patch, fileNotes, consumed, inert };
}

function learnRecoveries(events: StoredEvent[], ctx: FoldContext): Recovery[] {
  const hasOutcome = events.some(
    (e) => e.type === 'TOOL_RESULT' || e.type === 'COMMAND_EXECUTED',
  );
  if (!hasOutcome) return [];
  const sessions = new Set(events.map((e) => e.session_id));
  const seen = new Set(events.map((e) => e.id));
  // History is filtered to the batch's sessions here too: a recovery never pairs across sessions,
  // whatever the caller passed.
  const history = (ctx.history ?? []).filter((e) => sessions.has(e.session_id) && !seen.has(e.id));
  const attempts = collectAttempts([...history, ...events], ctx.root ?? null);
  return findRecoveries(attempts, seen, { isScratchCommand, isHarnessError });
}

/**
 * How long a recovery rule is served without being seen again. Borrowed from headroom, which drops
 * a learned error pattern after 21 days unseen: a mistake the agent has stopped making is either
 * learned or about a layout that has moved on. It fades through the ordinary TTL decay - `stale`,
 * not deleted (invariant 13) - and seeing the mistake again revives it.
 */
export const RECOVERY_TTL_SECONDS = 21 * 86_400;

/** Evidence a rule keeps accumulating. Past this, re-observation only revalidates it. */
const MAX_RULE_EVIDENCE = 12;

interface RuleOps {
  add: AddItem[];
  update: NonNullable<StatePatch['update']>;
  touch: string[];
  supersede: NonNullable<StatePatch['supersede']>;
}

/** Recoveries of one wrong path or command, in the order they were learned. */
function groupRecoveries(learned: Recovery[]): Recovery[][] {
  const groups = new Map<string, Recovery[]>();
  for (const r of learned) {
    const key = `${r.kind}\u0000${r.failed.key}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The file a path rule says was meant, or every file an ambiguous one has seen. */
function rightPathsOf(rule: MemoryItem): string[] {
  return rule.fields.ambiguous === true ? stringList(rule.fields.candidates) : stringList(rule.fields.references);
}

function evidenceOf(group: Recovery[]): string[] {
  return [...new Set(group.flatMap((r) => [r.failed.resultEventId, r.success.resultEventId]))];
}

/**
 * Seeing a rule's mistake again is evidence that it is still true: revalidate it (`touch` sets
 * `last_validated_at`, which the TTL counts from), add the new evidence, revive it if it had
 * faded - never add it a second time.
 */
function revalidate(rule: MemoryItem, group: Recovery[], ops: RuleOps, fields: Record<string, unknown> = {}): void {
  const fresh = evidenceOf(group).filter((id) => !rule.evidence.includes(id));
  const room = Math.max(0, MAX_RULE_EVIDENCE - rule.evidence.length);
  const change: RuleOps['update'][number] = { id: rule.id };
  if (fresh.length > 0 && room > 0) change.evidence = fresh.slice(0, room);
  if (rule.status === 'stale') change.status = 'active';
  const merged = rule.fields.stale_paths != null ? { ...fields, stale_paths: null } : fields;
  if (Object.keys(merged).length > 0) change.fields = merged;
  if (rule.ttl_seconds == null) change.ttl_seconds = RECOVERY_TTL_SECONDS;
  if (Object.keys(change).length > 1) ops.update.push(change);
  ops.touch.push(rule.id);
}

/**
 * Turn the recoveries of one wrong path or command into patch operations, against the rules
 * already learned about it.
 *
 * One wrong path "fixed" to two different files is not a typo, it is ambiguity: `src/utils.ts`
 * reached for when the agent meant whichever utility module the task needed. Two rules each
 * naming one file would send the next session to the wrong one half the time, so they collapse
 * into a single rule that says to search. The old rules are retired by `add.supersedes`, which
 * `validatePatch` guards like any other retirement (invariant 12); a protected rule never reaches
 * here, because the lookup does not return one.
 */
function planRecoveryRules(group: Recovery[], existing: MemoryItem[], issues: string[], ops: RuleOps): void {
  const head = group[0]!;
  const retireIssues = (by: string) => {
    for (const id of issues) ops.supersede.push({ id, by, reason: 'the failure was recovered from' });
  };

  if (head.kind === 'command') {
    const fixes = [...new Set(group.map((r) => r.success.key))];
    fixes.forEach((fix, n) => {
      const same = group.filter((r) => r.success.key === fix);
      const rule = existing.find((i) => i.fields.command === fix);
      if (rule) {
        revalidate(rule, same, ops);
        if (n === 0) retireIssues(rule.id);
      } else {
        ops.add.push(recoveryItem(same, n === 0 ? issues : []));
      }
    });
    return;
  }

  const ambiguous = existing.find((i) => i.fields.ambiguous === true);
  const plain = existing.filter((i) => i.fields.ambiguous !== true);
  const rights = [...new Set([...existing.flatMap(rightPathsOf), ...group.map((r) => r.success.key)])];

  if (ambiguous) {
    const known = stringList(ambiguous.fields.candidates);
    revalidate(ambiguous, group, ops, rights.length > known.length ? { candidates: rights } : {});
    for (const p of plain) {
      ops.supersede.push({ id: p.id, by: ambiguous.id, reason: 'the same wrong path was fixed to different files' });
    }
    retireIssues(ambiguous.id);
    return;
  }
  if (rights.length >= 2) {
    ops.add.push({
      category: 'discoveries',
      // No count of the files in the text: it would be false as soon as there is one more (invariant 28).
      text: `\`${head.failed.key}\` does not exist; search for the file before opening it (it has been several different files).`,
      importance: 'medium',
      confidence: 0.7,
      source: 'deterministic',
      evidence: evidenceOf(group).slice(0, MAX_RULE_EVIDENCE),
      reason: 'calls on this path failed as not found, and were followed by successful calls on different files',
      ttl_seconds: RECOVERY_TTL_SECONDS,
      tags: ['recovery'],
      supersedes: [...plain.map((p) => p.id), ...issues],
      // Only the missing path is a claim the staleness check may test; the candidates are history.
      fields: { recovery: 'path', ambiguous: true, absent_references: [head.failed.key], candidates: rights },
    });
    return;
  }
  const rule = plain.find((p) => rightPathsOf(p).includes(head.success.key));
  if (rule) {
    revalidate(rule, group, ops);
    retireIssues(rule.id);
    return;
  }
  ops.add.push(recoveryItem(group, issues));
}

/**
 * The durable rule a recovery teaches.
 *
 * A wrong path is a fact about the repository's layout, so it is a `discoveries` item: served
 * by query when the agent works near that file, not taxed on every bootstrap. A command that does
 * not work here, and the one that does, is how this project is operated - a `conventions` item,
 * which the bootstrap serves, because the agent will not think to query before running it.
 *
 * `same` is every recovery in the batch with this failure and this fix; the first one speaks.
 */
function recoveryItem(same: Recovery[], supersedes: string[]): AddItem {
  const r = same[0]!;
  const base = {
    text: r.text,
    importance: 'medium' as const,
    confidence: 0.7,
    source: 'deterministic' as const,
    evidence: evidenceOf(same).slice(0, MAX_RULE_EVIDENCE),
    ttl_seconds: RECOVERY_TTL_SECONDS,
    tags: ['recovery'],
    ...(supersedes.length > 0 ? { supersedes } : {}),
  };
  if (r.kind === 'path') {
    return {
      ...base,
      category: 'discoveries',
      reason: 'a call on the first path failed as not found; the same call on the second succeeded',
      // What must hold for the rule to stay true: the right file exists and the wrong one does not.
      // The staleness check reads these instead of the text, which names the missing path on purpose.
      fields: { recovery: 'path', references: [r.success.key], absent_references: [r.failed.key] },
    };
  }
  return {
    ...base,
    category: 'conventions',
    reason: 'the first command failed as malformed; a related retry succeeded',
    fields: {
      recovery: 'command',
      failed_command: r.failed.key,
      command: r.success.key,
      ...(r.errorClass ? { error_class: r.errorClass } : {}),
    },
  };
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
