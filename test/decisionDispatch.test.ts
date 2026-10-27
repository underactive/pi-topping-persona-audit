import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierContext } from "@earendil-works/pi-ai";
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
  buildDispatchQuestions,
  buildDispatchState,
  classifyDispatch,
  DISPATCH_MIN_PROBABILITY,
  expandCategories,
  selectedCategories,
} from "../src/decision/dispatch.ts";
import { REVIEWER_CATEGORIES, REVIEWER_CATEGORY_IDS, holisticReviewerNames } from "../src/decision/categories.ts";
import { DecisionClassifier, type DecisionRegistry } from "../src/decision/classifier.ts";
import { DEFAULT_DECISION_SETTINGS } from "../src/modelConfig.ts";
import { DISPATCHER_MAX, DISPATCHER_MIN, type DispatcherEntry, type RepoFingerprint } from "../src/dispatcher.ts";
import { TIERS } from "../src/components/ReviewerData.ts";

const CATALOGUE_NAMES = new Set(TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => reviewer.name)));

const fingerprint: RepoFingerprint = {
  languages: [
    { language: "TypeScript", files: 30 },
    { language: "Python", files: 4 },
  ],
  manifests: ["package.json", "Dockerfile", ".github/workflows"],
  frameworks: ["express", "passport", "vitest"],
  signals: ["auth", "ci", "containers", "database", "tests"],
  authEvidence: ["passport", "src/auth/login.ts"],
  sampleFiles: ["src/index.ts"],
  totalFiles: 42,
};

/** A classifier whose answers are fixed, for the pure expansion and fallback tests. */
function stubClassifier(answers: Record<string, number>): DecisionClassifier {
  const registry: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
    async classify() {
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, probability]) => [key, { type: "bool", probability }]),
        ) as never,
        stopReason: "stop",
        timestamp: 1,
      };
    },
  };
  return DecisionClassifier.open(registry, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
}

test("every category names catalogue reviewers, and every catalogue name is reachable", () => {
  for (const category of REVIEWER_CATEGORIES) {
    assert.ok(category.reviewers.length > 0, `${category.id} has no reviewers`);
    for (const reviewer of category.reviewers) {
      assert.ok(CATALOGUE_NAMES.has(reviewer), `${category.id} names unknown reviewer ${reviewer}`);
    }
  }
  const reachable = new Set(REVIEWER_CATEGORIES.flatMap((category) => category.reviewers));
  const missing = [...CATALOGUE_NAMES].filter((name) => !reachable.has(name));
  assert.deepEqual(missing, [], "every catalogue reviewer is reachable from some category");
  assert.equal(new Set(REVIEWER_CATEGORY_IDS).size, REVIEWER_CATEGORY_IDS.length, "category ids are unique");
});

test("holisticReviewerNames reads the catalogue's holistic tier", () => {
  const names = holisticReviewerNames(TIERS);
  assert.ok(names.includes("Principal Engineer"));
  assert.ok(!names.includes("Security Engineer"));
});

test("the dispatch state carries the fingerprint summary and omits the sample files", () => {
  const state = buildDispatchState(fingerprint, { mode: "diff", scope: "src" });
  assert.deepEqual(state, {
    audit_mode: "diff",
    scope: "src",
    file_count: 42,
    languages: ["TypeScript: 30 files", "Python: 4 files"],
    manifests: ["package.json", "Dockerfile", ".github/workflows"],
    frameworks: ["express", "passport", "vitest"],
    signals: ["auth", "ci", "containers", "database", "tests"],
    auth_evidence: ["passport", "src/auth/login.ts"],
  });
  assert.ok(!JSON.stringify(state).includes("src/index.ts"), "sample files stay out of the classifier's context");
});

test("the dispatch questions are one bool per category, each with both criteria", () => {
  const questions = buildDispatchQuestions();
  assert.deepEqual(Object.keys(questions), [...REVIEWER_CATEGORY_IDS]);
  for (const category of REVIEWER_CATEGORIES) {
    const question = questions[category.id];
    assert.ok(question && question.type === "bool");
    if (question?.type !== "bool") continue;
    assert.equal(question.criteria.true, category.criteria);
    assert.ok(question.criteria.false.length > 0);
    assert.ok(question.instructions.length > 0);
  }
});

test("selectedCategories keeps the answers above the threshold, strongest first", () => {
  const selected = selectedCategories({
    architecture: { type: "bool", probability: 0.8 },
    security: { type: "bool", probability: 0.95 },
    auth: { type: "bool", probability: 0.49 },
    native: { type: "bool", probability: 0.5 },
    docs: { type: "choice", choice: "yes", confidence: 1, probabilities: {} },
  });
  assert.deepEqual(selected.map((entry) => entry.id), ["security", "architecture", "native"]);
  assert.equal(selected[0]?.probability, 0.95);
  assert.equal(DISPATCH_MIN_PROBABILITY, 0.5);
});

test("expansion dedupes across categories, caps at the maximum, and guarantees a holistic reviewer", () => {
  const entries = expandCategories([
    { id: "security", label: "security", probability: 0.9 },
    { id: "auth", label: "auth", probability: 0.8 },
    { id: "architecture", label: "architecture", probability: 0.7 },
  ]);
  const reviewers = entries.map((entry) => entry.reviewer);
  assert.equal(new Set(reviewers).size, reviewers.length, "no reviewer appears twice");
  assert.ok(reviewers.length <= DISPATCHER_MAX);
  // Principal Engineer arrives from architecture, so no anchor is prepended.
  assert.ok(reviewers.includes("Principal Engineer"));
  assert.match(entries[0]!.reason, /classifier matched security \(confidence 0\.90\)/);

  const specialistsOnly = expandCategories([{ id: "cryptography", label: "crypto", probability: 0.9 }]);
  assert.deepEqual(specialistsOnly.map((entry) => entry.reviewer), [
    "Principal Engineer",
    "Cryptography & Protocol Specialist",
  ]);
  assert.match(specialistsOnly[0]!.reason, /at least one holistic reviewer/);

  // A category answering yes to everything still cannot exceed the cap.
  const everything = expandCategories(
    REVIEWER_CATEGORIES.map((category) => ({ id: category.id, label: category.label, probability: 1 })),
  );
  assert.equal(everything.length, DISPATCHER_MAX);
  assert.equal(new Set(everything.map((entry) => entry.reviewer)).size, DISPATCHER_MAX);
});

test("classifyDispatch expands the classifier's answers and reports the outcome", async () => {
  const classifier = stubClassifier({ architecture: 0.9, security: 0.8, docs: 0.1 });
  const classified = await classifyDispatch(classifier, fingerprint, { mode: "diff", scope: "src" }, DISPATCHER_MIN);
  assert.ok(classified);
  const reviewers = classified!.entries.map((entry: DispatcherEntry) => entry.reviewer);
  assert.ok(reviewers.includes("Principal Engineer"));
  assert.ok(reviewers.includes("Security Engineer"));
  assert.ok(!reviewers.includes("Documentation Writer"), "a 0.1 answer is a no");
  assert.equal(classified!.outcome.model, "typesafe/jev-latest");
});

test("classifyDispatch returns undefined when the classifier says yes to too little", async () => {
  const classifier = stubClassifier({ cryptography: 0.9 });
  const classified = await classifyDispatch(classifier, fingerprint, { mode: "diff", scope: "src" }, DISPATCHER_MIN);
  // One category expands to two reviewers (a specialist plus the holistic
  // anchor), which is under the dispatcher's minimum of three, so the caller
  // falls back to the agent session.
  assert.equal(classified, undefined);
});

test("classifyDispatch returns undefined when the classifier fails", async () => {
  const registry: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true }),
    async classify(): Promise<never> {
      throw new Error("socket hang up");
    },
  };
  const classifier = DecisionClassifier.open(registry, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
  assert.equal(await classifyDispatch(classifier, fingerprint, { mode: "full", scope: "." }, DISPATCHER_MIN), undefined);
});

test("classifyDispatch sends the summary state and one question per category", async () => {
  const contexts: ClassifierContext[] = [];
  const registry: DecisionRegistry = {
    findOfType: (_type, provider, id) => (provider === "typesafe" ? { ...jevModel, provider, id } : undefined),
    getProviderAuthStatus: () => ({ configured: true }),
    async classify(_model, context) {
      contexts.push(context);
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-latest",
        answers: { architecture: { type: "bool", probability: 0.9 } },
        stopReason: "stop",
        timestamp: 1,
      } as never;
    },
  };
  const classifier = DecisionClassifier.open(registry, { ...DEFAULT_DECISION_SETTINGS, enabled: true })!;
  await classifyDispatch(classifier, fingerprint, { mode: "diff", scope: "src" }, DISPATCHER_MIN);
  assert.equal(contexts.length, 1);
  assert.deepEqual(Object.keys(contexts[0]!.questions), [...REVIEWER_CATEGORY_IDS]);
  assert.equal(contexts[0]!.state.file_count, 42);
});
