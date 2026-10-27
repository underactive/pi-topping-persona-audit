import assert from "node:assert/strict";
import { test } from "node:test";
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
import {
  buildTriageQuestions,
  buildTriageState,
  classifyFinding,
  classifyFindings,
  hasSuggestion,
  parseTriageSuggestion,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_MIN_CONFIDENCE,
  TRIAGE_CHANGE_KINDS,
  TRIAGE_CHANGE_KIND_MIN_CONFIDENCE,
  TRIAGE_CONCURRENCY,
  TRIAGE_VERDICTS,
  TRIAGE_VERDICT_MIN_CONFIDENCE,
  TriageSuggestionFeed,
} from "../src/decision/triage.ts";
import { DecisionClassifier, type DecisionRegistry } from "../src/decision/classifier.ts";
import { DEFAULT_DECISION_SETTINGS } from "../src/modelConfig.ts";
import type { Finding } from "../src/types.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "Security Engineer",
    file: "src/auth/login.ts",
    line: 42,
    category: "security",
    severity: "high",
    rationale: "The session token is compared with ===, so a timing attack can recover it byte by byte.",
    summary: "Session token compared with ===.",
    suggestedChange: "Use timingSafeEqual for the comparison.",
    ...overrides,
  };
}

/** A classifier whose answers are fixed, so the pure parsing paths are testable. */
function stubClassifier(answers: Record<string, unknown>): DecisionClassifier {
  const registry: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true }),
    async classify() {
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers,
        stopReason: "stop",
        timestamp: 1,
      } as never;
    },
  };
  return DecisionClassifier.open(registry, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
}

const choice = (value: string, confidence: number) =>
  ({ type: "choice", choice: value, confidence, probabilities: {} }) as const;

test("the triage state carries the finding's own words and nothing else", () => {
  const state = buildTriageState(finding());
  assert.deepEqual(state, {
    file: "src/auth/login.ts",
    line: 42,
    severity: "high",
    reviewer: "Security Engineer",
    reported_category: "security",
    summary: "Session token compared with ===.",
    rationale: "The session token is compared with ===, so a timing attack can recover it byte by byte.",
    suggested_change: "Use timingSafeEqual for the comparison.",
  });
});

test("long finding text is collapsed and capped, so one finding cannot flood the context", () => {
  const state = buildTriageState(finding({ rationale: `word\n\n${"x".repeat(5000)}` }));
  const rationale = String(state.rationale);
  assert.ok(rationale.length <= 1200);
  assert.ok(!rationale.includes("\n"));
  assert.ok(rationale.endsWith("…"));
});

test("the triage questions cover the three suggestion axes with full vocabularies", () => {
  const questions = buildTriageQuestions();
  assert.deepEqual(Object.keys(questions), ["category", "verdict", "change_kind"]);
  const category = questions.category;
  assert.ok(category && category.type === "choice");
  if (category?.type === "choice") {
    assert.deepEqual(Object.keys(category.criteria), ["security", "correctness", "performance", "style"]);
  }
  const verdict = questions.verdict;
  if (verdict?.type === "choice") assert.deepEqual(Object.keys(verdict.criteria), ["accept", "reject", "defer"]);
  const changeKind = questions.change_kind;
  if (changeKind?.type === "choice") {
    assert.deepEqual(Object.keys(changeKind.criteria), ["signature", "behavior", "internal", "cosmetic"]);
  }
});

test("the vocabularies map onto the finding and triage unions", () => {
  assert.deepEqual(TRIAGE_CATEGORIES.map((entry) => entry.category), ["security", "bug", "performance", "style"]);
  assert.deepEqual(TRIAGE_VERDICTS.map((entry) => entry.verdict), ["apply", "reject", "defer"]);
  assert.deepEqual(TRIAGE_CHANGE_KINDS.map((entry) => entry.changeKind), ["signature", "behavior", "internal", "cosmetic"]);
});

test("a confident answer becomes a suggestion, and each axis has its own threshold", () => {
  const suggestion = parseTriageSuggestion(
    {
      category: choice("correctness", TRIAGE_CATEGORY_MIN_CONFIDENCE),
      verdict: choice("defer", TRIAGE_VERDICT_MIN_CONFIDENCE),
      change_kind: choice("behavior", TRIAGE_CHANGE_KIND_MIN_CONFIDENCE),
    },
    "typesafe/jev-latest",
    120,
  );
  assert.deepEqual(suggestion, {
    category: "bug",
    categoryConfidence: TRIAGE_CATEGORY_MIN_CONFIDENCE,
    verdict: "defer",
    verdictConfidence: TRIAGE_VERDICT_MIN_CONFIDENCE,
    changeKind: "behavior",
    changeKindConfidence: TRIAGE_CHANGE_KIND_MIN_CONFIDENCE,
    model: "typesafe/jev-latest",
    latencyMs: 120,
  });
  assert.equal(hasSuggestion(suggestion), true);

  const unsure = parseTriageSuggestion(
    {
      category: choice("security", TRIAGE_CATEGORY_MIN_CONFIDENCE - 0.01),
      verdict: choice("accept", TRIAGE_VERDICT_MIN_CONFIDENCE - 0.01),
      change_kind: choice("cosmetic", TRIAGE_CHANGE_KIND_MIN_CONFIDENCE - 0.01),
    },
    "typesafe/jev-latest",
    90,
  );
  assert.equal(unsure.category, undefined);
  assert.equal(unsure.verdict, undefined);
  assert.equal(unsure.changeKind, undefined);
  assert.equal(hasSuggestion(unsure), false, "nothing cleared its threshold");
});

test("an answer outside the vocabulary is ignored rather than coerced", () => {
  const suggestion = parseTriageSuggestion(
    { category: choice("documentation", 0.99), verdict: choice("accept", 0.99), change_kind: choice("huge", 0.99) },
    "typesafe/jev-latest",
    10,
  );
  assert.equal(suggestion.category, undefined, "the four-category vocabulary has no documentation");
  assert.equal(suggestion.verdict, "apply");
  assert.equal(suggestion.changeKind, undefined);
});

test("classifyFinding returns undefined on failure and a suggestion on success", async () => {
  const ok = await classifyFinding(stubClassifier({ category: choice("security", 0.9), verdict: choice("accept", 0.8) }), finding());
  assert.equal(ok?.suggestion.category, "security");
  assert.equal(ok?.suggestion.verdict, "apply");
  assert.equal(ok?.outcome.latencyMs, 0);

  const registry: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true }),
    async classify() {
      return { stopReason: "error", errorMessage: "500" } as never;
    },
  };
  const failing = DecisionClassifier.open(registry, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
  assert.equal(await classifyFinding(failing, finding()), undefined);
});

test("classifyFindings fills the feed for every finding at bounded concurrency and never rejects", async () => {
  const findings = [finding(), finding({ file: "src/b.ts" }), finding({ file: "src/c.ts" })];
  const feed = new TriageSuggestionFeed();
  const seen: number[] = [];
  const listener = feed.subscribe(() => seen.push(feed.size));
  const classifier = stubClassifier({ category: choice("security", 0.9), verdict: choice("accept", 0.8) });
  const landed = await classifyFindings(classifier, findings, feed);
  assert.equal(landed, 3);
  assert.equal(feed.size, 3);
  assert.equal(feed.get(1)?.verdict, "apply");
  assert.equal(feed.get(99), undefined);
  assert.ok(seen.length >= 3, "every arrival notified the subscriber");
  listener();

  const throwing: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true }),
    async classify(): Promise<never> {
      throw new Error("socket hang up");
    },
  };
  const failing = DecisionClassifier.open(throwing, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
  const emptyFeed = new TriageSuggestionFeed();
  assert.equal(await classifyFindings(failing, findings, emptyFeed), 0, "a failing classifier leaves the feed empty");
  assert.equal(emptyFeed.size, 0);
  assert.equal(TRIAGE_CONCURRENCY, 4);
});

test("the feed stops notifying once a listener unsubscribes", () => {
  const feed = new TriageSuggestionFeed();
  let calls = 0;
  const unsubscribe = feed.subscribe(() => {
    calls += 1;
  });
  feed.set(0, {
    categoryConfidence: 0,
    verdictConfidence: 0,
    changeKindConfidence: 0,
    model: "typesafe/jev-latest",
    latencyMs: 1,
  });
  assert.equal(calls, 1);
  unsubscribe();
  feed.set(1, {
    categoryConfidence: 0,
    verdictConfidence: 0,
    changeKindConfidence: 0,
    model: "typesafe/jev-latest",
    latencyMs: 1,
  });
  assert.equal(calls, 1);
  assert.equal(feed.size, 2, "the map keeps the suggestions after the last listener leaves");
});
