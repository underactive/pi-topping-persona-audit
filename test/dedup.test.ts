import assert from "node:assert/strict";
import test from "node:test";

import { dedupFindings } from "../src/dedup.ts";

test("collapses findings with same file, line, and category", () => {
  const result = dedupFindings([
    {
      reviewer: "Security Engineer",
      file: "src/index.ts",
      line: 42,
      category: "bug",
      severity: "medium",
      rationale: "Short reason",
      suggestedChange: "Fix it",
    },
    {
      reviewer: "Backend Engineer",
      file: "src/index.ts",
      line: 42,
      category: "bug",
      severity: "high",
      rationale: "Longer and clearer reason",
      suggestedChange: "Fix it with a more concrete guard",
    },
  ]);

  assert.equal(result.inputCount, 2);
  assert.equal(result.outputCount, 1);
  assert.equal(result.duplicateGroups, 1);
  assert.equal(result.findings[0]?.reviewer, "Security Engineer, Backend Engineer");
  assert.equal(result.findings[0]?.severity, "high");
  assert.equal(result.findings[0]?.rationale, "Longer and clearer reason");
  assert.equal(result.findings[0]?.suggestedChange, "Fix it with a more concrete guard");
});

test("preserves complete rationale text for review display", () => {
  const rationale = "Completely wrong: resolveSynthesizerFailure recursing into itself on undefined is a stack-bomb for callers";
  const result = dedupFindings([baseFinding({ rationale })]);

  assert.equal(result.findings[0]?.rationale, rationale);
});

test("keeps distinct file, line, or category findings separate", () => {
  const result = dedupFindings([
    baseFinding({ line: 1, category: "bug" }),
    baseFinding({ line: 2, category: "bug" }),
    baseFinding({ line: 1, category: "security" }),
    baseFinding({ file: "src/other.ts", line: 1, category: "bug" }),
  ]);

  assert.equal(result.outputCount, 4);
  assert.equal(result.duplicateGroups, 0);
});

test("rejects invalid lines and keeps valid findings separate", () => {
  const result = dedupFindings([
    baseFinding({ file: " src/index.ts ", line: "not-a-number", category: "BUG" }),
    baseFinding({ file: "src/index.ts", line: -1, category: "bug", reviewer: "Principal Engineer" }),
  ]);

  assert.equal(result.inputCount, 1);
  assert.equal(result.outputCount, 1);
  assert.equal(result.findings[0]?.file, "src/index.ts");
  assert.equal(result.findings[0]?.line, -1);
  assert.equal(result.findings[0]?.category, "bug");
  assert.equal(result.findings[0]?.reviewer, "Principal Engineer");
});

test("skips no-findings sentinels and malformed findings", () => {
  const result = dedupFindings([
    { reviewer: "Security Engineer", findings: 0 },
    { reviewer: "Missing Required Fields" },
    baseFinding({}),
  ]);

  assert.equal(result.inputCount, 1);
  assert.equal(result.outputCount, 1);
});

test("sorts output deterministically", () => {
  const result = dedupFindings([
    baseFinding({ file: "src/b.ts", line: 10, category: "style", severity: "low" }),
    baseFinding({ file: "src/a.ts", line: 2, category: "style", severity: "low" }),
    baseFinding({ file: "src/a.ts", line: 1, category: "bug", severity: "medium" }),
    baseFinding({ file: "src/a.ts", line: 1, category: "security", severity: "high" }),
  ]);

  assert.deepEqual(
    result.findings.map((finding) => `${finding.file}:${finding.line}:${finding.category}`),
    ["src/a.ts:1:security", "src/a.ts:1:bug", "src/a.ts:2:style", "src/b.ts:10:style"],
  );
});

function baseFinding(overrides: Record<string, unknown>) {
  return {
    reviewer: "Testing Engineer",
    file: "src/index.ts",
    line: 1,
    category: "bug",
    severity: "medium",
    rationale: "A test rationale",
    suggestedChange: "A suggested change",
    ...overrides,
  };
}
