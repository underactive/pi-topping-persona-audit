import { coerceFinding, dedupFindings, isRecord, normalizeFindingText } from "./dedup.ts";
import type {
  CollectReviewerFindingsResult,
  Finding,
  MalformedReviewerOutput,
  MissingReviewerRun,
  NoFindings,
  ReviewerOutput,
} from "./types.ts";

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyOutput(output: string): string {
  const parsed = tryParseJson(output);
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
}

function candidateJsonLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));
}

function noFindings(raw: unknown, assignedReviewer: string): NoFindings | null {
  if (!isRecord(raw)) return null;
  if (raw.findings !== 0) return null;
  const reviewer = normalizeFindingText(assignedReviewer) || normalizeFindingText(raw.reviewer);
  return reviewer ? { reviewer, findings: 0 } : null;
}

function expectedMissingRuns(reviewers: string[], passes: number, outputs: ReviewerOutput[]): MissingReviewerRun[] {
  const received = new Set(
    outputs
      .filter((output) => output.reviewer && Number.isFinite(output.pass))
      .map((output) => `${output.reviewer}\u0000${output.pass}`),
  );

  const missing: MissingReviewerRun[] = [];
  for (const reviewer of reviewers) {
    for (let pass = 1; pass <= passes; pass++) {
      if (!received.has(`${reviewer}\u0000${pass}`)) {
        missing.push({ reviewer, pass });
      }
    }
  }
  return missing;
}

export function collectReviewerFindings(
  reviewers: string[],
  passes: number,
  outputs: ReviewerOutput[],
): CollectReviewerFindingsResult {
  const findings: Finding[] = [];
  const noFindingsResults: NoFindings[] = [];
  const malformed: MalformedReviewerOutput[] = [];

  outputs.forEach((source, sourceIndex) => {
    const text = stringifyOutput(source.output);
    const lines = candidateJsonLines(text);

    if (lines.length === 0) {
      malformed.push({
        reviewer: source.reviewer,
        pass: source.pass,
        sourceIndex,
        reason: "No JSON object lines found in reviewer output",
      });
      return;
    }

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        malformed.push({
          reviewer: source.reviewer,
          pass: source.pass,
          sourceIndex,
          line,
          reason: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const none = noFindings(parsed, source.reviewer);
      if (none) {
        noFindingsResults.push(none);
        continue;
      }

      const finding = coerceFinding(parsed, source.reviewer);
      if (finding) {
        findings.push(finding);
        continue;
      }

      malformed.push({
        reviewer: source.reviewer,
        pass: source.pass,
        sourceIndex,
        line,
        reason: "JSON object did not match finding or no-findings schema",
      });
    }
  });

  const deduped = dedupFindings(findings);

  return {
    findings,
    dedupedFindings: deduped.findings,
    noFindings: noFindingsResults,
    malformed,
    expectedRuns: reviewers.length * passes,
    receivedRuns: outputs.length,
    missingRuns: expectedMissingRuns(reviewers, passes, outputs),
    inputCount: deduped.inputCount,
    outputCount: deduped.outputCount,
    duplicateGroups: deduped.duplicateGroups,
  };
}

