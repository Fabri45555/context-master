import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';


/** PRD 27 - worker tiers. The coding agent's model and the context model are unrelated. */
export const ModelTierSchema = z.enum(['cheap', 'medium', 'high']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const WORKER_TASKS = [
  'classification',
  'extraction',
  'summarization',
  'conflict_resolution',
  'complex_reconciliation',
  /** Lessons from a session's failure -> success episodes. Never on the hook path. */
  'learn',
] as const;
export const WorkerTaskSchema = z.enum(WORKER_TASKS);
export type WorkerTask = z.infer<typeof WorkerTaskSchema>;

export const ProviderSchema = z.enum(['anthropic', 'openai', 'ollama', 'noop']);
export type ProviderName = z.infer<typeof ProviderSchema>;

export const ModelSpecSchema = z.object({
  provider: ProviderSchema,
  model: z.string(),
  /** USD per million tokens, used by the cost controller (PRD 26/28). */
  input_cost_per_mtok: z.number().nonnegative().default(0),
  output_cost_per_mtok: z.number().nonnegative().default(0),
  max_output_tokens: z.number().int().positive().default(4096),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /**
   * Reasoning toggle for providers that expose one (ollama's `think`).
   *
   * Left unset by default so nothing is sent to a provider that would reject the field. Set it
   * to false for a reasoning model: a worker wants a patch, and a real run of a 120B reasoning
   * model spent 7,669 output tokens on reasoning and emitted no content at all, twice.
   */
  think: z.boolean().optional(),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

/**
 * Phase 4 semantic retrieval settings. Defined here rather than beside the index so that
 * core never depends on the store layer.
 */
export const EmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['ollama', 'openai', 'none']).default('ollama'),
  model: z.string().default('nomic-embed-text'),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /** Weight of the semantic ranking when fused with BM25. 0 disables it at query time. */
  weight: z.number().min(0).max(1).default(0.5),
  /** Embed at most this many items per backfill batch. */
  batch_size: z.number().int().positive().default(32),
  /**
   * Absolute floor on cosine similarity for a semantic hit. 0 leaves only the per-query
   * relative cut, because each model has its own baseline for unrelated text.
   */
  min_similarity: z.number().min(0).max(1).default(0),
  /** Per request. A hung provider must degrade a query to keyword-only, not stall it. */
  timeout_ms: z.number().int().positive().default(5000),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const ConfigSchema = z.object({
  project: z
    .object({
      name: z.string().optional(),
      root: z.string().optional(),
    })
    .default({}),

  storage: z
    .object({
      /** Directory holding state.db, snapshots and logs (PRD 32). */
      dir: z.string().default('.context'),
    })
    .default({}),

  /** PRD 24 - continuous compaction triggers. */
  triggers: z
    .object({
      /** Run a worker once this many unprocessed events have accumulated. */
      event_count: z.number().int().positive().default(40),
      /** Run a worker once unprocessed events exceed this estimated token mass. */
      token_threshold: z.number().int().positive().default(6000),
      /** Periodic maintenance floor, seconds. 0 disables. */
      interval_seconds: z.number().int().nonnegative().default(300),
      /** Any event at or above this importance triggers a worker immediately. */
      importance_floor: z.enum(['ephemeral', 'low', 'medium', 'high', 'critical']).default('high'),
      /** PRD 25 - scale the thresholds up when a session turns out to be long. */
      adaptive: z.boolean().default(true),
    })
    .default({}),

  /**
   * PRD 24 - the compaction ladder. The triggers above watch our own backlog; these watch
   * the agent's context occupancy, which is the quantity the user actually feels. Hard
   * compaction is the last line of defence, so these thresholds sit below it.
   */
  lifecycle: z
    .object({
      /**
       * Left unset on purpose: an inferred window is reported as inferred, and setting this
       * pins it (useful behind a gateway that caps the window below the model's own).
       */
      context_window_tokens: z.number().int().positive().optional(),
      /** Deterministic maintenance only. */
      pressure_warn: z.number().min(0).max(1).default(0.55),
      /** Worth spending a model to consolidate. */
      pressure_high: z.number().min(0).max(1).default(0.75),
      /** Compaction is imminent; reconcile whatever is left. */
      pressure_critical: z.number().min(0).max(1).default(0.9),
      /** A backlog this large is unservable context regardless of occupancy. */
      backlog_event_threshold: z.number().int().positive().default(200),
      backlog_token_threshold: z.number().int().positive().default(30_000),
    })
    .default({}),

  /**
   * What the coding agent's own tokens cost, for the benefits view. Unset by default: the
   * dashboard reports saved tokens either way, and prints a dollar figure only when the price
   * was stated rather than guessed.
   */
  accounting: z
    .object({
      agent_input_cost_per_mtok: z.number().nonnegative().optional(),
      /**
       * What re-orienting a session without memory costs, in tokens. Unset: measured from the
       * project's root and docs/ markdown files.
       */
      rebuild_baseline_tokens: z.number().int().nonnegative().optional(),
    })
    .default({}),

  /** PRD 26 - cost controller. */
  budget: z
    .object({
      max_tokens_per_hour: z.number().int().positive().default(120_000),
      max_cost_per_session_usd: z.number().positive().default(0.5),
      max_worker_calls_per_hour: z.number().int().positive().default(60),
      /** When exceeded: keep deterministic maintenance, stop spawning workers. */
      on_exceeded: z.enum(['defer', 'disable']).default('defer'),
    })
    .default({}),

  /** PRD 27 - model routing per worker task. */
  models: z
    .object({
      tiers: z
        .record(ModelTierSchema, ModelSpecSchema)
        .default({
          cheap: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            input_cost_per_mtok: 1,
            output_cost_per_mtok: 5,
            max_output_tokens: 4096,
            api_key_env: 'ANTHROPIC_API_KEY',
          },
          medium: {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            input_cost_per_mtok: 3,
            output_cost_per_mtok: 15,
            max_output_tokens: 8192,
            api_key_env: 'ANTHROPIC_API_KEY',
          },
          high: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            input_cost_per_mtok: 15,
            output_cost_per_mtok: 75,
            max_output_tokens: 8192,
            api_key_env: 'ANTHROPIC_API_KEY',
          },
        }),
      routing: z
        .record(WorkerTaskSchema, ModelTierSchema)
        .default({
          classification: 'cheap',
          extraction: 'cheap',
          summarization: 'cheap',
          conflict_resolution: 'medium',
          complex_reconciliation: 'high',
          // Reads a small digest, but judging whether an episode is a lesson or ordinary
          // development is the whole job, and the cheap tier writes changelog lines instead.
          learn: 'medium',
        }),
    })
    .default({}),

  /**
   * Phase 4 semantic retrieval. Disabled by default: PRD 49 rules a vector store out of the
   * MVP, and keyword search plus metadata is genuinely enough at this scale. This exists so
   * the capability is available, not because it is needed.
   */
  embeddings: EmbeddingConfigSchema.default({}),

  /** `contextd mirror` - the bootstrap copied into an instruction file for agents without hooks or MCP. */
  mirror: z
    .object({
      /** A declared instruction-file target (`contextd surfaces`) or a path relative to the root. */
      target: z.string().default('claude-local'),
      /**
       * Rewrite already-mirrored blocks during maintenance when they are stale. Off by default:
       * contextd should not start editing a file the user reads because a hook fired.
       */
      refresh_on_maintenance: z.boolean().default(false),
    })
    .default({}),

  /**
   * The `learn` worker task (`contextd learn`). Off the lifecycle by default: it spends a model
   * call per session with an episode, and only a person should opt into that happening unasked.
   */
  learn: z
    .object({
      /** Also run it in `lifecycle --act` at the consolidate rung and above. */
      in_lifecycle: z.boolean().default(false),
      /** Episodes per digest; the rest wait for the next run. */
      max_episodes: z.number().int().positive().default(12),
      /** Estimated tokens per digest, cut at an episode boundary. */
      max_digest_tokens: z.number().int().positive().default(3000),
    })
    .default({}),

  /** PRD 45 - context is a budgeted resource. */
  context_budget: z
    .object({
      total_tokens: z.number().int().positive().default(8000),
      reserve_for_retrieval: z.number().int().nonnegative().default(4000),
      /**
       * A worker's hedged guess should not be paid for in every single session. Below this
       * confidence an item is kept out of the always-on slice but stays fully reachable by
       * query, which is where an uncertain claim belongs. User and critical items are never
       * withheld (K2).
       */
      min_bootstrap_confidence: z.number().min(0).max(1).default(0.5),
      sections: z
        .object({
          task: z.number().int().nonnegative().default(500),
          goals: z.number().int().nonnegative().default(400),
          constraints: z.number().int().nonnegative().default(600),
          decisions: z.number().int().nonnegative().default(700),
          important_files: z.number().int().nonnegative().default(600),
          open_issues: z.number().int().nonnegative().default(500),
          recent_events: z.number().int().nonnegative().default(600),
        })
        .default({}),
    })
    .default({}),

  /** PRD 36 / 37 - privacy defaults are local-first. */
  privacy: z
    .object({
      redact_secrets: z.boolean().default(true),
      /** Hard stop: never call a non-local provider. */
      local_only: z.boolean().default(false),
      /** Extra path globs excluded from ingestion, beyond .gitignore. */
      exclude_paths: z.array(z.string()).default([]),
      respect_gitignore: z.boolean().default(true),
    })
    .default({}),

  /** PRD 10 - L2 exists for audit and replay, but not forever. */
  retention: z
    .object({
      raw_events_days: z.number().int().positive().default(30),
      /** Truncate any single payload string beyond this many characters (PRD 51). */
      max_payload_chars: z.number().int().positive().default(4000),
      /** Keep at most this many events in the hot queue before shedding low value ones. */
      max_queue_events: z.number().int().positive().default(5000),
    })
    .default({}),

  /**
   * PRD 31 says "non-blocking" without giving a number. The hook path is the real
   * constraint because it is synchronous for the agent, so it gets an explicit ceiling that
   * `contextd status` and `contextd doctor` report against.
   */
  limits: z
    .object({
      /** Target ceiling for one hook invocation, end to end. */
      hook_latency_ms: z.number().int().positive().default(250),
      /** Hard ceiling: above this the hook path logs a warning to stderr. */
      hook_latency_hard_ms: z.number().int().positive().default(1000),
      /** Abort a worker provider call after this long. */
      worker_timeout_ms: z.number().int().positive().default(60_000),
      /** Keep at most this many latency samples per operation. */
      latency_samples: z.number().int().positive().default(500),
    })
    .default({}),

  observability: z
    .object({
      log_level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info'),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILENAMES = ['contextd.config.json', '.contextd.json'];

export interface LoadedConfig {
  config: Config;
  /** Absolute project root. */
  root: string;
  /** Absolute storage directory. */
  storageDir: string;
  /** Path the config was read from, or null when defaults were used. */
  path: string | null;
}

export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(cwd = process.cwd(), overrides: Partial<Config> = {}): LoadedConfig {
  const root = resolve(cwd);
  const path = findConfigFile(root);
  const raw: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = deepMerge(raw as Record<string, unknown>, overrides as Record<string, unknown>);
  const config = ConfigSchema.parse(merged);

  const projectRoot = config.project.root ? resolve(root, config.project.root) : root;
  if (!config.project.name) config.project.name = basename(projectRoot);

  return {
    config,
    root: projectRoot,
    storageDir: resolve(projectRoot, config.storage.dir),
    path,
  };
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlain(prev) && isPlain(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

export function resolveModel(config: Config, task: WorkerTask): ModelSpec {
  const tier = config.models.routing[task] ?? 'cheap';
  const spec = config.models.tiers[tier];
  if (!spec) throw new Error(`no model configured for tier ${tier}`);
  return spec;
}
