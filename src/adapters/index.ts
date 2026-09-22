import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import { cursorAdapter } from './cursor/index.js';
import { geminiAdapter } from './gemini/index.js';
import { genericAdapter } from './generic/index.js';
import { opencodeAdapter } from './opencode/index.js';
import { ingests, type Adapter, type HostEnv, type InstructionFile, type NativeMemorySource } from './types.js';

export type {
  Adapter,
  AdapterContext,
  AdapterSurface,
  CommandRunner,
  HookInstaller,
  HookMoment,
  HookReply,
  StatuslineSurface,
  HostEnv,
  InstalledHook,
  InstructionFile,
  InstructionFormat,
  Launch,
  McpChange,
  McpEntry,
  McpRegistrar,
  NativeMemoryEntry,
  NativeMemorySource,
  SurfaceKind,
  TranscriptCandidate,
  TranslateResult,
} from './types.js';
export { hookInstaller, ingests, newestTranscript, preferredSurface } from './types.js';
export { candidatesIn, sessionIdFromFilename } from './discover.js';
export { realHost } from './host.js';
export { isContextdLaunch } from './json-mcp.js';
export { claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter, genericAdapter, opencodeAdapter };

export const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  gemini: geminiAdapter,
  opencode: opencodeAdapter,
  generic: genericAdapter,
};

export const ADAPTER_NAMES = Object.keys(ADAPTERS);

/** Adapters with something to ingest - the only valid `--adapter` for hook, ingest, attach and run. */
export const INGEST_ADAPTER_NAMES = ADAPTER_NAMES.filter((n) => ingests(ADAPTERS[n]!));

export function getAdapter(name: string): Adapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown adapter "${name}" (available: ${ADAPTER_NAMES.join(', ')})`);
  return a;
}

/**
 * An adapter events can be read from. Asking an unobserved agent to translate would silently
 * store nothing, which looks like a working ingestion that happens to be idle.
 */
export function getIngestAdapter(name: string): Adapter {
  const a = getAdapter(name);
  if (!ingests(a)) {
    throw new Error(
      `${a.agent} has no ingestion surface contextd supports (see \`contextd surfaces\`); ` +
        `use one of: ${INGEST_ADAPTER_NAMES.join(', ')}`,
    );
  }
  return a;
}

/** Adapters that can register the MCP server, optionally narrowed to one by name. */
export function mcpAdapters(only?: string): Adapter[] {
  const list = only ? [getAdapter(only)] : Object.values(ADAPTERS);
  return list.filter((a) => a.mcp);
}

/**
 * Whether an agent looks used here. An adapter that cannot tell (no `detect`) counts as in use,
 * which keeps Claude Code and Codex - whose use `doctor` judges from hooks and transcripts - as
 * they were.
 */
export function agentDetected(adapter: Adapter, env: HostEnv): boolean {
  return adapter.detect ? adapter.detect(env) : true;
}

/** Every instruction file any adapter declares, keyed by its `--target` name. */
export function instructionFiles(): InstructionFile[] {
  return Object.values(ADAPTERS).flatMap((a) => a.instructionFiles ?? []);
}

/**
 * The instruction file a `--target` names: a declared target (`claude-local`, `agents`), or an
 * adapter whose one instruction file it is (`claude`, `cursor`). Null means "a path".
 */
export function findInstructionFile(name: string): InstructionFile | null {
  const declared = instructionFiles().find((f) => f.target === name);
  if (declared) return declared;
  const files = ADAPTERS[name]?.instructionFiles ?? [];
  return files.length === 1 ? files[0]! : null;
}

export function nativeMemorySources(): NativeMemorySource[] {
  return Object.values(ADAPTERS).flatMap((a) => (a.nativeMemory ? [a.nativeMemory] : []));
}
