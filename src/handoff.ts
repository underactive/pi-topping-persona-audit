/**
 * Deferred-findings handoff resume payload.
 *
 * A handoff written during triage (H key in the FindingsReview overlay) is a
 * human-readable markdown document. To make it resumable, a machine-readable
 * JSON block carrying the lossless Finding[] is appended to it — this module
 * owns that block's serialization, parsing, and validation.
 */

import { CATEGORY_PRIORITY, SEVERITY_ORDER } from "./types.ts";
import type { ChangeKind, Finding, FindingCategory, FindingSeverity } from "./types.ts";

export const HANDOFF_SCHEMA_VERSION = 1;

/** HTML-comment marker preceding the resume JSON fence, so the parser never confuses it with other fenced blocks. */
export const HANDOFF_RESUME_MARKER = "<!-- persona-audit-resume:v1 -->";

/** Machine-readable payload embedded in a deferred-findings handoff. */
export interface HandoffPayload {
  schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  writtenAt: string;
  scope: string;
  reviewers: string[];
  /** HEAD commit at handoff-write time; absent when not in a git repo. */
  headCommit?: string;
  findings: Finding[];
}

/**
 * Render the resume-data section appended to a deferred-findings handoff.
 * The JSON is serialized on one line, and the fence uses more backticks than
 * the longest backtick run inside the JSON, so content inside
 * `suggestedChange` can never close the fence.
 */
export function renderHandoffResumeBlock(payload: HandoffPayload): string {
  const findings = payload.findings.map(({ blastRadius: _blastRadius, ...finding }) => finding);
  const json = JSON.stringify({ ...payload, findings });
  const longestRun = json.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    "## Resume Data",
    "",
    "Machine-readable payload for `/persona-audit --handoff <path>`. Do not edit.",
    "",
    HANDOFF_RESUME_MARKER,
    `${fence}json`,
    json,
    fence,
    "",
  ].join("\n");
}

function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (CATEGORY_PRIORITY as readonly string[]).includes(value);
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && (SEVERITY_ORDER as readonly string[]).includes(value);
}

function isChangeKind(value: unknown): value is ChangeKind {
  return value === "signature" || value === "behavior" || value === "internal" || value === "cosmetic";
}

function validateFinding(raw: unknown, index: number): Finding {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Handoff resume data is invalid: findings[${index}] is not an object.`);
  }
  const f = raw as Record<string, unknown>;
  const fail = (reason: string): never => {
    throw new Error(`Handoff resume data is invalid: findings[${index}] ${reason}.`);
  };
  if (typeof f.reviewer !== "string" || !f.reviewer) fail("is missing a reviewer");
  if (typeof f.file !== "string" || !f.file) fail("is missing a file");
  if (typeof f.line !== "number" || !Number.isFinite(f.line)) fail("has a non-numeric line");
  if (!isFindingCategory(f.category)) fail(`has an unknown category: ${JSON.stringify(f.category)}`);
  if (!isFindingSeverity(f.severity)) fail(`has an unknown severity: ${JSON.stringify(f.severity)}`);
  if (typeof f.rationale !== "string") fail("is missing a rationale");
  if (f.summary !== undefined && (typeof f.summary !== "string" || !f.summary)) fail("has an invalid summary");
  if (typeof f.suggestedChange !== "string") fail("is missing a suggestedChange");

  const finding: Finding = {
    reviewer: f.reviewer as string,
    file: f.file as string,
    line: f.line as number,
    category: f.category as FindingCategory,
    severity: f.severity as FindingSeverity,
    rationale: f.rationale as string,
    ...(typeof f.summary === "string" && f.summary ? { summary: f.summary } : {}),
    suggestedChange: f.suggestedChange as string,
  };
  if (isChangeKind(f.changeKind)) {
    finding.changeKind = f.changeKind;
  }
  if (f.recommendation === "apply" || f.recommendation === "reject" || f.recommendation === "defer") {
    finding.recommendation = f.recommendation;
  }
  if (typeof f.recommendationReason === "string" && f.recommendationReason) {
    finding.recommendationReason = f.recommendationReason;
  }
  return finding;
}

/**
 * Parse the resume payload out of a handoff markdown document.
 * Throws a descriptive error when the marker or fence is missing, the schema
 * version is unsupported, or any finding fails validation.
 */
export function parseHandoffPayload(markdown: string): HandoffPayload {
  const markerIndex = markdown.indexOf(HANDOFF_RESUME_MARKER);
  if (markerIndex === -1) {
    throw new Error(
      "This handoff has no resume-data block — it was written by an older version of persona-audit. Re-run the audit and write a new handoff.",
    );
  }
  const afterMarker = markdown.slice(markerIndex + HANDOFF_RESUME_MARKER.length);
  const fenceMatch = /^\s*(`{3,})json\s*\n([\s\S]*?)\n\1/.exec(afterMarker);
  if (!fenceMatch) {
    throw new Error("Handoff resume data is malformed: no JSON fence follows the resume marker.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[2]!);
  } catch (error) {
    throw new Error(
      `Handoff resume data is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Handoff resume data is invalid: payload is not an object.");
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    throw new Error(
      `Handoff resume data has unsupported schema version ${JSON.stringify(payload.schemaVersion)} (expected ${HANDOFF_SCHEMA_VERSION}). Update persona-audit or re-write the handoff.`,
    );
  }
  if (!Array.isArray(payload.findings) || payload.findings.length === 0) {
    throw new Error("Handoff resume data is invalid: findings must be a non-empty array.");
  }

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    writtenAt: typeof payload.writtenAt === "string" ? payload.writtenAt : "",
    scope: typeof payload.scope === "string" ? payload.scope : ".",
    reviewers: Array.isArray(payload.reviewers)
      ? payload.reviewers.filter((r): r is string => typeof r === "string")
      : [],
    ...(typeof payload.headCommit === "string" && payload.headCommit ? { headCommit: payload.headCommit } : {}),
    findings: payload.findings.map((raw, index) => validateFinding(raw, index)),
  };
}

/** Split findings by whether their target file still exists — the staleness filter for resume. */
export function filterExistingFindings(
  findings: Finding[],
  exists: (file: string) => boolean,
): { kept: Finding[]; dropped: Finding[] } {
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const finding of findings) {
    (exists(finding.file) ? kept : dropped).push(finding);
  }
  return { kept, dropped };
}
