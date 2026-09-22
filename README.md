# contextd

Continuous context manager for AI coding agents.

> The agent's context is disposable; the project's state is persistent.

A coding agent accumulates conversation, tool output and dead ends until its context window is
mostly noise and a heavy compaction is unavoidable. `contextd` watches the session from outside,
keeps a structured persistent record of what the project actually *is* — goals, decisions,
constraints, discoveries, open issues — and serves back only the part that is relevant.

It is model-agnostic and agent-agnostic, works today with Claude Code and Codex, and requires no
change to the agent.

---

## Contents

- [How it works](#how-it-works)
- [Requirements and install](#requirements-and-install)
- [Quickstart](#quickstart)
- [Wiring it to your agent](#wiring-it-to-your-agent)
- [The MCP server](#the-mcp-server) — how the agent asks for context
- [Everyday use](#everyday-use)
- [Command reference](#command-reference)
- [Configuration reference](#configuration-reference)
- [Models and providers](#models-and-providers)
- [Privacy and security](#privacy-and-security)
- [Reading the numbers](#reading-the-numbers)
- [The compaction ladder](#the-compaction-ladder)
- [Optional layers](#optional-layers)
- [Files on disk, and moving them](#files-on-disk-and-moving-them)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Development](#development)

---

## How it works

```
 agent events ─► deterministic engine ─► discard / fold to state ─► ┐
                          │                                         │
                          └─ needs meaning? ─► ephemeral LLM worker ─┤
                                                   │                │
                                              state patch ──────────►│
                                                                     ▼
                                                            persistent memory
                                                                     │
                                          budget-aware retrieval ◄────┘
                                                     │
                                                     ▼
                                                   agent
```

**Most events never reach a model.** Duplicates, unchanged files, secrets, successful commands with
no residue and tool noise are all decided by code. On a real 3,000-record session, around 80% of
stored events are closed without any model involvement.

**What does reach a model** is handled by a worker that is a single call — read a slice of state,
emit a patch, terminate. The manager never grows a conversation of its own, so its cost does not
compound the way the agent's does.

**Memory has three levels:**

| Level | What it is | Goes in the prompt? |
|---|---|---|
| **L0** working memory | One small row: current task, plan, status, next action | Always |
| **L1** project memory | Structured items with category, source, confidence, decay | When relevant |
| **L2** raw history | Every stored event, for audit and replay | Never |

Everything written to L1 goes through an **append-only patch log**, which is the source of truth.
`contextd replay --verify` rebuilds state from that log and compares it against what is
materialised — if they diverge, something wrote to memory that should not have.

### What it does not do

It does not write code, modify your repository, or replace your agent. When it fails — no budget,
provider down, malformed output — it degrades: deterministic maintenance continues, events stay
queued, and the agent is never blocked.

It is a single-machine tool. There is no server and no shared database.

---

## Requirements and install

- **Node 22 or newer**
- A coding agent: Claude Code or Codex (or anything that can pipe normalised events)
- Optional: a model provider for the semantic half — Anthropic, OpenAI, or a local Ollama

```bash
git clone <this repo>
cd context_master
npm install
npm run build
```

To get a `contextd` command on your PATH:

```bash
npm link
```

Everything below works either way: with `npm link` use `contextd …`, without it use
`node /absolute/path/to/context_master/dist/cli/index.js …`. The absolute-path form is what the
hooks and the MCP registration record internally, so they keep working regardless.

---

## Quickstart

```bash
cd your-project

contextd init                    # writes contextd.config.json, installs the Claude Code hooks
contextd doctor                  # check it is wired before trusting it

# work normally in your agent; then:
contextd status                  # what it learned, and what it cost
contextd memory                  # what it decided to keep
contextd context "refresh token" # what an agent would be handed for this topic
```

`contextd init` creates two things in your project:

- `contextd.config.json` — every field has a default, so it is short on purpose
- `.claude/settings.json` — six hooks (any existing hooks of yours are preserved, not overwritten)

State lives in `.context/`, which is gitignored by default.

**Without a model provider configured, contextd still works** — deterministic filtering, the fold,
retention, decay and retrieval all run. You get a smaller, honest memory; you do not get semantic
extraction until a worker can run.

---

## Wiring it to your agent

`contextd surfaces` prints how each supported agent can be ingested from. There is no
agent-specific path anywhere in the CLI — each adapter declares its own.

### Claude Code (hooks — preferred)

`contextd init` installs handlers for six lifecycle events:

| Hook | What contextd does with it |
|---|---|
| `SessionStart` | Returns the bootstrap context, so a fresh session starts already briefed |
| `UserPromptSubmit` | Ingests what you said — the only source allowed to create user constraints |
| `PostToolUse` | Ingests file changes, commands and tool results |
| `PreCompact` | Records that the agent is compacting anyway, and flushes what it can first |
| `Stop` | Reads the finished turn's token usage from the tail of the transcript, so the compaction ladder sees real occupancy — including the drop after a compaction. Emits no event: the end of a turn is not the end of a task |
| `SessionEnd` | Closes the session record |

The hook path is **synchronous for the agent**, so it is bounded: `limits.hook_latency_ms` (default
250ms), with a warning on stderr above the hard ceiling. Measured p50 on real sessions is 9–15ms.
Hooks never call a model — only the free maintenance steps run there.

### Claude Code (transcript)

Works with or instead of hooks, and needs no installation:

```bash
contextd attach --watch                                  # newest transcript for this project
contextd attach --transcript path/to/file.jsonl --from-start
```

Both paths emit the same content hash, so running them together costs nothing — the second copy of
an event is recognised and dropped.

### Codex

```bash
contextd attach --adapter codex --watch
```

Codex rollouts live in `~/.codex/sessions/<y>/<m>/<d>/`. They are global rather than per-project, so
each file is checked against the project's working directory before being ingested.

### Running the agent under contextd

```bash
contextd run -- claude
contextd run -- codex
```

This spawns the agent with inherited stdio and tails its transcript. It is **not** a PTY wrapper and
sits nowhere between the agent and your terminal: if contextd crashes, the agent does not.

### Any other agent

Emit the normalised protocol and pipe it in:

```bash
cat events.jsonl | contextd ingest --adapter generic --session my-session
```

---

## The MCP server

Hooks are how information gets **in**. MCP is how it gets back **out** — the agent asks for context
instead of having its prompt rewritten. This is the half that makes the memory useful rather than
merely correct.

### Register it

```bash
cd your-project
contextd mcp install            # every agent that speaks MCP; idempotent
contextd mcp status             # where it is registered, and whether it can start
```

`--adapter claude|codex` limits it to one agent, `--scope local|project|user` picks where it is
written, `--force` replaces a contextd entry that runs a different command. `contextd init --mcp`
does it as part of setup. For Claude Code it runs `claude mcp add` (or edits the JSON config when
the binary is not on PATH); for Codex it writes a `[mcp_servers.contextd]` table inside a
`# --- contextd MCP server ---` block in `~/.codex/config.toml`, touching nothing outside it. An
entry named `contextd` that contextd did not write is reported, never overwritten.

By hand, the equivalent for Claude Code is:

```bash
claude mcp add contextd --scope local -- \
  node /absolute/path/to/context_master/dist/cli/index.js -C "$(pwd)" mcp
```

With `npm link` the command is shorter:

```bash
claude mcp add contextd --scope local -- contextd -C "$(pwd)" mcp
```

Two details that matter:

- **`-C "$(pwd)"` is required.** An MCP server is started with an unpredictable working directory,
  so it has to be told which project's memory to serve. Use an absolute path.
- **Scope decides who gets it:**

| Scope | Where it is written | Use when |
|---|---|---|
| `local` (default) | `~/.claude.json`, under this project | Just you, just this project. The safe default. |
| `project` | `.mcp.json` in the repo, committed | Everyone cloning the repo should get it |
| `user` | Your global config | You want it everywhere — but remember `-C` pins it to one project |

### Verify

```bash
claude mcp list        # should print: contextd: … - ✔ Connected
```

**MCP servers are loaded when a session starts**, so a server registered mid-session is not
available until you start a new one. That is the single most common surprise.

### What the agent gets

| Tool | What it is for |
|---|---|
| `memory_bootstrap` | The always-on slice: current task, plan, goals and requirements, active constraints, key decisions, important files, open issues. Read first in a new session. |
| `memory_query` | Retrieve memory relevant to a topic, plus the always-on critical items. Use before starting work on an area instead of re-deriving context. |
| `memory_remember` | Record a durable fact: a user constraint, a decision and its reason, a discovery, an open question, an important file. |
| `memory_retire` | Retire items that are wrong, stale, or were never project state. Kept in the patch log with the reason. User-critical items refuse. |
| `memory_task` | Set the current task, its status and the next action, so the next session does not start from a stale one. |
| `memory_close` | Mark goals met, requirements satisfied, questions answered or issues resolved. They leave the bootstrap but stay findable, shown as `done` with what closed them. |
| `memory_explain` | Why an item is held: source, reason, evidence, confidence, validation history. |
| `memory_link` | Record how two items relate (`governs`, `motivates`, `implemented_by`, `contradicts`, …). |
| `memory_neighbours` | Follow those relations out from an item. |
| `memory_conflicts` | Contradictions currently sitting in memory. Found deterministically, so it costs nothing. |
| `memory_status` | The metrics, as `contextd status` prints them. |

There is also a resource, `contextd://memory/{category}`, for browsing a whole category without
spending a tool call per item, and `memory_query` takes an optional `category` — with no query it
lists that category.

Two answers point somewhere on purpose:

- `memory_remember` names active items that say nearly the same thing ("Similar to d4 …") and how
  to retire one. It never merges or retires anything itself.
- When the budget leaves items out, the marker says how to get them:
  `(+3 more omitted for budget - memory_query category="decisions")` in the bootstrap, the dropped
  ids in a query.

### Making the agent actually use it

A registered server the agent never calls is worth nothing. Put something like this in your
project's `CLAUDE.md`:

```markdown
## Project memory

This project has a `contextd` MCP server holding persistent state across sessions.

- At the start of a session, call `memory_bootstrap` before reading files.
- Before working on an area, call `memory_query` with what you are about to do.
- When you learn something durable — a decision and its reason, a constraint, a discovery —
  call `memory_remember` rather than leaving it in the conversation.
- `memory_query` is cheaper than re-deriving context from the repository. Prefer it.
```

Without instructions of this kind, most agents will keep reading files, because that is what they
know how to do.

### Remove it

```bash
contextd mcp uninstall           # this project's registrations, nothing else
```

---

## Everyday use

There is no daemon to keep running. The hooks do the ingestion; everything else is a command you
run when you want it.

```bash
contextd status            # the dashboard
contextd memory            # what is being kept, by category
contextd memory --all      # including stale, superseded and archived
contextd context "oauth"   # exactly what an agent would be handed for that topic
contextd compact           # spend a model on the pending queue now
contextd lifecycle         # where you are on the compaction ladder
contextd conflicts         # does memory say two incompatible things?
contextd ui                # all of it, in a browser
```

A reasonable rhythm:

- **During work** — nothing. Hooks handle it.
- **End of a session** — `contextd compact`, then `contextd memory`. Do not silently tolerate an
  item you disagree with; correct it (see below).
- **Weekly** — `contextd prune` (retention and decay), `contextd conflicts`, `contextd doctor`.

### Recording something by hand

```bash
contextd remember "Never store refresh tokens in Redis" \
  --category constraints --importance critical --reason "production has no Redis instance"
```

Anything recorded this way is `source: user`. A `source: user` + `importance: critical` item is
**protected in code**: no patch, including one from contextd's own workers, can delete or weaken it.
That protection is permanent, so use `critical` deliberately.

### Correcting memory

Nothing is ever deleted from the patch log; a correction is a new patch that says what changed and
why, so `inspect` and `replay` still show the history.

```bash
# Wrong, or never project state at all (harness noise, a stored measurement):
contextd forget ki1 comp9 --reason "session scaffolding, not a project issue"

# Right idea, wrong wording — replace it:
contextd remember "Hook latency has an explicit budget; current values live in contextd status" \
  --category completed_work --source agent --importance high --supersedes comp1
```

Your own critical instructions (`source: user`, `critical`) refuse every retirement from a worker
or an agent — that is the point of them. To retire one yourself, add `--protected` and type the id
when asked; it only works at an interactive terminal, so an agent running the same command in its
shell is refused:

```bash
contextd forget mem_0mucgeiti1db922250a --reason "duplicate of mem_0mucgeift9687811391" --protected
```

### Keeping the current task current

The **Current task** at the top of every bootstrap is working memory, normally written by workers.
A worker only learns what the events tell it, and some endings are invisible to it — a successful
`git commit` used to be closed as inert tool traffic. Successful *milestone* commands — commit,
push, merge, tag, `gh pr create`, publish — are now kept for a worker, which updates the task and
closes the goals they finish, and the bootstrap lists them under the task until then
(`- since then: git commit -m … (feat: …), 5m ago`). The bootstrap also says how old the task is and
whether you have spoken since (`- recorded: 3h ago, 16 user messages since - verify before relying on it`),
`contextd doctor` warns after five, and you can set it directly:

```bash
contextd task                                    # show it
contextd task "Ship the export" --status in_progress --next "write the CSV header test"
contextd task --status done
contextd task --clear
```

An agent does the same with `memory_task`.

### Closing what is finished

A met goal, a satisfied requirement, an answered question or a fixed issue is not wrong — it is
done. Retiring it would lose history, and a user goal cannot be retired anyway. Close it:

```bash
contextd close g1 r1 --reason "README written; Benefits tab shipped"
contextd reopen g1 --reason "README still misses the uninstall section"
```

A closed item leaves the always-on bootstrap, keeps its protection, and still answers queries as
`(goal, done) … (closed: <reason>)`. Only goals, requirements, open questions and known issues can
be closed — a constraint or a decision is never "done". Workers close items too when the events
show the outcome, but a worker closing a `source: user` + `critical` goal must cite an event that
exists, or the close is dropped.

`--source agent` is for corrections you did not hear from the user: it keeps the item at confidence
0.85 and out of the protected class. An agent does the same through `memory_retire` and
`memory_remember` with `supersedes`. A `source: user` + `critical` item refuses both, whoever asks.

---

### Agents without hooks or MCP

Some agents only read an instruction file. `contextd mirror` writes the bootstrap into one, between
`<!-- contextd:start -->` and `<!-- contextd:end -->`, leaving the rest of the file alone:

```bash
contextd mirror                         # CLAUDE.local.md (gitignored by Claude Code convention)
contextd mirror --target agents         # AGENTS.md, for Codex and others
contextd mirror --check                 # exit 1 if the block is missing or stale; writes nothing
```

A target tracked by git gets a warning: the generated block would be committed. The copy uses
absolute dates, since a file is read long after it is written. Set
`mirror.refresh_on_maintenance: true` to rewrite it during maintenance.

### Bringing in memory the agent already has

```bash
contextd import --from claude-memory --dry-run   # what would come in
contextd import --from claude-memory [<dir>]     # ~/.claude/projects/<slug>/memory by default
```

One-way. Each memory file becomes one item (`user`/`feedback` → conventions,
`project`/`reference` → discoveries) with `source: import` and capped confidence — never
attributed to you. `MEMORY.md` is the index and is skipped. Re-running is a no-op; an edited file
supersedes what it produced before; a retired import stays retired.

### What it learns on its own

Besides what workers extract, the fold records two things without a model:

- **A fix that followed a mistake.** Within one session and one tool, a not-found path followed by
  the right one ("`src/core/fold.js` does not exist; the file is `src/core/fold.ts`.") or a command
  the shell rejected followed by the one that worked. Test and build failures never teach a rule:
  a narrower passing command is not a fix.
- **Memory pointing at files that are gone.** When every path an item names has been deleted, the
  item goes stale (not deleted) and comes back if the file does. A protected item is only flagged,
  and `contextd doctor` lists it for you to retire.

### Every project at once

```bash
contextd status --all      # root, items, pending, recovery, hard compactions, last activity
```

Read-only. Projects are listed in `~/.contextd/projects.json` (or `$CONTEXTD_HOME`) when you run
`init`, `attach` or `mcp install` in them; a project set up before that appears after any of the three.

---

## Command reference

| Command | Purpose | Notable flags |
|---|---|---|
| `init` | Write config, install agent hooks | `--agent`, `--global`, `--no-hooks`, `--mcp [scope]` |
| `doctor` | Check ingestion, providers, budgets and the patch log | |
| `surfaces` | How each supported agent can be ingested from | |
| `attach` | Follow a session transcript | `--adapter`, `--transcript`, `--watch`, `--interval`, `--from-start`, `--no-worker` |
| `run -- <agent>` | Run an agent with management attached | `--adapter`, `--interval` |
| `hook` | Handle one hook payload on stdin (used by the hooks) | `--adapter` |
| `ingest` | Read normalised JSONL events on stdin | `--adapter`, `--session`, `--worker` |
| `mcp` | Serve memory over MCP on stdio (`mcp serve`, the default) | |
| `mcp install` / `uninstall` / `status` | Register the MCP server with each agent, remove it, or show where it is | `--adapter`, `--scope`, `--force` |
| `uninstall` | Remove the hooks, MCP registrations and mirror blocks contextd added | `--purge`, `--yes` |
| `mirror` | Write the bootstrap into an instruction file | `--target claude-local\|agents\|<path>`, `--check` |
| `status` | Metrics: events, memory, reduction, cost, pressure, precision | `--session`, `--json`, `--all` |
| `memory` | List persistent memory | `--category`, `--all`, `--json` |
| `context [query]` | Build the context an agent should receive | `--limit`, `--category`, `--json` |
| `remember <text>` | Record a constraint or decision by hand | `--category`, `--reason`, `--importance`, `--source user\|agent`, `--supersedes <ids>` |
| `forget <ids...>` | Retire wrong items; kept in the patch log | `--reason` (required), `--protected` (your own critical items, confirmed at a terminal) |
| `task [text]` | Show or set the current task in working memory | `--status`, `--next`, `--state`, `--plan <steps...>`, `--clear` |
| `close <ids...>` | Mark goals / requirements / questions / issues as finished | `--reason` (required) |
| `reopen <ids...>` | Undo a close | `--reason` (required) |
| `inspect [id]` | Explain an item, or show the patch and event log | `--patches [n]`, `--events [n]`, `--search <q>` |
| `replay` | Rebuild state from the patch log | `--verify`, `--version <n>` |
| `compact` | Drain the pending queue through workers now | `--session`, `--task`, `--max-runs` |
| `lifecycle` | Where the session sits on the compaction ladder | `--act`, `--session`, `--max-runs` |
| `conflicts` | Contradictions in memory, found without a model | `--limit`, `--json` |
| `reconcile` | Have a worker resolve contradictions | `--restructure`, `--no-conflicts`, `--max-runs` |
| `graph [id]` | Typed relations between memory items | `--json` |
| `embed` | Build the optional semantic index | `--limit`, `--all` |
| `bench` | Managed context against the unmanaged baseline; or retrieval quality | `--session`, `--json`, `--retrieval`, `--k`, `--verbose`, `--real-embeddings` |
| `prune` | Apply retention and memory decay | |
| `export` | Export memory and patch log as JSON | `--out <file>` |
| `import [file]` | Replay an exported patch log, or import an agent's own memory | `--force`, `--from claude-memory`, `--dry-run` |
| `reset` | Delete stored context for this project | `--events-only`, `--yes` |
| `sessions` | List observed agent sessions | |
| `ui` | Read-only dashboard on localhost | `--port`, `--host` |

Global: `-C, --cwd <dir>` points any command at a different project.

---

## Configuration reference

`contextd.config.json` in the project root. **Every field has a default** — set only what you need.
Here is the complete set, with the defaults filled in:

```jsonc
{
  "project": { "name": "my-project" },

  "storage": { "dir": ".context" },

  // When to spend a model on the pending queue.
  "triggers": {
    "event_count": 40,          // run a worker once this many events are waiting
    "token_threshold": 6000,    // …or once they weigh this much
    "interval_seconds": 300,    // periodic floor; 0 disables
    "importance_floor": "high", // any event at or above this fires immediately
    "adaptive": true            // scale the thresholds up on long sessions
  },

  // The compaction ladder: thresholds on the *agent's* context occupancy.
  "lifecycle": {
    "pressure_warn": 0.55,             // deterministic maintenance only
    "pressure_high": 0.75,             // worth spending a model
    "pressure_critical": 0.9,          // compaction is imminent
    "backlog_event_threshold": 200,    // a backlog is pressure of its own kind
    "backlog_token_threshold": 30000
    // "context_window_tokens": 200000 // unset on purpose: inferred, then corrected by observation
  },

  // What the coding agent's own input tokens cost, for the Benefits view. Unset: savings are
  // shown in tokens only, never priced at a guessed rate.
  "accounting": {
    // "agent_input_cost_per_mtok": 15,
    // "rebuild_baseline_tokens": 40000  // what re-orienting without memory costs; unset: measured
                                         // from the root and docs/ .md files, minus CLAUDE.md
  },

  // Cost control. When exceeded, workers stop; deterministic maintenance continues.
  "budget": {
    "max_tokens_per_hour": 120000,
    "max_cost_per_session_usd": 0.5,
    "max_worker_calls_per_hour": 60,
    "on_exceeded": "defer"      // "defer" retries later; "disable" stops for the session
  },

  // See "Models and providers" below.
  "models": {
    "tiers": {
      "cheap":  { "provider": "anthropic", "model": "claude-haiku-4-5-20251001",
                  "input_cost_per_mtok": 1,  "output_cost_per_mtok": 5,
                  "max_output_tokens": 4096, "api_key_env": "ANTHROPIC_API_KEY" },
      "medium": { "provider": "anthropic", "model": "claude-sonnet-5",
                  "input_cost_per_mtok": 3,  "output_cost_per_mtok": 15,
                  "max_output_tokens": 8192, "api_key_env": "ANTHROPIC_API_KEY" },
      "high":   { "provider": "anthropic", "model": "claude-opus-5",
                  "input_cost_per_mtok": 15, "output_cost_per_mtok": 75,
                  "max_output_tokens": 8192, "api_key_env": "ANTHROPIC_API_KEY" }
    },
    "routing": {
      "classification": "cheap",
      "extraction": "cheap",
      "summarization": "cheap",
      "conflict_resolution": "medium",
      "complex_reconciliation": "high"
    }
  },

  // Optional semantic retrieval. Off by default.
  "embeddings": {
    "enabled": false,
    "provider": "ollama",       // "ollama" | "openai" | "none"
    "model": "nomic-embed-text",
    "weight": 0.5,              // weight of the semantic ranking in the fusion; 0 disables at query time
    "batch_size": 32,
    "min_similarity": 0,        // absolute floor on cosine; the per-query relative cut applies regardless
    "timeout_ms": 5000          // per provider request; on timeout the query answers keyword-only
  },

  // Context is a budget, not a bucket.
  "context_budget": {
    "total_tokens": 8000,
    "reserve_for_retrieval": 4000,
    "min_bootstrap_confidence": 0.5,   // below this an item is query-only, never always-on
    "sections": {
      "task": 500, "goals": 400, "constraints": 600, "decisions": 700,
      "important_files": 600, "open_issues": 500, "recent_events": 600
    }
  },

  "privacy": {
    "redact_secrets": true,
    "local_only": false,        // refuse any non-local *model* (see below)
    "exclude_paths": [],        // extra globs never ingested
    "respect_gitignore": true
  },

  "retention": {
    "raw_events_days": 30,
    "max_payload_chars": 4000,  // anything longer is truncated and hashed
    "max_queue_events": 5000    // beyond this, low-value pending events are shed
  },

  "limits": {
    "hook_latency_ms": 250,     // target for one hook, end to end
    "hook_latency_hard_ms": 1000,
    "worker_timeout_ms": 60000,
    "latency_samples": 500
  },

  "observability": { "log_level": "info" }
}
```

---

## Models and providers

Context maintenance is a different job from coding, so it does not have to run on the same model.
Tasks are routed per tier, and each has its own prompt:

| Task | Reads | Default tier |
|---|---|---|
| `extraction` | new events | cheap |
| `summarization` | new events | cheap |
| `classification` | existing memory | cheap |
| `conflict_resolution` | detected contradiction pairs | medium |
| `complex_reconciliation` | the whole memory | high |

Providers: `anthropic`, `openai`, `ollama`, and `noop` for deterministic-only operation.

### A local model

```json
{
  "models": {
    "tiers": { "cheap": { "provider": "ollama", "model": "qwen2.5:7b" } },
    "routing": { "classification": "cheap", "extraction": "cheap", "summarization": "cheap",
                 "conflict_resolution": "cheap", "complex_reconciliation": "cheap" }
  }
}
```

### Reasoning models

A model that reasons in a separate channel can spend its whole output budget before emitting
anything. Turn it off per tier:

```json
{ "models": { "tiers": { "cheap": { "provider": "ollama", "model": "some-reasoning-model",
                                    "think": false, "max_output_tokens": 8192 } } } }
```

Left unset, nothing is sent, so providers that would reject the field are unaffected. If a model
does return only reasoning, the error names that cause rather than saying "no JSON found".

### `local_only` is about the model, not the daemon

Ollama runs on your machine but **proxies `*-cloud` models to a remote host**, and a non-loopback
`base_url` is a network call whatever the provider is called. The check is therefore per model, and
`contextd doctor` prints `local` or `remote` for every routed tier. Trust the doctor output, not the
provider's name.

---

## Privacy and security

- **Local by default.** All state lives in `.context/` inside your project.
- **Secrets are redacted at ingest** — before anything is written to disk and before anything is
  sent to a provider. Provider keys, JWTs, PEM blocks, bearer tokens, credentialed URLs, and
  **values whose key names a secret** (`{"apiKey": "..."}`), which no value pattern catches.
- **Sensitive files are never ingested at all**: `.env`, `*.pem`, `id_rsa`, `secrets.*`, and
  anything in `privacy.exclude_paths`. `.gitignore` is respected.
- **Hooks never call a provider.** Automatic ingestion cannot send anything anywhere; data leaves
  the machine only when you run `compact`, `reconcile` or `lifecycle --act`.
- **`privacy.local_only: true`** refuses any non-local model outright, judged per model.
- Raw history is pruned on `raw_events_days`; memory items decay on their TTL.

---

## Reading the numbers

`contextd status` prints more than a size. The parts worth understanding:

```
Events:               1,424
  stored:             1,424
  discarded:          99        ← never written: duplicates, secrets, worthless output
  pending:            1         ← waiting for a worker
  inert:              1,142     ← closed, derived nothing (tool traffic, rejected noise)

Token reduction:      99.9%     ← the cheap ratio: active context vs raw equivalent
Coverage:             99.6%     ← of events that *could* produce state, how many did
Effective (K1):       99.5%     ← their product. This is the number to quote.
```

**Quote `Effective`.** The raw ratio reads ~100% on a backlog nobody has read, which is arrears, not
compression. Coverage is `derived / (derived + pending)`: inert events were never candidates, so
they neither help nor hurt, and a worker that records nothing pins coverage at zero rather than
flattering itself.

```
Context pressure
  occupancy:          51.9% (519,072 / 1,000,000 tokens, window observed)
  stage:              steady
  recovery (K5):      ready
  hard compactions:   0         ← times the agent compacted anyway: this mechanism's own score
```

`window observed` means the figure came from a turn that actually fitted, which beats any inference
from the model name. `recovery` asks K5 *before* the fact: if the agent compacted right now, is
there enough derived state to continue from?

```
Memory precision
  never retrieved:    50.0%     ← true facts nobody has ever needed are still a cost
```

This is the signal to watch once you have been using it for a while. Memory that is true but
worthless is the failure mode that actually occurs — not loss, and not invention.

```
Latency budget:       250ms (hook path)
  hook              p50 15ms · p95 28ms · max 32ms (n=59)
```

The agent is blocked while a hook runs, which is why this has a number rather than an adjective.

### The dashboard

`contextd ui` serves a read-only page on localhost with four views — **Overview**, **Memory**
(items, conflicts, relations, a context preview), **History** and **Activity** (events, the patch
log). The header carries a health pill backed by `GET /api/health`, the same checks as
`contextd doctor`; click it for what is failing and how to fix it. Keys: `1`–`4` switch views, `R`
refreshes, `/` searches memory. Old `#benefits`, `#graph`, `#events` links still land in the right
place. Light and dark themes follow the system, with a toggle.

The Overview opens with what the tool has bought this project, each figure with the baseline it is
measured against:

| Figure | Measured as |
|---|---|
| **N× smaller** | the size of the project state vs the conversation it was distilled from — a size comparison, not a saving |
| **Saved** | per **resume** (a new session, or the same one after a compaction), the project's `.md` documents an agent would re-read to reorient, minus the bootstrap. Queries inside a session count for nothing: that session already holds its context |
| **Settled by code** | events discarded at ingest or closed by the deterministic fold: they never reached a model |
| **Protected instructions** | active `source: user` + `critical` items, enforced by `isProtected` |
| **From events to memory** | the funnel: observed → settled by code → read by a worker → still waiting → items |
| **Continuity** | recovery readiness, hard compactions, hook p95 against its budget, session starts and queries served |
| **Guarantees enforced in code** | attributions downgraded, invented ids dropped, outputs rejected with their events kept pending |

The Overview ends with **"How to read these numbers"**: caveats generated from the same data — no agent
price configured, unpriced worker models, pending events, memory nobody has retrieved, compactions
the ladder failed to prevent. A benefits page with no counterweight on the same screen is marketing;
this one is meant to be quotable. Set `accounting.agent_input_cost_per_mtok` to see savings in
dollars. Previewing a query in the Memory view's Context preview is not counted as a retrieval.

The same data is at `GET /api/benefits` for anything that wants to chart it.

---

## The compaction ladder

The usual way to survive a full context window is to wait for it to fill and then cut hard.
`contextd` reads the occupancy the agent reports each turn and answers in stages, cheapest first —
so a hard compaction becomes the failure case rather than the mechanism:

| Occupancy | Stage | What runs |
|---|---|---|
| under 55% | `steady` | ingest and fold, nothing else |
| 55% | `maintain` | deterministic only: fold the backlog, decay, retention |
| 75% | `consolidate` | a model: extraction, contradiction resolution |
| 90% | `reduce` | whole-memory reconciliation; compaction is imminent |

The free stages run inside the hook, which is why maintenance continues with no budget, no provider,
or in local-only mode with nothing local configured.

```bash
contextd lifecycle          # where am I, and what would be run
contextd lifecycle --act    # run exactly what this stage authorises
```

---

## Optional layers

Off or empty unless you turn them on; nothing depends on them.

**Relations.** Workers can emit typed links (`governs`, `motivates`, `implemented_by`,
`contradicts`, `refines`, `blocked_by`, `relates_to`) as part of an ordinary patch, so relations are
versioned and replayable like everything else. Retrieval walks one hop out from its best hits, which
reaches a constraint governing a decision even when its text shares no words with your query.

```bash
contextd graph            # all relations
contextd graph <item-id>  # the neighbourhood of one item
```

**Semantic search.** Disabled by default — keyword search plus metadata is enough at a few thousand
items, where an exhaustive cosine scan takes microseconds, so no vector database is involved. Turn
it on if you want it:

```json
{ "embeddings": { "enabled": true, "provider": "ollama", "model": "nomic-embed-text" } }
```

```bash
contextd embed --all      # build the index up front (optional)
```

Once on, `memory_query`, `contextd context <query>` and the dashboard's Context tab all fuse the
semantic ranking in, and each query first embeds any item that is new or has changed, so the index
never needs a manual refresh. The hooks never do: embedding a query is a provider call, and the hook
path has a latency budget, so what hooks inject stays keyword-only.

Rankings are fused by reciprocal rank rather than by adding scores, because BM25 and cosine are not
on a comparable scale. The cosine scan covers every vector, so only similarities that stand out from
that query's own distribution (above mean + one standard deviation) count as semantic hits — a
fixed threshold would be wrong for some model, since unrelated text scores ~0.1 under one and ~0.45
under another. If the provider is down or slow, the query answers keyword-only instead of failing
or waiting.

**Contradictions.** Detection is deterministic and free — trigram similarity plus polarity — and
deliberately crosses category boundaries, because a user constraint contradicted by an agent
decision is exactly the case a within-category check misses. A model is spent only on deciding which
side wins, and never on weakening something you said yourself.

```bash
contextd conflicts        # what is incompatible right now
contextd reconcile        # have a worker resolve it
```

---

## Files on disk, and moving them

```
your-project/
├── contextd.config.json      ← your settings (commit it)
├── .claude/settings.json     ← the hooks (absolute paths; usually not committed)
└── .context/                 ← state (gitignored by default)
    └── state.db              ← SQLite: events, patches, memory, metrics
```

Because the patch log is the source of truth, moving a project's memory is just replaying it:

```bash
contextd export --out memory.json      # on the old machine
contextd import memory.json            # on the new one
contextd replay --verify               # prove it reproduced exactly
```

Import is idempotent: patches already present are skipped, not duplicated.

---

## Troubleshooting

Start with `contextd doctor`. It checks the config, storage, each agent's ingestion surface, every
routed provider, the budget, hook latency, the patch log and the compaction ladder.

| Symptom | Likely cause | Fix |
|---|---|---|
| `status` shows events but no memory | No worker has run | Check the provider warnings in `doctor`, then `contextd compact` |
| Workers fail, events stay pending | No API key, or `local_only` blocking the routed model | `doctor` names the tier and the missing variable |
| `Effective (K1)` is 0% | Nothing has derived state yet | Run `compact`; if it persists, see the next row |
| Runs say `ok` but memory stays empty | The model is ignoring the patch contract | `doctor` reports it after two such runs ("worker output") |
| `never retrieved: 100%` | Nothing has queried yet | Register the MCP server and instruct the agent to use it |
| MCP tools do not appear | Servers load at session start | Start a new session; `claude mcp list` should say Connected |
| MCP serves an empty memory | `-C` points at the wrong project | Re-register with an absolute project path |
| Hooks do not fire | Installed after the session started | Start a new session, or use `contextd attach --watch` meanwhile |
| Hook latency warnings | Something slow on the hook path | `status` shows p50/p95/max; raise `limits.hook_latency_ms` only if you understand why |
| `replay --verify` says INCONSISTENT | Something wrote to memory outside the patch log | A real bug: the patch log is the source of truth |
| Memory full of the agent's own fumbling | Should be filtered; if it is not, that is a gap | See `isTransientToolError`, and open an issue with the text |
| A wrong item needs removing | — | `contextd forget <id> --reason "…"`, or `remember … --supersedes <id>` to replace it |
| A wrong item cannot be deleted | It is `source: user` + `critical`, protected by design | `reset` and re-import without that patch; the protection is deliberate |
| Bootstrap shows a task that finished long ago | Its ending was invisible to workers (e.g. a commit) | `contextd task "…" --status …`; `doctor` flags it after 5 user messages |
| Occupancy never changes between turns | The `Stop` hook is missing or predates this version | Re-run `contextd init`; occupancy is read from the transcript on `Stop` |
| Memory repeats itself after you paste `contextd memory` output | Older version | Verbatim re-adds are now dropped as no-ops; `forget` the copies |

---

## Uninstall

```bash
contextd uninstall                  # hooks, MCP registrations and mirror blocks contextd added
contextd uninstall --purge          # also .context/ and contextd.config.json - lists them, then asks
```

Only what contextd wrote is removed: your own hooks and other MCP servers stay. The Codex block is
shared by every project on the machine, and the command says so when it removes it. Without a
terminal, `--purge` needs `--yes`.

`contextd reset` clears the state without touching the wiring; `contextd reset --events-only` keeps
memory and drops raw history.

---

## Development

```bash
npm test            # no network — providers are scripted
npm run typecheck
npm run build
npm run dev -- <args>   # run the CLI from source
```

- [CLAUDE.md](CLAUDE.md) — architecture and the invariants. Each one exists because breaking it
  broke a guarantee, usually discovered on real data.
- [prd.md](prd.md) — the full specification, with amendments from the implementation in §61.
- [docs/prd-review.md](docs/prd-review.md) — where the implementation departs from the spec, and
  every bug that real sessions found.
- [docs/landscape.md](docs/landscape.md) — how this compares to other open-source agent memory
  tools, what was borrowed, and what was deliberately refused.

MIT.
