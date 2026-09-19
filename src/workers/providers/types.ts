import type { TokenUsage } from '../../core/budget.js';
import type { ModelSpec } from '../../core/config.js';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Abort signal so a hung provider cannot stall the daemon (PRD 31/35). */
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  usage: TokenUsage;
}

export interface Provider {
  readonly name: string;
  /**
   * True when the provider runs on this machine (PRD 37 local-only mode).
   *
   * The default for the provider as a whole. It is not always enough: ollama runs locally but
   * proxies `*-cloud` models to ollama.com, so `local_only` was satisfied while the prompt left
   * the machine. Where that is possible the provider must also implement `isLocalFor`.
   */
  readonly isLocal: boolean;
  /** Per-model verdict, which overrides `isLocal` when the provider defines it. */
  isLocalFor?(spec: ModelSpec): boolean;
  complete(req: CompletionRequest, spec: ModelSpec): Promise<CompletionResponse>;
}

/** The local-only decision in one place, so every call site asks the same question. */
export function providerIsLocal(provider: Provider, spec: ModelSpec): boolean {
  return provider.isLocalFor ? provider.isLocalFor(spec) : provider.isLocal;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
