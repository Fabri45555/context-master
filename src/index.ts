/** Public API. The CLI, the hook bridge and the MCP server are all thin wrappers on this. */

export { ContextManager } from './daemon/manager.js';
export type { CycleResult, ManagerOptions } from './daemon/manager.js';
export { IngestPipeline } from './daemon/ingest.js';
export type { IngestStats } from './daemon/ingest.js';
export { StateMachine, MACHINE_STATES } from './daemon/machine.js';
export type { MachineState, Transition } from './daemon/machine.js';
export { tailJsonl } from './daemon/tail.js';

export * from './core/events.js';
export * from './core/state.js';
export * from './core/patch.js';
export { DeterministicEngine, evaluateTriggers, adaptiveScale } from './core/deterministic.js';
export type { EventDecision, EventAction, TriggerInput, TriggerVerdict } from './core/deterministic.js';
export { deterministicFold } from './core/fold.js';
export { classifyImportance, needsSemantics } from './core/importance.js';
export { redactText, redactValue, isSensitivePath, DEFAULT_RULES } from './core/redact.js';
export { IgnoreMatcher } from './core/ignore.js';
export { loadConfig, ConfigSchema, resolveModel } from './core/config.js';
export type { Config, ModelSpec, ModelTier, WorkerTask, ProviderName } from './core/config.js';
export { CostController, priceUsage, totalTokens } from './core/budget.js';

export { ContextStore } from './store/store.js';
export type { StoredEvent, CommitResult } from './store/store.js';
export { openDb, dbPath } from './store/db.js';
export { RetrievalEngine, toMatchQuery } from './store/retrieval.js';
export type { ScoredItem, SearchOptions } from './store/retrieval.js';

export { ContextBuilder } from './retrieval/context-builder.js';
export type { BuiltContext, ContextSection } from './retrieval/context-builder.js';

export { WorkerRunner, parsePatch } from './workers/runner.js';
export type { RunOutcome, RunnerOptions } from './workers/runner.js';
export { getProvider, noopProvider } from './workers/providers/index.js';
export type { Provider, CompletionRequest, CompletionResponse } from './workers/providers/types.js';
export { PATCH_SHAPE, buildRepairPrompt, renderStateForWorker } from './workers/prompts.js';
export {
  TASK_DEFINITIONS,
  taskDefinition,
  buildEventsPrompt,
  buildConflictsPrompt,
  buildMemoryPrompt,
} from './workers/tasks.js';
export type { TaskDefinition, TaskInput } from './workers/tasks.js';
export { detectConflicts, similarity, isNegated } from './core/conflicts.js';
export type { Conflict } from './core/conflicts.js';
export { diagnose, formatChecks, worstStatus } from './daemon/doctor.js';
export type { Check, CheckStatus } from './daemon/doctor.js';

export { getAdapter, ADAPTERS, ADAPTER_NAMES, claudeAdapter, codexAdapter, genericAdapter } from './adapters/index.js';
export type { Adapter, AdapterContext, TranslateResult } from './adapters/types.js';
export { installHooks, buildHookConfig, claudeProjectDir } from './adapters/claude/hooks.js';

export { collectMetrics, formatMetrics } from './metrics/index.js';
export type { Metrics } from './metrics/index.js';
export { benchmark, formatBench } from './bench/index.js';
export type { BenchResult } from './bench/index.js';
export { buildMcpServer, runMcpStdio } from './mcp/server.js';
export { startUi } from './ui/server.js';
export type { UiHandle, UiOptions } from './ui/server.js';
export * from './core/graph.js';
export {
  EmbeddingIndex,
  getEmbeddingProvider,
  cosine,
  reciprocalRankFusion,
  embeddingText,
} from './store/embeddings.js';
export type { EmbeddingProvider, BackfillResult } from './store/embeddings.js';
