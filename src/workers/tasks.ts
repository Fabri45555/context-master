import type { WorkerTask } from '../core/config.js';
import type { Conflict } from '../core/conflicts.js';
import type { MemoryItem, ProjectState } from '../core/state.js';
import type { StoredEvent } from '../store/store.js';
import {
  LEARN_SYSTEM,
  PATCH_SHAPE,
  renderEventsForWorker,
  renderStateForWorker,
} from './prompts.js';

/**
 * PRD 14 / 44 - one prompt per kind of semantic work.
 *
 * The tasks were routed to different model tiers from the start but all shared the
 * extraction prompt, which meant paying for a high tier to do a job it was never told
 * about. Each task now states its own objective, and declares whether it reads events or
 * existing memory - because reconciliation is not about new events at all.
 */

/**
 * `episodes` reads a session's failure -> success episodes (src/core/episodes.ts), which are built
 * from events that may already be processed: it neither consumes nor re-marks them (invariant 5),
 * and advances a per-session watermark instead.
 */
export type TaskInput = 'events' | 'conflicts' | 'memory' | 'episodes';

export interface TaskDefinition {
  task: WorkerTask;
  /** What this task reads. Determines how the runner selects its batch. */
  input: TaskInput;
  system: string;
  describe: string;
}

const COMMON_RULES = `Hard rules:
- Never invent information. If the input does not state it, do not record it.
- Never store source code. Record a file path and its purpose instead.
- Preserve explicit user instructions verbatim in meaning, as constraints with source "user"
  and importance "critical". Do not soften them into preferences.
- When new information contradicts an existing item, supersede it. Do not silently delete it.
- Lower "confidence" below 0.7 when you are inferring rather than quoting.
- Cite the ids that justify each change in "evidence".
- Only two kinds of id may be referenced: an id present in the state you were given, or one you
  set yourself on an item in this same patch's "add". Never invent an id, never reuse an id you
  saw quoted inside an event's text, and never use a file path as an id. To link two items you
  are adding at once, give both an explicit "id" first.
- The session's own scaffolding is not project information: a prompt telling the agent how to
  behave, a tool the harness refused to run, a permission denial. None of it belongs in memory.
- A "constraint" is a standing rule about the project or its code. Permission granted for this
  session, a preference about how to reply, or an instruction about the conversation itself are
  none of those — do not record them, and never as source "user" with importance "critical",
  which is the one combination that can never be withdrawn afterwards.

Reply with a single JSON object and nothing else. No markdown fence, no commentary.
An empty object {} is a valid answer when nothing should change.`;

export const EXTRACTION_SYSTEM = `You are a context maintenance worker for a software project.

Your job is NOT to solve the coding task. Your job is to maintain persistent project state.

You are given the current project state and a batch of new events from the coding session.

Decide:
- what must be preserved as durable project memory
- what can be compressed into a single statement
- what can be discarded
- what decisions were made, and why
- what constraints or requirements changed
- what the current task state is

Prefer updating an existing item over adding a near-duplicate.
A decision must carry its reason when the events give one.
Link a new item to the memory it relates to, so retrieval can reach one from the other.

Be strict about the difference between a decision and a piece of finished work, because a real
run put eighteen changelog entries into "decisions" and left the category useless:
- "decisions" is for a choice that constrains what comes next, with its reason: "state is kept in
  SQLite because the whole writer path is synchronous".
- "completed_work" is for something that was done: "added regression tests for the importance bug".
  If it reads like a changelog line, it belongs here.
- "discoveries" is for a fact about the system that was learned and would cost time to relearn.

Confidence is a claim you have to earn. Reserve 1.0 for something the user stated in so many
words; use 0.6-0.8 for a reading of the evidence. Marking everything 1.0 makes the field useless.

One statement per item. An item that lists eight unrelated fixes cannot be retrieved for any of
them, and retrieval is the only reason any of this is stored.

Never record a measurement as a durable fact. Test counts, token totals, percentages and timings
change every run, and a stored number is a lie the moment it moves — a real session recorded
"coverage = 93.2%" and "194-198 tests" as completed work, both already false. Record that the
measurement exists and where it lives; the current value is always cheaper to look up than to
distrust.

Record what the user asked for under "goals", in their own terms. It is the one thing a new
session cannot reconstruct from the repository.

A successful commit, push, merge, tag or publish is evidence that work was finished. Use it to
update "working" (the task, its status, the next action) and to close the goals it completes -
citing the command's event id. Do not add it as its own memory item: it is a changelog line, and
the repository already records it.

When the events show that an existing goal was met, a requirement satisfied, an open question
answered or a known issue fixed, "close" it: say what closed it and cite the event ids that show
it. Do not remove it and do not supersede it - a finished goal is history worth finding, it just
stops being orientation. Close only on evidence of the outcome, never on the agent saying it will
do something. Items that are not goals, requirements, open questions or known issues cannot be
closed.

A question the user asks the agent is not an "open_questions" item. Open questions are what the
project has not decided yet; a question put to the agent is answered in the session.

Text the user pasted from this memory system's own output - a memory listing, a status report,
a context dump - is the memory quoting itself. Never add those statements again; they are
already in the state you were given.

${COMMON_RULES}

${PATCH_SHAPE}`;

export const SUMMARIZATION_SYSTEM = `You are a context compression worker for a software project.

You are given the current project state and a batch of events that are individually
low-value but may collectively mean one thing.

Your only job is to compress. Specifically:
- collapse many events that describe a single outcome into one statement
- merge existing memory items that say the same thing, superseding the duplicates
- do NOT introduce facts that are not already present in the state or the events
- do NOT add new categories of information; this task only condenses

Prefer "update" and "supersede" over "add". Adding more items than you retire means you
have not compressed anything.

${COMMON_RULES}

${PATCH_SHAPE}`;

export const CONFLICT_RESOLUTION_SYSTEM = `You are a contradiction resolution worker for a software project.

You are given pairs of existing memory items that appear to contradict each other. They were
paired by a textual heuristic, so some pairs are NOT real contradictions.

For each pair, decide exactly one of:
1. NOT a contradiction - the two statements can both hold. Do nothing for that pair.
2. One supersedes the other - the project changed its mind, or one is simply newer and more
   specific. Emit a "supersede" with the losing id and the winning id, and a "reason" saying
   what changed. Never delete the loser: the history matters.
3. Both are partly right - emit an "update" on the surviving item whose text states the
   reconciled position, and supersede the other.
4. You cannot tell - emit an "update" lowering the confidence of the less certain item and
   add an "open_questions" item naming the ambiguity. Do not guess.

Never resolve a contradiction by weakening an item whose source is "user" and whose
importance is "critical". If a user constraint appears to conflict with an agent decision,
the user constraint wins and the decision is superseded.

Recency is evidence, not proof. A specific, reasoned older statement beats a vague newer one.

${COMMON_RULES}

${PATCH_SHAPE}`;

export const RECONCILIATION_SYSTEM = `You are a memory reconciliation worker for a software project.

You are given the full active project memory. Nothing new has happened; your job is to make
the existing memory coherent and smaller without losing meaning.

Do all of the following that apply:
- merge items that state the same fact, keeping the clearest wording and superseding the rest
- retire items that later items have obviously made obsolete
- fix items filed under the wrong category (a decision recorded as a discovery, say)
- mark as "stale" anything that reads as a transient observation rather than a durable fact
- split an item that has been overloaded with two unrelated facts into two items
- attach a missing "reason" only when another item already supplies it
- add the relations that are obviously missing: which constraint governs which decision,
  which decision a file implements

Constraints on your own behaviour:
- Do not weaken or remove any item whose source is "user" and importance is "critical".
- Do not invent reasons. If no reason is recorded anywhere, leave it null.
- The result must contain every distinct fact the input contained. You are deduplicating and
  reorganising, not summarising away.

${COMMON_RULES}

${PATCH_SHAPE}`;

export const CLASSIFICATION_SYSTEM = `You are a triage worker for a software project's memory.

You are given memory items whose importance or confidence may be wrong.

For each, decide whether its importance and confidence are justified by its own text and
evidence, and emit "update" operations to correct them. Also emit "touch" for items you
confirm are still accurate and current.

Raise importance only for durable project facts: user constraints, architecture decisions,
API contracts, security requirements. Lower it for transient observations.

Never raise or lower an item whose source is "user" and importance is "critical".

${COMMON_RULES}

${PATCH_SHAPE}`;

export const TASK_DEFINITIONS: Record<WorkerTask, TaskDefinition> = {
  extraction: {
    task: 'extraction',
    input: 'events',
    system: EXTRACTION_SYSTEM,
    describe: 'turn new events into durable project state',
  },
  summarization: {
    task: 'summarization',
    input: 'events',
    system: SUMMARIZATION_SYSTEM,
    describe: 'collapse many low-value events into single statements',
  },
  classification: {
    task: 'classification',
    input: 'memory',
    system: CLASSIFICATION_SYSTEM,
    describe: 'correct the importance and confidence of existing items',
  },
  conflict_resolution: {
    task: 'conflict_resolution',
    input: 'conflicts',
    system: CONFLICT_RESOLUTION_SYSTEM,
    describe: 'decide which side of a contradiction wins, and why',
  },
  complex_reconciliation: {
    task: 'complex_reconciliation',
    input: 'memory',
    system: RECONCILIATION_SYSTEM,
    describe: 'restructure the whole memory for coherence',
  },
  learn: {
    task: 'learn',
    input: 'episodes',
    system: LEARN_SYSTEM,
    describe: 'turn a session\'s failure -> success episodes into lessons',
  },
};

export function taskDefinition(task: WorkerTask): TaskDefinition {
  return TASK_DEFINITIONS[task];
}

// ------------------------------------------------------------- user prompts

export function buildEventsPrompt(
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

export function buildConflictsPrompt(state: ProjectState, conflicts: Conflict[]): string {
  const lines: string[] = ['## contradiction candidates', ''];
  for (const [n, c] of conflicts.entries()) {
    lines.push(`### pair ${n + 1} (${c.reason}, similarity ${c.similarity.toFixed(2)})`);
    for (const item of [c.a, c.b]) {
      const meta = [
        item.importance,
        `conf=${item.confidence.toFixed(2)}`,
        `src=${item.source}`,
        `created=${item.created_at}`,
      ].join(' ');
      lines.push(`- ${item.id} [${item.category}] (${meta})`);
      lines.push(`    ${item.text}`);
      if (item.reason) lines.push(`    why: ${item.reason}`);
      if (item.evidence.length > 0) lines.push(`    evidence: ${item.evidence.join(', ')}`);
    }
    lines.push(`  (the newer of the two is ${c.newer})`);
    lines.push('');
  }
  lines.push(`Return the state patch as JSON. Use base_version ${state.version}.`);
  return lines.join('\n');
}

export function buildMemoryPrompt(state: ProjectState, items: MemoryItem[]): string {
  return [
    renderStateForWorker(state, items),
    '',
    `That is the complete active memory (${items.length} items).`,
    `Return the state patch as JSON. Use base_version ${state.version}.`,
  ].join('\n');
}
