import {
  CATEGORY_PRIORITY,
  EXPLOITABILITY_ORDER,
  SEVERITY_ORDER,
  type Finding,
} from "./types.ts";

export function exploitabilityIndex(finding: Finding): number {
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
