import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/core/config.js';
import { ConfigSchema } from '../src/core/config.js';
import { makeEvent, type ContextEvent, type EventType } from '../src/core/events.js';
import { ContextManager } from '../src/daemon/manager.js';
import type { CompletionResponse, Provider } from '../src/workers/providers/types.js';

export function tempProject(config: Partial<Config> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'contextd-test-'));
  writeFileSync(join(root, 'contextd.config.json'), JSON.stringify(config), 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse(overrides);
}

/** A provider that replays scripted responses, so worker tests never touch a network. */
export class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  readonly isLocal = true;
  calls: string[] = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async complete(req: { user: string }): Promise<CompletionResponse> {
    this.calls.push(req.user);
    const next = this.queue.shift() ?? '{}';
    if (next instanceof Error) throw next;
    return { text: next, usage: { input_tokens: 100, output_tokens: 50 } };
  }
}

export function event(
  type: EventType,
  payload: Record<string, unknown> = {},
  opts: Partial<ContextEvent> = {},
): ContextEvent {
  return makeEvent({
    session_id: opts.session_id ?? 's1',
    source: opts.source ?? 'test',
    timestamp: opts.timestamp ?? new Date().toISOString(),
    type,
    payload,
    ordinal: opts.ordinal ?? null,
    ...(opts.importance ? { importance: opts.importance } : {}),
  });
}

export function makeManager(
  config: Partial<Config> = {},
  provider?: Provider,
): { manager: ContextManager; cleanup: () => void; root: string } {
  const { root, cleanup } = tempProject(config);
  const manager = new ContextManager({ cwd: root, ...(provider ? { provider } : {}) });
  return {
    manager,
    root,
    cleanup: () => {
      manager.close();
      cleanup();
    },
  };
}
