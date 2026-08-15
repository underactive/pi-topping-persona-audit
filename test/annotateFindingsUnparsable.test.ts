import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateFindings } from "../src/orchestrator.ts";
import type { Finding } from "../src/types.ts";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "unsanitized input reaches exec",
  suggestedChange: "escape the argument",
  ...overrides,
});

test("annotateFindings defaults every finding to defer when adjudicator output is unparsable", () => {
  const base = [
    finding(),
    finding({ file: "src/b.ts", line: 3, category: "bug" }),
    finding({ file: "src/c.ts", line: 7, category: "performance" }),
  ];

  const { findings, note } = annotateFindings(base, ["the adjudicator rambled instead"]);

  for (const f of findings) {
    assert.equal(f.recommendation, "defer", `expected defer for ${f.file}:${f.line} ${f.category}`);
  }
  assert.ok(note?.includes("unparsable"));
});

test("annotateFindings defaults every finding to defer when all texts are empty", () => {
  const base = [finding()];

  const { findings } = annotateFindings(base, ["", "  ", ""]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.recommendation, "defer");
});

test("annotateFindings preserves original fields when defaulting to defer on unparsable output", () => {
  const base = [finding({ file: "src/x.ts", line: 42, category: "bug", severity: "critical" })];

  const { findings } = annotateFindings(base, ["no json here"]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/x.ts");
  assert.equal(findings[0]?.line, 42);
  assert.equal(findings[0]?.category, "bug");
  assert.equal(findings[0]?.severity, "critical");
  assert.equal(findings[0]?.recommendation, "defer");
});
