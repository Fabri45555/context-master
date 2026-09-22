import { eventText, type ContextEvent, type Importance } from './events.js';

/**
 * PRD 13 / 17 - deterministic importance classification.
 *
 * Nothing here calls a model. The point is that the overwhelming majority of events get
 * their value assigned for free, so the LLM budget is spent only on the events that
 * genuinely need reading. Cues are bilingual (en/it) because the surrounding project is.
 */

/** Phrases that turn a user message into a hard constraint (PRD 18). */
const CONSTRAINT_CUES = [
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bnever\b/i,
  /\bmust not\b/i,
  /\bmust\b/i,
  /\balways\b/i,
  /\bonly use\b/i,
  /\bdo not change\b/i,
  /\brequired?\b/i,
  /\bnon\s+(?:modificare|toccare|usare|cambiare|cancellare|rimuovere)\b/i,
  /\bmai\b/i,
  /\bsempre\b/i,
  /\bdevi\b/i,
  /\bobbligatorio\b/i,
  /\bvincolo\b/i,
  /\brequisito\b/i,
];

/** Phrases that mark a decision with a rationale worth persisting (PRD 14). */
const DECISION_CUES = [
  /\binstead of\b/i,
  /\bwe(?:'ll| will| should)? use\b/i,
  /\bswitch(?:ing)? to\b/i,
  /\bdecided? to\b/i,
  /\bbecause\b/i,
  /\bdoes(?:n't| not) support\b/i,
  /\binvece di\b/i,
  /\busiamo\b/i,
  /\bpassiamo a\b/i,
  /\bperch[eé]\b/i,
  /\bnon va bene\b/i,
  /\bnon supporta\b/i,
];

/**
 * Phrases that mark a *finding* rather than a plan.
 *
 * Added after a real session: the cue list above only recognised decisions phrased as
 * intentions ("we'll use X instead of Y"), and missed the far more common declarative form -
 * "Found the real bug: the default importance was being treated as a claim". Every one of
 * those was classified `medium`, never queued, and never seen by a model.
 */
const DISCOVERY_CUES = [
  /\bfound (?:the|a|an|it|that)\b/i,
  /\bturns out\b/i,
  /\broot cause\b/i,
  /\bthe (?:real|actual) (?:bug|problem|issue|cause)\b/i,
  /\bthe (?:bug|problem|issue) (?:is|was)\b/i,
  /\bfixed by\b/i,
  /\bregression\b/i,
  /\bconfirmed:/i,
  /\bscopert[oa]\b/i,
  /\bil (?:vero )?(?:bug|problema|errore) (?:è|era)\b/i,
  /\bla causa\b/i,
  /\brisulta che\b/i,
  /\bin realt[àa]\b/i,
];

const ERROR_CUES = [
  /\berror\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bpanic\b/i,
  /\bsegfault\b/i,
  /\bETIMEDOUT\b/,
  /\bENOENT\b/,
  /\bcannot find\b/i,
  /\bunhandled\b/i,
  /\btest(?:s)? failed\b/i,
  /\berrore\b/i,
];

/** Output that means "it worked and there is nothing more to know" (PRD 17 ephemeral). */
/**
 * Commands whose success is itself an outcome: work was recorded, shared or released.
 *
 * Successful commands are otherwise tool traffic and closed as inert, which is right for `ls` and
 * wrong for `git commit`: a commit made in another session left "Commit project repository:
 * blocked" as the current task indefinitely, because no worker ever saw it happen. This is a class
 * of command, not one command - the outcome of a task is often a shell exit code and nothing else.
 */
const MILESTONE_COMMAND =
  /(?:^|&&|\|\||;|\n)\s*(?:git\s+(?:-C\s+\S+\s+)?(?:commit|push|merge|tag|rebase)\b|gh\s+(?:pr\s+(?:create|merge)|release\s+create)\b|(?:npm|pnpm|yarn|cargo|poetry)\s+publish\b|twine\s+upload\b)/;

/** `--dry-run` changes nothing, so it finishes nothing either. */
const DRY_RUN = /\s--dry-run\b/;

export function isMilestoneCommand(command: string | undefined | null): boolean {
  if (!command) return false;
  return MILESTONE_COMMAND.test(command) && !DRY_RUN.test(command);
}

/** A milestone that exited 0 - the only kind that says something was finished. */
export function isSuccessfulMilestone(event: ContextEvent): boolean {
  return (
    event.type === 'COMMAND_EXECUTED' &&
    event.payload.exit_code === 0 &&
    isMilestoneCommand(event.payload.command)
  );
}

const BENIGN_OUTPUT = /^\s*(ok|done|success|passed|no changes|nothing to commit|up to date|\d+ passed[^\n]*)\s*$/i;

export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function looksLikeConstraint(text: string): boolean {
  return matchesAny(text, CONSTRAINT_CUES);
}

export function looksLikeDecision(text: string): boolean {
  return matchesAny(text, DECISION_CUES);
}

export function looksLikeDiscovery(text: string): boolean {
  return matchesAny(text, DISCOVERY_CUES);
}

/**
 * Length below which an agent message is progress narration rather than content.
 *
 * Measured, not guessed: on a real 106-message session the median was 79 characters
 * ("Typechecking the whole thing."), while every message carrying a finding was longer than
 * this. Only 15 of the 106 clear the bar, so the recall costs ~11 extra events of a cheap tier.
 */
export const ASSISTANT_SUBSTANCE_CHARS = 150;

export function hasSubstance(text: string): boolean {
  return text.trim().length >= ASSISTANT_SUBSTANCE_CHARS;
}

export function looksLikeError(text: string): boolean {
  return matchesAny(text, ERROR_CUES);
}

/**
 * A shell prompt line, which means the message is pasted terminal output.
 *
 * It is still the user speaking, so it is not discarded — but a paste is evidence, not an
 * instruction. A real session promoted a pasted terminal dump to a `critical` constraint
 * because a cue happened to appear inside the output, and `isProtected` then made it permanent.
 */
const SHELL_PROMPT_LINE = /^\s*(?:\(\w[\w.-]*\)\s*)?[\w.-]+@[\w.-]+[^\n]*[%$#]\s+\S/m;

export function looksLikePastedTerminal(text: string): boolean {
  return SHELL_PROMPT_LINE.test(text);
}

export function classifyImportance(event: ContextEvent): Importance {
  const text = eventText(event);

  switch (event.type) {
    // A changed constraint, requirement or architecture decision is always critical.
    case 'CONSTRAINT_CHANGED':
    case 'REQUIREMENT_CHANGED':
    case 'ARCHITECTURE_CHANGED':
    case 'DECISION_DETECTED':
      return 'critical';

    case 'USER_MESSAGE':
      // User intent is never discardable; an explicit prohibition outranks everything. But a
      // cue found inside pasted terminal output is not a prohibition, and `critical` is the one
      // level that cannot later be withdrawn.
      return looksLikeConstraint(text) && !looksLikePastedTerminal(text) ? 'critical' : 'high';

    case 'ASSISTANT_MESSAGE':
      return looksLikeDecision(text) || looksLikeDiscovery(text) ? 'high' : 'medium';

    case 'ERROR_DETECTED':
      return 'high';

    case 'TASK_STARTED':
    case 'TASK_COMPLETED':
    case 'COMPACTION_REQUESTED':
      return 'high';

    case 'FILE_CHANGED':
      return 'medium';

    case 'COMMAND_EXECUTED': {
      const code = event.payload.exit_code;
      if (typeof code === 'number' && code !== 0) return 'high';
      // "nothing to commit" would otherwise match BENIGN_OUTPUT and be discarded as ephemeral.
      if (isSuccessfulMilestone(event)) return 'high';
      if (looksLikeError(text)) return 'high';
      return BENIGN_OUTPUT.test(event.payload.output ?? '') ? 'ephemeral' : 'low';
    }

    case 'TOOL_CALL':
      return 'low';

    case 'TOOL_RESULT': {
      if (looksLikeError(text)) return 'medium';
      const out = event.payload.output ?? '';
      if (out.length === 0 || BENIGN_OUTPUT.test(out)) return 'ephemeral';
      return 'low';
    }

    case 'SESSION_STARTED':
    case 'SESSION_ENDED':
      return 'low';

    default:
      return 'medium';
  }
}

/**
 * PRD 13/14 - does this event need a model to be understood?
 *
 * Answering "no" is the whole cost saving, so the bar for "yes" is deliberately high:
 * something that carries intent, rationale, or a contradiction.
 */
export function needsSemantics(event: ContextEvent): boolean {
  switch (event.type) {
    case 'USER_MESSAGE':
    case 'DECISION_DETECTED':
    case 'CONSTRAINT_CHANGED':
    case 'REQUIREMENT_CHANGED':
    case 'ARCHITECTURE_CHANGED':
    case 'COMPACTION_REQUESTED':
      return true;
    case 'ASSISTANT_MESSAGE': {
      const text = eventText(event);
      // Asymmetric on purpose: a false negative loses the reasoning permanently, a false
      // positive costs a few hundred tokens of the cheap tier. So substance alone is enough.
      return looksLikeDecision(text) || looksLikeDiscovery(text) || hasSubstance(text);
    }
    case 'ERROR_DETECTED':
      return true;
    case 'TASK_STARTED':
    case 'TASK_COMPLETED':
      return true;
    case 'COMMAND_EXECUTED':
      // The worker is the one that can say which task or goal the milestone finished.
      return isSuccessfulMilestone(event);
    default:
      return false;
  }
}
