import type { StoredEvent } from '../store/store.js';
import { extensionOf, hasSourceExtension, projectRelative } from './references.js';

/**
 * Error -> recovery learning, borrowed from headroom's traffic learner.
 *
 * The fold already drops an agent's wrong guesses (invariant 11) and records real failures as
 * short-lived known issues. Neither keeps the *fix*, so the next session makes the same mistake
 * and pays for the same failure. When a call fails and a closely related call of the same tool
 * succeeds a few calls later, the pair is a durable lesson: this path is wrong and that one is
 * right; this command does not work here and that one does.
 *
 * Pure and deterministic (invariant 1). Every guard below exists because the loose version fired
 * on real transcripts - see `docs/invariants.md` and the tests.
 */

/** How far back a success may look for the failure it recovers from, in tool calls. */
export const RECOVERY_WINDOW = 5;

/** One tool call and what became of it. */
export interface Attempt {
  sessionId: string;
  tool: string;
  kind: 'command' | 'path';
  /** The command line, or the project-relative path the call targeted. */
  key: string;
  ok: boolean;
  output: string;
  /** Position of the call and of its outcome in the session's event order. */
  callAt: number;
  resultAt: number;
  /** The event carrying the outcome - an `ERROR_DETECTED`, a `TOOL_RESULT`, a `COMMAND_EXECUTED`. */
  resultEventId: string;
}

export interface Recovery {
  kind: 'path' | 'command';
  failed: Attempt;
  success: Attempt;
  text: string;
  /** Short description of the failure, when it can be read cheaply. */
  errorClass: string | null;
}

interface PendingCall {
  tool: string;
  kind: 'command' | 'path';
  key: string;
  at: number;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function argsPath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  return str(a.file_path) ?? str(a.notebook_path);
}

/**
 * Pair every call with its own outcome (invariant 27), per session, in event order.
 *
 * Transcript calls are correlated by `tool_use_id`: the call is a `TOOL_CALL` (or, for an edit, a
 * `FILE_CHANGED`) and the outcome a `TOOL_RESULT` or `ERROR_DETECTED` with the same id. A hook
 * `COMMAND_EXECUTED` is call and outcome in one event, so it correlates with itself. An outcome
 * with no call is dropped: guessing which call it belonged to is the exact mistake the
 * correlation exists to prevent.
 */
export function collectAttempts(events: StoredEvent[], root: string | null): Attempt[] {
  const attempts: Attempt[] = [];
  const pending = new Map<string, PendingCall>();

  events.forEach((e, at) => {
    const p = e.payload as Record<string, unknown>;
    const useId = str(p.tool_use_id);
    switch (e.type) {
      case 'TOOL_CALL':
      case 'FILE_CHANGED': {
        if (!useId) break;
        const tool = str(p.tool) ?? 'unknown';
        const command = str(p.command);
        if (command) {
          pending.set(useId, { tool, kind: 'command', key: command.trim(), at });
          break;
        }
        const raw = e.type === 'FILE_CHANGED' ? str(p.path) : argsPath(p.args);
        const path = raw ? projectRelative(raw, root) : null;
        if (path) pending.set(useId, { tool, kind: 'path', key: path, at });
        break;
      }
      case 'TOOL_RESULT':
      case 'ERROR_DETECTED': {
        const call = useId ? pending.get(useId) : undefined;
        if (!call) break;
        pending.delete(useId!);
        attempts.push({
          sessionId: e.session_id,
          tool: call.tool,
          kind: call.kind,
          key: call.key,
          ok: e.type === 'TOOL_RESULT',
          output: str(p.error) ?? str(p.output) ?? '',
          callAt: call.at,
          resultAt: at,
          resultEventId: e.id,
        });
        break;
      }
      case 'COMMAND_EXECUTED': {
        const command = str(p.command);
        const code = p.exit_code;
        if (!command || typeof code !== 'number') break;
        attempts.push({
          sessionId: e.session_id,
          tool: str(p.tool) ?? 'Bash',
          kind: 'command',
          key: command.trim(),
          ok: code === 0,
          output: str(p.output) ?? str(p.error) ?? '',
          callAt: at,
          resultAt: at,
          resultEventId: e.id,
        });
        break;
      }
      default:
        break;
    }
  });
  return attempts.sort((a, b) => a.callAt - b.callAt);
}

/** A failure that says the file is not where the call looked. */
const NOT_FOUND = /\b(?:does not exist|no such file|ENOENT|not found)\b/i;

/**
 * Failures that say the *command* was wrong, not the project.
 *
 * Deliberately excludes "No such file or directory" from a shell: on real transcripts that was
 * overwhelmingly `cd api && ...` run from the wrong directory, or `sed` on a path relative to a
 * cwd the agent had changed - facts about the shell's state at that moment, not about the project.
 * And a failing test or build is never here: `npm test` failing, then `npm test -- a.test.ts`
 * passing after a fix, says nothing about which command to use.
 */
const COMMAND_SHAPE_ERROR = [
  /\bcommand not found\b/i,
  /\bnot recognized as an internal or external command\b/i,
  /\bunknown (?:option|flag|command|subcommand|argument)\b/i,
  /\bunrecognized (?:option|argument|arguments|subcommand)\b/i,
  /\binvalid (?:option|choice)\b/i,
  /\bno such (?:option|command|subcommand)\b/i,
  /\bmissing script\b/i,
  /\bcannot find module\b/i,
  /\bModuleNotFoundError\b/,
  /^\s*usage:/im,
];

/** The line of the output that names what went wrong, without shell noise. */
export function errorClass(output: string): string | null {
  for (const line of output.split('\n', 40)) {
    if (!COMMAND_SHAPE_ERROR.some((p) => p.test(line))) continue;
    const clean = line
      .replace(/^\s*\(eval\):\d+:\s*/, '')
      .replace(/^\s*(?:npm|pnpm|yarn)\s+(?:error|ERR!)\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length === 0) continue;
    // A path inside the message would be an absolute, machine-local detail.
    const short = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
    return short.replace(/`/g, "'");
  }
  return null;
}

export function isCommandShapeError(output: string): boolean {
  return errorClass(output) != null;
}

// --------------------------------------------------------------------- relations

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const cur = [j];
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(cur[i - 1]! + 1, prev[i]! + 1, prev[i - 1]! + cost);
    }
    prev = cur;
  }
  return prev[a.length]!;
}

/**
 * Basenames that many unrelated files share. Reading `web/src/index.ts` and then `api/index.ts`
 * is two different files, not a corrected path.
 */
const GENERIC_BASENAMES = /^(?:index|main|mod|lib|__init__|readme|package|page|layout|route|types|utils?|config|setup|test|tests|app|server|client|constants|helpers?|conftest|settings|models?|schema)\.[^.]+$/i;

function splitPath(p: string): { dir: string; base: string; stem: string; ext: string | null } {
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash) : '';
  const base = p.slice(slash + 1);
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  return { dir, base, stem, ext };
}

/**
 * Whether `success` is plausibly the file `failed` was trying to name.
 *
 * Stricter than headroom's basename distance of max(2, len/3): on this repo that pairs
 * `tests/fold.test.ts` with `tests/core.test.ts` - three edits in twelve characters, and two
 * unrelated files. So the distance is measured on the stem, within one directory, with the same
 * extension; a different extension counts only when the stem is identical (`fold.js` /
 * `fold.ts`), and a different directory only when the basename is identical and not generic.
 */
export function pathsRelatedAsTypo(failed: string, success: string): boolean {
  if (!failed || !success || failed === success) return false;
  const a = splitPath(failed);
  const b = splitPath(success);
  if (a.base.length === 0 || b.base.length === 0) return false;
  if (a.base === b.base) return a.dir !== b.dir && !GENERIC_BASENAMES.test(a.base);
  if (a.dir !== b.dir) return false;
  if (a.stem === b.stem) return a.ext !== b.ext;
  if (a.ext !== b.ext) return false;
  const longest = Math.max(a.stem.length, b.stem.length);
  if (Math.min(a.stem.length, b.stem.length) < 3) return false;
  return levenshtein(a.stem, b.stem) <= Math.max(1, Math.floor(longest / 4));
}

/** Tokens common to unrelated commands, which prove nothing about two being the same operation. */
const COMMAND_NOISE_TOKENS = new Set(['head', 'tail', 'cat', 'grep', 'awk', 'sed', 'sort', 'uniq', 'wc', 'xargs', 'find', 'echo']);

/** The binary a shell command runs, skipping `VAR=value` assignments and a `source x &&` prefix. */
export function firstBinary(command: string): string | null {
  let s = command.trim();
  const sourced = /^source\s+\S+\s*&&\s*(.*)$/is.exec(s);
  if (sourced) s = sourced[1]!;
  for (const tok of s.split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.slice(0, eq))) continue;
    return tok.length > 0 ? tok : null;
  }
  return null;
}

function binariesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.slice(a.lastIndexOf('/') + 1);
  const y = b.slice(b.lastIndexOf('/') + 1);
  if (x === y) return true;
  // `python` / `python3`: one a prefix of the other, and barely different.
  return (x.startsWith(y) || y.startsWith(x)) && levenshtein(x, y) <= 2;
}

/**
 * Whether `success` is plausibly a corrected retry of `failed`: the same binary, and either a
 * small edit (at most 40% of the longer command) or a shared substantive argument.
 */
export function commandsRelatedAsRetry(failed: string, success: string): boolean {
  if (!failed || !success || failed === success) return false;
  const binA = firstBinary(failed);
  const binB = firstBinary(success);
  if (!binA || !binB || !binariesMatch(binA, binB)) return false;
  const longest = Math.max(failed.length, success.length);
  if (levenshtein(failed, success) / longest <= 0.4) return true;
  const substantive = (cmd: string, bin: string) =>
    new Set(
      cmd
        .split(/\s+/)
        .filter((t) => t.length >= 5 && !t.startsWith('-') && t !== bin && !COMMAND_NOISE_TOKENS.has(t.toLowerCase())),
    );
  const sa = substantive(failed, binA);
  for (const t of substantive(success, binB)) if (sa.has(t)) return true;
  return false;
}

/** Longest command a rule may quote. A rule the agent cannot read at a glance teaches nothing. */
const MAX_RULE_COMMAND = 200;

function quotable(command: string): boolean {
  return command.length <= MAX_RULE_COMMAND && !command.includes('\n') && !command.includes('`');
}

// ------------------------------------------------------------------------ pairing

export interface RecoveryGuards {
  isScratchCommand: (command: string) => boolean;
  isHarnessError: (text: string) => boolean;
}

/**
 * Find the recoveries completed by the attempts whose outcome is in `fresh`.
 *
 * `attempts` may include earlier history, so a failure seen in one ingest batch still pairs with
 * a success arriving in the next - on the hook path every batch is a single event. Only a success
 * in `fresh` produces a rule, so re-reading history never re-derives one.
 */
export function findRecoveries(attempts: Attempt[], fresh: Set<string>, guards: RecoveryGuards): Recovery[] {
  const out: Recovery[] = [];
  const used = new Set<string>();
  const bySession = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = bySession.get(a.sessionId) ?? [];
    list.push(a);
    bySession.set(a.sessionId, list);
  }

  for (const list of bySession.values()) {
    list.forEach((success, j) => {
      if (!success.ok || !fresh.has(success.resultEventId)) return;
      for (let i = j - 1; i >= Math.max(0, j - RECOVERY_WINDOW); i--) {
        const failed = list[i]!;
        if (failed.ok || failed.tool !== success.tool) continue;
        // Only the most recent failure of this tool is a candidate; an older one was either
        // already recovered or abandoned.
        if (used.has(failed.resultEventId)) return;
        // Issued before the failure came back (parallel calls): not a reaction to it.
        if (success.callAt < failed.resultAt) return;
        const r = buildRecovery(failed, success, guards);
        if (r) {
          used.add(failed.resultEventId);
          out.push(r);
        }
        return;
      }
    });
  }
  return out;
}

function buildRecovery(failed: Attempt, success: Attempt, guards: RecoveryGuards): Recovery | null {
  if (failed.kind !== success.kind) return null;
  // A recovery that is the failure again, verbatim, is a flaky call or a fixed project - not a lesson.
  if (failed.key === success.key) return null;
  if (guards.isHarnessError(failed.output)) return null;

  if (failed.kind === 'path') {
    if (!NOT_FOUND.test(failed.output.slice(0, 400))) return null;
    // Screenshots and build output land wherever a tool put them; they are not the project's layout.
    if (!hasSourceExtension(failed.key) || !hasSourceExtension(success.key)) return null;
    if (!pathsRelatedAsTypo(failed.key, success.key)) return null;
    return {
      kind: 'path',
      failed,
      success,
      errorClass: null,
      text: `\`${failed.key}\` does not exist; the file is \`${success.key}\`.`,
    };
  }

  if (guards.isScratchCommand(failed.key) || guards.isScratchCommand(success.key)) return null;
  if (!quotable(failed.key) || !quotable(success.key)) return null;
  const cls = errorClass(failed.output);
  if (!cls) return null;
  if (!commandsRelatedAsRetry(failed.key, success.key)) return null;
  return {
    kind: 'command',
    failed,
    success,
    errorClass: cls,
    text: `\`${failed.key}\` fails (${cls}); use \`${success.key}\`.`,
  };
}
