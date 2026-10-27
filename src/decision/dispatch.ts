/**
 * Dispatcher classification: the deterministic fingerprint goes in, reviewer
 * categories come back, and the categories expand to exact catalogue names.
 *
 * The classifier is not agentic — it cannot read the repository — so it never
 * replaces the fingerprint. It replaces the *agent session* that read the
 * fingerprint and named reviewers, which is where the cost was.
 *
 * Everything here is pure except `classifyDispatch`, so the prompt, the state
 * and the expansion are all testable without a registry.
 *
 * The import of `DISPATCHER_MAX` from `../dispatcher.ts` closes a deliberate
 * cycle — the dispatcher calls back into this module — and is safe because the
 * constant is only read inside a function body, never while either module is
 * still evaluating. Both load orders are covered by tests.
 */

import type { ClassifierContext, JsonObject } from "@earendil-works/pi-ai";
import { boolAnswer, type Answers, type ClassificationOutcome } from "@underactive/pi-topping-primitives/classifier";
import { DISPATCHER_MAX, type DispatcherEntry, type RepoFingerprint } from "../dispatcher.ts";
import { REVIEWER_CATEGORIES, holisticReviewerNames } from "./categories.ts";
import { TIERS } from "../components/ReviewerData.ts";
import type { DecisionClassifier } from "./classifier.ts";

/** A category the classifier answered yes to, with the probability it gave. */
export interface SelectedCategory {
  id: string;
  label: string;
  probability: number;
}

/** Below this probability a category's yes is treated as a no. */
export const DISPATCH_MIN_PROBABILITY = 0.5;

/**
 * The fingerprint summary the classifier sees. `sampleFiles` is deliberately
 * absent: the summary carries the signal, and 200 paths would spend the
 * classifier's context on names it cannot act on.
 */
export function buildDispatchState(
  fingerprint: RepoFingerprint,
  opts: { mode: "diff" | "full"; scope: string },
): JsonObject {
  return {
    audit_mode: opts.mode,
    scope: opts.scope,
    file_count: fingerprint.totalFiles,
    languages: fingerprint.languages.map((entry) => `${entry.language}: ${entry.files} files`),
    manifests: fingerprint.manifests,
    frameworks: fingerprint.frameworks,
    signals: fingerprint.signals,
    auth_evidence: fingerprint.authEvidence,
  };
}

/** One yes/no question per category, each judged from the fingerprint alone. */
export function buildDispatchQuestions(): ClassifierContext["questions"] {
  const questions: ClassifierContext["questions"] = {};
  for (const category of REVIEWER_CATEGORIES) {
    questions[category.id] = {
      type: "bool",
      instructions:
        "Answer true when this category's reviewers would add coverage the others would miss, judged from the fingerprint alone.",
      criteria: {
        true: category.criteria,
        false: "Not applicable: the fingerprint shows nothing this category covers.",
      },
    };
  }
  return questions;
}

/** The categories whose yes cleared the threshold, strongest first. */
export function selectedCategories(
  answers: Answers,
  minProbability: number = DISPATCH_MIN_PROBABILITY,
): SelectedCategory[] {
  const selected: SelectedCategory[] = [];
  for (const category of REVIEWER_CATEGORIES) {
    const answer = boolAnswer(answers, category.id);
    if (!answer || answer.probability < minProbability) continue;
    selected.push({ id: category.id, label: category.label, probability: answer.probability });
  }
  return selected.sort((left, right) => right.probability - left.probability || left.id.localeCompare(right.id));
}

/**
 * Expand categories into catalogue entries: each category's reviewers in
 * catalogue order, deduplicated across categories, capped at the dispatcher's
 * maximum, and guaranteed at least one holistic reviewer.
 *
 * Returns fewer than the dispatcher's minimum when the classifier said yes to
 * too little; the caller treats that as a classification failure and falls back
 * to the agent session rather than padding the roster.
 */
export function expandCategories(selected: readonly SelectedCategory[]): DispatcherEntry[] {
  const holistic = new Set(holisticReviewerNames(TIERS));
  const byId = new Map(REVIEWER_CATEGORIES.map((category) => [category.id, category]));
  const entries: DispatcherEntry[] = [];
  const seen = new Set<string>();

  const add = (reviewer: string, reason: string): void => {
    if (entries.length >= DISPATCHER_MAX || seen.has(reviewer)) return;
    seen.add(reviewer);
    entries.push({ reviewer, reason });
  };

  for (const category of selected) {
    const match = byId.get(category.id);
    if (!match) continue;
    const reason = `classifier matched ${category.label} (confidence ${category.probability.toFixed(2)})`;
    for (const reviewer of match.reviewers) add(reviewer, reason);
  }

  // The agent dispatcher always included a holistic reviewer; the classifier
  // path holds the same invariant so a narrow fingerprint cannot produce a
  // roster of specialists with nobody looking at the whole.
  if (entries.length > 0 && !entries.some((entry) => holistic.has(entry.reviewer))) {
    const anchor = holisticReviewerNames(TIERS)[0];
    if (anchor) entries.unshift({ reviewer: anchor, reason: "at least one holistic reviewer is always included" });
  }

  return entries.slice(0, DISPATCHER_MAX);
}

/**
 * Classify the fingerprint into reviewer categories and expand them.
 * Returns undefined on any failure — timeout, error, abort, or too few
 * reviewers — so the caller falls back to the agent dispatcher.
 */
export async function classifyDispatch(
  classifier: DecisionClassifier,
  fingerprint: RepoFingerprint,
  opts: { mode: "diff" | "full"; scope: string },
  minReviewers: number,
): Promise<{ entries: DispatcherEntry[]; outcome: ClassificationOutcome } | undefined> {
  if (!classifier.allows()) return undefined;
  const outcome = await classifier.classify({
    state: buildDispatchState(fingerprint, opts),
    questions: buildDispatchQuestions(),
  });
  if (!outcome.ok) return undefined;
  const entries = expandCategories(selectedCategories(outcome.answers));
  if (entries.length < minReviewers) return undefined;
  return { entries, outcome };
}
