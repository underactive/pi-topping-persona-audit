import { normalizeFindingText } from "./dedup.ts";

export const MAX_FINDING_SUMMARY_LENGTH = 360;

const REDUNDANT_PREFIX = /^(?:\[[^\]]+\]\s*|(?:security|bug|performance|maintainability|style|documentation|accessibility|reliability)(?:\s*[:#]\s*\d+)?\s*[:—-]\s*)/i;

/**
 * Produce a conservative single-line fallback when the adjudicator does not
 * provide a valid ASD-STE100 summary. It only removes redundant labels and
 * shortens at natural boundaries; it never invents a technical claim.
 */
export function fallbackSteSummary(rationale: string): string {
  const normalized = normalizeFindingText(rationale).replace(/\s+/g, " ");
  if (!normalized) return "";

  const withoutPrefix = normalized.replace(REDUNDANT_PREFIX, "").trim();
  if (!withoutPrefix) return normalized;
  const simplified = withoutPrefix
    .replace(/\butilize\b/gi, "use")
    .replace(/\bprior to\b/gi, "before")
    .replace(/\bin order to\b/gi, "to")
    .replace(/^([a-z])/, (letter) => letter.toUpperCase());
  if (simplified.length <= MAX_FINDING_SUMMARY_LENGTH) return simplified;

  const boundary = findBoundary(simplified, MAX_FINDING_SUMMARY_LENGTH);
  if (boundary > 0) return simplified.slice(0, boundary).trimEnd();
  return `${simplified.slice(0, MAX_FINDING_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function findBoundary(text: string, limit: number): number {
  const bounded = text.slice(0, limit + 1);
  const sentence = Math.max(bounded.lastIndexOf(". "), bounded.lastIndexOf("! "), bounded.lastIndexOf("? "));
  if (sentence > 0) return sentence + 1;
  const clause = Math.max(bounded.lastIndexOf("; "), bounded.lastIndexOf(", "));
  if (clause > 0) return clause + 1;
  const word = bounded.lastIndexOf(" ");
  return word > 0 ? word : 0;
}
