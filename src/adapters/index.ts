import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import { genericAdapter } from './generic/index.js';
import type { Adapter, InstructionFile, NativeMemorySource } from './types.js';

export type {
  Adapter,
  AdapterContext,
  AdapterSurface,
  CommandRunner,
  HookInstaller,
  HostEnv,
  InstalledHook,
  InstructionFile,
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
export { hookInstaller, newestTranscript, preferredSurface } from './types.js';
export { candidatesIn, sessionIdFromFilename } from './discover.js';
export { realHost } from './host.js';
export { claudeAdapter, codexAdapter, genericAdapter };

export const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  generic: genericAdapter,
};

export const ADAPTER_NAMES = Object.keys(ADAPTERS);

export function getAdapter(name: string): Adapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown adapter "${name}" (available: ${ADAPTER_NAMES.join(', ')})`);
  return a;
}

/** Adapters that can register the MCP server, optionally narrowed to one by name. */
export function mcpAdapters(only?: string): Adapter[] {
  const list = only ? [getAdapter(only)] : Object.values(ADAPTERS);
  return list.filter((a) => a.mcp);
}

/** Every instruction file any adapter declares, keyed by its `--target` name. */
export function instructionFiles(): InstructionFile[] {
  return Object.values(ADAPTERS).flatMap((a) => a.instructionFiles ?? []);
}

export function nativeMemorySources(): NativeMemorySource[] {
  return Object.values(ADAPTERS).flatMap((a) => (a.nativeMemory ? [a.nativeMemory] : []));
}
