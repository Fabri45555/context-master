/**
 * PRD 12 - the context manager as an explicit state machine.
 *
 * Written out rather than left implicit in control flow: every cycle is observable, illegal
 * transitions throw instead of silently corrupting state, and the transition log is what
 * `contextd inspect` reads to explain why a cycle did what it did.
 */

export const MACHINE_STATES = [
  'IDLE',
  'INGEST',
  'CLASSIFY',
  'DISCARD',
  'UPDATE_STATE',
  'NEED_LLM',
  'SPAWN_WORKER',
  'APPLY_RESULT',
  'PERSIST',
  'FAILED',
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

const TRANSITIONS: Record<MachineState, readonly MachineState[]> = {
  IDLE: ['INGEST'],
  INGEST: ['CLASSIFY', 'PERSIST', 'FAILED'],
  CLASSIFY: ['DISCARD', 'UPDATE_STATE', 'NEED_LLM', 'PERSIST', 'FAILED'],
  DISCARD: ['PERSIST'],
  UPDATE_STATE: ['PERSIST', 'NEED_LLM'],
  NEED_LLM: ['SPAWN_WORKER', 'PERSIST'],
  SPAWN_WORKER: ['APPLY_RESULT', 'FAILED'],
  APPLY_RESULT: ['PERSIST', 'FAILED'],
  // A failure still reaches PERSIST so the raw events survive for a retry (PRD 35).
  PERSIST: ['IDLE'],
  FAILED: ['PERSIST', 'IDLE'],
};

export interface Transition {
  from: MachineState;
  to: MachineState;
  at: number;
  reason: string;
}

export class StateMachine {
  private current: MachineState = 'IDLE';
  private log: Transition[] = [];

  constructor(private historyLimit = 200) {}

  get state(): MachineState {
    return this.current;
  }

  get history(): readonly Transition[] {
    return this.log;
  }

  can(to: MachineState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  to(next: MachineState, reason = ''): void {
    if (!this.can(next)) {
      throw new Error(`illegal transition ${this.current} -> ${next}`);
    }
    this.log.push({ from: this.current, to: next, at: Date.now(), reason });
    if (this.log.length > this.historyLimit) this.log.shift();
    this.current = next;
  }

  /** Force back to IDLE after an unexpected throw, keeping the trail honest. */
  reset(reason = 'reset'): void {
    if (this.current !== 'IDLE') {
      this.log.push({ from: this.current, to: 'IDLE', at: Date.now(), reason });
      this.current = 'IDLE';
    }
  }
}
