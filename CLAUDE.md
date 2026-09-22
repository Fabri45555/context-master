# contextd

Continuous context manager for AI coding agents. Observes an agent's session, turns events
into persistent structured project state, and serves back only the context that is relevant.
Spec: [prd.md](prd.md) (amendments in its §61). Deviations from it:
[docs/prd-review.md](docs/prd-review.md). Why it is not one of the existing OSS memory tools,
and what was borrowed from them: [docs/landscape.md](docs/landscape.md).

The one-line thesis: **the agent's context is disposable; the project's state is persistent.**

## Project memory (read this first)

This project runs its own tool on itself. A `contextd` MCP server holds persistent state across
sessions, and using it is the point — a memory nothing ever queries is a cost with no return.

- **Start of a session:** call `memory_bootstrap` before reading any file. It costs a few hundred
  tokens and tells you the current task, the active constraints and the open issues.
- **Before working on an area:** call `memory_query` with what you are about to do, rather than
  re-deriving the context by reading source.
- **When something durable is settled** — a decision and its reason, a constraint, a discovery that
  cost time to find — call `memory_remember`. Leaving it in the conversation loses it.
- **When the task changes or finishes**, call `memory_task`. The next session starts from it.
- **When a goal is met or a question answered**, call `memory_close` with what closed it. Otherwise
  every future session is told the work is still open.
- `memory_explain` answers "why is this here"; `memory_conflicts` answers "does memory currently
  contradict itself"; `memory_retire` removes what is wrong.

If a query returns something wrong or stale, that is a finding about this project, not an
inconvenience: say so and correct it.

## Commands

```bash
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run build         # tsc -> dist/
npm run dev -- <args> # run the CLI from source via tsx
```

Always run `npm test` and `npm run typecheck` before claiming a change works.

## Layout

| Path | What lives there |
|---|---|
| [src/core/](src/core/) | Pure logic, no I/O: event schema, patches, classification, redaction, budget |
| [src/store/](src/store/) | SQLite: schema, the single writer, FTS5 retrieval |
| [src/adapters/](src/adapters/) | Per-agent translation into normalized events |
| [src/workers/](src/workers/) | Ephemeral LLM workers: prompt, providers, runner |
| [src/daemon/](src/daemon/) | Ingest pipeline, state machine, the `ContextManager` facade |
| [src/retrieval/](src/retrieval/) | Budget-aware context building |
| [src/mcp/](src/mcp/) | MCP server — how an agent pulls context |
| [src/ui/](src/ui/) | Read-only local dashboard (`contextd ui`) |
| [src/ops/](src/ops/) | Install/uninstall, mirror, native-memory import, the project registry |
| [src/cli/](src/cli/) | The `contextd` command |

Memory has three levels: **L0** working memory (one row, small, always injected), **L1**
memory items (the structured project state), **L2** raw events (audit and replay only, never
prompted).

## Invariants

Breaking one breaks a PRD guarantee. One line each; the reason and the real failure behind every
one are in [docs/invariants.md](docs/invariants.md) — read the entry before changing the rule.

1. **Deterministic first.** Every event passes `deterministic.ts` then `fold.ts`; a model only gets what code cannot decide.
2. **Adapters may not assert importance they do not know** (`importance_source`).
3. **The patch log is the source of truth.** Write memory only via `commitPatch`; `replay --verify` is the guard.
4. **Ids are assigned before a patch is stored** (`normalizePatch`).
5. **`processed_at` means "state was derived from this".** Only the fold or a worker sets it.
6. **User-critical memory is protected in code** (`isProtected`), never by prompt.
7. **Redact at ingest**, including values whose key names a secret.
8. **A worker failure never reaches the agent.** Events stay pending; maintenance continues.
9. **Workers are single calls.** One prompt, one patch, at most one repair retry.
10. **Code is not memory.** Store a path and its purpose.
11. **The fold is conservative:** harness errors, refusals, path guesses, dumps are not project issues.
12. **Every retirement path is guarded** — `supersede` and `add.supersedes` too, not just `remove`.
13. **`isLive` means `status === 'active'`.**
14. **Each worker task has its own prompt** and declares what it reads.
15. **Agents never appear in the CLI.** Adapters declare their `surfaces`.
16. **Pressure is measured, never assumed.** Observed occupancy overrides an inferred window.
17. **Only the free rungs run on the hook path** (`needsProvider`).
18. **"Resolved" is not "derived from":** `markInert`, not `markProcessed`, for events with no state.
19. **The semantics gate is asymmetric:** an agent message queues on a decision cue, a discovery cue, or substance.
20. **A worker that recorded nothing derived nothing** — empty patch ⇒ inert; `doctor` watches the streak.
21. **`local_only` is about the model:** use `providerIsLocal(provider, spec)`.
22. **Scaffolding is not the user speaking:** strip harness lines at all three `USER_MESSAGE` sites.
23. **Workers may not claim certainty:** inferred confidence ≤ `MAX_INFERRED_CONFIDENCE`.
24. **A provable no-op is dropped, not a reason to reject** (`pruneInertOperations`); `update`/`supersede` never are.
25. **One bad entry does not sink the batch** (`parsePatch` salvage) — but losing a whole operation is not a salvage.
26. **A worker must prove a user attribution** (`verifyUserProvenance`).
27. **An error belongs to the call that produced it** (`tool_use_id` correlation, `isScratchCommand`).
28. **A measurement is not memory.** Never store counts, percentages or timings.
29. **Never recover structured data by re-parsing your own output** — carry `itemIds` through.
30. **Measuring is not serving:** `bootstrapContext()` logs nothing; `serveBootstrap()` counts.
31. **Every memory category has a place:** bootstrap section or query-only (tested).
32. **Occupancy comes from the transcript** (`usageSource` on `Stop`), not the hook payload.
33. **`Stop` is the end of a turn, not of a task.** It emits no event.
34. **Absent is absent:** `makeEvent` strips `null` payload fields.
35. **A verbatim re-add is a no-op,** its id aliased to the original.
36. **Wrong memory is correctable:** `forget` / `memory_retire`, `remember --supersedes`.
37. **Finished is not wrong:** `close` keeps the item active and protected, out of the bootstrap.
38. **An MCP call's session is inferred** (`activeSessionId`) — a label, never a decision input.
39. **Working memory states its age;** `contextd task` / `memory_task` set it.
40. **Some successful commands are outcomes** (`isMilestoneCommand`); a Claude Bash success is exit 0.
41. **A worker may not overwrite a task set by hand after the events it read** (`working_set_by_hand_at`).
42. **One item may not tax every session:** the bootstrap clips items over `BOOTSTRAP_ITEM_CHARS`; queries show them whole; an omitted marker names the way back.
43. **A write names its near-duplicates, never merges them** (`findSimilar`): advice, no patch.
44. **Exact tokens trust the keyword index** (`adaptiveKeywordWeight`): paths, ids, identifiers raise it.
45. **Only between our markers.** In files contextd does not own, write inside its block or key; never a file it cannot parse.
46. **A copy is served, not resumed:** `mirror` goes through `serveBootstrap` as `(mirror)`, with absolute times.
47. **An import is not the user:** `source: import`, capped confidence, deduplicated by content hash across all items.
48. **Installers take a `HostEnv`.** Tests never touch a real home or run a real agent CLI.
49. **A recovery is learned only from its own outcome:** same session and tool, not-found path or command-shape error.
50. **A missing file makes memory stale, never deleted** (`verify_refs`); protected items are flagged, revived when it returns.
51. **Only a person lifts protection:** `release_protected` from a `user` commit, typed at a TTY (`forget --protected`).

## Conventions

- TypeScript, ESM, Node 22+, `strict` plus `noUncheckedIndexedAccess`. Relative imports
  carry the `.js` extension.
- Zod schemas are the contract at every boundary (config, events, patches, memory items).
- Tests live in [tests/](tests/) and use scripted providers — a test must never hit a
  network or a real model.
- Comments explain *why*, especially where a choice looks odd. Do not add comments that
  restate the code.
- When a bug is found by running against real data, add the regression test that would have
  caught it.

## Verifying against real data

The test suite uses synthetic fixtures; it has missed real bugs that a real transcript
caught immediately. For a behavioural change, also run:

```bash
node dist/cli/index.js init --no-hooks
node dist/cli/index.js attach --adapter claude --transcript <a real .jsonl> --no-worker
node dist/cli/index.js status
node dist/cli/index.js memory        # is what was recorded actually worth keeping?
node dist/cli/index.js replay --verify
```

Claude Code transcripts are in `~/.claude/projects/<slugged-cwd>/*.jsonl`; Codex rollouts in
`~/.codex/sessions/<y>/<m>/<d>/*.jsonl`.

## Metrics

Quote `effective_reduction` (token ratio × coverage), never the raw ratio. Coverage is
`derived / (derived + pending)`, pinned to 0 when nothing was derived. Watch `never_retrieved_ratio`
and `hard_compactions`. The Benefits view counts savings per resume only, against the project's
documents. Why each definition is what it is: [docs/invariants.md](docs/invariants.md#metrics-in-full).
