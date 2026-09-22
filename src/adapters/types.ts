import type { ContextEvent, Importance } from '../core/events.js';
import type { MemoryCategory } from '../core/state.js';

/**
 * PRD 22 - the adapter layer. Everything agent-specific lives behind this interface so the
 * core never learns what a "Bash tool" or a "codex rollout" is.
 */
export interface AdapterContext {
  sessionId: string;
  /** Ordering hint from the source (transcript line number, codex ordinal). */
  ordinal?: number;
  cwd?: string | null;
}

export interface TranslateResult {
  events: ContextEvent[];
  /** Provider token usage observed on this record, for baseline accounting (PRD 28). */
  agentUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    model?: string | null;
    /** Provider message id, so the same turn read twice (hook and transcript) counts once. */
    message_id?: string | null;
  };
  /** Session metadata discovered in the record. */
  session?: { id?: string; cwd?: string | null; agent?: string | null };
}

/**
 * How events get out of a given agent.
 *
 * "Agent agnostic" (PRD 6) hides a real asymmetry: each agent has one good ingestion
 * surface and several bad ones, and which one is chosen decides whether PRD 54.7 ("no
 * changes to the main model") actually holds. Declaring the surfaces makes that choice
 * explicit and inspectable instead of buried in the CLI.
 */
export type SurfaceKind =
  /** The agent invokes us on lifecycle events. Low latency, synchronous, must not block. */
  | 'hook'
  /** We tail an append-only log the agent writes. Complete, slightly delayed. */
  | 'transcript'
  /** Something else pipes normalized events to us. */
  | 'stdin'
  /**
   * No ingestion at all: the agent keeps its history somewhere contextd does not read. Declared
   * rather than left out, so `surfaces`, `init` and `doctor` say so instead of implying a
   * transcript that will never be found. Memory still reaches such an agent through MCP and the
   * mirror.
   */
  | 'none';

export interface TranscriptCandidate {
  path: string;
  /** Epoch ms of last modification, for picking the live session. */
  mtime: number;
  /** Session id if it can be derived from the file itself. */
  sessionId?: string;
}

export interface AdapterSurface {
  kind: SurfaceKind;
  /** The recommended path for this agent. Exactly one surface should set this. */
  preferred: boolean;
  description: string;
  /** True when `contextd init` can wire this surface up without manual steps. */
  installable: boolean;
  /**
   * Locate transcripts belonging to a project, newest first. Only for `transcript`
   * surfaces. Keeping this on the adapter is what stops the CLI from knowing where any
   * particular agent stores its logs.
   */
  locate?(projectRoot: string, home: string): TranscriptCandidate[];
  /** For `hook` surfaces: how `init` wires them and `uninstall` unwires them. */
  hooks?: HookInstaller;
}

// ------------------------------------------------------------------ installation

/**
 * Everything an installer may touch derives from this, so a test can point it at a temp dir and
 * never reach the real home directory or the real agent binary.
 */
export interface HostEnv {
  projectRoot: string;
  home: string;
  /** Environment variables an agent uses to relocate its config (CLAUDE_CONFIG_DIR, CODEX_HOME). */
  vars?: Readonly<Record<string, string | undefined>>;
  /** Locate an executable. Absent means "no external binaries": installers fall back to files. */
  which?: (bin: string) => string | null;
  /** Run a binary synchronously. Only called for a binary `which` found. */
  exec?: CommandRunner;
}

export type CommandRunner = (
  bin: string,
  args: readonly string[],
  opts?: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

export interface InstalledHook {
  path: string;
  command: string;
  events: string[];
}

export interface HookInstaller {
  /** Where hooks go; `global` means the user-level settings rather than the project's. */
  install(
    env: HostEnv,
    opts: { command: string; global?: boolean },
  ): { path: string; created: boolean; preserved: string[] };
  /** Every hook command wired for this agent, ours or not, with the file it lives in. */
  installed(env: HostEnv): InstalledHook[];
  /** Remove the hook entries whose command `isOurs` accepts, and nothing else. */
  uninstall(env: HostEnv, isOurs: (command: string) => boolean): Array<{ path: string; events: string[] }>;
}

/** How to start the contextd CLI: a command plus the arguments before the subcommand. */
export interface Launch {
  command: string;
  args: readonly string[];
}

export interface McpEntry {
  scope: string;
  /** The file the registration lives in. */
  where: string;
  command: string;
  args: string[];
  /** False for an entry contextd did not write (outside its markers); it is never modified. */
  managed: boolean;
}

export type McpChangeStatus =
  | 'registered'
  | 'already'
  | 'updated'
  | 'conflict'
  | 'removed'
  | 'absent'
  | 'failed';

export interface McpChange {
  status: McpChangeStatus;
  scope: string;
  where: string;
  detail: string;
}

/**
 * How an agent learns that an MCP server exists. Each agent invented its own config file and
 * format, so this is declared by the adapter next to its `surfaces` - the CLI only knows the verbs.
 */
export interface McpRegistrar {
  description: string;
  scopes: readonly string[];
  defaultScope: string;
  /**
   * Whether an entry in this scope names the project (`-C <root>`). A server started with an
   * unpredictable working directory must be told which memory to serve; a scope whose config is
   * global cannot pin one project without serving it everywhere.
   */
  pinsProject(scope: string): boolean;
  /** The command and arguments a registration in `scope` would carry. */
  entryFor(env: HostEnv, launch: Launch, scope: string): { command: string; args: string[] };
  /** Registrations named `name`, in `scope` or in every scope. */
  get(env: HostEnv, name: string, scope?: string): McpEntry[];
  /** Idempotent. A different existing entry is a `conflict` unless `force`; foreign entries never change. */
  register(env: HostEnv, name: string, launch: Launch, scope: string, opts?: { force?: boolean }): McpChange;
  /** Removes only an entry contextd wrote. */
  unregister(env: HostEnv, name: string, scope: string): McpChange;
}

/**
 * How the mirror block is framed. `mdc` is Cursor's rule format: a file it creates starts with
 * a frontmatter of `alwaysApply: true`, without which Cursor loads the rule only on request.
 */
export type InstructionFormat = 'markdown' | 'mdc';

/** A file an agent reads as standing instructions, where `contextd mirror` can write memory. */
export interface InstructionFile {
  /** Name used on the command line, e.g. `contextd mirror --target <target>`. */
  target: string;
  /** Relative to the project root. */
  path: string;
  description: string;
  format: InstructionFormat;
  /**
   * Tokens the mirrored bootstrap may take in this file. The agent pays for the whole file on
   * every turn, and some load only a prefix (Claude Code reads the first ~200 lines of memory
   * files), so the budget is the agent's, not the bootstrap's.
   */
  budget: number;
}

/** One memory the agent wrote in its own format, translated but not yet committed. */
export interface NativeMemoryEntry {
  /** Absolute path of the file it came from. */
  file: string;
  /**
   * Stable identity across edits, so a changed entry replaces its import: the file name for one
   * memory per file, the file and heading for a section of rules (several entries share it, and
   * are paired with what the section produced before in order).
   */
  key: string;
  /** Hash of the file content: unchanged content is not imported twice. */
  hash: string;
  /** The agent's own classification, kept for explainability. */
  nativeType: string | null;
  /** Structured fields the item carries, e.g. `path` and `purpose` for an important file. */
  fields?: Record<string, unknown>;
  /** The name the agent gave it, if any. */
  title: string | null;
  category: MemoryCategory;
  importance: Importance;
  text: string;
  detail: string | null;
}

/** An agent's own persistent memory, readable for a one-way import. */
export interface NativeMemorySource {
  /** Name used on the command line: `contextd import --from <name>`. */
  name: string;
  description: string;
  /** Default directory for this project. */
  locate(projectRoot: string, home: string): string;
  read(dir: string): { entries: NativeMemoryEntry[]; skipped: Array<{ file: string; reason: string }> };
}

export interface Adapter {
  readonly name: string;
  /** Human-facing name of the agent this adapter serves. */
  readonly agent: string;
  readonly surfaces: readonly AdapterSurface[];
  /** Translate one raw record (a transcript line, or a hook payload) into events. */
  translate(raw: unknown, ctx: AdapterContext): TranslateResult;
  /**
   * Where the agent's latest token usage can be read, given a hook payload - or null.
   *
   * Hook payloads carry no usage, so a hook-only installation never saw occupancy change: after
   * a compaction the ladder kept reading the pre-compaction peak and stayed at its most expensive
   * rung. The manager reads the tail of this file generically; only the adapter knows it exists.
   */
  usageSource?(hookPayload: unknown): string | null;
  /** How to register the contextd MCP server with this agent, if it speaks MCP. */
  readonly mcp?: McpRegistrar;
  /** Instruction files this agent reads on its own, for `contextd mirror`. */
  readonly instructionFiles?: readonly InstructionFile[];
  /** The agent's own memory store, for `contextd import --from`. */
  readonly nativeMemory?: NativeMemorySource;
  /**
   * Whether this agent appears to be used here - its config directory exists, for this project or
   * for the user. Stat only. `doctor` runs its checks, and `mcp install` without `--adapter`
   * registers, only for an agent in use, so contextd never creates `~/.gemini` for someone who
   * has never run Gemini.
   */
  detect?(env: HostEnv): boolean;
}

/** Whether contextd can read events from this agent at all (see the `none` surface). */
export function ingests(adapter: Adapter): boolean {
  return adapter.surfaces.some((s) => s.kind !== 'none');
}

export function noEvents(): TranslateResult {
  return { events: [] };
}

export function preferredSurface(adapter: Adapter): AdapterSurface | null {
  return adapter.surfaces.find((s) => s.preferred) ?? adapter.surfaces[0] ?? null;
}

/** Newest transcript across every transcript surface this adapter declares. */
export function newestTranscript(
  adapter: Adapter,
  projectRoot: string,
  home: string,
): TranscriptCandidate | null {
  let best: TranscriptCandidate | null = null;
  for (const surface of adapter.surfaces) {
    if (!surface.locate) continue;
    for (const candidate of surface.locate(projectRoot, home)) {
      if (!best || candidate.mtime > best.mtime) best = candidate;
    }
  }
  return best;
}

/** The installer of this adapter's hook surface, if it has one. */
export function hookInstaller(adapter: Adapter): HookInstaller | null {
  return adapter.surfaces.find((s) => s.hooks)?.hooks ?? null;
}
