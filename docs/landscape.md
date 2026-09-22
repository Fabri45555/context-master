# Landscape, and what it changes

Written for: whoever decides what this project is for. It turns a survey of comparable
open-source work into decisions — what to borrow, what to refuse, and what is left that is
actually ours.

The survey it responds to is not independently verified here: the claims about other projects
are their own descriptions of themselves, read second-hand. That is enough to decide
positioning, and not enough to decide architecture; where a decision depends on how one of
them really behaves, that is said explicitly.

## 1. The honest verdict first

Persistent memory for coding agents is a populated category, not an empty one. Read
individually, almost every piece of this project has a precedent:

| Piece | Where it already exists |
|---|---|
| Hierarchical memory (working / project / raw) | Letta / MemGPT — core, recall and archival memory, since 2023 |
| Background memory consolidation | MemGPT's own roadmap named an async consolidation loop |
| Deterministic-then-LLM extraction | AgentMemory Codex says exactly this |
| Cross-agent persistent memory | AgentMemory, Engram, Cortex, create-ai-memory, AIDE |
| SQLite + FTS5, local-first, no model in the retrieval loop | Engram, Cortex |
| Continuous context reduction outside the session | YesMem's context collapsing |
| A proxy between the agent and its provider | YesMem |

So the founding claim cannot be "we thought of managing an agent's memory". It has to be
narrower and it has to be true. The defensible version:

> An external context runtime that decides, continuously and mostly without a model, what an
> arbitrary coding agent should be carrying right now — with hard compaction as the failure
> case rather than the mechanism.

Three parts of that survive contact with the survey: **the ladder** (§4), **scoring ourselves
on hard compactions we failed to prevent** (§4), and **guarantees enforced in code rather than
in a prompt** (§6). Everything else in the list above is a good idea we share with others.

## 2. What the survey changes in the PRD

The PRD reads as a memory manager with a compaction feature. The stronger framing, which the
implementation already matches, is three separable responsibilities:

| Responsibility | Question it answers | Where it lives |
|---|---|---|
| Memory | what is worth remembering | [core/](../src/core/), [store/](../src/store/) |
| Context | what belongs in the prompt *now* | [retrieval/](../src/retrieval/), [mcp/](../src/mcp/) |
| Lifecycle | when to consolidate, spawn, compact, checkpoint | [core/lifecycle.ts](../src/core/lifecycle.ts) |

The third was the one genuinely missing as a named thing; it exists now. See §4.

## 3. The proxy: do not build it

YesMem's most interesting structural decision is to sit between the agent and its upstream API
and rewrite what goes over the wire. It is the one idea from the survey I would refuse outright
rather than defer, for four reasons.

1. **It fights prompt caching, and the user pays for the fight.** Caching is prefix-based:
   rewriting or collapsing anything early in the context invalidates the cache from that point
   on. A proxy that both collapses context and advertises a prompt cache is in tension with
   itself, and the cost of a cache miss on a 500k-token prefix is large and immediate. Our
   measurements on a real session show cached reads dominating occupancy — that is exactly the
   thing a rewrite destroys.
2. **It makes us a single point of failure for the agent.** A hook that throws loses one event.
   A proxy that throws ends the session. PRD 35 asks for graceful degradation; owning the wire
   is the one position from which degradation cannot be graceful.
3. **It requires owning credentials and every provider's request format**, including changes to
   them, including whatever the agent does that is not documented. That is an unbounded
   maintenance surface for a single-developer tool.
4. **PRD 54.7 already forbids it in spirit** — "no changes to the main model". Hooks plus an
   MCP server achieve context control without ever holding the agent's request.

What the proxy idea is genuinely better at is *acting without the agent's cooperation*: an agent
that never calls our MCP tools gets nothing from us. The honest answer to that is the
`SessionStart` push, which is the one moment where injecting beats waiting to be asked, plus
saying plainly that an agent which refuses to pull context is outside what this tool can fix.

## 4. What we took instead: the ladder

The survey's sharpest observation is that threshold-based collapsing is still
*episodic* — context grows, crosses a line, gets cut hard, grows again. Turning that into a
graduated response is the design we did take, and it is now
[core/lifecycle.ts](../src/core/lifecycle.ts):

```
occupancy < 55%   steady       ingest and fold; nothing else is warranted
        >= 55%    maintain     deterministic only: fold the backlog, decay, retention
        >= 75%    consolidate  spend a model: extract, resolve contradictions
        >= 90%    reduce       whole-memory reconciliation; compaction is imminent
```

Three properties matter more than the thresholds:

- **Pressure is measured, not guessed.** It comes from the occupancy the agent itself reported
  for its last turn. Every rung below `consolidate` is free, so escalation is cheap until it
  cannot be.
- **The free rungs run on the hook path.** Folding and decaying are SQL; measured p50 for the
  whole hook, ingestion included, is 9ms against a 250ms budget. This is what keeps maintenance
  alive when there is no budget, no provider, or local-only with nothing local configured.
- **We score ourselves on failures.** `hard_compactions` counts the times the agent compacted
  anyway. If that number does not fall, the ladder is decoration, and `contextd status` says so
  without being asked.

`recovery_ready` answers the related question before the fact: if the agent compacted *now*,
is there enough derived state to continue from? High occupancy with a large unprocessed backlog
is the specific failure this exposes, and nothing else in the survey appears to report it.

### A bug this found immediately

Inferring the context window from the model id was wrong on the first real session: the agent
reported `claude-opus-5` while occupying 512,598 tokens. A 200k assumption puts that at 256%
occupancy and pins the ladder at its most expensive rung forever. Observation now overrides
inference — a turn that fitted proves the window is at least that large — and the reported
`window_source` says which it was. Same discipline as `importance_source`: an inferred number
must never be indistinguishable from a known one.

## 5. Borrowed: quarantine, in its smallest useful form

AgentMemory Codex names *quarantine* and *provenance* as separate mechanisms. We already had
provenance (source, reason, evidence, confidence, validation history). Quarantine we did not,
and there was a real hole behind it: a worker's hedged guess could sit in the always-on slice,
injected into every session forever, on the strength of nothing.

`alwaysOnEligible` closes it in three lines. Below `min_bootstrap_confidence` (0.5) an item is
kept out of the bootstrap but stays fully reachable by query — withheld from the expensive
slice, not lost. Anything the user said, and anything critical, is in unconditionally, because
withholding those is the loss K2 forbids.

## 6. Where the remaining difference actually is

Not in the feature list. In which guarantees are enforced by code:

- `isProtected` makes K2 ("~0% loss of critical information") a validator that rejects patches,
  including patches from our own workers, rather than a sentence in a prompt. Every retirement
  path is guarded, not just deletion — that hole existed and was closed.
- The patch log is the source of truth and `memory_items` is a materialization, so rollback,
  diff, audit and replay are one mechanism. `replay --verify` is a real guard: it caught ids
  being minted during apply, which had silently voided reproducibility.
- Contradiction detection is deterministic, free, and crosses category boundaries — a user
  constraint contradicted by an agent decision is the K2 case, and a within-category check is
  the one thing that misses it.
- Metrics are built to be hard to flatter. K1 is reported as three numbers because the cheap
  ratio reads 99.9% on a backlog nothing has touched; `precision` reports the share of memory
  never once retrieved, which on real data is the failure mode that actually occurs.

That is a smaller claim than "we invented continuous compaction", and unlike that one it is
checkable by running the tests.

## 7. Recommended reading order if this gets a deep dive

1. **YesMem** — specifically what its proxy does to a live Claude Code or Codex session, and
   what happens to prompt caching when it collapses. That is the one empirical question that
   could change §3.
2. **AgentMemory Codex** — its claim structure, validation and quarantine, against our patch
   validator and confidence handling.
3. **Letta** — whether its self-editing memory produces better state than our ephemeral
   workers, which never converse and never see their own previous output.

None of the three blocks work here. All three could change what we claim.

## 8. Borrowed from headroom

[headroom](https://github.com/headroomlabs-ai/headroom) is a context *compression* layer - a proxy
and library that shrinks what an agent reads before it reaches the model - with a memory side
attached. Unlike the survey above, this one was read first-hand, from its source, in September 2026.
Its core (the proxy, the JSON/code/text compressors, the CCR store of originals) is the wire §3
declines to own. The memory side had things we lacked:

| Borrowed | Theirs | Ours, and what changed on the way |
|---|---|---|
| Error→recovery rules | `traffic_learner.py` pairs a failure with the next success of the same tool | `src/core/recovery.ts`, far stricter: their relation check kept 281 of 2,307 real failure→success pairs, almost all wrong-cwd noise; ours keeps not-found paths and command-shape errors only (invariant 49) |
| Similar-memory hint on write | `memory_save` answers "similar memory exists" | `findSimilar`; advice only - their background delete above 92% cosine is an unguarded retirement (invariants 12, 43) |
| Stale file references | `_detect_staleness` checks paths against `git ls-files` | `verify_refs`, a stat per path, stale not deleted, revived when the file returns (invariant 50) |
| MCP registration, uninstall | `mcp_registry/`, marker blocks, `unwrap` | adapters declare it; the CLI stays agent-free (invariants 15, 45) |
| Doctor checks | version drift, stale wrap markers, routing | hook command resolves, MCP registered, embedding coverage, memory actually pulled |
| Writing memory into instruction files | `memory/writers/` with per-agent budgets | `contextd mirror`, served but not a resume (invariant 46) |
| Importing native memory | `bridge.py`, two-way sync with Claude auto-memory | one-way only - two-way sync is two sources of truth (invariant 47) |
| Adaptive keyword weight | `HybridScorer` raises BM25 for UUIDs, ids | `adaptiveKeywordWeight`, also for paths and item ids (invariant 44) |
| A retrieval handle in the "omitted" marker | CCR's `hash=` in the marker | the marker names `memory_query category=…` or the dropped ids |
| Retrieval evaluation | LoCoMo with an LLM judge | a deterministic golden set, recall@5 and MRR, no model |
| Dashboard layout | health pill, scope switch, label/value cards, empty states that say what to run | the four-view `contextd ui`, with a latest-session/all-time switch |
| Savings over time | a savings ledger sampled per request | rebuilt from `retrieval_log`, nothing sampled; ends exactly at the Benefits figure |
| Refining learned rules | `_refine_error_recovery`: ambiguity → "search first", evidence decay, cap 15 | revalidation, collapse, 21-day TTL, cap 5 in the bootstrap (invariant 52) |
| `headroom learn` with a model | `learn/analyzer.py` over session digests | `contextd learn`: code finds the episodes, a session without one costs nothing (invariant 54) |
| Loop detection | `learn/loops.py`, counts over a session | a signal in `status`/`doctor`, never memory, far stricter (invariant 53) |
| Importing instruction files | `bridge_parsers.py` | `import --from markdown`, dropping code, commands and our own mirror (invariant 56) |
| Writers per agent, more agents | Cursor/Codex/Claude writers; opencode, grok registries | per-target budgets; Cursor, Gemini CLI, opencode over MCP, declared unobserved (57, 59) |
| Version drift | `check_version_drift` | a `build` check by stat alone (invariant 60) |
| LLM-judged retrieval eval | LoCoMo with a judge | `bench --retrieval --judge`, opt-in, stores nothing (invariant 55) |

Refused: the proxy and output shaping (§3), auto-dedup deletion and budget pruning (unguarded
retirement), loop counts and "known large files" stored as memory (invariant 28), and a telemetry
beacon that is on unless you opt out.
