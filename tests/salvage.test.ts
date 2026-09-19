import { describe, expect, it } from 'vitest';
import { parsePatch, WorkerRunner } from '../src/workers/runner.js';
import { ScriptedProvider, makeManager } from './helpers.js';

/**
 * One malformed entry must not sink a whole batch.
 *
 * A real run emitted 23 items, one of which lacked `text`. The patch was rejected twice and 48
 * events plus 22 correct items were lost to a single missing field.
 */
describe('salvaging a mostly-valid patch', () => {
  it('keeps the good items and drops the one without text', () => {
    const add = Array.from({ length: 23 }, (_, i) =>
      i === 22 ? { category: 'decisions' } : { category: 'decisions', text: `decision ${i}` },
    );
    const parsed = parsePatch(JSON.stringify({ add }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.add).toHaveLength(22);
    expect(parsed.dropped).toHaveLength(1);
    // The trail has to name the field, or it cannot tell a missing text from a bad category.
    expect(parsed.dropped?.[0]).toMatch(/^add\[22\]: text/);
  });

  it('refuses to salvage when a whole operation is lost', () => {
    // Real run: all 10 add entries were malformed, the patch kept only its `working` block, and
    // it was applied as a success - consuming 58 events and storing no items at all.
    const parsed = parsePatch(
      JSON.stringify({
        working: { current_task: 'reviewing the ingest pipeline' },
        add: Array.from({ length: 10 }, () => ({ category: 'not_a_category', text: 'x' })),
      }),
    );
    expect(parsed.ok).toBe(false);
    // The repair pass then gets the schema error, which is the only thing that can fix the shape.
    if (!parsed.ok) expect(parsed.error).toContain('add');
  });

  it('still refuses a response that is not a patch at all', () => {
    expect(parsePatch('not json').ok).toBe(false);
    // The failure is not an array entry, so there is nothing to drop.
    expect(parsePatch('{"working": "should be an object"}').ok).toBe(false);
    // Dropping the only entry would leave an empty patch, which is not a salvage.
    expect(parsePatch(JSON.stringify({ add: [{ category: 'decisions' }] })).ok).toBe(false);
  });

  it('does not quietly coerce a bad value into a valid one', () => {
    // `importance` is an enum: a wrong value drops that entry, it is not rounded to something.
    const parsed = parsePatch(
      JSON.stringify({
        add: [
          { category: 'decisions', text: 'good', importance: 'high' },
          { category: 'decisions', text: 'bad', importance: 'extremely' },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.add).toHaveLength(1);
    expect(parsed.patch.add?.[0]?.text).toBe('good');
  });

  it('records what it ignored in the patch note', async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({
        add: [
          { category: 'decisions', text: 'Keep the writer path synchronous' },
          { category: 'decisions' },
        ],
      }),
    ]);
    const { manager, cleanup } = makeManager({}, provider);
    try {
      manager.ingestOnly(
        'claude',
        [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'keep the writer path synchronous' }],
        { sessionId: 's1', cwd: manager.projectRoot },
      );
      const runner = new WorkerRunner(manager.store, manager.config, { provider });
      const outcome = await runner.runOnce('s1', 'extraction');

      expect(outcome.status).toBe('ok');
      expect(manager.store.currentState().items).toHaveLength(1);
      // The log has to say what was ignored, or the gap between what the model wrote and what
      // was stored is invisible.
      expect(JSON.stringify(manager.store.listPatches(1))).toContain('dropped malformed');
    } finally {
      cleanup();
    }
  });
});

describe('memory quoting itself', () => {
  // A pasted `contextd memory` listing sat in the queue; the worker re-extracted seven items
  // verbatim under new ids, and the bootstrap then served each decision twice.
  function seeded(responses: string[]) {
    const provider = new ScriptedProvider(responses);
    const made = makeManager({}, provider);
    made.manager.remember({
      add: [{ id: 'd1', category: 'decisions', text: 'Keep the writer path synchronous.', source: 'agent', importance: 'high', confidence: 0.8 }],
    });
    made.manager.ingestOnly(
      'claude',
      [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'here is what memory says: keep the writer path synchronous' }],
      { sessionId: 's1', cwd: made.manager.projectRoot },
    );
    return { provider, ...made };
  }

  it('drops a verbatim re-add and moves its links onto the original', async () => {
    const { manager, provider, cleanup } = seeded([
      JSON.stringify({
        add: [
          { id: 'd9', category: 'decisions', text: 'keep the writer path  synchronous' },
          { id: 'c1', category: 'constraints', text: 'No async writes to the store' },
        ],
        link: [{ from: 'c1', to: 'd9', kind: 'governs' }],
      }),
    ]);
    try {
      const out = await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      expect(out.status).toBe('ok');
      const ids = manager.store.allItems(false).map((i) => i.id);
      expect(ids).toContain('c1');
      expect(ids).not.toContain('d9');
      expect(manager.store.allEdges().map((e) => `${e.from}->${e.to}`)).toContain('c1->d1');
    } finally {
      cleanup();
    }
  });

  it('closes the batch as inert when every add was a copy', async () => {
    const { manager, provider, cleanup } = seeded([
      JSON.stringify({ add: [{ id: 'd9', category: 'decisions', text: 'Keep the writer path synchronous' }] }),
    ]);
    try {
      const out = await new WorkerRunner(manager.store, manager.config, { provider }).runOnce('s1', 'extraction');
      // Not `invalid`: nothing was wrong with the output, it just derived nothing new.
      expect(out.status).toBe('noop');
      expect(provider.calls).toHaveLength(1);
      expect(manager.metrics('s1').events.pending).toBe(0);
    } finally {
      cleanup();
    }
  });
});
