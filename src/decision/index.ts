/**
 * The Jev decision classifier integration: the shared classifier handle, the
 * dispatcher's fingerprint-to-reviewers path, and the triage suggestions that
 * appear as badges while the findings review renders.
 *
 * Both integrations are opt-in (`decision.enabled`, then `useForDispatcher` or
 * `useForTriage`) and both fail soft: no credentialed model, an open circuit, a
 * timeout, or an error means the phase behaves exactly as it did before the
 * feature existed.
 */

export { DecisionClassifier, type DecisionClassifierOptions, type DecisionRegistry } from "./classifier.ts";
export {
  buildDispatchQuestions,
  buildDispatchState,
  classifyDispatch,
  DISPATCH_MIN_PROBABILITY,
  expandCategories,
  type SelectedCategory,
  selectedCategories,
} from "./dispatch.ts";
export { holisticReviewerNames, REVIEWER_CATEGORIES, REVIEWER_CATEGORY_IDS, type ReviewerCategory } from "./categories.ts";
export {
  buildTriageQuestions,
  buildTriageState,
  classifyFinding,
  classifyFindings,
  hasSuggestion,
  parseTriageSuggestion,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_MIN_CONFIDENCE,
  TRIAGE_CONCURRENCY,
  TRIAGE_CHANGE_KINDS,
  TRIAGE_CHANGE_KIND_MIN_CONFIDENCE,
  TRIAGE_VERDICTS,
  TRIAGE_VERDICT_MIN_CONFIDENCE,
  type TriageSuggestion,
  TriageSuggestionFeed,
} from "./triage.ts";
