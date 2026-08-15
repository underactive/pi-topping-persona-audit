import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyRevoicedFindings, selectRevoiceTargets } from "../src/orchestrator.ts";
import type { Finding } from "../src/types.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "Linus Torvalds",
    file: "src/a.ts",
    line: 10,
    category: "bug",
    severity: "high",
    rationale: "original rationale",
    suggestedChange: "original suggested change",
    ...overrides,
  };
}

test("selectRevoiceTargets gates on hot temperament and Linus membership", () => {
  const findings = [
    finding(),
    finding({ reviewer: "Julia Evans", file: "src/b.ts" }),
    finding({ reviewer: "Julia Evans, Linus Torvalds", file: "src/c.ts" }),
  ];

  assert.deepEqual(selectRevoiceTargets(findings, undefined), []);
  assert.deepEqual(selectRevoiceTargets(findings, "calibrated"), []);

  const targets = selectRevoiceTargets(findings, "lkml");
  assert.deepEqual(targets.map((t) => t.index), [0, 2]);
  assert.equal(targets[1]!.finding.file, "src/c.ts");
});

test("applyRevoicedFindings merges voice fields by index and freezes the rest", () => {
  const base = [finding(), finding({ file: "src/b.ts", line: 20 })];
  const output = JSON.stringify([
    { index: 0, rationale: "This is garbage. NAK.", suggestedChange: "Fix the data.", severity: "critical", file: "evil.ts" },
  ]);

  const { findings, matched, note } = applyRevoicedFindings(base, [0, 1], [output]);
  assert.equal(matched, 1);
  assert.equal(findings[0]!.rationale, "This is garbage. NAK.");
  assert.equal(findings[0]!.suggestedChange, "Fix the data.");
  assert.equal(findings[0]!.severity, "high");
  assert.equal(findings[0]!.file, "src/a.ts");
  assert.equal(findings[1]!.rationale, "original rationale");
  assert.match(note!, /1\/2 findings/);
});

test("applyRevoicedFindings keeps originals on unparsable output", () => {
  const base = [finding()];
  const { findings, matched, note } = applyRevoicedFindings(base, [0], ["the model rambled instead"]);
  assert.equal(matched, 0);
  assert.deepEqual(findings, base);
  assert.match(note!, /unparsable/);
});

test("applyRevoicedFindings rejects out-of-target indices and empty rewrites", () => {
  const base = [finding(), finding({ file: "src/b.ts" })];
  const output = JSON.stringify([
    { index: 1, rationale: "should not land", suggestedChange: "x" },
    { index: 0, rationale: "", suggestedChange: "" },
    { index: 99, rationale: "nope", suggestedChange: "nope" },
  ]);

  const { findings, matched } = applyRevoicedFindings(base, [0], [output]);
  assert.equal(matched, 0);
  assert.deepEqual(findings, base);
});

test("applyRevoicedFindings re-caps transport limits and flattens control chars", () => {
  const base = [finding()];
  const output = JSON.stringify([
    { index: 0, rationale: `NAK.\n${"x".repeat(200)}`, suggestedChange: "y".repeat(3000) },
  ]);

  const { findings, matched } = applyRevoicedFindings(base, [0], [output]);
  assert.equal(matched, 1);
  assert.equal(findings[0]!.rationale.length, 100);
  assert.ok(!findings[0]!.rationale.includes("\n"));
  assert.equal(findings[0]!.suggestedChange.length, 2000);
});

test("applyRevoicedFindings falls back per-field when one side is empty", () => {
  const base = [finding()];
  const output = JSON.stringify([{ index: 0, rationale: "This is garbage. NAK.", suggestedChange: "" }]);

  const { findings, matched } = applyRevoicedFindings(base, [0], [output]);
  assert.equal(matched, 1);
  assert.equal(findings[0]!.rationale, "This is garbage. NAK.");
  assert.equal(findings[0]!.suggestedChange, "original suggested change");
});
