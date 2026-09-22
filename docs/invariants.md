# Invariants, and why each one exists

The rules in [CLAUDE.md](../CLAUDE.md) in full: what each guards, and the real failure that made it
necessary. Numbers are stable - code comments, tests and [prd-review.md](prd-review.md) refer to
them. Add new ones at the end; never renumber.

Breaking one of these breaks a PRD guarantee, so change them deliberately or not at all.

1. **Deterministic first.** Every event passes [deterministic.ts](src/core/deterministic.ts)
   and then [fold.ts](src/core/fold.ts) at ingest time. A model is called only for what is
   left. Adding a model call to a path that can be decided by code is the main way to ruin
   this project's economics.

2. **Adapters may not assert importance they do not know.** `makeEvent` records whether
   importance was a deliberate claim (`importance_source`). The classifier only yields to a
   real claim. Treating the default as a claim silently disables all filtering — that bug
   persisted 3,401 worthless events on the first real transcript.

3. **The patch log is the source of truth.** `memory_items` is a materialization of it.
   Never write to `memory_items` outside `ContextStore.commitPatch`, and keep
   `contextd replay --verify` consistent — that command is the guard.

4. **Ids are assigned before a patch is stored** (`normalizePatch`). Minting them during
   apply makes replay produce different items and voids rollback and audit.

5. **`processed_at` means "state was derived from this"**, not "we saw it". Only the fold or
   a worker may set it.

6. **User-critical memory is protected in code**, not by prompt. `isProtected` in
   [patch.ts](src/core/patch.ts) rejects any patch that deletes or weakens a
   `source: user` + `importance: critical` item. K2 targets ~0% loss of critical info; a
   prompt instruction cannot deliver that.

7. **Redact at ingest**, before anything reaches L2 or a provider — including values whose
   *key* names a secret. Never redact only on egress.

8. **A worker failure must never reach the agent.** Budget exhausted, provider down, patch
   rejected twice: the events stay pending and the run returns `deferred`/`invalid`/`error`.
   Deterministic maintenance keeps working.

9. **Workers are single calls, never conversations.** One prompt, one patch, terminate. At
   most one repair retry.

10. **Code is not memory.** Store a path and its purpose; the repository stays the source of
    truth for file contents.

11. **The fold is conservative about project memory.** Harness errors, permission refusals, an
    agent guessing at a path, a shell command that never parsed, and a dump rather than a
    message are not project issues — see `isTransientToolError` and `looksLikeDump`. Filtering
    these cut recorded issues from 36 to 4 real ones on a real session.

12. **Every retirement path is guarded, not just `remove`.** `supersede`, and an `add` that
    declares `supersedes`, retire an item as surely as deleting it. Guarding only `remove`
    and `update` left K2 bypassable with one different key.

13. **`isLive` means `status === 'active'`.** `stale` is what TTL decay assigns to stop an
    item being served; treating it as live made `decay()` a no-op for keyword search and
    graph traversal, because the SQL paths filtered on status and hid it.

14. **Each worker task has its own prompt.** [tasks.ts](src/workers/tasks.ts) — they were
    routed to different model tiers while sharing the extraction prompt, so a high tier paid
    to do a job it was never told about. A task also declares what it *reads*
    (`events` | `conflicts` | `memory`); reconciliation is not about new events at all.

15. **Agents never appear in the CLI.** Where a transcript lives is declared by the adapter's
    `surfaces`, not hardcoded in a command. `contextd surfaces` prints them; `contextd
    doctor` verifies them.

16. **Pressure is measured, never assumed.** The compaction ladder in
    [lifecycle.ts](src/core/lifecycle.ts) reads the occupancy the agent reported for its last
    turn, and an observed occupancy overrides an inferred window: a real session reported
    `claude-opus-5` while holding 512,598 tokens, and trusting the model id put it at 256% of a
    200k window, pinning the ladder at its most expensive rung. `window_source` says which
    number was used.

17. **Only the free rungs may run on the hook path.** `fold`, `decay` and `prune` are SQL and
    stay inside the latency budget. Anything that needs a provider waits for
    `contextd lifecycle --act` or the next cycle — see `needsProvider`.

18. **"Resolved" is not "derived from".** An event that carried no derivable state is closed
    with `markInert`, not `markProcessed`, and coverage excludes it from both sides of the ratio
    (see the metrics note). Counting inert events as derived made 739 stored events with an
    *empty* memory report 98.9% coverage — a discard rate dressed as compression.

19. **The semantics gate is asymmetric.** A false negative loses the agent's reasoning
    permanently; a false positive costs a few hundred tokens of the cheap tier. So an agent
    message queues on a decision cue, a discovery cue, *or* mere substance
    (`ASSISTANT_SUBSTANCE_CHARS`). Keyword-only matching dropped 102 of 106 agent messages on a
    real session, including every finding in it — `contextd status` cannot show you that,
    because a filter that never fires looks exactly like a quiet session.

20. **A worker that recorded nothing derived nothing.** An empty patch closes its batch with
    `markInert`, not `markProcessed` — otherwise a misconfigured model drains the queue, reports
    `ok`, and drives coverage up while the memory stays empty. `emptyRunStreak` plus the
    `worker output` check in `doctor` is what tells that apart from a quiet project.

21. **`local_only` is a promise about the model, not about the daemon.** ollama runs on this
    machine and proxies `*-cloud` models off it, so a constant `isLocal` let the gate pass while
    every prompt left the machine. Use `providerIsLocal(provider, spec)`; a flag describing the
    transport will eventually be wrong about the destination.

22. **Session scaffolding is not the user speaking — but it quotes things that are.** A harness
    *instruction line* is removed wherever it appears; a turn is dropped whole only when its
    *opening* is harness framing. Scanning the whole text for framing markers did stop "do not
    acknowledge the summary" becoming a protected constraint, and also threw away the project's
    original goal, which existed only as a quotation inside that same summary.
    `stripHarnessScaffolding` excises tagged
    blocks wherever they appear and drops harness preambles whole; a cue found inside pasted
    terminal output never promotes a message to `critical`. A real extraction turned "do not
    acknowledge the summary, do not recap" into a `source: user` + `critical` constraint, which
    `isProtected` then made permanent. There are three sites that emit `USER_MESSAGE` — all
    three must strip.

23. **A worker may not assert certainty it cannot have.** `normalizePatch` clamps inferred
    confidence to `MAX_INFERRED_CONFIDENCE`; 1.0 is for what the user said in so many words. A
    real run returned 18 items at 1.00, which makes the field carry no information and stops
    `min_bootstrap_confidence` from ever firing.

24. **A provable no-op is dropped, not a reason to reject everything.** `pruneInertOperations`
    removes `remove`/`link`/`unlink`/`touch` whose target exists nowhere, records the drop in the
    patch note, and leaves `update` and `supersede` alone — a mistyped `update` target means real
    intent. A real run lost 45 events of good extraction because the model invented three link
    targets, one of them a file path. A user's own patch still gets the error.

25. **One bad entry does not sink the batch — but losing the whole operation is not a salvage.**
    `parsePatch` drops the individual array entries a schema failure blames and re-parses,
    recording *which field failed* per entry in the patch note. It salvages nothing when the
    failure is elsewhere, when the result would be empty, or when every entry of an operation was
    dropped: that last case once applied a patch containing only its `working` block, reported
    `ok`, consumed 58 events and stored zero items — the invariant-20 failure arriving through the
    salvage path. A real run lost 48 events and 22
    correct items because item 23 of 23 lacked `text`. The same shape of fix as
    `pruneInertOperations` — and the third time all-or-nothing handling of a mostly-good model
    output turned out to be the expensive choice.

26. **A worker must be able to *prove* a user attribution.** `source: user` + `critical` is the one
    combination `isProtected` makes permanent, so `verifyUserProvenance` downgrades any such item
    whose `evidence` does not cite a real `USER_MESSAGE` event. The text survives, the attribution
    does not. On a live session the worker synthesised a goal from the conversation — including a
    detail the *agent* had proposed — and filed it as a permanently protected user instruction.

27. **An error belongs to the call that produced it.** A tool error arrives as `ERROR_DETECTED`
    carrying only `tool_use_id`; the command is on the matching `TOOL_CALL`. The fold correlates
    them, so a failed throwaway one-liner (`isScratchCommand`) is inert while a failed `npm run
    build` is still a known issue. Without the correlation the two are indistinguishable.

28. **A measurement is not memory.** The sibling of invariant 10: test counts, percentages,
    token totals and timings move every run, so a stored number is false as soon as it changes.
    A live extraction recorded "coverage = 93.2%" and "194-198 tests" as completed work, both
    already wrong when written. Record that the measurement exists; `contextd status` is where its
    value lives.

29. **Never recover structured data by re-parsing your own output.** `finish` scraped the rendered
    context for `[mem_...]` to learn which items it had served. Workers began assigning short ids
    (`d3`) — because the prompt asked them to — and the regex silently matched nothing, so
    `markUsed` got an empty list and `never_retrieved` was pinned at 100% however much was
    retrieved. Sections carry their `itemIds` through instead.

30. **Measuring is not serving.** `bootstrapContext()` measures the always-on slice for status,
    pressure and the dashboard and logs nothing; `serveBootstrap()` is what the SessionStart hook
    and `memory_bootstrap` call, and it counts as a retrieval. Counting only queries left every
    always-on item looking never-retrieved; counting the measurement would let `status` move the
    number it reports. Same for the dashboard's query preview (`record: false`).

31. **Every memory category has a place.** `BOOTSTRAP_SECTIONS` plus `QUERY_ONLY_CATEGORIES` must
    cover `MEMORY_CATEGORIES` exactly — a test enforces it. `goals` and then `requirements` were
    extracted correctly and served to no session, because no section named them.

32. **Occupancy comes from the transcript, not the hook payload.** Claude hook payloads carry no
    usage, so on a hook-only install the ladder read the pre-compaction peak forever and sat at
    `reduce` with the window half empty. `Stop` reads the last turn's usage via the adapter's
    `usageSource`; usage rows are keyed by message id so hook and transcript count a turn once. A
    compaction request stays live only until the agent reports another turn.

33. **`Stop` is the end of a turn, not of a task.** It emits no event. As `TASK_COMPLETED` it
    would have the fold mark the working task done after every reply.

34. **Absent is absent, however it is spelled.** Adapter helpers return `null`; the payload schema
    takes `undefined`. `makeEvent` strips nulls. The mismatch made every Claude `Stop` hook throw
    for as long as it was installed — silently, because a hook must never fail the agent.

35. **A verbatim re-add is a provable no-op** (the invariant-24 family). `pruneInertOperations`
    drops an `add` whose text matches an active item in the same category and aliases its id to
    the original so links still land; a patch left empty closes its batch as inert, not `invalid`.
    A pasted `contextd memory` listing was re-extracted into seven duplicates: the memory quoting
    itself back into the queue.

36. **Wrong memory has to be correctable.** `contextd forget` / `memory_retire` retire with a
    reason; `remember --supersedes` replaces. The project instructions tell the agent to correct
    stale memory, and until these existed nothing short of `reset` could.

37. **Finished is not wrong.** `close` marks a goal met, a requirement satisfied, a question
    answered or an issue fixed: `fields.closed_at` / `closed_reason`, status still `active`,
    protection intact, out of the bootstrap, tagged `done` in queries. Only those four categories
    close. A worker closing a user-critical item must cite a real event (`verifyClosures`). Two
    sessions in a row reported every goal open with the work visibly done.

38. **An MCP call is attributed by inference.** The server is never told its session;
    `activeSessionId` takes the session with the freshest event, or none if nothing is recent. It
    only labels retrievals — never use it to decide anything.

39. **Working memory states its age.** It is written by workers, and some endings never reach one:
    a successful shell command is closed as inert by the fold, so a commit made in another session
    left "Commit project repository: blocked" in every bootstrap with no way to change it. The
    bootstrap now prints when the task was recorded and how many user messages came after it;
    `doctor` warns at five; `contextd task` / `memory_task` set it by hand.

40. **Some successful commands are outcomes.** `isMilestoneCommand` (commit, push, merge, tag,
    rebase, `gh pr create|merge`, publish) marks the class; a successful one is queued for a worker
    instead of closed as inert, and the bootstrap lists it under the recorded task ("since then:").
    The worker updates the task and closes goals, citing it. A class, not one command. It depended
    on a second fix: Claude reports a successful Bash as `{stdout, stderr, interrupted:false}` with
    no exit code, so no successful command was ever known to have succeeded - `inferExitCode` now
    reads that shape as 0.


41. **A worker may not overwrite a task set by hand after the events it read.** Working memory is
    one row and the last write wins. Draining a 19-event backlog, a worker put "Commit project
    repository: blocked" back over a task set by hand minutes later, from events older than that
    edit. `commitPatch` drops a worker's `working` when `working_set_by_hand_at` is newer than the
    newest event in its batch (`observedUntil`); the rest of the patch still lands. Keyed on the hand
    edit, not `updated_at`: a worker's own commit stamps "now", which would lock out the second batch
    of any backlog.

42. **One item may not tax every session.** Every session pays for the bootstrap, and a single
    558-character decision with its reason cost about 250 tokens of it. The bootstrap clips any item
    over `BOOTSTRAP_ITEM_CHARS` to its opening words plus `(full: memory_explain <id>)`; a query
    renders it whole, even when the bootstrap already showed its start. Whether an item was clipped
    is computed (`needsClip`), never read back from the rendered line (invariant 29).

    The markers that say something was left out name the way back, so an agent is never told
    "there is more" without being told how to get it: a bootstrap section ends with
    `memory_query category="…"`, a query section with the dropped ids for `memory_explain`. Both
    come from `droppedCategories` / `droppedIds`, carried through from where the budget cut them.

43. **A write names its near-duplicates, never merges them.** `memory_remember` and
    `contextd remember` answer with the closest active items (`findSimilar`: trigram similarity
    ≥ `RESTATEMENT_THRESHOLD`, the same 0.42 `memory_conflicts` uses, or ≥ 0.9 cosine against
    stored vectors) and how to retire one. Advice only, no patch: headroom deletes above 92% cosine
    in the background, which is exactly the unguarded retirement invariant 12 forbids. A
    user-critical match is reported as not retirable, since `isProtected` would reject the call.

44. **Exact tokens trust the keyword index.** A query holding a path, an item id, a UUID, an
    identifier, a version or a flag raises the keyword weight of the fusion (`adaptiveKeywordWeight`:
    0.8 for paths/ids/UUIDs, 0.7 otherwise, never above 0.9, never lowered). With RRF k=60 and a
    fixed 0.5, an item that is keyword rank 1 lost to a semantic rank-1 rival; `bench --retrieval`
    shows MRR 0.885 → 0.906 on the golden fixture.

45. **Only between our markers.** In a file contextd does not own (`~/.codex/config.toml`,
    `CLAUDE.local.md`, `AGENTS.md`, `~/.claude.json`) it writes inside its own marker block or under
    its own key, refuses to rewrite a file it cannot parse, and reports - never touches - a
    same-named entry it did not write, `--force` or not. `uninstall` removes exactly what was added.

46. **A copy is served, not resumed.** `contextd mirror` writes the bootstrap into an instruction
    file through `serveBootstrap` labelled `(mirror)`, so it counts as serving (invariant 30) but
    the Benefits view does not count it as a resume. The copy carries absolute times - "3h ago" is
    true only when rendered, and a file is read much later - which is also what makes
    `mirror --check` deterministic.

47. **An import is not the user.** Items read from an agent's native memory
    (`import --from claude-memory`) are `source: import` at confidence ≤ `MAX_INFERRED_CONFIDENCE`,
    whatever the file says about who wrote it (invariant 26). They are deduplicated by content hash
    against every item, not only active ones: the verbatim re-add rule (35) looks at live items, so a
    retired import came back on the next run.

48. **Installers take a `HostEnv`.** Every path into the user's machine - home, agent configs,
    the `claude` binary - comes from a `HostEnv`; with no `which`, no external binary is called.
    Tests never touch a real home directory or run a real agent CLI.

49. **A recovery is learned only from its own outcome.** The fold turns a failure followed by a fix
    into a rule (`src/core/recovery.ts`) only within one session and one tool, pairing each call
    with its result by `tool_use_id` (invariant 27), and only for a not-found path or an error that
    says the command itself was wrong - never a test or build failure, never a shell "no such file"
    from the wrong cwd. Of 2,307 failure→success Bash pairs in 256 real transcripts, headroom's
    relation check kept 281, almost all `cd x && …` from the wrong directory; one lesson was real.
    A test failure followed by a narrower passing command would have taught the wrong command.

50. **A missing file makes memory stale, never deleted.** `verify_refs` (a free rung, throttled on
    the hook path) marks an item stale only when every path it names is gone, flags a protected
    item instead (tag `stale_reference`, `fields.stale_paths`, shown by `doctor`), and revives it
    when the file returns - a branch switch must not cost memory. It stats files; it never runs
    `git ls-files`, a process spawn on a path with a latency budget.

51. **Only a person lifts protection.** Invariant 6 was absolute, and invariant 36 then failed for
    the one kind of item that matters most: `contextd remember` defaults to `user` + `critical`, so a
    duplicated or mistyped instruction could be retired by no one, the user included. A patch may now
    carry `release_protected: [ids]`, which lets its `remove` retire those items. `commitPatch`
    rejects the field from any origin but `user` (and `import`, which replays a checked log), since a
    worker could write it into its JSON; the MCP `memory_retire` never sets it, because the caller
    there is the agent. `contextd forget --protected` sets it only after the id is typed at an
    interactive terminal - an agent's shell tool is not one. The field stays in the log as the
    record of consent, so replay rebuilds the same state.

52. **A learned rule is refined, never duplicated.** Invariant 49 wrote a rule per recovery and
    never revisited it. The same mistake seen again now touches the rule (`last_validated_at`),
    adds evidence and revives it if stale. One wrong path "fixed" to different files is ambiguity,
    not a typo: those rules collapse into one saying to search first (files in `fields.candidates`),
    the old ones retired through a guarded `add.supersedes` (12). Rules fade after 21 days unseen
    through the ordinary TTL - stale, not deleted (13). At most `MAX_BOOTSTRAP_RECOVERY_RULES` (5)
    learned command rules reach the bootstrap, ranked by `last_validated_at`, never a stored count
    (28); the rest are named by the omitted marker.

53. **A loop is a signal, not memory.** headroom counts a repeated call over a whole session; on
    254 real sessions that flagged 818 "loops" in 197 of them - reruns on purpose, screenshots after
    clicks, polling. `detectLoops` counts a repetition only when it is the same call with the same
    answer and nothing written or said in between, which flagged none. The count describes one
    session, so it lives in `status` and `doctor`, never in memory, and never runs on the hook path.

54. **A lesson cites its episode, and code decides what an episode is.** `contextd learn` sends a
    model only what `collectEpisodes` found deterministically - a failed command, what was tried,
    what worked - and a session with none makes no call (1). `restrictLearnPatch` keeps only `add`s
    in `conventions`/`discoveries`, each citing an event id from the digest, `source: worker`,
    without measurements or code. Learn reads events and never marks them (5); a per-session
    watermark advances only on `ok` or an empty answer. On 27 real transcripts a looser pairing
    kept only probes, sandbox refusals and wrong-cwd retries.

55. **A judge's verdict is a measurement.** `bench --retrieval --judge` is opt-in, refuses a
    non-local model under `local_only` before any call (21), prints its cost and stores nothing.

56. **An instruction file is not a rule list.** `import --from markdown` keeps a statement only when
    it stands alone. Code blocks, command lines, table rows (except path/purpose), list preambles
    and contextd's own mirror block never become memory - importing our own copy would be a loop.
    A rule removed from the file is reported as gone, not retired: the file is not the only source.

57. **An agent contextd cannot observe says so.** Cursor, Gemini CLI and opencode get memory
    (MCP, `mirror`) but have no ingestion surface: their only surface is `none`, ingestion refuses
    them, and `doctor` mentions them only where their config dir exists - as a note, since a config
    dir on the machine is no evidence anyone uses the agent in this project.

58. **In a JSON config, ours is proven by shape.** Where there is no room for markers (45), an
    entry under our key counts as ours only if it looks like a contextd launch (`isContextdLaunch`);
    anything else under that name is reported and never replaced, `--force` or not.

59. **A mirror fits its reader's budget by dropping items, never by cutting text.** Each target
    declares a budget (CLAUDE.local.md 2000, AGENTS.md / GEMINI.md / Cursor 3000); `bootstrap({budget})`
    scales the section allowances, whole items drop, and the omitted marker names them.

60. **A stale build is a warning, found by stat alone.** The script behind the installed hooks and
    MCP entries is compared with the newest `src/**/*.ts` beside it and with the checkout's
    package.json version. A fix that was built but never reaches the agent looks exactly like a
    fix that did not work.

61. **A project registers itself only on evidence of use.** `status --all` reads a registry of
    roots. A SessionStart hook, `init`, `attach` and `mcp install` add the project; `status`,
    `doctor` and `ui` add it only where a config file or an observed session exists, because
    opening a manager creates storage and a stray command in the wrong directory must not list it
    forever. `contextd projects` removes, prunes and clears entries; none of them touch memory.

62. **Advice about the context goes to the person, never into it.** contextd cannot clear the
    agent's window and should not trim it turn by turn (that defeats the prompt cache); it says
    when `/clear` is safe. `clearAdvice` keys on measured occupancy past `pressure_high`, never on
    a stage a backlog alone raised, and says "not yet" with what to run when memory could not carry
    the session. The hook returns it as the adapter's person-only channel (Claude's
    `systemMessage`), once per level per session (`clearAdviceOnce`); the dashboard and status line
    only read it.

63. **A status line someone had is never lost.** `statusline install` writes the personal
    `.claude/settings.local.json`, never the committed settings. An existing line is a conflict;
    `--chain` runs it first with the same payload, records it in the project's local store (never
    the committed config: it is a path on one machine; never quoted into settings.json) and `uninstall` puts it back in the file it came from. Rendering is
    silent on every failure, bounded to a second for the chained command, and creates no storage.

64. **A worker on Claude Code is not a session.** The `claude-code` provider runs `claude -p` with
    `--safe-mode` (no hooks, CLAUDE.md, plugins or MCP), `--tools ""`, no saved session and an
    empty temp directory, and sets `CONTEXTD_WORKER=1`, on which `contextd hook` exits at once.
    Without these the worker's own session would be ingested as the person's work. Not `--bare`:
    it never reads OAuth, so it needs the API key this provider exists to do without.

65. **A contradiction judged compatible stays quiet while both items read the same.** Detection is
    lexical and has false positives by construction; a worker that answers for a pair with nothing
    has judged it. `conflict_reviews` keys each pair by a fingerprint of both items' text, category,
    status and importance, so an edit to either reopens it - the review is about those two
    statements, not those two ids. Only a finished worker run (`ok` or `noop`) or a person
    (`conflicts --dismiss`) records one; a failed run marks nothing. It is not memory and not in
    the patch log: losing it only means asking again. Before it, one false positive at similarity
    0.20 asked for the same model call on every `conflicts`, `doctor` and dashboard refresh.

## Metrics, in full

K1 is reported as three numbers, not one: `token_reduction` (the cheap ratio), `coverage` and
`effective_reduction` (their product). Quote the third. A high ratio with low coverage is a
backlog, not compression.

**Coverage is `derived / (derived + pending)`** — of the events that could ever have produced
state, how many have. It took three definitions to get right, each wrong in a way this codebase
keeps repeating:

| Definition | What it got wrong |
|---|---|
| `derived / stored` | inert events counted as derived → 98.9% on an *empty* memory |
| `(stored − pending − inert) / stored` | punished discarding worthless events → 18.9% with nothing outstanding |
| `derived / (derived + pending)` | current: inert events were never candidates, so they neither help nor hurt |

`derived === 0` pins coverage at zero regardless, because a worker returning empty patches closes
its batches as inert — without that, a broken model reads 100% against an empty memory.

`precision` answers the question PRD 29 does not: whether the memory we keep is worth
keeping. `never_retrieved_ratio` is the signal to watch — a true fact nobody ever needed is
still a cost.

`hard_compactions` is how this project scores itself: it counts the times the agent compacted
anyway, which is the ladder failing. `recovery_ready` asks K5 before the fact — if the agent
compacted right now, is there enough derived state to continue from?

**Tokens avoided are charged per resume against the bootstrap actually served at that resume**
(`retrieval_log.tokens`), not today's bootstrap, so the History running total - rebuilt from the
log like the never_retrieved trend - ends exactly at the Benefits figure (tested). The documents
are priced at their size now, because their past size was never recorded; the chart says so. A
`(mirror)` delivery is neither a resume nor a query.

The hook path has an explicit latency budget (`limits.hook_latency_ms`, default 250ms)
because it is synchronous for the agent. Measured p50 on a real session is ~9ms.

## Optional layers

These are off or empty unless used, and nothing depends on them:

- **Graph** ([graph.ts](src/core/graph.ts)) — typed relations, emitted by workers as `link`
  in a patch. Retrieval walks one hop out from its best hits, so a constraint that governs a
  decision is reachable even when its text shares nothing with the query.
- **Embeddings** ([embeddings.ts](src/store/embeddings.ts)) — disabled by default, local
  provider by default. Fused with BM25 by reciprocal rank, because the two scores are not on
  a comparable scale. A vector database is still not justified at this size: the cosine scan
  is exhaustive and fast.
- **Conflicts** ([conflicts.ts](src/core/conflicts.ts)) — detection is deterministic and
  free; a model is spent only on deciding which side wins. Comparison crosses category
  boundaries for pairs like constraints/decisions, which is where the K2-relevant conflicts
  actually live.
