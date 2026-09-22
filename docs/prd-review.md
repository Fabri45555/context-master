# PRD review: what was built, changed, and deferred

Written for: whoever owns [prd.md](../prd.md) and needs to know where the implementation
departs from it and why.

The PRD is internally coherent and its central bet — deterministic first, semantic second —
held up under real data. What follows is every place the implementation makes a decision the
PRD left open or resolves differently, plus the gaps found while building.

## 1. Integration: hooks and transcripts, not a PTY wrapper

**PRD §39** proposes `contextd run -- claude` as the primary integration, implying the
manager wraps the agent process.

Wrapping means intercepting a PTY, which is fragile and puts the manager on the agent's
critical path. Both Claude Code and Codex already expose two non-invasive surfaces:

- **lifecycle hooks** (Claude Code): low latency, synchronous, so the handler ingests and
  exits without ever calling a model;
- **the JSONL transcript**: append-only and complete, tailed from a byte cursor.

Both paths emit the same dedupe hash, so running them together costs nothing. `contextd run`
still exists, but it only spawns the agent with inherited stdio and tails its transcript —
it never sits between the agent and the terminal. This satisfies §54.7 ("no changes to the
main model") literally rather than approximately.

## 2. Context injection: MCP pull, not prompt rewriting

**PRD §21** prefers that the manager not continuously rewrite the agent's prompt, and that
the agent ask for context instead. That is exactly an MCP server, so `contextd mcp` exposes
`memory_bootstrap`, `memory_query`, `memory_remember`, `memory_explain` and `memory_status`.
The agent decides when to pull and how much.

The small bootstrap context of §21 is still pushed, once, via the `SessionStart` hook, which
is the one moment where pushing is strictly better than waiting to be asked.

## 3. The patch log is the source of truth

**PRD §33** wants versioned memory and **§34** wants atomic patches, but treats them as two
features. Making the append-only patch log authoritative and `memory_items` a materialization
of it collapses them: rollback, diff, audit and `replay` all become consequences of one
design rather than four mechanisms.

`contextd replay --verify` folds the log and compares it to the materialized state. It is a
real guard — it immediately caught that ids minted during `applyPatch` made replay produce a
different set of items, which would have quietly voided the audit guarantee.

## 4. Guarantees the PRD assigns to the prompt, moved into code

**PRD §18** requires user instructions keep their semantics, and **K2** targets ~0% loss of
critical information. A prompt instruction cannot deliver a ~0% guarantee.

`isProtected` in [patch.ts](../src/core/patch.ts) rejects, deterministically, any patch that
deletes or weakens a `source: user` + `importance: critical` item — including patches from
the worker itself. The worker prompt still asks for the right behaviour; the validator is
what makes it true.

## 5. Gaps in the PRD that needed filling

| Gap | Resolution |
|---|---|
| No idempotency story, though §39 implies overlapping hook and transcript ingestion | Content-hash dedupe key, unique per `(session, hash)` |
| §34 says "validate patch" but not what happens when validation fails | One repair pass with the violations fed back, then give up; events stay pending |
| §31 wants a non-blocking queue but nothing bounds it | Bounded queue that sheds `low`/`ephemeral` pending events under back-pressure |
| §36 says redact secrets, without saying where | At ingest, before L2 and before any provider egress — and by key name, not just value pattern |
| §26 budget has no accounting source | Priced from **reported** provider usage, with a trailing-hour window and a session cap |
| §20 suggests keyword search | SQLite FTS5 + BM25, with importance/recency/confidence boosting. No embedding provider, so the local-only default of §37 stays intact |
| §53 defers the economic comparison to an experiment | `contextd bench` ships in the MVP, measuring from real ingested data |
| §10 keeps L2 forever | Retention in days, plus TTL decay on memory items |

## 6. Deviation: the deterministic fold runs at ingest, not in the worker

The PRD's flow diagram (§48) places deterministic processing before the worker but inside the
same cycle. Running the fold at **ingest** instead matters for two reasons:

- deterministic maintenance then still happens when no worker can run at all — no budget, no
  provider, `local_only` with nothing local configured, which is what §26 and §35 both
  require;
- `processed_at` stays honest. It now means "state was derived from this", so the K1 figure
  cannot count history that nothing has read.

## 7. What real data changed

The synthetic test suite passed while three consequential bugs were live. Each was found by
ingesting a real 7,521-record Claude Code session, and each now has a regression test.

1. **Filtering was entirely disabled.** `makeEvent` defaults importance to `medium`, and the
   engine treated that default as a deliberate adapter claim, so no event was ever
   downgraded. Result: 3,401 worthless tool results persisted at `medium` and *zero* events
   discarded. Fixed by recording `importance_source` and only yielding to a real claim.

2. **The "events discarded" metric could never be non-zero**, because discarded events are
   deliberately never stored and the metric counted rows. Now a counter.

3. **The fold promoted agent noise to project memory.** 36 "known issues", almost all of them
   `ENOENT` from the agent guessing at paths, rate-limit errors, and harness permission
   refusals. After filtering: 4, all genuine — including a real `SyntaxError` traceback.
   Bare exit codes with no message are rejected too.

Measured on that session after the fixes: 7,521 records ingested in ~0.85s, 601k tokens of
raw history against a 490-token active context, and a peak observed agent context of 663k
tokens — which is the problem the PRD describes, confirmed rather than assumed.

## 8. Second round: the deferred items

All but one of the items originally deferred have since been built, each in the smallest form
that delivers the capability.

### §44 specialised prompts, and the detector they needed

The five worker tasks were routed to five model tiers while sharing one prompt, so
`complex_reconciliation` was paying opus rates to do extraction. Each task now has its own
objective, and declares what it *reads* — because reconciliation is not about new events at
all: `extraction` and `summarization` read events, `conflict_resolution` reads contradiction
pairs, `classification` and `complex_reconciliation` read the memory itself.

The larger gap was upstream. §44 says what to do once a contradiction is known but never says
how one is noticed, and nothing in the pipeline was looking — two incompatible decisions could
sit side by side indefinitely, both active, and retrieval would serve both. Detection is now
deterministic and free (trigram similarity plus polarity), and a model is spent only on
deciding which side wins. Comparison deliberately crosses category boundaries: a user
constraint in `constraints` contradicted by an agent decision in `decisions` is precisely the
K2 case, and a within-category check is the one thing that would miss it.

### Knowledge graph (§56, Phase 6)

A small labelled graph, not an ontology: seven relation kinds, emitted by workers as a `link`
operation inside an ordinary patch, so relations are versioned, replayable and exportable like
everything else. Retrieval walks one hop out from its best hits with a per-kind weight, which
solves a concrete failure: a constraint that governs a decision is unreachable by keyword
search when its text shares no words with the query.

### Vector search (Phase 4)

Built as an optional layer, and the PRD's original judgement still stands: at a few thousand
items an exhaustive cosine scan is microseconds, so a vector *database* buys nothing. What was
missing was the capability, not the infrastructure. Disabled by default, local provider by
default, fused with BM25 by reciprocal rank because the two score scales are not comparable
and normalising them would add a per-corpus tuning parameter. If the provider is down,
retrieval silently falls back to keyword-only rather than failing.

### Developer UI (§41)

One HTML page and a few JSON endpoints, served from the process that owns the store. No
framework, no build step, no external asset. GET-only and loopback-only by construction: the
memory holds project internals, and a dashboard that could mutate state or answer on the
network would be a far larger surface than the value justifies.

### Distributed store (§32) — not built, and I recommend against it

This is the one item I did not build, and the recommendation is to drop it from the roadmap
rather than defer it again.

The stated future is "PostgreSQL, vector DB, distributed event store". The cost is not the
driver: `commitPatch` validates and applies inside one synchronous SQLite transaction, and
every method on the store, the runner, the ingest pipeline and the CLI is synchronous because
of it. Postgres is async, so this becomes an async refactor of essentially the whole codebase.

The benefit is zero for the product as specified. This is a single-developer, single-machine
tool; there is no second writer to coordinate with. And the case that sounds like it needs a
server — a team sharing project memory — is a different product, with authentication, tenancy,
per-user visibility and cross-user conflict semantics that the PRD does not describe.

What the underlying need actually is, for a tool like this, is *portability*: moving a
project's memory to another machine. Because the patch log is the source of truth, that is
just replaying it, so `contextd import` completes `contextd export` and reproduces state
exactly, including relations. That is a few dozen lines instead of a rewrite.

Still not built, and still correctly out of scope: learned compaction policies (§55 Phase 6).

## 9. The four PRD recommendations, implemented

The recommendations from the first review were spec changes, but three had implementations
worth having.

1. **A latency budget for §31.** "Non-blocking" now has a number: `limits.hook_latency_ms`,
   default 250ms, measured on every hook invocation with p50/p95/max reported by `status` and
   checked by `doctor`. A breach of the hard ceiling warns on stderr, because the agent is
   blocked while the hook runs. Measured p50 on a real session: ~9ms.

2. **K1 defined.** Split into `token_reduction` (the cheap ratio), `coverage` (the share of
   stored events something actually derived state from) and `effective_reduction` (their
   product, and the one to quote). This is what stops a 100% figure being reported on an
   untouched backlog.

3. **The ingestion surface named per agent.** Adapters declare their `surfaces` — kind,
   whether preferred, whether auto-installable, and how to locate transcripts. The CLI no
   longer contains any agent-specific paths, which is what §22 asked for in the first place.
   `contextd surfaces` prints them; `contextd doctor` verifies the whole chain.

4. **A memory-quality metric.** `precision` reports the share of memory never retrieved,
   retired within an hour of being written, held at low confidence, or tagged unverified.
   This measures the failure mode that actually occurred, which was neither loss nor false
   memory but true-and-worthless memory.

## 10. Bugs this round found

Two were real defects in guarantees the PRD makes, both caught by writing a test for
behaviour rather than for code.

1. **K2 was bypassable.** `validatePatch` guarded `remove` and `update` against user-critical
   items but not `supersede`, and superseding retires an item just as surely. An `add` that
   declared `supersedes` had the same hole.

2. **TTL decay did nothing for half the retrieval paths.** `isLive` treated `stale` as live,
   and `stale` is exactly what `decay()` assigns to stop an item being served. The SQL paths
   filtered on `status` and hid the inconsistency, so decayed items kept being returned by
   keyword search and followed through the graph.

## 11. Recommendations for the PRD itself

All four recommendations from the first review are now implemented (§9 above) and should be
folded into the PRD text. Two further ones follow from this round:

5. **§44 should require contradiction *detection*, not just resolution.** As written it
   assumes contradictions arrive labelled. They do not; something has to look, and saying so
   is what makes the section implementable.

6. **Drop the distributed store from §32's future work.** See §8 above: it is an async
   rewrite of the codebase for no benefit to the product as specified, and the need it
   gestures at — moving memory between machines — is satisfied by export/import over the
   patch log. If multi-user shared memory is genuinely wanted, it deserves its own PRD,
   because auth, tenancy and cross-user conflict semantics are the actual content of it.

## 12. Third round: the compaction ladder

Prompted by a survey of comparable open-source work (recorded in
[landscape.md](landscape.md)), which made one gap obvious: every trigger in the system watched
*our* backlog, and nothing watched the quantity the user actually feels — how full the agent's
context is. Every adapter already reported it per turn, and it was going unused beyond a peak
figure in `status`.

[core/lifecycle.ts](../src/core/lifecycle.ts) turns §24's "continuous compaction" into a
graduated response: `steady` → `maintain` (deterministic only) → `consolidate` (a model) →
`reduce` (whole-memory reconciliation). The free rungs run on the hook path, because they are
SQL — measured hook p50 stayed at 9ms with them in place, against a 250ms budget — which is
what keeps maintenance alive with no budget, no provider, or local-only.

Two things this adds that the PRD did not ask for and should:

- **`hard_compactions`**, the count of times the agent compacted anyway. It is the ladder's own
  failure count, and without it the mechanism cannot be judged at all. Proposed as K6.
- **`recovery_ready`**, K5 asked before the fact rather than after: if the agent compacted now,
  is there enough derived state to continue from? High occupancy over a large unprocessed
  backlog is a specific, reportable failure.

### The bug real data found this round

Inferring the context window from the model id was wrong on the first real session. The agent
reported `claude-opus-5` while occupying 512,598 tokens, so a 200k assumption read as 256%
occupancy and pinned the ladder at `reduce` — the most expensive rung — for the whole session.
A turn that fitted is proof the window is at least that large, so observation now overrides
inference, and `window_source` reports which number was used. Same discipline as
`importance_source`: an inferred value must never be indistinguishable from a known one.

### Borrowed: quarantine, minimally

The survey named *quarantine* as a distinct mechanism. Provenance we already had; quarantine we
did not, and it covered a real hole — a worker's hedged guess could sit in the always-on slice
and be injected into every session indefinitely. `alwaysOnEligible` keeps an item below
`min_bootstrap_confidence` (0.5) out of the bootstrap while leaving it fully reachable by query.
User-authored and critical items are never withheld, because that is the loss K2 forbids.

### Refused: the provider proxy

Sitting between the agent and its upstream API is the one surveyed idea worth rejecting outright
rather than deferring: it invalidates the prompt cache precisely where collapsing happens
(caching is prefix-based), it makes the manager a single point of failure for the session against
§35, and it means owning credentials and every provider's request format. Reasoning in full in
[landscape.md](landscape.md) §3; recorded in the PRD as §61.9.

### Two more bugs the same run found

1. **The fold still recorded harness noise.** After the round-two filters, the single "known
   issue" produced from a real session was `Invalid arguments for tool "browser_click"` — a
   schema complaint about the agent's own tool call. Tool-argument and unknown-tool errors are
   now classified as harness errors, alongside permission refusals and rate limits.

2. **Coverage counted events that derived nothing.** The ingest fold marked inert events
   `processed`, and coverage read "processed" as "derived from", so 739 stored events with a
   completely empty memory reported 98.9% coverage and a 98.9% effective reduction. Inert
   events are now closed with `markInert` and subtracted from coverage; the same session reports
   15.4%, and `status` shows the inert count explicitly. This is the round-two K1 problem
   arriving by a second route, which suggests any future "resolved" state needs the same
   scrutiny before it is allowed to feed a metric.

### Three more, on a second pass over the same data

Asked whether everything was closed, I looked again rather than answering from memory, and the
three findings below came out of it. All were pre-existing; two were made visible by the change
above.

1. **Failing commands lost their error text entirely.** `stringifyToolContent` looked up
   `stdout`, `output`, `text`, `content`, `result` in order and returned the first *string* it
   found — and `stdout: ""` is a string. So any command that failed while writing only to
   stderr arrived with empty output, which the fold then correctly judged to have no substance
   and filed as noise. Both streams are now kept, because a failing build routinely splits its
   message across them. This one had been silently discarding the most useful error text in the
   pipeline.

2. **The fold itself conflated rejecting and deriving.** It returned a single `consumed` list,
   so an error it deliberately rejected as noise counted towards coverage exactly like a
   `FILE_CHANGED` that updated the file index. `FoldResult` now separates `consumed` from
   `inert`, and only the former feeds coverage.

3. **A dump is not a finding.** With stderr restored, the first thing recorded as a "known
   issue" was 500 characters of a minified vendor bundle from a failed `npx` call. True, and
   useless — the precision failure rather than the loss failure. `looksLikeDump` rejects text
   whose long lines have almost no whitespace, and it is checked *before* the stack-trace
   exemption, because a minified bundle can contain the word "traceback" and must not buy its
   way in with it.

After all three, the same session reports 13.5% coverage with an empty memory and no worker
available — which is the honest reading of a deterministic-only run, and was 98.9% before this
round.

## 13. The recall failure, found by finally trying to run the loop

Everything up to here measured whether the memory we keep is worth keeping. Preparing the first
real worker run asked the opposite question, and the answer was worse: of 106 agent messages in
a real session, **102 were never queued for a model at all**.

The gate for `ASSISTANT_MESSAGE` was `looksLikeDecision`, a list of cues for decisions phrased as
intentions — "we'll use X instead of Y", "because". Real agent messages mostly state findings
declaratively, and those matched nothing:

- *"Found the real bug: the adapter default importance was treated as a deliberate claim, so the
  classifier could never downgrade anything."*
- *"Moving the deterministic fold into ingestion, where deterministic first belongs."*

Both were classified `medium`, marked inert, and closed. The single most valuable sentence in
the session never reached the extraction worker.

Two changes, both deterministic:

1. `DISCOVERY_CUES` — findings, not just plans, bilingual like the rest.
2. A substance floor, **measured rather than guessed**: on that session the median agent message
   was 79 characters of progress narration ("Typechecking the whole thing."), and only 15 of 106
   exceeded 150 characters. Anything above the floor queues even with no cue at all.

Pending events went from 13 to 33 — about 7k tokens on the cheap tier, which is the entire cost
of recovering the agent's reasoning stream.

The general lesson is about the shape of the gate, not the cues. `needsSemantics` answers a
question that keywords cannot answer, so it must be **asymmetric**: a false negative loses the
reasoning permanently and invisibly, a false positive costs a fraction of a cent. It had been
tuned as though both errors were equal. Recorded as invariant 19.

This is also an argument about PRD 29's metric set: nothing in it could have surfaced this.
Precision measures what we keep; there is no recall measure, because the events we failed to read
leave no trace in memory to count. The only thing that exposed it was reading the discarded
events by hand.

## 14. The same confusion again, in the worst place

Closing the loop for the first time — a local model via ollama, on the real session — the run
returned `noop` with `worker_returned_empty_patch`, which is the correct outcome for a model that
has no idea what it was asked. What was not correct: **the pending queue went from 33 to 0.**

`markProcessed` on an empty patch meant a worker that recorded nothing still counted its whole
batch as coverage. A wrong model, a model ignoring the JSON contract, or a provider quietly
returning junk would therefore show:

- `status: ok` on every run,
- a coverage figure climbing towards 100%,
- and a completely empty memory.

That is the third appearance of one root confusion — *resolved* is not *derived from* — after the
ingest fold and the fold's own `consumed` list. The worker was the worst place for it, because
here the events carried the reasoning the model failed to extract.

Two changes:

1. An empty patch closes its batch with `markInert`. The queue still drains, because otherwise
   the same batch is re-read forever and every retry costs tokens; but coverage stays honest.
   Nothing is lost — the events remain in L2 and `inspect` still reaches them.
2. `emptyRunStreak` plus a `worker output` check in `doctor`: two consecutive runs that read
   events and recorded nothing is a warning, three is a failure. Without it, a broken model is
   indistinguishable from a quiet project — both look like `ok` with no new memory.

Worth stating plainly, because it is the pattern of this whole review: **every state that means
"done" must say whether anything came of it.** Three separate bugs came from a single boolean
standing in for two different facts.

## 15. Two findings from pointing it at a remote model

### `local_only` was about the daemon, not the model

`Provider.isLocal` was a constant, and ollama declared `true`. But ollama runs locally and
*proxies* `*-cloud` models to a remote host, so a tier routed at `gpt-oss:120b-cloud` passed the
`local_only` gate and `doctor` printed **local** — while every prompt left the machine. The same
hole existed for any `base_url` pointing off-box.

PRD 37 is one of the few promises in the document that a user cannot verify for themselves, so
it has to be exact. `isLocalFor(spec)` now answers per model: a `-cloud` suffix is remote, and so
is any non-loopback `base_url`. `doctor` prints **remote** for that tier and refuses to run it
under `local_only`, naming the model rather than the provider.

Worth generalising: a capability flag that describes the *transport* will eventually be wrong
about the *destination*.

### A reasoning model can return nothing at all

The first real run against a 120B reasoning model: 19,458 input tokens, **7,669 output tokens
across two attempts, and no content whatsoever** — the whole budget went to the model's own
reasoning channel, which ollama returns separately from `content`. The runner reported
`empty_patch: no JSON object found in response`, which is accurate and useless: it cannot be
told apart from a model that simply had nothing to say.

Two changes: `ModelSpec.think` (unset by default, so nothing is sent to a provider that would
reject it) and a provider-level diagnostic that names the real problem and the fix when content
is empty but reasoning is not.

The degradation itself was correct, and worth recording as the one thing that behaved: the patch
was rejected twice, the run was marked `invalid`, **all 33 events stayed pending**, and state
stayed at v1. Invariant 8 held under a genuine provider failure rather than a simulated one.

## 16. The first real extraction, and what it put in memory

With reasoning disabled the run applied a patch on the first attempt: 33 events, 22 items, state
v2. Judged item by item, the extraction itself was good — accurate, specific, nothing invented,
and the user's original request correctly identified as `critical`. The problems were not in the
model's reading. They were in what the pipeline let it see, and in what the schema let it claim.

### Session scaffolding became protected memory

Two of the three `constraints` it produced were *"do not acknowledge the summary, do not recap"*
and *"do not respond to messages marked as local-command-caveat"* — Claude Code's own session
scaffolding, recorded as `source: user` + `critical`, which `isProtected` then makes permanent and
unremovable by any patch. The most privileged tier in the memory, filled with harness plumbing.

Three causes, all now fixed:

1. `INJECTED_BLOCK` only matched scaffolding at the *start* of a turn, so anything appended after
   the user's words survived. Blocks are now **excised wherever they appear**, which also keeps
   the user's real words when the two are mixed.
2. The post-compaction resume preamble has no tag at all — it reads exactly like a user message
   and is full of imperatives. Those turns are now dropped whole, along with background-task
   notifications and the local-command caveat.
3. A `USER_MESSAGE` is emitted from **three** places in the Claude adapter, and only one was
   filtered. Finding the third took a second pass over the ingested rows.

A related one, subtler: a pasted terminal transcript *is* the user speaking, but a constraint cue
occurring inside pasted output is not a prohibition. `looksLikePastedTerminal` keeps those at
`high` rather than `critical`, because `critical` is the one level that cannot be withdrawn later.

After the fixes, the same transcripts yield **zero** spurious critical items, the original request
is still captured, and no notification survives as a user message.

### Confidence was uniformly 1.00

All 18 extracted decisions claimed certainty. That makes `confidence` carry no information at
all, and silently disables `min_bootstrap_confidence`, the gate added in §9 above.
`normalizePatch` now clamps anything not authored by the user to `MAX_INFERRED_CONFIDENCE` (0.9) —
the same discipline as `importance_source`: a component may not assert a certainty it cannot have.

### Category misuse: a changelog filed as decisions

Eighteen items landed in `decisions`, and most were finished work ("added regression tests for the
default-importance bug"). A decision is a choice that constrains what comes next, and mixing the
two makes the always-on `Decisions` section a changelog. The extraction prompt now draws the line
explicitly, with `completed_work` and `discoveries` named as the alternatives. That one is a prompt
change rather than a guarantee, so it needs the next real run to confirm.

### Still not measured: extraction quality across a whole session

## 17. The second run: all-or-nothing validation was costing everything

With the inputs cleaned, the second real run failed differently and more usefully:

```
invalid  patch_rejected_twice   events 0
  unknown_item: remove targets unknown id mem_0mu873uy64687e9c0
  unknown_item: link references unknown id mem_0new_discovery_scaffolding
  unknown_item: link references unknown id src/core/ingest.ts
```

Three things at once, and only one of them was the model's fault.

**The ids it removed were real — in a different database.** They appeared inside the event text,
because the memory listing from the previous run had been pasted into the conversation and then
ingested. The model reasonably read them as ids. They exist nowhere in this store. The worker
prompt now states the rule: the only referenceable ids are those in the provided state, or ones
the patch sets itself on `add`. Never an id quoted inside an event, never a file path.

**The validator's all-or-nothing stance cost 45 events of good extraction.** A `remove` of an id
that does not exist removes nothing. A `link` to an id that does not exist links nothing. Both are
provable no-ops, and rejecting the entire patch over them threw away every item the model had
correctly extracted — twice, because the repair pass hit the same wall.

`pruneInertOperations` drops exactly those, records the drop in the patch note so the log still
explains itself, and deliberately refuses to touch `update` or `supersede`: a mistyped `update`
target means the model intended to change something real, and silently discarding that changes
intent rather than normalising it. A user's own patch is never pruned — there the typo deserves
the error. The guarantee that mattered still holds unchanged: a dangling edge never enters the
graph.

**And the deterministic fold recorded four permission denials as project issues.** "Permission for
this action was denied by the … classifier", stored complete with the guidance text about what the
agent may do instead. Same category as invariant 11 and the same fix: a tool the harness refused to
run says nothing about the project. After it, the same transcripts produce no spurious items at
all.

The pattern across both runs is worth naming: **every failure so far has been the pipeline
mishandling a correct model output, or feeding the model something that was never the user's.** The
extraction itself has not yet been the weak part.

## 18. The third run: one missing field, 48 events lost

```
extraction  invalid  events=48  in=28,282  out=11,059  attempts=2
error: empty_patch: patch failed schema: add.22.text: Required
```

Item 23 of 23 had no `text`. The other 22 were fine. Both passes were rejected, all 48 events
stayed pending, and the memory stayed empty — for one missing field. The reported code also lied:
`empty_patch` for a patch that was anything but empty.

`parsePatch` now drops the individual array entries a schema failure blames and re-parses. It
salvages nothing when the failure is elsewhere (a malformed `working` block, a non-object at the
top level) or when the result would be empty, and it never coerces a bad value into a good one —
a wrong `importance` drops that entry rather than being rounded to the nearest enum member. What
was dropped goes into the patch note. The parse failure code is now `unparsable_response`, which is
what it always meant.

That an `add` without `text` is discardable is not a compromise: an item with no text is not a fact.
Nothing that could have been recorded is lost.

### The meta-finding

This is the **third** time the same shape of bug has cost real data:

| Where | What was lost |
|---|---|
| `commitPatch` validation | 45 events, over three invented link targets |
| `parsePatch` schema check | 48 events and 22 items, over one missing field |
| worker empty-patch handling | the queue drained and counted as coverage |

Each time the model's output was mostly correct and the pipeline's response was all-or-nothing.
The principle worth carrying forward: **a component that consumes model output must degrade at the
granularity of the output, not of the request.** Reject the entry, not the batch; drop the no-op,
not the patch. Strictness that discards correct work is not strictness, it is a second failure
layered on a small one.

The counter-rule, so this does not become an excuse for laxity: salvage only where the discarded
piece is provably inert or provably unusable, never where it carries intent. `update`, `supersede`
and protected-item checks are untouched by all of it.

## 19. The fourth run: the first one that worked, and what it still got wrong

`ok patch_applied`, 51 events, state v1, three items. The pipeline finally ran end to end. Three
observations, in order of how much they matter.

**The scaffolding constraint came back.** *"Do not acknowledge the summary, do not recap"* was
recorded again as `source: user` + `critical`. The excision worked; the *preamble* check did not,
because it only looked at the first 600 characters and a compaction summary buries that instruction
thousands of characters in.

Fixing it by scanning the whole text then broke the opposite way: the turn was dropped whole, and
with it the project's **original goal**, which existed nowhere else in the ingested transcripts
except as a quotation inside that same summary. Both failures are the same mistake — treating a
mixed turn as all-or-nothing, the fourth instance in this review. The resolution separates the two
kinds of harness text: an *instruction line* is removed wherever it appears, and a turn is dropped
whole only when its *opening* is framing. Verified both ways: no scaffolding survives, and the goal
does.

**A session permission was filed as a permanent project constraint.** "Allow sending data outside
the machine for real tests" is something the user really said, so no filter should remove it — but
it is about this session's operation, not about the project, and as `user` + `critical` it can never
be withdrawn. That one is scope, not code: the worker prompt now says a constraint is a standing
rule about the project, and that permissions, reply preferences and instructions about the
conversation are not constraints at all.

**Recall dropped from 22 items to 3, and the run could not explain itself.** `attempts=2` with a
single `error` column means the first pass leaves no trace, so a repair pass that returns far less
than the first attempt is invisible. The runner now records a per-pass trail — what was dropped,
what was rejected, how many operations each pass carried — and stores it even on success. Without
that, "the second attempt was worse than the first" is a hypothesis with no evidence, and the next
run would have produced the same unanswerable question.

## 20. The fifth run: the salvage was worse than the rejection

The per-pass trail earned its keep immediately:

```
v1->v2  worker  working
  dropped malformed: add[0] … add[9] | dropped inert: link … (7 of them)
```

**All ten items were dropped**, the seven links then had nothing to point at, and what remained was
a `working` block — which is not empty, so it passed, applied, reported `ok patch_applied`, and
marked 58 events processed. Zero items stored. The salvage added in §18 had produced precisely the
failure invariant 20 exists to prevent, by a route that invariant did not cover.

The rule was too permissive in one specific way: losing *every* entry of an operation is not a
salvage, it is the model having misunderstood the shape. Now, if the dropped count for a key equals
that array's length, nothing is salvaged and the schema error goes to the repair pass, which is the
only thing that can fix a shape. Entry-level salvage survives for what it was meant for: one bad
row among many.

Two further things the trail exposed:

- **It said which entries failed, not why.** "add[0]" cannot distinguish a missing `text` from an
  invalid category. The trail now carries the failing field and message per entry.
- **The prompt contradicted itself.** `COMMON_RULES` told the worker to set explicit ids on items it
  wanted to link together, while the `add` shape shown right below it **did not list an `id` field
  at all** — and the invented ids in those dead links (`mem_0mu89rdk001`) look like imitations of
  the id format of existing items. The shape now lists `id`, says it is optional and assigned when
  absent, and asks for a short plain name rather than an imitation of ours.

That is the fifth instance of the meta-pattern, and the first where **my own fix** was the thing
that caused the loss. Worth recording as such: a degradation rule needs its own failure case
written down, or it becomes a silent success path.

## 21. The sixth run: the loop finally closed, and K1 met

```
Memory items:    14 active     decisions 6, discoveries 5, completed_work 3
Active context:  432 tokens    raw equivalent 205,001
Token reduction: 99.8%    Coverage: 100.0%    Effective (K1): 99.8%   [target >70%]
pending: 0    replay --verify: consistent    conflicts: none
```

Everything the previous five runs were for. The `id` contradiction in the prompt was indeed what
made all ten items malformed — with `id` documented, `+14` items applied with nothing dropped. And
the three quality problems from run four are all gone:

- **Categories are right.** `decisions` hold choices that constrain what comes next ("cap confidence
  for non-user items at 0.9"), `discoveries` hold facts that would cost time to relearn,
  `completed_work` holds the changelog that used to pollute `decisions`.
- **Confidence varies** — 0.80, 0.85, 0.90 — instead of a uniform 1.00, and the clamp holds the
  ceiling.
- **No scaffolding anywhere**, and every item carries its reason.

Two things were *not* wrong despite appearances. The glued words in the terminal output
("respondto", "missingrequired") are a display or copy artefact: the stored text is clean, verified
directly against the database. And the absence of `constraints` is correct — nothing in these
transcripts is a standing rule about the project.

### The metric was the last thing wrong, in the way everything else was

`Effective (K1)` read **18.9%** on that run, with nothing pending and every candidate event
processed. Coverage was dividing by *every stored event*, so 994 correctly discarded tool results
counted against us. That is the same conflation as §12 and §14, now in the measurement rather than
the pipeline: "we chose not to derive from this" treated as "we have not looked at it yet".

Coverage is now `derived / (derived + pending)` — of the events that could ever have produced
state, how many have — with `derived === 0` pinned to zero so a worker returning empty patches
cannot drive it to 100% against an empty memory. Three definitions:

| Definition | What it got wrong |
|---|---|
| `derived / stored` | inert counted as derived → 98.9% on an empty memory |
| `(stored − pending − inert) / stored` | punished correct discarding → 18.9% with nothing outstanding |
| `derived / (derived + pending)` | inert was never a candidate: neither helps nor hurts |

With it, the same session reads 99.8% effective reduction: 205,001 tokens of raw history against a
432-token active context, nothing outstanding, and a memory whose fourteen items are each worth
reading. That is K1 met on real data with a definition that resists flattery — which is the first
claim in this whole review that the PRD's own target can be checked against.

## 22. Dogfooding: the two defects only a live session could show

With hooks installed in contextd's own repo and the MCP server registered, the first extraction ran
against the session that was writing the code. Two defects surfaced that no previous run could
have, because both need the agent and the user to be in the same transcript.

### The worker invented a user instruction

It recorded a goal — "run a real test of the compaction flow using a local model (qwen2.5:7b) and
verify MCP next session" — as `source: user`, `importance: critical`, confidence 1.00. The user had
asked for a real test. **The local model was the agent's own proposal.** The worker had synthesised
an instruction out of the conversation and attributed it, and `source: user` + `critical` is
exactly the pair `isProtected` makes permanent: nothing could then remove it.

This is a different failure from the scaffolding one. Nothing was mis-ingested; the model asserted
a provenance it had no standing to assert. The fix is the rule that was missing everywhere else:
**a worker may attribute something to the user only when it cites a real `USER_MESSAGE` event as
evidence.** Unbacked claims keep their text and lose the attribution, which also brings them back
under the inferred-confidence ceiling. Provenance verified rather than asserted.

An existing test failed immediately on the new rule, citing `evidence: ['evt_x']` — an id that
never existed. The fixture had been sloppy in precisely the way the rule now forbids.

The rule is not a prohibition, and the next run proved it: three goals came back as `source: user`
+ `critical` and all three survived, because all three cite the messages where the user actually
said them.

### An error without its command is unattributable

A throwaway `node -e` query against the database failed, and its stack trace became a project known
issue. `isScratchCommand` was supposed to stop that, and could not: a tool failure arrives as
`ERROR_DETECTED` carrying only `tool_use_id` and the output — **the command lives on the matching
`TOOL_CALL`**. The fold now correlates the two, so a failed one-liner is inert while a failed
`npm run build` is still recorded. Without the correlation the two are the same event shape with
different text.

After both fixes the deterministic fold produces nothing at all from this session, which is the
correct answer: no genuine project issue occurred in it.

## 23. Both halves, measured

The run after those fixes is the one the whole review was working towards:

```
Memory items:    32 active   completed_work 10, decisions 9, discoveries 9, goals 3, known_issues 1
Active context:  296 tokens  raw equivalent 226,024
Token reduction: 99.9%   Coverage: 99.6%   Effective (K1): 99.5%   [target >70%]
```

The provenance rule discriminated rather than blocked: of three goals, two kept `source: user` at
confidence 1.00 because they cite the messages where the user said them, and one was downgraded to
`agent` at 0.90 — correctly, because it restated something the *agent* had proposed. Confidence now
spreads across 0.80/0.90/1.00 instead of sitting at 1.00, so the field carries information again.
One item is worth quoting: `disc7`, *"Model synthesized a user-critical goal without a real
USER_MESSAGE evidence, causing an irremovable constraint"* — the system recording its own defect.

### Retrieval, and the metric that could never move

A targeted query returned exactly the right five items, correctly ranked: the bug, its fix, the
related provenance case, and two neighbours. Retrieval works.

`never_retrieved` still read **100.0%** afterwards. `finish` recovered the ids of what it had served
by **re-parsing its own rendered text** for `[mem_...]`. Workers had started assigning short ids
like `d3` — because a prompt change earlier in this review asked them to — so the regex matched
nothing, `markUsed` received an empty list, and the precision metric was structurally incapable of
moving. The same shape as the very first finding in this document, where "events discarded" could
never be non-zero.

Sections now carry their `itemIds` through, which is also more accurate than scraping: an item the
budget dropped is not credited as retrieved. After the fix, two queries against the real memory:
**never_retrieved 50.0%**. The first honest reading of the retrieval half in the project's life.

### The remaining quality problem: measurements stored as facts

`comp2` recorded "coverage = 93.2%, effective_reduction = 93.2%" and `comp9` "194-198 tests" as
completed work. Both were already false when written — the coverage definition changed twice more
in the same session. A number that moves every run is telemetry, not project state, and `contextd
status` is where it lives. The extraction prompt now says so, and it is the sibling of PRD 19:
code is not memory, and neither is a measurement.

## 24. What a single good run does and does not prove

One run against one batch is evidence, not a measurement. What it established is that the
extraction contract works and that the *inputs* were polluted; what it cannot establish is whether
memory stays coherent across a whole session, whether the category boundaries hold now that the
prompt names them, or whether contradiction resolution fires on real material. Those need a second
run after these fixes, which is the obvious next step.

## 25. After the first compaction on a live, hook-only install

The session compacted with contextd wired in through hooks and MCP. The bootstrap it injected was
the first thing read after the compaction, which is the mechanism working. Reading what it served
and what `status` said afterwards found seven defects, all invisible in the test suite:

| Observed | Cause | Fix |
|---|---|---|
| Bootstrap carried nine decisions and no goal | No section named `goals`; `requirements` likewise | `BOOTSTRAP_SECTIONS` + `QUERY_ONLY_CATEGORIES` must cover every category (tested) |
| `never_retrieved` never moved | Only `forQuery` logged; the injected bootstrap did not | `serveBootstrap` for delivery, `bootstrap` for measurement |
| Stage stuck at `reduce` with 52% occupancy | Hook payloads carry no usage; the flag stayed while the request sat in the queue | `Stop` reads usage from the transcript tail; request live only until the next turn |
| Every `Stop` hook failed silently | `text: null` against a schema accepting `undefined` | `makeEvent` strips nulls |
| (latent) task marked done after every reply | `Stop` emitted `TASK_COMPLETED` — hidden until the crash above was fixed | `Stop` emits no event |
| Seven verbatim duplicates under new ids | A pasted `contextd memory` listing was queued and re-extracted | Verbatim re-adds dropped as no-ops, ids aliased |
| Stored items that were wrong could not be removed | No command for it | `forget`, `remember --supersedes`, `memory_retire` |

Two defects found in the dashboard while building the Benefits view: its Context tab counted a
human preview as a retrieval (moving `never_retrieved` by being looked at), and "tokens avoided"
credited empty retrievals. Both fixed; the page carries its own caveats.

A user goal is `critical` and therefore permanent even once it is done; a second, independent
session found the same gap on its first question ("all five goals still read as open"). Letting any
caller retire it would let an agent with a shell delete user constraints. Resolved with `close`: the
item stays active and protected, leaves the bootstrap, and answers queries as `done` with its
reason. A worker must cite a real event to close a user-critical goal. The same session also misread
a discovery (`disc2`, a fixed bug) as an open issue and proposed retiring it, because query results
carried no category; they now do (`(discovery, historical)`).

The same session's working memory still read "Commit project repository: blocked" after the commit
had been made in the other session. A commit is a successful shell command, which the fold closes as
inert, so no worker ever saw the task end - and working memory had no writer but a worker. The
bootstrap now prints the task's age and the user messages since it was recorded, `doctor` warns at
five (it fired at 16 on this project), and `contextd task` / `memory_task` set it directly.

Follow-up: successful milestone commands (commit, push, merge, tag, PR, publish) now reach a worker
and appear under the task in the bootstrap. Building it exposed that no successful Claude Bash
command had ever carried an exit code - success is `{stdout, stderr, interrupted:false}` - so the
fold could not tell a finished commit from an unknown one.

## 26. What the savings figure should have said

The first Benefits view reported **1.0M tokens / $15.56 saved**. It compared every delivery of
memory with the agent's 519k peak. Two things were wrong with that. Nobody re-reads a whole
conversation to resume. And eight of the ten deliveries were queries inside a session that already
held its context, which avoid nothing. Measured turn by turn, the one real resume (a new session)
started at 51k tokens of which the bootstrap was 425, and answered "what did I ask, what is left"
correctly for +3.6k.

The figure now counts **resumes only** (bootstrap deliveries, with the hook and `memory_bootstrap`
serving the same one merged within ten minutes) and prices each against re-reading the project's
own `.md` documents, measured. On this project that is 1 resume and about $0.56, 28× less than the
first claim. The page says what that comparison leaves out: the user's requests are in none of
those documents, so the alternative to memory is not more expensive, it is incomplete.

The same analysis found the largest fixed cost was not contextd but `CLAUDE.md`: 5.2k tokens in
every session, 12× the bootstrap, mostly the history behind each invariant. That history moved
verbatim to [invariants.md](invariants.md); `CLAUDE.md` keeps one line per rule (2.1k tokens).

Draining the last 19 pending events surfaced two more. The worker rewrote the current task back to
"Commit project repository: blocked" over a task set by hand after those events - last write wins
on a one-row table. And one 558-character decision written over MCP had grown the bootstrap by about
250 tokens. Fixed by invariants 41 and 42; the item was split into four statements that supersede
it. The bootstrap is still larger than at first (684 tokens) because memory holds more decisions
now, which is what the per-section budgets exist to bound.
