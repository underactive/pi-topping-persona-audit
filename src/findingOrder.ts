import {
  CATEGORY_PRIORITY,
  EXPLOITABILITY_ORDER,
  SEVERITY_ORDER,
  type Finding,
  type FindingRecommendation,
} from "./types.ts";

function exploitabilityIndex(finding: Finding): number {
  return finding.exploitability
    ? EXPLOITABILITY_ORDER.indexOf(finding.exploitability)
    : EXPLOITABILITY_ORDER.length;
}

export function compareFindingsByExploitability(a: Finding, b: Finding): number {
  return (
    exploitabilityIndex(a) - exploitabilityIndex(b) ||
    CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category) ||
    SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );
}

/** Verdict rank for a classifier suggestion: accept first, defer second, reject last. */
const SUGGESTED_VERDICTS: FindingRecommendation[] = ["apply", "defer", "reject"];

/** A finding with no suggested verdict sorts after every finding that has one. */
function suggestedVerdictIndex(finding: Finding): number {
  return finding.triageSuggestion?.verdict
    ? SUGGESTED_VERDICTS.indexOf(finding.triageSuggestion.verdict)
    : SUGGESTED_VERDICTS.length;
}

/** A finding with no suggested category sorts after every finding that has one. */
function suggestedCategoryIndex(finding: Finding): number {
  const category = finding.triageSuggestion?.category;
  return category ? CATEGORY_PRIORITY.indexOf(category) : CATEGORY_PRIORITY.length;
}

/**
 * Order findings by what the decision classifier suggested: the verdict it would
 * reach, then the category it would file the finding under, then how sure it
 * was. Findings it said nothing about fall to the exploitability order, so the
 * sort degrades to today's behavior when no classifier is configured.
 */
export function compareFindingsBySuggestion(a: Finding, b: Finding): number {
  return (
    suggestedVerdictIndex(a) - suggestedVerdictIndex(b) ||
    (b.triageSuggestion?.verdictConfidence ?? 0) - (a.triageSuggestion?.verdictConfidence ?? 0) ||
    suggestedCategoryIndex(a) - suggestedCategoryIndex(b) ||
    (b.triageSuggestion?.categoryConfidence ?? 0) - (a.triageSuggestion?.categoryConfidence ?? 0) ||
    compareFindingsByExploitability(a, b)
  );
}
