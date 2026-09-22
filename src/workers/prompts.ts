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
