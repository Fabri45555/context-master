import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import { genericAdapter } from './generic/index.js';
import type { Adapter } from './types.js';

export type {
  Adapter,
  AdapterContext,
  AdapterSurface,
  SurfaceKind,
  TranscriptCandidate,
  TranslateResult,
} from './types.js';
export { newestTranscript, preferredSurface } from './types.js';
export { candidatesIn, sessionIdFromFilename } from './discover.js';
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
