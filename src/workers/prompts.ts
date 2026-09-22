import { MEMORY_CATEGORIES, type MemoryItem, type ProjectState } from '../core/state.js';
import { EDGE_KINDS } from '../core/graph.js';
import { eventText } from '../core/events.js';
import type { StoredEvent } from '../store/store.js';
import type { PatchViolation } from '../core/patch.js';

/**
 * PRD 50 - the worker prompt.
 *
 * The worker is a maintenance function, not an assistant: it reads a bounded slice of
 * state plus a bounded event batch and returns a patch. Everything the patch may contain
 * is spelled out here because a malformed patch is rejected, not guessed at.
 */
/** The patch vocabulary, shared by every task prompt (PRD 16). */
export const PATCH_SHAPE = `The JSON object is a state patch with these optional keys:

{
  "working": {
    "current_task": string|null,
    "task_status": "unknown"|"planning"|"in_progress"|"blocked"|"review"|"done",
    "current_plan": string[],
    "current_state": string|null,
    "next_action": string|null
  },
  "add": [{
    "id": string,
    "category": ${MEMORY_CATEGORIES.map((c) => `"${c}"`).join('|')},
    "text": string,
    "fields": object,
    "importance": "critical"|"high"|"medium"|"low",
    "confidence": number,
    "source": "user"|"agent"|"worker",
    "evidence": string[],
    "reason": string|null,
    "supersedes": string[]
  }],
  "update": [{ "id": string, "text": string, "importance": string, "confidence": number,
               "status": "active"|"stale"|"superseded"|"archived", "reason": string|null }],
  "remove": [string],
  "supersede": [{ "id": string, "by": string, "reason": string }],
  "touch": [string],
  "link": [{ "from": string, "to": string,
             "kind": ${EDGE_KINDS.map((k) => `"${k}"`).join('|')},
             "reason": string|null }],
  "unlink": [{ "from": string, "to": string, "kind": string }],
  "close": [{ "id": string, "reason": string, "evidence": string[] }],
  "note": string
}

Omit any key you do not need. "category" and "text" are the only required fields of an item;
everything else has a default. "id" is optional and assigned for you when absent — set it yourself
only when you need to reference the item elsewhere in this same patch, and then use a short plain
name like "d1" rather than imitating the id format of existing items.

Relations (link) are how retrieval reaches reasoning that the query text does not name.
Use "governs" from a constraint to what it constrains, "motivates" from a reason to the
decision it justifies, "implemented_by" from a decision to the file that realises it, and
"relates_to" only when nothing stronger applies. Do not link an item to itself.`;

/** Compact state rendering: the worker sees identifiers and text, not full JSON rows. */
export function renderStateForWorker(state: ProjectState, items: MemoryItem[]): string {
  const w = state.working;
  const lines: string[] = ['## working memory'];
  lines.push(`state_version: ${state.version}`);
  lines.push(`project: ${w.project_name ?? '(unknown)'}`);
  lines.push(`current_task: ${w.current_task ?? '(none)'}`);
  lines.push(`task_status: ${w.task_status}`);
  lines.push(`current_state: ${w.current_state ?? '(none)'}`);
  lines.push(`next_action: ${w.next_action ?? '(none)'}`);
  if (w.current_plan.length) {
    lines.push('current_plan:');
    for (const [n, p] of w.current_plan.entries()) lines.push(`  ${n + 1}. ${p}`);
  }

  lines.push('', '## existing memory items');
  if (items.length === 0) {
    lines.push('(none yet)');
  } else {
    for (const i of items) {
      const meta = [i.importance, `conf=${i.confidence.toFixed(2)}`, `src=${i.source}`, i.status].join(' ');
      lines.push(`- ${i.id} [${i.category}] (${meta}) ${i.text}`);
      if (i.reason) lines.push(`    why: ${i.reason}`);
    }
  }
  return lines.join('\n');
}

export function renderEventsForWorker(events: StoredEvent[]): string {
  const lines: string[] = ['## new events'];
  for (const e of events) {
    const head = `- ${e.id} ${e.timestamp} ${e.type} (${e.importance})`;
    const body = eventText(e)
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(0, 40)
      .map((l) => `    ${l}`)
      .join('\n');
    lines.push(head);
    if (e.payload.tool) lines.push(`    tool: ${e.payload.tool}`);
    if (typeof e.payload.exit_code === 'number') lines.push(`    exit_code: ${e.payload.exit_code}`);
    if (e.payload.truncated) lines.push(`    (payload truncated from ${e.payload.original_bytes} bytes)`);
    if (body) lines.push(body);
  }
  return lines.join('\n');
}

export function buildWorkerUserPrompt(
  state: ProjectState,
  items: MemoryItem[],
  events: StoredEvent[],
): string {
  return [
    renderStateForWorker(state, items),
    '',
    renderEventsForWorker(events),
    '',
    `Return the state patch as JSON. Use base_version ${state.version}.`,
  ].join('\n');
}

/**
 * PRD 34 - a rejected patch is repaired once rather than dropped. One retry keeps the cost
 * bounded while recovering the common failure (a hallucinated item id, a stale version).
 */
export function buildRepairPrompt(previous: string, violations: PatchViolation[]): string {
  return [
    'Your previous patch was rejected. It was:',
    '',
    previous.slice(0, 4000),
    '',
    'Rejection reasons:',
    ...violations.map((v) => `- [${v.code}] ${v.message}`),
    '',
    'Return a corrected JSON patch. Reference only ids that exist in the state you were given,',
    'omit any operation you cannot justify, and do not weaken user-critical items.',
    'An empty object {} is acceptable if nothing can be safely recorded.',
  ].join('\n');
}

/**
 * The `learn` task: lessons from one session's failure -> success episodes.
 *
 * Its own prompt (invariant 14) because it has its own job and a much narrower output: only
 * `add`, only two categories, every item citing the digest lines it came from. The runner enforces
 * all of that in code (`restrictLearnPatch`); the prompt says it so the model does not spend its
 * one repair retry finding out.
 */
export const LEARN_SYSTEM = `You are a lessons-learned worker for a software project's memory.

You are given a digest of episodes from one coding session. Each episode is a shell command that
failed, what was tried next, and the command that finally worked. Every line carries the id of the
event it came from, in square brackets.

Your job: for each episode, decide whether it teaches something durable about how THIS project is
operated or how it behaves - something a future session would otherwise rediscover by failing the
same way. Examples of a real lesson:
- "The API tests need the database container running first (docker compose up -d db)."
- "Migrations must run before the seed script; the seed fails on a missing table otherwise."
- "Run Python through the project's virtualenv (uv run python); the system python lacks the dependencies."

Most episodes teach nothing, and then you record nothing for them. Not a lesson:
- a test or build that failed and then passed because the code was fixed - that is development
- a command run from the wrong directory, a typo, a flaky or rate-limited call
- anything the digest does not show: if the fix is not visible in the episode, do not guess one

File each lesson as:
- "conventions" when it is how to operate the project (which command, which order, which flag)
- "discoveries" when it is a fact about how the system behaves that cost time to learn

Rules for every item:
- One lesson per item, one or two sentences, stated as the rule to follow next time, with the
  reason in "reason" when the episode shows it.
- "evidence" is required: the ids, copied exactly from the square brackets, of the failure and of
  the step that fixed it. An item without evidence from this digest is discarded.
- "source" is "worker". Nothing in the digest is the user speaking.
- "confidence" at most 0.8: this is a reading of what happened, not something anyone stated.
- "importance" is "medium", or "high" only when ignoring the lesson breaks the build or the tests.
- No numbers that describe this run: no counts of attempts, durations, percentages or test totals.
  They are false the next time it runs.
- No source code, no stack traces, no pasted output. A command line is fine when it is the lesson.
- Do not repeat a lesson already listed under "existing lessons"; record nothing instead.

Reply with a single JSON object and nothing else, no markdown fence:
{
  "add": [{
    "category": "conventions"|"discoveries",
    "text": string,
    "reason": string|null,
    "importance": "medium"|"high",
    "confidence": number,
    "source": "worker",
    "evidence": string[]
  }],
  "note": string
}

Any other key is ignored. An empty object {} is the right answer when no episode teaches anything.`;

/** The learn prompt: the lessons already held (so they are not re-learned), then the digest. */
export function buildLearnPrompt(existing: MemoryItem[], digest: string): string {
  const lines: string[] = ['## existing lessons'];
  if (existing.length === 0) lines.push('(none)');
  for (const i of existing) lines.push(`- [${i.category}] ${i.text}`);
  lines.push('', digest, '', 'Return the lessons as JSON.');
  return lines.join('\n');
}
