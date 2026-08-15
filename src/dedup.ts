import {
  CATEGORY_PRIORITY,
  SEVERITY_ORDER,
  type DedupFindingsResult,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
} from "./types.ts";

function priorityIndex<T extends readonly string[]>(values: T, value: string): number {
  const index = values.indexOf(value as T[number]);
  return index === -1 ? values.length : index;
}

function highestSeverity(a: string, b: string): FindingSeverity {
  return priorityIndex(SEVERITY_ORDER, b) < priorityIndex(SEVERITY_ORDER, a)
    ? b as FindingSeverity
    : a as FindingSeverity;
}

function clearerText(current: string, candidate: string, maxLength?: number): string {
  const trimmed = candidate.trim();
  if (!trimmed) return current;
  const bounded = maxLength ? trimmed.slice(0, maxLength) : trimmed;
  if (!current) return bounded;
  return bounded.length > current.length ? bounded : current;
}

export function normalizeFindingText(value: unknown, maxLength?: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!normalized) return "";
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

/** Like normalizeFindingText, but preserves line structure for document-sized markdown blocks. */
export function normalizeMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function coerceFinding(raw: unknown, assignedReviewer?: string): Finding | null {
  if (!isRecord(raw)) return null;
  if (raw.findings === 0) return null;

  // The assigned persona is ground truth; self-reported names are hallucination-prone.
  const reviewer = normalizeFindingText(assignedReviewer) || normalizeFindingText(raw.reviewer);
  const file = normalizeFindingText(raw.file);
  const category = normalizeFindingText(raw.category).toLowerCase();
  const severity = normalizeFindingText(raw.severity).toLowerCase();
  const rationale = normalizeFindingText(raw.rationale, 100);
  const suggestedChange = normalizeFindingText(raw.suggestedChange, 2000);

  if (!reviewer || !file || !rationale || !suggestedChange) {
    return null;
  }

  if (priorityIndex(CATEGORY_PRIORITY, category) === CATEGORY_PRIORITY.length) return null;
  if (priorityIndex(SEVERITY_ORDER, severity) === SEVERITY_ORDER.length) return null;

  const numericLine = typeof raw.line === "number" ? raw.line : Number(raw.line);
  if (!Number.isInteger(numericLine) || (numericLine !== -1 && numericLine <= 0)) return null;

  return {
    reviewer,
    file,
    line: numericLine,
    category: category as FindingCategory,
    severity: severity as FindingSeverity,
    rationale,
    suggestedChange,
  };
}

interface Group {
  finding: Finding;
  reviewerSet: Set<string>;
  count: number;
}

export function dedupFindings(rawFindings: unknown[]): DedupFindingsResult {
  const groups = new Map<string, Group>();
  let inputCount = 0;

  for (const raw of rawFindings) {
    const finding = coerceFinding(raw);
    if (!finding) continue;
    inputCount++;

    const key = `${finding.file}\u0000${finding.line}\u0000${finding.category}`;
    const group = groups.get(key);

    if (!group) {
      groups.set(key, {
        finding: { ...finding },
        reviewerSet: new Set([finding.reviewer]),
        count: 1,
      });
      continue;
    }

    group.count++;
    group.reviewerSet.add(finding.reviewer);

    group.finding.severity = highestSeverity(group.finding.severity, finding.severity);
    group.finding.rationale = clearerText(group.finding.rationale, finding.rationale, 100);
    group.finding.suggestedChange = clearerText(group.finding.suggestedChange, finding.suggestedChange);
  }

  const findings = [...groups.values()]
    .map((group) => ({ ...group.finding, reviewer: [...group.reviewerSet].join(", ") }))
    .sort((a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      priorityIndex(CATEGORY_PRIORITY, a.category) - priorityIndex(CATEGORY_PRIORITY, b.category) ||
      priorityIndex(SEVERITY_ORDER, a.severity) - priorityIndex(SEVERITY_ORDER, b.severity)
    );

  return {
    findings,
    inputCount,
    outputCount: findings.length,
    duplicateGroups: [...groups.values()].filter((group) => group.count > 1).length,
  };
}
