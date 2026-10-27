/**
 * The decision classifier: one credentialed Jev model, one deadline, one
 * circuit breaker, shared by the dispatcher and the triage phases.
 *
 * This is the only place in persona-audit that talks to a classifier. Both
 * callers go through `classify`, which enforces the deadline and records the
 * breaker outcome, so a dead classifier costs one timeout per cooldown instead
 * of one per finding.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import {
  CircuitBreaker,
  type ClassificationOutcome,
  type ClassifyRegistry,
  type JevModel,
  type JevRegistry,
  preferredClassifier,
  runClassification,
  selectJevModel,
} from "@underactive/pi-topping-primitives/classifier";
import type { DecisionSettings } from "../modelConfig.ts";

/** Everything a classifier call needs from pi's model registry. */
export type DecisionRegistry = JevRegistry & ClassifyRegistry;

export interface DecisionClassifierOptions {
  signal?: AbortSignal;
  /** Injected clock, for tests and for a shared run clock. */
  now?: () => number;
}

export class DecisionClassifier {
  /** `provider/model-id`, for a status line or a notification. */
  readonly label: string;
  readonly #registry: DecisionRegistry;
  readonly #model: JevModel;
  readonly #settings: DecisionSettings;
  readonly #breaker: CircuitBreaker | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #now: (() => number) | undefined;

  private constructor(registry: DecisionRegistry, model: JevModel, settings: DecisionSettings, options: DecisionClassifierOptions) {
    this.#registry = registry;
    this.#model = model;
    this.#settings = settings;
    this.#signal = options.signal;
    this.#now = options.now;
    this.label = `${model.provider}/${model.id}`;
    this.#breaker = settings.circuitBreakerEnabled
      ? new CircuitBreaker(settings.circuitBreakerCooldownSeconds * 1000, options.now ?? Date.now)
      : undefined;
  }

  /**
   * The classifier these settings describe, or undefined when the feature is
   * off, the selection is unusable, or no model has credentials. An undefined
   * result is the normal "behave exactly as before" answer, never an error.
   */
  static open(
    registry: DecisionRegistry,
    settings: DecisionSettings | undefined,
    options: DecisionClassifierOptions = {},
  ): DecisionClassifier | undefined {
    if (!settings?.enabled) return undefined;
    if (options.signal?.aborted) return undefined;
    const model = selectJevModel(registry, preferredClassifier(settings));
    if (!model) return undefined;
    return new DecisionClassifier(registry, model, settings, options);
  }

  /** The breaker state, for a diagnostic. Undefined when the breaker is disabled. */
  breakerState(): string | undefined {
    return this.#breaker?.state();
  }

  /** Whether a call may be made now; a half-open circuit admits exactly one probe. */
  allows(): boolean {
    return this.#breaker ? this.#breaker.allow() : true;
  }

  /** Run one classification, recording the breaker outcome either way. */
  async classify(context: ClassifierContext): Promise<ClassificationOutcome> {
    const outcome = await runClassification(this.#registry, this.#model, context, {
      timeoutMs: this.#settings.timeoutMs,
      ...(this.#signal ? { signal: this.#signal } : {}),
      ...(this.#now ? { now: this.#now } : {}),
    });
    if (this.#breaker) {
      if (outcome.ok) this.#breaker.recordSuccess();
      else if (outcome.kind === "timeout") this.#breaker.recordTimeout();
      else this.#breaker.recordFailure();
    }
    return outcome;
  }
}
