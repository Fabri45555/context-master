import type { Config, ModelSpec } from './config.js';

/**
 * PRD 26 / 28 - the cost controller.
 *
 * The important number is not what the manager costs but what the whole system costs
 * versus baseline, so every worker call is priced from real reported usage rather than
 * estimated, and the breaker trips on measured spend.
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface UsageRecord {
  /** Epoch ms. */
  at: number;
  tokens: number;
  cost_usd: number;
}

export function priceUsage(spec: ModelSpec, usage: TokenUsage): number {
  const cachedIn = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // Cache reads bill at ~10% of input, cache writes at ~125%. Good enough for a budget
  // breaker; exactness is not worth a per-provider pricing matrix here.
  const inputCost =
    ((usage.input_tokens + cacheWrite * 1.25 + cachedIn * 0.1) / 1_000_000) * spec.input_cost_per_mtok;
  const outputCost = (usage.output_tokens / 1_000_000) * spec.output_cost_per_mtok;
  return inputCost + outputCost;
}

export function totalTokens(usage: TokenUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export interface BudgetSources {
  /** Usage records in the trailing window, newest first or any order. */
  recentUsage(sinceMs: number): UsageRecord[];
  /** Total USD already spent on workers for this session. */
  sessionCostUsd(): number;
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: string; action: 'defer' | 'disable' };

export class CostController {
  constructor(
    private config: Config,
    private sources: BudgetSources,
  ) {}

  /** Called before spawning a worker. Estimated tokens keep a single huge call in check. */
  check(estimatedTokens: number, now = Date.now()): BudgetDecision {
    const b = this.config.budget;
    const action = b.on_exceeded;

    const sessionCost = this.sources.sessionCostUsd();
    if (sessionCost >= b.max_cost_per_session_usd) {
      return {
        allowed: false,
        action,
        reason: `session cost $${sessionCost.toFixed(4)} >= cap $${b.max_cost_per_session_usd}`,
      };
    }

    const hourAgo = now - 3_600_000;
    const recent = this.sources.recentUsage(hourAgo);
    const tokensThisHour = recent.reduce((s, r) => s + r.tokens, 0);
    if (tokensThisHour + estimatedTokens > b.max_tokens_per_hour) {
      return {
        allowed: false,
        action,
        reason: `hourly tokens ${tokensThisHour}+${estimatedTokens} > cap ${b.max_tokens_per_hour}`,
      };
    }

    if (recent.length >= b.max_worker_calls_per_hour) {
      return {
        allowed: false,
        action,
        reason: `hourly worker calls ${recent.length} >= cap ${b.max_worker_calls_per_hour}`,
      };
    }

    return { allowed: true };
  }

  remaining(now = Date.now()): { tokens: number; calls: number; usd: number } {
    const b = this.config.budget;
    const recent = this.sources.recentUsage(now - 3_600_000);
    const tokens = recent.reduce((s, r) => s + r.tokens, 0);
    return {
      tokens: Math.max(0, b.max_tokens_per_hour - tokens),
      calls: Math.max(0, b.max_worker_calls_per_hour - recent.length),
      usd: Math.max(0, b.max_cost_per_session_usd - this.sources.sessionCostUsd()),
    };
  }
}
