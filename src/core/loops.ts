import type { StoredEvent } from '../store/store.js';
import { isHarnessError } from './fold.js';

/**
 * Loop detection, borrowed from headroom's `learn/loops.py`: the agent issuing the same call again
 * and again. Waste that scales with the repetitions rather than being paid once.
 *
 * A signal, never memory (invariant 28): a count of repetitions is a measurement of one session,
 * true of that session only. `status` and `doctor` report it; nothing here writes a patch. Pure,
 * and never on the hook path (invariant 17) - it reads a session's whole tool traffic.
 *
 * Stricter than headroom's, which counts a signature over a whole session. Run over 253 real
 * sessions, that flagged a batch job run six times on purpose, every screenshot after a click and
 * every read of a file being edited. So a repetition counts only when it is the same call, with the
 * same answer, with nothing written in between: the same question put to an unchanged world. A
 * different answer means something moved - a job made progress, a query saw new rows - and asking
 * again was the point.
 */

/** Repetitions of one call, same answer, nothing written in between, that make a loop. */
export const LOOP_MIN_REPEATS = 3;

/** How many calls a loop's repetitions may span. Three reads of a file an hour apart are not one. */
export const LOOP_WINDOW = 15;

export interface ToolCallRecord {
  sessionId: string;
  tool: string;
  /** Canonical identity of the call: tool plus its normalized arguments. */
  signature: string;
  /** Human-readable form, for a report. */
  display: string;
  /** Whether the call's own outcome was an error; null when no outcome was stored. */
  failed: boolean | null;
  /**
   * What the call returned, normalized. Null when no outcome was stored: an empty or benign result
   * is discarded at ingest, so "unknown" is mostly "nothing", and matches any answer.
   */
  outcome: string | null;
  /** Position in the session's event order. */
  at: number;
  /**
   * After this, the same call may rightly answer differently, so every run of repetitions before
   * it ends: a write to the project, or the user speaking ("I reconnected it, try again").
   */
  resets: boolean;
  /** Never counted: waiting on something, or looking at a world this cannot see change. */
  ignored: boolean;
}

export interface LoopFinding {
  sessionId: string;
  tool: string;
  signature: string;
  display: string;
  repeats: number;
  /** Most of the repetitions failed: the agent retried a call that kept failing. */
  errorLoop: boolean;
  /** Event positions of the first and last repetition. */
  firstAt: number;
  lastAt: number;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/**
 * Tools whose purpose is to be called repeatedly (a background shell's output, a task list, a
 * wake-up), and tools acting on a world whose changes are invisible here: a browser, a desktop,
 * a remote database. A screenshot after every click is the same call with the same (empty) text
 * answer and a different picture.
 */
const IGNORED_TOOLS =
  /^(?:BashOutput|TaskOutput|KillShell|KillBash|TodoWrite|TodoRead|TaskList|TaskGet|TaskUpdate|TaskCreate|TaskStop|ScheduleWakeup|Monitor|SendMessage|write_stdin|update_plan)$|poll|wait|status|browser|computer|playwright|chrome|screenshot|navigate|page|click|execute_sql|query_logs/i;

/**
 * Commands where repeating is the point: the working tree's state, a test or build run, a process
 * or CI status, a sleep, another process's output in a temp file.
 *
 * Repeated test runs with nothing edited in between are sometimes waste, but an edit made through
 * a subagent is invisible here, so a test rerun is given the benefit of the doubt.
 */
const POLLING_COMMANDS = [
  /^git\s+(?:status|diff|log|show|branch|fetch|stash\s+list|worktree\s+list)\b/,
  /^(?:sleep|wait|watch|ps|pgrep|jobs|top|uptime|date|pwd|whoami|ls|lsof)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint|check|dev|start)\b/,
  /^(?:npx\s+|poetry\s+run\s+|uv\s+run\s+)?(?:vitest|jest|tsc|eslint|pytest|mypy|ruff|playwright|next\s+build)\b/,
  /^(?:\S*python\d?(?:\.\d+)?\s+-m\s+)?(?:pytest|unittest|mypy)\b/,
  /^(?:cargo|go)\s+(?:test|build|check|vet|clippy)\b/,
  /^(?:make|just)\b/,
  /^gh\s+(?:run|pr\s+checks|pr\s+status|pr\s+view)\b/,
  /^(?:docker|docker-compose|kubectl)\s+(?:ps|logs|get|compose\s+ps|compose\s+logs)\b/,
  /^curl\b.*\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/,
];

/** Anywhere in the command: a wait loop, or reading what another process writes to a temp file. */
const POLLING_ANYWHERE = /\bsleep\s+\d|\b(?:until|while)\b.*\bdo\b|(?:^|\s|["'=])(?:\/private)?\/tmp\/|\/var\/folders\/|\.log\b/;

/** Shell commands that change the project, and so end a run of repetitions like an edit does. */
const MUTATING_COMMAND =
  /(?:^|[;&|]\s*)(?:git\s+(?:commit|add|checkout|switch|stash(?!\s+list)|merge|rebase|reset|pull|cherry-pick|restore|rm|mv|apply|am)|(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|uninstall|ci)|pip\d?\s+install|poetry\s+(?:install|add|lock|remove)|uv\s+(?:add|sync|pip)|sed\s+-i|perl\s+-pi|rm|mv|cp|mkdir|touch|tee|patch|ln)\b|(?:^|\s)>>?\s*(?!&|\/dev\/)[\w.~"'$\/-]/;

/** Shell prefixes that do not change which command runs: `cd dir &&`, env assignments, `source venv &&`. */
function stripShellPrefix(command: string): string {
  let s = command.trim();
  for (;;) {
    const next = s
      .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '')
      .replace(/^source\s+\S+\s*(?:&&|;)\s*/, '')
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (next === s) return s;
    s = next;
  }
}

export function isPollingCommand(command: string, root: string | null = null): boolean {
  const s = withoutRoot(stripShellPrefix(command), root);
  return POLLING_COMMANDS.some((p) => p.test(s)) || POLLING_ANYWHERE.test(s);
}

/** A project may itself live under a temp directory; its own files are not another process's output. */
function withoutRoot(text: string, root: string | null): string {
  return root ? text.split(root).join('<root>') : text;
}

export function isMutatingCommand(command: string): boolean {
  return MUTATING_COMMAND.test(stripShellPrefix(command));
}

/**
 * Output-limiting fragments that do not change which command is run: `| head -50` and
 * `| head -100` are the same command re-fetched with a larger window (headroom's re-fetch loop).
 * Other numbers are kept, unlike headroom: `sed -n '1,80p' f` then `sed -n '80,160p' f` is paging
 * through a file, not asking the same question twice.
 */
const PAGINATION = /\|\s*(?:head|tail)(?:\s+-n)?\s*-?\d+\b|\s--max-count[= ]\d+/g;

export function normalizeCommand(command: string): string {
  return stripShellPrefix(command).replace(PAGINATION, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * An answer, up to what changes on every run without the answer changing: timestamps, durations,
 * temp ids. Other numbers are kept - a count that moved is the world moving.
 */
export function normalizeOutcome(output: string): string {
  return output
    .slice(0, 4000)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, 'T')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m)\b/g, 'D')
    .replace(/\s+/g, ' ')
    .trim();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Stable JSON: key order must not split a group. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Arguments that identify a call, per tool. Anything else is identified by all its arguments. */
const IDENTITY_FIELDS: Record<string, readonly string[]> = {
  Read: ['file_path', 'offset', 'limit'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode'],
  Glob: ['pattern', 'path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
};

function argsIdentity(tool: string, args: unknown): { signature: string; display: string; path: string | null } {
  if (typeof args === 'string') {
    const s = args.replace(/\s+/g, ' ').trim();
    return { signature: s.toLowerCase(), display: s, path: null };
  }
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const fields = IDENTITY_FIELDS[tool];
  const picked = fields ? Object.fromEntries(fields.filter((f) => a[f] !== undefined).map((f) => [f, a[f]])) : a;
  const body = stable(Object.keys(picked).length > 0 ? picked : a);
  const first = fields ? str(a[fields[0]!]) : null;
  return { signature: body, display: first ?? body, path: str(a.file_path) ?? str(a.path) };
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

interface Outcome {
  failed: boolean;
  output: string;
}

/**
 * One record per tool call of each session, in event order.
 *
 * A transcript gives the call (`TOOL_CALL` / `FILE_CHANGED`) and its outcome separately, matched by
 * `tool_use_id` (invariant 27). A hook gives call and outcome as one event. A session read both
 * ways would count every call twice, so a session that has transcript calls uses only those. A
 * call replayed under the same id (a resumed transcript) is counted once.
 *
 * Hook-only sessions are undercounted: two identical hook events with identical output are one
 * event to the ingest dedupe, so a loop seen only through hooks shows fewer repetitions.
 */
export function collectToolCalls(events: StoredEvent[], root: string | null = null): ToolCallRecord[] {
  const transcriptSessions = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    const id = str(p.tool_use_id);
    if (e.type === 'TOOL_CALL' && id) transcriptSessions.add(e.session_id);
    if (!id) continue;
    const output = str(p.error) ?? str(p.output) ?? '';
    if (e.type === 'ERROR_DETECTED') outcomes.set(id, { failed: true, output });
    else if (e.type === 'TOOL_RESULT' && !outcomes.has(id)) outcomes.set(id, { failed: false, output });
    else if (e.type === 'COMMAND_EXECUTED' && typeof p.exit_code === 'number') {
      outcomes.set(id, { failed: p.exit_code !== 0, output });
    }
  }

  const out: ToolCallRecord[] = [];
  const seenIds = new Set<string>();
  events.forEach((e, at) => {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'USER_MESSAGE') {
      out.push({ sessionId: e.session_id, tool: 'user', at, signature: 'user::message', display: 'user message', failed: null, outcome: null, resets: true, ignored: true });
      return;
    }
    const tool = str(p.tool) ?? 'unknown';
    const useId = str(p.tool_use_id);
    const base = { sessionId: e.session_id, tool, at };
    let command: string | null;
    let args: unknown;
    let outcome: Outcome | null;

    if (transcriptSessions.has(e.session_id)) {
      if ((e.type !== 'TOOL_CALL' && e.type !== 'FILE_CHANGED') || !useId) return;
      const key = `${e.session_id}\u0000${useId}`;
      if (seenIds.has(key)) return;
      seenIds.add(key);
      outcome = outcomes.get(useId) ?? null;
      if (e.type === 'FILE_CHANGED' || WRITE_TOOLS.has(tool)) {
        // A failed edit changed nothing, so it does not end a run of reads of that file.
        out.push({ ...base, signature: `${tool}::write`, display: str(p.path) ?? tool, failed: outcome?.failed ?? null, outcome: null, resets: outcome?.failed !== true, ignored: true });
        return;
      }
      command = str(p.command);
      args = p.args;
    } else {
      if (e.type === 'FILE_CHANGED') {
        out.push({ ...base, signature: `${tool}::write`, display: str(p.path) ?? tool, failed: null, outcome: null, resets: true, ignored: true });
        return;
      }
      const output = str(p.error) ?? str(p.output) ?? '';
      if (e.type === 'COMMAND_EXECUTED' && typeof p.exit_code === 'number') {
        outcome = { failed: p.exit_code !== 0, output };
      } else if ((e.type === 'TOOL_RESULT' || e.type === 'ERROR_DETECTED') && p.args !== undefined) {
        outcome = { failed: e.type === 'ERROR_DETECTED', output };
      } else {
        return;
      }
      command = str(p.command);
      args = p.args;
    }

    // The harness refusing or timing out is not the agent's call failing (invariant 11): retrying
    // after "auto mode cannot determine the safety of ..." is what the message asks for.
    const harness = outcome?.failed === true && isHarnessError(outcome.output);
    const answer = outcome ? normalizeOutcome(outcome.output) : null;
    const common = { ...base, failed: outcome?.failed ?? null, outcome: answer && answer.length > 0 ? answer : null };
    if (command) {
      const cmd = command.trim();
      out.push({
        ...common,
        signature: `${tool}::${normalizeCommand(cmd)}`,
        display: clip(cmd),
        // A command that changes the project ends a run whether or not it reported success.
        resets: isMutatingCommand(cmd),
        ignored: harness || IGNORED_TOOLS.test(tool) || isPollingCommand(cmd, root) || isMutatingCommand(cmd),
      });
      return;
    }
    const id = argsIdentity(tool, args);
    out.push({
      ...common,
      signature: `${tool}::${id.signature}`,
      display: clip(id.display),
      resets: false,
      ignored: harness || IGNORED_TOOLS.test(tool) || (id.path != null && POLLING_ANYWHERE.test(withoutRoot(id.path, root))),
    });
  });
  return out;
}

export interface LoopOptions {
  minRepeats?: number;
  window?: number;
}

/**
 * Loops in each session: one call repeated at least `minRepeats` times with the same answer, each
 * repetition within `window` calls of the previous one, nothing written and nothing said by the
 * user in between. The longest
 * run per call and session is reported, most repetitions first.
 */
export function detectLoops(calls: ToolCallRecord[], opts: LoopOptions = {}): LoopFinding[] {
  const minRepeats = opts.minRepeats ?? LOOP_MIN_REPEATS;
  const window = opts.window ?? LOOP_WINDOW;
  const bySession = new Map<string, ToolCallRecord[]>();
  for (const c of calls) {
    const list = bySession.get(c.sessionId) ?? [];
    list.push(c);
    bySession.set(c.sessionId, list);
  }

  interface Run {
    lastIndex: number;
    answer: string | null;
    members: ToolCallRecord[];
  }

  const findings: LoopFinding[] = [];
  for (const [sessionId, list] of bySession) {
    const open = new Map<string, Run>();
    const best = new Map<string, LoopFinding>();
    const close = (sig: string, run: Run) => {
      if (run.members.length < minRepeats) return;
      const prev = best.get(sig);
      if (prev && prev.repeats >= run.members.length) return;
      const failed = run.members.filter((m) => m.failed === true).length;
      const head = run.members[0]!;
      best.set(sig, {
        sessionId,
        tool: head.tool,
        signature: sig,
        display: head.display,
        repeats: run.members.length,
        errorLoop: failed * 2 > run.members.length,
        firstAt: head.at,
        lastAt: run.members[run.members.length - 1]!.at,
      });
    };

    list.forEach((c, i) => {
      if (c.resets) {
        for (const [sig, run] of open) close(sig, run);
        open.clear();
        return;
      }
      if (c.ignored) return;
      const run = open.get(c.signature);
      const sameAnswer = run != null && (run.answer == null || c.outcome == null || run.answer === c.outcome);
      if (run && sameAnswer && i - run.lastIndex <= window) {
        run.members.push(c);
        run.lastIndex = i;
        run.answer ??= c.outcome;
        return;
      }
      if (run) close(c.signature, run);
      open.set(c.signature, { lastIndex: i, answer: c.outcome, members: [c] });
    });
    for (const [sig, run] of open) close(sig, run);
    findings.push(...best.values());
  }
  return findings.sort((a, b) => b.repeats - a.repeats || a.firstAt - b.firstAt);
}

export interface LoopSummary {
  /** Sessions whose traffic was read: the one asked for, or the most recent ones. */
  sessions_scanned: number;
  sessions_with_loops: number;
  /** The loop with the most repetitions, or null. */
  worst: { session: string; tool: string; call: string; repeats: number; error_loop: boolean } | null;
}

/** Detect loops over stored traffic and reduce them to what `status` shows. */
export function summarizeLoops(events: StoredEvent[], root: string | null = null, opts: LoopOptions = {}): LoopSummary {
  const findings = detectLoops(collectToolCalls(events, root), opts);
  const top = findings[0];
  return {
    sessions_scanned: new Set(events.map((e) => e.session_id)).size,
    sessions_with_loops: new Set(findings.map((f) => f.sessionId)).size,
    worst: top
      ? { session: top.sessionId, tool: top.tool, call: top.display, repeats: top.repeats, error_loop: top.errorLoop }
      : null,
  };
}
