import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ClassifierModel } from "@earendil-works/pi-ai";

/** A full classifier model, so a stub registry satisfies `JevRegistry`. */
const jevModel: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
};
import { DecisionClassifier, type DecisionRegistry } from "../src/decision/classifier.ts";
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from "../src/modelConfig.ts";

/** A registry that resolves the typesafe Jev model and answers with `answers`. */
function fakeRegistry(
  answers: ClassifierResult["answers"],
  overrides: Partial<ClassifierResult> = {},
  calls: { timeoutMs?: number; signal?: AbortSignal }[] = [],
): DecisionRegistry {
  return {
    findOfType: (_type, provider, id) =>
      provider === "typesafe" && id === "jev-latest" ? { ...jevModel, provider, id } : undefined,
    getProviderAuthStatus: (provider) => ({ configured: provider === "typesafe", source: "environment" }),
    async classify(_model, _context, options) {
      calls.push({ timeoutMs: options?.timeoutMs, signal: options?.signal });
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers,
        stopReason: "stop",
        timestamp: 1,
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00001 } },
        ...overrides,
      };
    },
  };
}

const bools = (values: Record<string, number>): ClassifierResult["answers"] =>
  Object.fromEntries(
    Object.entries(values).map(([key, probability]) => [key, { type: "bool", probability }]),
  ) as ClassifierResult["answers"];

function decision(overrides: Partial<DecisionSettings> = {}): DecisionSettings {
  return { ...DEFAULT_DECISION_SETTINGS, enabled: true, ...overrides };
}

test("open returns undefined when the feature is off, unset, or uncredentialed", () => {
  assert.equal(DecisionClassifier.open(fakeRegistry({}), undefined), undefined);
  assert.equal(DecisionClassifier.open(fakeRegistry({}), DEFAULT_DECISION_SETTINGS), undefined, "disabled by default");
  const uncredentialed: DecisionRegistry = {
    ...fakeRegistry({}),
    getProviderAuthStatus: () => ({ configured: false }),
  };
  assert.equal(DecisionClassifier.open(uncredentialed, decision()), undefined);
});

test("open resolves the pinned model when it has credentials, else the known chain", () => {
  const registry = fakeRegistry({});
  assert.equal(DecisionClassifier.open(registry, decision())?.label, "typesafe/jev-latest");
  assert.equal(
    DecisionClassifier.open(registry, decision({ provider: "openrouter", model: "typesafe/jev-1.13" }))?.label,
    "typesafe/jev-latest",
    "an unavailable pin falls through to the known chain",
  );
});

test("open refuses an already-aborted signal", () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(DecisionClassifier.open(fakeRegistry({}), decision(), { signal: controller.signal }), undefined);
});

test("classify passes the deadline and signal and reports the model and cost", async () => {
  const calls: { timeoutMs?: number; signal?: AbortSignal }[] = [];
  const registry = fakeRegistry(bools({ architecture: 0.9 }), {}, calls);
  const controller = new AbortController();
  const classifier = DecisionClassifier.open(registry, decision({ timeoutMs: 1234 }), { signal: controller.signal })!;
  const outcome = await classifier.classify({ state: {}, questions: {} });
  assert.ok(outcome.ok);
  assert.deepEqual(calls, [{ timeoutMs: 1234, signal: controller.signal }]);
  assert.equal(outcome.model, "typesafe/jev-latest");
  assert.equal(outcome.cost, 0.00001);
});

test("a timeout opens the circuit and blocks the next call until the cooldown passes", async () => {
  let now = 0;
  const registry = fakeRegistry(bools({}), { stopReason: "error", errorMessage: "request timed out after 3000ms" });
  const classifier = DecisionClassifier.open(registry, decision({ circuitBreakerCooldownSeconds: 30 }), { now: () => now })!;
  assert.equal(classifier.breakerState(), "closed");
  assert.equal(classifier.allows(), true);

  const first = await classifier.classify({ state: {}, questions: {} });
  assert.equal(first.ok, false);
  assert.equal(classifier.breakerState(), "open");
  assert.equal(classifier.allows(), false, "the cooldown blocks the next call");

  now = 29_999;
  assert.equal(classifier.allows(), false);
  now = 30_000;
  assert.equal(classifier.allows(), true, "one probe after the cooldown");
  assert.equal(classifier.allows(), false, "and no second probe while probing");
});

test("a non-timeout failure never opens the circuit, and a disabled breaker never blocks", async () => {
  const registry = fakeRegistry(bools({}), { stopReason: "error", errorMessage: "System One API error: 500" });
  const classifier = DecisionClassifier.open(registry, decision())!;
  await classifier.classify({ state: {}, questions: {} });
  assert.equal(classifier.breakerState(), "closed");
  assert.equal(classifier.allows(), true);

  const noBreaker = DecisionClassifier.open(registry, decision({ circuitBreakerEnabled: false }))!;
  assert.equal(noBreaker.breakerState(), undefined);
  for (let index = 0; index < 5; index += 1) await noBreaker.classify({ state: {}, questions: {} });
  assert.equal(noBreaker.allows(), true, "with the breaker off every call is admitted");
});

test("a successful call closes an open circuit", async () => {
  let now = 0;
  let stop: ClassifierResult["stopReason"] = "error";
  const registry = fakeRegistry(bools({}), { stopReason: "error", errorMessage: "deadline exceeded" });
  const original = registry.classify.bind(registry);
  registry.classify = async (model, context, options) => {
    const result = await original(model, context, options);
    return stop === "stop" ? { ...result, stopReason: "stop", errorMessage: undefined } : result;
  };
  const classifier = DecisionClassifier.open(registry, decision(), { now: () => now })!;
  await classifier.classify({ state: {}, questions: {} });
  assert.equal(classifier.breakerState(), "open");
  now = 30_000;
  stop = "stop";
  const probe = await classifier.classify({ state: {}, questions: {} });
  assert.ok(probe.ok);
  assert.equal(classifier.breakerState(), "closed");
});
