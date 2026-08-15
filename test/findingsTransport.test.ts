import assert from "node:assert/strict";
import test from "node:test";

import { collectReviewerFindings } from "../src/findingsTransport.ts";

const reviewers = ["Testing Engineer", "Security Engineer"];

const finding = {
  reviewer: "Testing Engineer",
  file: "src/index.ts",
  line: 12,
  category: "bug",
  severity: "medium",
  rationale: "A concise rationale",
  suggestedChange: "Guard the missing case",
};

test("parses valid reviewer JSON-lines findings", () => {
  const result = collectReviewerFindings(["Testing Engineer"], 1, [
    { reviewer: "Testing Engineer", pass: 1, output: JSON.stringify(finding) },
  ]);

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.dedupedFindings, result.findings);
  assert.equal(result.expectedRuns, 1);
  assert.equal(result.receivedRuns, 1);
  assert.deepEqual(result.missingRuns, []);
  assert.deepEqual(result.malformed, []);
});

test("stamps the assigned reviewer over a self-reported name", () => {
  const result = collectReviewerFindings(["Security Engineer"], 1, [
    {
      reviewer: "Security Engineer",
      pass: 1,
      output: JSON.stringify({ ...finding, reviewer: "General Code Reviewer" }),
    },
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.reviewer, "Security Engineer");
});

test("accepts findings that omit the self-reported reviewer field", () => {
  const { reviewer: _dropped, ...withoutReviewer } = finding;
  const result = collectReviewerFindings(["Security Engineer"], 1, [
    { reviewer: "Security Engineer", pass: 1, output: JSON.stringify(withoutReviewer) },
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.reviewer, "Security Engineer");
  assert.deepEqual(result.malformed, []);
});

test("stamps the assigned reviewer on no-findings sentinels", () => {
  const result = collectReviewerFindings(["Security Engineer"], 1, [
    { reviewer: "Security Engineer", pass: 1, output: '{"reviewer":"Claude Code Reviewer","findings":0}' },
  ]);

  assert.deepEqual(result.noFindings, [{ reviewer: "Security Engineer", findings: 0 }]);
});

test("records no-findings sentinels without adding findings", () => {
  const result = collectReviewerFindings(["Testing Engineer"], 1, [
    { reviewer: "Testing Engineer", pass: 1, output: '{"reviewer":"Testing Engineer","findings":0}' },
  ]);

  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.noFindings, [{ reviewer: "Testing Engineer", findings: 0 }]);
  assert.equal(result.outputCount, 0);
});

test("extracts JSON object lines from prose and fenced output", () => {
  const result = collectReviewerFindings(["Testing Engineer"], 1, [
    {
      reviewer: "Testing Engineer",
      pass: 1,
      output: [
        "Here are the findings:",
        "```json",
        JSON.stringify(finding),
        "```",
        "Done.",
      ].join("\n"),
    },
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.file, "src/index.ts");
  assert.deepEqual(result.malformed, []);
});

test("reports malformed JSON lines but keeps valid neighboring findings", () => {
  const result = collectReviewerFindings(["Testing Engineer"], 1, [
    {
      reviewer: "Testing Engineer",
      pass: 1,
      output: [`{bad json}`, JSON.stringify(finding)].join("\n"),
    },
  ]);

  assert.equal(result.findings.length, 1);
  assert.equal(result.malformed.length, 1);
  assert.match(result.malformed[0]?.reason ?? "", /Invalid JSON/);
});

test("reports missing expected reviewer passes", () => {
  const result = collectReviewerFindings(reviewers, 2, [
    { reviewer: "Testing Engineer", pass: 1, output: JSON.stringify(finding) },
    { reviewer: "Security Engineer", pass: 2, output: '{"reviewer":"Security Engineer","findings":0}' },
  ]);

  assert.equal(result.expectedRuns, 4);
  assert.equal(result.receivedRuns, 2);
  assert.deepEqual(result.missingRuns, [
    { reviewer: "Testing Engineer", pass: 2 },
    { reviewer: "Security Engineer", pass: 1 },
  ]);
});

test("deduplicates parsed findings through transport result", () => {
  const result = collectReviewerFindings(["Testing Engineer", "Security Engineer"], 1, [
    { reviewer: "Testing Engineer", pass: 1, output: JSON.stringify(finding) },
    {
      reviewer: "Security Engineer",
      pass: 1,
      output: JSON.stringify({ ...finding, reviewer: "Security Engineer", severity: "high" }),
    },
  ]);

  assert.equal(result.findings.length, 2);
  assert.equal(result.dedupedFindings.length, 1);
  assert.equal(result.duplicateGroups, 1);
  assert.equal(result.dedupedFindings[0]?.reviewer, "Testing Engineer, Security Engineer");
  assert.equal(result.dedupedFindings[0]?.severity, "high");
});
