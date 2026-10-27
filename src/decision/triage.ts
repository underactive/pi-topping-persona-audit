/**
 * Triage classification: while the findings review renders, a classifier reads
 * each finding's summary, rationale and suggested change and answers three
 * questions — what kind of finding it is, what verdict a reviewer would reach,
 * and what kind of change the fix would be.
 *
 * A suggestion is advisory. It never pre-sets the Accept/Reject/Defer state:
 * the badge shows what the classifier thought, and the user decides. The
 * category feeds the review's sort keys, and the verdict and change kind are
 * read at a glance.
 *
 * Everything here is pure except `classifyFinding`, so the state, the questions
 * and the thresholds are testable without a registry.
 */

import type { ClassifierContext, JsonObject } from "@earendil-works/pi-ai";
import { choiceAnswer, type Answers, type ClassificationOutcome } from "@underactive/pi-topping-primitives/classifier";
import type { ChangeKind, Finding, FindingCategory, FindingRecommendation } from "../types.ts";
import type { DecisionClassifier } from "./classifier.ts";

/** Keep one finding's text well inside a small classifier's context. */
const MAX_FIELD_CHARS = 1_200;

/** The categories the classifier can suggest, mapped to the finding vocabulary. */
export const TRIAGE_CATEGORIES: readonly { answer: string; category: FindingCategory }[] = [
  { answer: "security", category: "security" },
  { answer: "correctness", category: "bug" },
  { answer: "performance", category: "performance" },
  { answer: "style", category: "style" },
];

/** The verdicts the classifier can suggest, mapped to the triage vocabulary. */
export const TRIAGE_VERDICTS: readonly { answer: string; verdict: FindingRecommendation }[] = [
  { answer: "accept", verdict: "apply" },
  { answer: "reject", verdict: "reject" },
  { answer: "defer", verdict: "defer" },
];

/** The change kinds the classifier can suggest, in blast-radius's order. */
export const TRIAGE_CHANGE_KINDS: readonly { answer: string; changeKind: ChangeKind }[] = [
  { answer: "signature", changeKind: "signature" },
  { answer: "behavior", changeKind: "behavior" },
  { answer: "internal", changeKind: "internal" },
  { answer: "cosmetic", changeKind: "cosmetic" },
];

/** Below this confidence a suggested category is withheld. */
export const TRIAGE_CATEGORY_MIN_CONFIDENCE = 0.5;
/** Below this confidence a suggested verdict is withheld. */
export const TRIAGE_VERDICT_MIN_CONFIDENCE = 0.6;
/** Below this confidence a suggested change kind is withheld. */
export const TRIAGE_CHANGE_KIND_MIN_CONFIDENCE = 0.5;

/** What the classifier thought of one finding. Every field is independently optional. */
export interface TriageSuggestion {
  /** The category the classifier would have filed this under, when confident. */
  category?: FindingCategory;
  categoryConfidence: number;
  /** The verdict the classifier would have reached, when confident. */
  verdict?: FindingRecommendation;
  verdictConfidence: number;
  /** The change kind the classifier expects the fix to be, when confident. */
  changeKind?: ChangeKind;
  changeKindConfidence: number;
  /** Classifier that produced the suggestion, as `provider/model-id`. */
  model: string;
  latencyMs: number;
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_FIELD_CHARS ? collapsed : `${collapsed.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

/** The finding as the classifier sees it: location, the reviewer's own words, and nothing else. */
export function buildTriageState(finding: Finding): JsonObject {
  return {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    reviewer: finding.reviewer,
    reported_category: finding.category,
    summary: truncate(finding.summary ?? finding.rationale),
    rationale: truncate(finding.rationale),
    suggested_change: truncate(finding.suggestedChange),
  };
}

export function buildTriageQuestions(): ClassifierContext["questions"] {
  return {
    category: {
      type: "choice",
      instructions:
        "Read the finding's summary, rationale and suggested change and choose the category it belongs to. " +
        "Judge the defect itself, not the wording: a security issue described calmly is still security.",
      criteria: {
        security: "A weakness an attacker could reach: injection, broken access control, exposed secrets, unsafe deserialization, or missing validation of untrusted input.",
        correctness: "The code does not do what it claims: a wrong result, a missed case, a broken invariant, a race, or a resource that is never released.",
        performance: "The code is correct but wasteful: needless work per call, quadratic behavior, unbounded growth, or repeated I/O.",
        style: "The code works and is clear enough, but reads poorly: naming, structure, duplication, or a misleading comment.",
      },
    },
    verdict: {
      type: "choice",
      instructions:
        "Choose the verdict a careful reviewer would reach for this finding on its own evidence, ignoring how it is worded. " +
        "Defer when the finding is real but the fix needs a decision or a migration this change cannot make.",
      criteria: {
        accept: "A real defect with a concrete, low-risk fix that belongs in this change.",
        reject: "Not a defect, already handled elsewhere, or contradicted by the code as written.",
        defer: "A real concern whose fix is out of scope, needs a migration, or needs a decision the reviewer cannot make here.",
      },
    },
    change_kind: {
      type: "choice",
      instructions: "Choose the smallest kind of change that would resolve this finding.",
      criteria: {
        signature: "The fix changes a function, type, or API signature that callers depend on.",
        behavior: "The fix keeps every signature but changes what the code does.",
        internal: "The fix rewrites the inside of a function with no visible change.",
        cosmetic: "The fix only moves or renames text.",
      },
    },
  };
}

/** Map the three answers into a suggestion, withholding anything below its threshold. */
export function parseTriageSuggestion(answers: Answers, model: string, latencyMs: number): TriageSuggestion {
  const suggestion: TriageSuggestion = {
    categoryConfidence: 0,
    verdictConfidence: 0,
    changeKindConfidence: 0,
    model,
    latencyMs,
  };

  const category = choiceAnswer(answers, "category");
  if (category && category.confidence >= TRIAGE_CATEGORY_MIN_CONFIDENCE) {
    const match = TRIAGE_CATEGORIES.find((entry) => entry.answer === category.choice);
    if (match) {
      suggestion.category = match.category;
      suggestion.categoryConfidence = category.confidence;
    }
  }

  const verdict = choiceAnswer(answers, "verdict");
  if (verdict && verdict.confidence >= TRIAGE_VERDICT_MIN_CONFIDENCE) {
    const match = TRIAGE_VERDICTS.find((entry) => entry.answer === verdict.choice);
    if (match) {
      suggestion.verdict = match.verdict;
      suggestion.verdictConfidence = verdict.confidence;
    }
  }

  const changeKind = choiceAnswer(answers, "change_kind");
  if (changeKind && changeKind.confidence >= TRIAGE_CHANGE_KIND_MIN_CONFIDENCE) {
    const match = TRIAGE_CHANGE_KINDS.find((entry) => entry.answer === changeKind.choice);
    if (match) {
      suggestion.changeKind = match.changeKind;
      suggestion.changeKindConfidence = changeKind.confidence;
    }
  }

  return suggestion;
}

/** Whether a suggestion carries anything worth showing. */
export function hasSuggestion(suggestion: TriageSuggestion | undefined): boolean {
  return !!suggestion && (suggestion.category !== undefined || suggestion.verdict !== undefined || suggestion.changeKind !== undefined);
}

/**
 * Classify one finding. Returns undefined when the classifier is unavailable,
 * blocked by an open circuit, or failed — the review simply shows no badge.
 */
export async function classifyFinding(
  classifier: DecisionClassifier,
  finding: Finding,
): Promise<{ suggestion: TriageSuggestion; outcome: ClassificationOutcome } | undefined> {
  if (!classifier.allows()) return undefined;
  const outcome = await classifier.classify({
    state: buildTriageState(finding),
    questions: buildTriageQuestions(),
  });
  if (!outcome.ok) return undefined;
  const suggestion = parseTriageSuggestion(outcome.answers, outcome.model, outcome.latencyMs);
  if (!hasSuggestion(suggestion)) return undefined;
  return { suggestion, outcome };
}

/** How many findings are classified at once. Enough to hide latency, few enough to be polite. */
export const TRIAGE_CONCURRENCY = 4;

/**
 * Classify every finding into the feed, at most {@link TRIAGE_CONCURRENCY} at a
 * time. Never rejects: one finding's failure costs that finding's badge and
 * nothing else. Resolves with the number of suggestions that landed.
 */
export async function classifyFindings(
  classifier: DecisionClassifier,
  findings: readonly Finding[],
  feed: TriageSuggestionFeed,
  limit: number = TRIAGE_CONCURRENCY,
): Promise<number> {
  let next = 0;
  let landed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= findings.length) return;
      const finding = findings[index];
      if (!finding) continue;
      try {
        const classified = await classifyFinding(classifier, finding);
        if (!classified) continue;
        feed.set(index, classified.suggestion);
        landed += 1;
      } catch {
        // Advisory only: a finding without a badge is the documented fallback.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, findings.length)) }, worker));
  return landed;
}

/**
 * The live suggestion map the review overlay reads while it renders.
 *
 * Classification runs beside the overlay rather than before it, so the review
 * opens immediately and badges appear as the answers land. The feed is the only
 * shared state: the overlay reads `get`, and the classifier writes `set`.
 */
export class TriageSuggestionFeed {
  readonly #byIndex = new Map<number, TriageSuggestion>();
  readonly #listeners = new Set<() => void>();

  /** The suggestion for a finding's original index, if it has landed. */
  get(index: number): TriageSuggestion | undefined {
    return this.#byIndex.get(index);
  }

  /** Record a suggestion and wake the overlay so it repaints. */
  set(index: number, suggestion: TriageSuggestion): void {
    this.#byIndex.set(index, suggestion);
    for (const listener of [...this.#listeners]) listener();
  }

  /** Subscribe to arrivals; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** How many suggestions have landed, for a run summary. */
  get size(): number {
    return this.#byIndex.size;
  }
}
