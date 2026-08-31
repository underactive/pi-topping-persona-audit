import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handoffRelPath,
  makeSlug,
  partialReportRelPath,
  formatDuration,
  renderChatSummary,
  renderCollectionFailureReport,
  renderCompactReport,
  renderDeferredHandoff,
  renderFullReport,
  renderPartialReport,
  reportRelPath,
  type CollectionDiagnostics,
  type ReportContext,
} from "../src/report.ts";
import type {
  AuditSummary,
  CollectReviewerFindingsResult,
  Finding,
  FixVerification,
  RegressionResult,
  VerificationOutcome,
  VerificationRound,
} from "../src/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const ctx: ReportContext = {
  slug: "2026-07-01_10-00-00",
  isoDate: "2026-07-01T10:00:00Z",
  scope: ".",
  mode: "diff",
  baseLabel: "merge-base with main",
  changedCount: 3,
  importerCount: 2,
  fileCount: 5,
  reviewers: ["Security Engineer", "Kent Beck"],
  passes: 2,
  cacheHits: 1,
  freshRuns: 3,
};

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "unsanitized input reaches exec",
  suggestedChange: "escape the argument before interpolation",
  ...overrides,
});

const collection: CollectReviewerFindingsResult = {
  findings: [finding()],
  dedupedFindings: [finding()],
  noFindings: [{ reviewer: "Kent Beck", findings: 0 }],
  malformed: [{ reviewer: "Security Engineer", pass: 2, sourceIndex: 1, reason: "No JSON object lines found in reviewer output" }],
  expectedRuns: 4,
  receivedRuns: 3,
  missingRuns: [{ reviewer: "Kent Beck", pass: 2 }],
  inputCount: 1,
  outputCount: 1,
  duplicateGroups: 0,
};

const diagnostics: CollectionDiagnostics = {
  collection,
  failedRuns: [{ reviewer: "Kent Beck", pass: 2, status: "failed", outputChars: 0, detail: "exit 1" }],
  annotationNote: "adjudicator annotated 0/1 findings — the rest default to apply in triage",
};

const fixVerification = (overrides: Partial<FixVerification> = {}): FixVerification => ({
  file: "src/a.ts",
  line: 12,
  category: "security",
  verdict: "fixed",
  evidence: "escapes argv before execFile",
  changed: "changed",
  selfReport: "applied",
  ...overrides,
});

const verificationOutcome = (overrides: Partial<VerificationOutcome> = {}): VerificationOutcome => ({
  status: "passed",
  fixes: [],
  regressions: [],
  scripts: [],
  notes: [],
  rounds: [],
  contested: [],
  ...overrides,
});

const summaryBase = {
  fixedCount: 0,
  fixVerifications: [] as FixVerification[],
  regressions: [] as RegressionResult[],
  verificationNotes: [] as string[],
  verificationRounds: [] as VerificationRound[],
};

// ── Slug & paths ───────────────────────────────────────────────────────────

test("makeSlug uses underscored filename form and ISO frontmatter form", () => {
  // Non-zero milliseconds: the slug keeps them zero-padded so two audits
  // started in the same second cannot collide, and the ISO form drops them.
  const { slug, iso } = makeSlug(new Date(Date.UTC(2026, 6, 1, 9, 5, 7, 42)));
  assert.equal(slug, "2026-07-01_09-05-07-042");
  assert.equal(iso, "2026-07-01T09:05:07Z");
  assert.equal(reportRelPath(slug), ".pi/persona-audit/audits/2026-07-01_09-05-07-042_persona-audit.md");
  assert.equal(partialReportRelPath(slug), ".pi/persona-audit/audits/2026-07-01_09-05-07-042_progress_snapshot.md");
  assert.equal(handoffRelPath(slug), ".pi/persona-audit/handoffs/2026-07-01_09-05-07-042_deferred-findings.md");
  assert.ok(!slug.includes(":"), "filename slug must not contain colons");
});

test("makeSlug keeps two audits started in the same second apart", () => {
  const at = (ms: number) => makeSlug(new Date(Date.UTC(2026, 6, 1, 9, 5, 7, ms))).slug;
  assert.notEqual(at(0), at(1));
  assert.equal(at(0), "2026-07-01_09-05-07-000");
});

// ── Deferred handoff ──────────────────────────────────────────────────────

const handoffCtx = {
  isoDate: "2026-07-01T10:00:00Z",
  scope: ".",
  reviewers: ["Security Engineer", "Kent Beck"],
};

test("deferred handoff includes frontmatter and complete finding details", () => {
  const handoff = renderDeferredHandoff(handoffCtx, [
    finding({ recommendation: "defer", recommendationReason: "needs design review" }),
  ]);

  assert.ok(handoff.startsWith("---\ndate: 2026-07-01T10:00:00Z\nauthor: pi-topping-persona-audit"));
  assert.ok(handoff.includes('topic: "Deferred persona-audit findings — ."'));
  assert.ok(handoff.includes("tags: [audit, persona-audit, deferred, handoff]"));
  assert.ok(handoff.includes("status: pending"));
  assert.ok(handoff.includes("## Deferred Findings (1)"));
  assert.ok(handoff.includes("**src/a.ts:12** [high] — security"));
  assert.ok(handoff.includes("Rationale: unsanitized input reaches exec"));
  assert.ok(handoff.includes("Suggested Change: escape the argument before interpolation"));
  assert.ok(handoff.includes("Reviewers: Security Engineer"));
  assert.ok(handoff.includes("Adjudicator: needs design review"));
});

test("written findings include a summary when one is available", () => {
  const handoff = renderDeferredHandoff(handoffCtx, [finding({ summary: "User input reaches the command." })]);

  assert.ok(handoff.includes("Summary: User input reaches the command."));
  assert.ok(handoff.includes("Rationale: unsanitized input reaches exec"));
});

test("deferred handoff groups findings and action items by file", () => {
  const handoff = renderDeferredHandoff(handoffCtx, [
    finding({ file: "src/a.ts" }),
    finding({ file: "src/b.ts", line: 0 }),
    finding({ file: "src/a.ts", line: 24 }),
  ]);

  assert.equal((handoff.match(/### `src\/a\.ts`/g) ?? []).length, 1);
  assert.equal((handoff.match(/### `src\/b\.ts`/g) ?? []).length, 1);
  const actionItems = handoff.slice(handoff.indexOf("## Action Items & Next Steps"));
  assert.equal((actionItems.match(/- `src\/a\.ts`/g) ?? []).length, 1);
  assert.equal((actionItems.match(/- `src\/b\.ts`/g) ?? []).length, 1);
});

test("deferred handoff renders a valid empty handoff", () => {
  const handoff = renderDeferredHandoff(handoffCtx, []);
  assert.ok(handoff.includes("# Handoff: Deferred audit findings"));
  assert.ok(handoff.includes("## Deferred Findings (0)"));
  assert.ok(handoff.includes("No findings were deferred."));
});

test("deferred handoff embeds a machine-readable resume block", () => {
  const handoff = renderDeferredHandoff(
    { ...handoffCtx, headCommit: "b".repeat(40) },
    [finding({ recommendation: "defer" })],
  );
  assert.ok(handoff.includes("## Resume Data"));
  assert.ok(handoff.includes("<!-- persona-audit-resume:v1 -->"));
  assert.ok(handoff.includes('"schemaVersion":1'));
  assert.ok(handoff.includes(`"headCommit":"${"b".repeat(40)}"`));
});

// ── Full-tree mode overview ──────────────────────────────────────────

test("full-tree mode overview omits diff-based/base wording and shows scan mode", () => {
  const fullCtx: ReportContext = { ...ctx, mode: "full" };
  const report = renderCompactReport(fullCtx, { reason: "no-findings", deferred: [], rejected: [], diagnostics });
  assert.ok(report.includes("Mode: full-tree scan (no git required)"));
  assert.ok(report.includes("Files audited: 5 (full-tree scan)"));
  assert.ok(!report.includes("diff-based"));
  assert.ok(!report.includes("base:"));
});

test("full-tree mode overview surfaces the truncation note when capped", () => {
  const truncatedCtx: ReportContext = { ...ctx, mode: "full", truncated: true, totalFilesFound: 812 };
  const report = renderCompactReport(truncatedCtx, { reason: "no-findings", deferred: [], rejected: [], diagnostics });
  assert.ok(report.includes("capped from 812 found"));
  assert.ok(report.includes("the scan found 812 files"));
  assert.ok(report.includes("not sampled"));
});

// ── Handoff-resume mode overview ────────────────────────────────

test("handoff mode overview names the source handoff and resume notes", () => {
  const handoffModeCtx: ReportContext = {
    ...ctx,
    mode: "handoff",
    handoffSource: ".pi/persona-audit/handoffs/old_deferred-findings.md",
    resumeNotes: ["1 finding dropped — target file no longer exists: src/gone.ts:3"],
  };
  const report = renderCompactReport(handoffModeCtx, { reason: "none-accepted", deferred: [], rejected: [], diagnostics });
  assert.ok(report.includes("Mode: resumed from handoff (.pi/persona-audit/handoffs/old_deferred-findings.md)"));
  assert.ok(report.includes("Files audited: 5 (from deferred findings)"));
  assert.ok(report.includes("Note: 1 finding dropped — target file no longer exists: src/gone.ts:3"));
  assert.ok(!report.includes("diff-based"));
  assert.ok(!report.includes("full-tree scan"));
});

// ── Compact report ──────────────────────────────────────────────────────

test("report renders only additional-context metadata", () => {
  const report = renderCompactReport(
    { ...ctx, additionalContext: "214 chars · 2 images" },
    { reason: "no-findings", deferred: [], rejected: [], diagnostics },
  );
  assert.match(report, /Additional context: 214 chars · 2 images/);
  assert.doesNotMatch(report, /raw secret guidance|base64/);
});

test("compact report covers both no-findings and none-accepted reasons", () => {
  const noFindings = renderCompactReport(ctx, { reason: "no-findings", deferred: [], rejected: [], diagnostics });
  assert.ok(noFindings.startsWith("---\ndate: 2026-07-01T10:00:00Z"));
  assert.ok(noFindings.includes("## No Actionable Findings"));
  assert.ok(noFindings.includes("No findings were reported"));
  assert.ok(noFindings.includes("skipped — no accepted fixes"));

  const noneAccepted = renderCompactReport(ctx, {
    reason: "none-accepted",
    deferred: [finding({ recommendation: "defer", recommendationReason: "needs design review" })],
    rejected: [finding({ file: "src/b.ts" })],
    diagnostics,
  });
  assert.ok(noneAccepted.includes("the user accepted none"));
  assert.ok(noneAccepted.includes("### Deferred (1)"));
  assert.ok(noneAccepted.includes("### Rejected (1)"));
  assert.ok(noneAccepted.includes("Adjudicator: needs design review"));
});

test("none-accepted report names the findings dropped as out of scope", () => {
  const stray = finding({ file: "../outside/evil.ts", line: 7 });
  const vendored = finding({ file: "vendor/gen.js", line: -1, reviewer: "Kent Beck", category: "bug" });
  const report = renderCompactReport(ctx, {
    reason: "none-accepted",
    deferred: [],
    rejected: [],
    diagnostics: { failedRuns: [], outOfScope: [stray, vendored] },
  });

  assert.ok(report.includes("Accepted findings outside the audited scope (not applied): 2"));
  assert.ok(report.includes("out of scope: `../outside/evil.ts:7` security — Security Engineer"));
  // line -1 is file-level, so no line suffix.
  assert.ok(report.includes("out of scope: `vendor/gen.js` bug — Kent Beck"));
});

test("reports omit the out-of-scope block when nothing was dropped", () => {
  const report = renderCompactReport(ctx, {
    reason: "none-accepted",
    deferred: [],
    rejected: [],
    diagnostics: { failedRuns: [] },
  });
  assert.ok(!report.includes("outside the audited scope"));
});

test("compact report renders collection integrity diagnostics", () => {
  const report = renderCompactReport(ctx, { reason: "no-findings", deferred: [], rejected: [], diagnostics });
  assert.ok(report.includes("### Collection Integrity"));
  assert.ok(report.includes("3 received / 4 expected"));
  assert.ok(report.includes("missing: Kent Beck pass 2"));
  assert.ok(report.includes("malformed: Security Engineer pass 2"));
  assert.ok(report.includes("failed run: Kent Beck pass 2 — exit 1"));
  assert.ok(report.includes("Adjudicator annotation degradation"));
  assert.ok(report.includes("### Reviewers with no findings"));
  assert.ok(report.includes("- Kent Beck"));
});

// ── Collection failure report ──────────────────────────────────────────────

test("collection failure report warns that no findings can be inferred", () => {
  const report = renderCollectionFailureReport(ctx, {
    diagnostics,
    reason: "Reviewer collection failed: 0/4 reviewer passes were collected, with 4 missing and 0 malformed.",
  });
  assert.ok(report.includes("## Audit Failed"));
  assert.ok(report.includes("No findings should be inferred from this run"));
  assert.ok(report.includes("3 received / 4 expected"));
  assert.ok(report.includes("skipped — audit failed before fixes"));
});

// ── Full report ────────────────────────────────────────────────────────────

test("full report includes applied findings, apply report, and validation", () => {
  const report = renderFullReport(ctx, {
    accepted: [finding()],
    deferred: [],
    rejected: [finding({ file: "src/b.ts", line: -1 })],
    applyReport: "## Adjudicator Fix Application Report\n\n### Fixes Applied\n- src/a.ts:12 [high] — security: escaped",
    verification: verificationOutcome({
      status: "failed",
      scripts: [
        { script: "check", command: "npm run check", status: "pass", exitCode: 0, relevantOutput: "" },
        { script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" },
      ],
    }),
    diagnostics,
    partialReportPath: partialReportRelPath(ctx.slug),
  });

  assert.ok(report.includes("### Applied (batch) (1)"));
  assert.ok(report.includes("**src/a.ts:12** [high] — security"));
  assert.ok(
    report.includes("## Adjudicator Fix Application Report\n\n### Fixes Applied\n- src/a.ts:12"),
    "apply report keeps its line structure instead of being flattened to one line",
  );
  // file-level finding renders without :line suffix
  assert.ok(report.includes("**src/b.ts** [high]"));
  assert.ok(report.includes("- Status: failed"));
  assert.ok(report.includes("`npm run check`: pass (exit 0)"));
  assert.ok(report.includes("`npm run test`: fail (exit 1)"));
  assert.ok(report.includes("1 failing"));
  assert.ok(report.includes("### Partial Failure / Cancellation"));
  assert.ok(report.includes("_progress_snapshot.md"));
  assert.ok(!report.includes("- Models:"), "no models line when phaseModels is unset");
});

test("full report renders a models line when phaseModels is present, omitting unset phases", () => {
  const report = renderFullReport(
    { ...ctx, phaseModels: { Review: "anthropic/claude-opus-4-6 (thinking: high)", Implement: "openai/gpt-5 (thinking: medium)" } },
    {
      accepted: [],
      deferred: [],
      rejected: [],
      applyReport: "",
      verification: verificationOutcome({ status: "skipped" }),
      diagnostics,
    },
  );
  assert.ok(report.includes("- Models: Review anthropic/claude-opus-4-6 (thinking: high) · Implement openai/gpt-5 (thinking: medium)"));
});

// ── Validation summary ────────────────────────────────────────────────

function fullReportWith(verification: VerificationOutcome): string {
  return renderFullReport(ctx, {
    accepted: [finding()],
    deferred: [],
    rejected: [],
    applyReport: "",
    verification,
    diagnostics,
  });
}

test("validation summary renders verdict counts, the verdict table, and regression evidence", () => {
  const report = fullReportWith(
    verificationOutcome({
      status: "partial",
      fixes: [
        fixVerification(),
        fixVerification({
          file: "src/b.ts",
          line: 3,
          category: "bug",
          verdict: "not-fixed",
          changed: "unchanged",
          evidence: "target file is byte-identical to the pre-fix snapshot",
        }),
      ],
      regressions: [
        {
          file: "src/a.ts",
          line: 12,
          category: "security",
          testFile: "test/exec-escape.test.ts",
          testCommand: "node --test test/exec-escape.test.ts",
          outcome: "proven",
          greenAfterFix: true,
          redWhenReverted: true,
          proven: true,
        },
      ],
      scripts: [{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" }],
      notes: ["verifier judged 1/2 changed findings — the rest are cannot-verify"],
    }),
  );

  assert.ok(report.includes("- Status: partial"));
  assert.ok(report.includes("- Fixes verified: 1 fixed · 0 partial · 1 not fixed · 0 unverified"));
  assert.ok(report.includes("- Note: verifier judged 1/2 changed findings"));
  assert.ok(report.includes("#### Fix Verdicts"));
  assert.ok(report.includes("| `src/a.ts:12` security | fixed | changed | applied | escapes argv before execFile |"));
  assert.ok(report.includes("| `src/b.ts:3` bug | not-fixed | unchanged | applied |"));
  assert.ok(report.includes("#### Regression Evidence"));
  assert.ok(report.includes("- `src/a.ts:12` security — proven"));
  assert.ok(report.includes("Command: `node --test test/exec-escape.test.ts`"));
  assert.ok(report.includes("red when the fix is reverted"));
  assert.ok(report.includes("#### Verification Scripts"));
  assert.ok(report.includes("`npm run test`: fail (exit 1)"));
  assert.ok(report.includes("1 failing"));
});

const verificationRound = (overrides: Partial<VerificationRound> = {}): VerificationRound => ({
  round: 1,
  status: "failed",
  fixVerdicts: [fixVerification({ verdict: "not-fixed", changed: "changed" })],
  regressions: [],
  scripts: [],
  notes: [],
  ...overrides,
});

test("rounds table marks a repair round that ran escalated", () => {
  const report = fullReportWith(
    verificationOutcome({
      status: "failed",
      fixes: [fixVerification({ verdict: "not-fixed" })],
      rounds: [
        verificationRound({ repairOutcome: "first repair" }),
        verificationRound({ round: 2, repairOutcome: "root-cause repair", repairEscalated: true }),
        verificationRound({ round: 3 }),
      ],
    }),
  );
  assert.ok(report.includes("| 1 | failed |"));
  assert.ok(report.includes("(escalated) root-cause repair"));
  assert.ok(!report.includes("(escalated) first repair"));
});

test("a single round still renders the rounds table when its repair attempt itself failed to run", () => {
  // The repair loop sets repairOutcome on the round it tried to repair without
  // pushing a new round when the repair agent session itself fails — rounds
  // stays length 1, but the failed repair attempt must still be visible.
  const report = fullReportWith(
    verificationOutcome({
      status: "failed",
      fixes: [fixVerification({ verdict: "fixed" })],
      scripts: [{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" }],
      rounds: [
        verificationRound({
          fixVerdicts: [fixVerification({ verdict: "fixed" })],
          scripts: [{ script: "test", command: "npm run test", status: "fail", exitCode: 1, relevantOutput: "1 failing" }],
          repairOutcome: "gate repair round 2 failed — idle timeout",
        }),
      ],
    }),
  );
  assert.ok(report.includes("#### Fix + Verify Rounds"));
  assert.ok(report.includes("gate repair round 2 failed — idle timeout"));
});

test("contested verdicts render with the adjudication caveat, and only when present", () => {
  const contestedReport = fullReportWith(
    verificationOutcome({
      status: "failed",
      fixes: [fixVerification({ verdict: "not-fixed" })],
      contested: [
        { file: "src/a.ts", line: 12, category: "security", reason: "diff shows the guard landed; verifier read the snapshot", round: 3 },
      ],
    }),
  );
  assert.ok(contestedReport.includes("#### Contested Verdicts"));
  assert.ok(contestedReport.includes("They still count as failures;"));
  assert.ok(contestedReport.includes("- `src/a.ts:12` security — diff shows the guard landed; verifier read the snapshot"));

  const plainReport = fullReportWith(
    verificationOutcome({ status: "failed", fixes: [fixVerification({ verdict: "not-fixed" })] }),
  );
  assert.ok(!plainReport.includes("#### Contested Verdicts"));
});

test("validation summary omits sub-sections that have no content", () => {
  const report = fullReportWith(
    verificationOutcome({
      status: "passed",
      fixes: [fixVerification()],
      scripts: [{ script: "check", command: "npm run check", status: "pass", exitCode: 0, relevantOutput: "" }],
    }),
  );
  assert.ok(report.includes("#### Fix Verdicts"));
  assert.ok(!report.includes("#### Regression Evidence"));
  assert.ok(!report.includes("- Note:"));
});

test("validation summary escapes pipes so an evidence string cannot break the table", () => {
  const report = fullReportWith(
    verificationOutcome({ fixes: [fixVerification({ evidence: "replaced a | b with a || b" })] }),
  );
  assert.ok(report.includes("replaced a \\| b with a \\|\\| b"));
});

// ── Partial report ─────────────────────────────────────────────────────────

test("partial report carries status marker and run records", () => {
  const partial = renderPartialReport(ctx, {
    status: "cancelled",
    runRecords: [
      { reviewer: "Security Engineer", pass: 1, status: "cached", outputChars: 512 },
      { reviewer: "Security Engineer", pass: 2, status: "completed", outputChars: 1024 },
      { reviewer: "Kent Beck", pass: 1, status: "failed", outputChars: 0, detail: "exit 1" },
      { reviewer: "Kent Beck", pass: 2, status: "pending", outputChars: 0 },
    ],
    diagnostics,
    note: "User cancelled during findings review.",
  });

  assert.ok(partial.includes("status: cancelled"));
  assert.ok(partial.includes("no fixes were applied") || partial.includes("before fixes were applied"));
  assert.ok(partial.includes("Security Engineer pass 1: cached (512 chars)"));
  assert.ok(partial.includes("Security Engineer pass 2: completed (1024 chars)"));
  assert.ok(partial.includes("Kent Beck pass 1: failed — exit 1"));
  assert.ok(partial.includes("Kent Beck pass 2: pending"));
  assert.ok(partial.includes("User cancelled during findings review."));
});

test("partial report without collection notes that collection did not run", () => {
  const partial = renderPartialReport(ctx, {
    status: "partial",
    runRecords: [],
    diagnostics: { failedRuns: [] },
  });
  assert.ok(partial.includes("status: partial"));
  assert.ok(partial.includes("collection did not run"));
  assert.ok(partial.includes("- none launched yet"));
});

// ── Chat summary ───────────────────────────────────────────────────────────

test("chat summary renders counts, verification, and report path", () => {
  const summary: AuditSummary = {
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer", "Kent Beck"],
    passes: 2,
    findingsCount: 3,
    acceptedCount: 2,
    rejectedCount: 1,
    deferredCount: 0,
    verification: "passed",
    verifyResults: [
      { script: "check", command: "npm run check", status: "pass", exitCode: 0, relevantOutput: "" },
    ],
    ...summaryBase,
    reportPath: reportRelPath(ctx.slug),
    expectedRuns: 4,
    receivedRuns: 4,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 1,
    freshRuns: 3,
  };
  const text = renderChatSummary(summary);
  assert.ok(text.includes("## Audit Summary"));
  assert.ok(text.includes("3 issues found | 2 applied | 0 deferred | 1 rejected"));
  assert.ok(text.includes("Total time: 11m 37s"));
  assert.ok(text.includes("Verification: passed | Scripts run: check"));
  assert.ok(text.includes("Collection: 4/4 reviewer passes received"));
  assert.ok(text.includes("Security Engineer, Kent Beck"));
  assert.ok(text.includes(reportRelPath(ctx.slug)));
  assert.ok(!text.includes("### Handoff Report"));
});

test("chat summary includes the handoff report path when a handoff was written", () => {
  const summary: AuditSummary = {
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 3,
    acceptedCount: 2,
    rejectedCount: 0,
    deferredCount: 1,
    verification: "passed",
    verifyResults: [],
    ...summaryBase,
    reportPath: reportRelPath(ctx.slug),
    handoffPath: handoffRelPath(ctx.slug),
    expectedRuns: 1,
    receivedRuns: 1,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 0,
    freshRuns: 1,
  };
  const text = renderChatSummary(summary);
  assert.ok(text.includes("### Audit Report"));
  assert.ok(text.includes(reportRelPath(ctx.slug)));
  assert.ok(text.includes("### Handoff Report"));
  assert.ok(text.includes(handoffRelPath(ctx.slug)));
});

test("chat summary does not claim fixes were applied when the implement phase failed", () => {
  const summary: AuditSummary = {
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 3,
    acceptedCount: 2,
    rejectedCount: 1,
    deferredCount: 0,
    verification: "skipped",
    verifyResults: [],
    ...summaryBase,
    reportPath: reportRelPath(ctx.slug),
    expectedRuns: 1,
    receivedRuns: 1,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 0,
    freshRuns: 1,
    implementFailedNote: "Implement phase failed — no accepted fixes were written to disk: exit 1",
  };
  const text = renderChatSummary(summary);
  assert.ok(!text.includes("2 applied"));
  assert.ok(text.includes("2 accepted (not applied)"));
  assert.ok(text.includes("Note: Implement phase failed — no accepted fixes were written to disk: exit 1"));
});

test("chat summary still says applied when implementFailedNote is absent", () => {
  const summary: AuditSummary = {
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 3,
    acceptedCount: 2,
    rejectedCount: 1,
    deferredCount: 0,
    verification: "passed",
    verifyResults: [],
    ...summaryBase,
    reportPath: reportRelPath(ctx.slug),
    expectedRuns: 1,
    receivedRuns: 1,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 0,
    freshRuns: 1,
  };
  const text = renderChatSummary(summary);
  assert.ok(text.includes("2 applied"));
  assert.ok(!text.includes("Note:"));
});

test("chat summary renders verdict counts, the regression line, and verification notes", () => {
  const summary: AuditSummary = {
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 3,
    acceptedCount: 2,
    fixedCount: 0,
    rejectedCount: 0,
    deferredCount: 0,
    verification: "partial",
    verifyResults: [{ script: "check", command: "npm run check", status: "pass", exitCode: 0, relevantOutput: "" }],
    fixVerifications: [fixVerification(), fixVerification({ file: "src/b.ts", verdict: "not-fixed" })],
    regressions: [
      {
        file: "src/a.ts",
        line: 12,
        category: "security",
        testFile: "test/a.test.ts",
        testCommand: "node --test test/a.test.ts",
        outcome: "proven",
        greenAfterFix: true,
        redWhenReverted: true,
        proven: true,
      },
      {
        file: "src/b.ts",
        line: 3,
        category: "bug",
        testFile: "test/b.test.ts",
        testCommand: "node --test test/b.test.ts",
        outcome: "not-discriminating",
        greenAfterFix: true,
        redWhenReverted: false,
        proven: false,
      },
    ],
    verificationNotes: ["no verification scripts discovered — the tree was not re-checked"],
    verificationRounds: [],
    reportPath: reportRelPath(ctx.slug),
    expectedRuns: 1,
    receivedRuns: 1,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 0,
    freshRuns: 1,
  };
  const text = renderChatSummary(summary);
  assert.ok(text.includes("Verification: partial | 1 fixed, 0 partial, 1 not fixed, 0 unverified | Scripts run: check"));
  assert.ok(text.includes("Regression tests: 1 proven, 1 inconclusive"));
  assert.ok(text.includes("Note: no verification scripts discovered"));
});

test("chat summary surfaces collection failure notes", () => {
  const summary: AuditSummary = {
    status: "failed",
    scope: ".",
    fileCount: 5,
    totalMs: 697_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    deferredCount: 0,
    verification: "skipped",
    verifyResults: [],
    ...summaryBase,
    reportPath: reportRelPath(ctx.slug),
    expectedRuns: 1,
    receivedRuns: 0,
    malformedCount: 0,
    missingCount: 1,
    cacheHits: 0,
    freshRuns: 1,
    failureNote: "Reviewer collection failed: 0/1 reviewer passes were collected, with 1 missing and 0 malformed.",
  };
  const text = renderChatSummary(summary);
  assert.ok(text.includes("Status: failed"));
  assert.ok(text.includes("Note: Reviewer collection failed"));
});

// ── Total run time ─────────────────────────────────────────────────────────

test("formatDuration promotes units only once they are reached", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(37_400), "37s");
  assert.equal(formatDuration(697_000), "11m 37s");
  assert.equal(formatDuration(3_733_000), "1h 02m 13s");
  assert.equal(formatDuration(-5), "0s", "a clock skew never renders a negative duration");
});

test("the overview omits total time until the run reports one", () => {
  assert.ok(
    !renderCompactReport(ctx, { reason: "no-findings", deferred: [], rejected: [], diagnostics: { failedRuns: [] } })
      .includes("Total time:"),
  );
  const timed = renderCompactReport(
    { ...ctx, totalMs: 697_000 },
    { reason: "no-findings", deferred: [], rejected: [], diagnostics: { failedRuns: [] } },
  );
  assert.ok(timed.includes("- Total time: 11m 37s"));
});

test("an in-progress partial report marks its total time as still running", () => {
  const partial = renderPartialReport(
    { ...ctx, totalMs: 245_000 },
    { status: "partial", runRecords: [], diagnostics: { failedRuns: [] } },
  );
  assert.ok(partial.includes("- Total time: 4m 05s (in progress)"));

  const cancelled = renderPartialReport(
    { ...ctx, totalMs: 245_000 },
    { status: "cancelled", runRecords: [], diagnostics: { failedRuns: [] } },
  );
  assert.ok(cancelled.includes("- Total time: 4m 05s"));
  assert.ok(!cancelled.includes("(in progress)"), "a settled run's total is final");
});

// ── Fix Now sections ───────────────────────────────────────────────────────

test("full report renders interactively fixed findings with their commit", () => {
  const report = renderFullReport(ctx, {
    accepted: [finding()],
    deferred: [],
    rejected: [],
    fixed: [
      { finding: finding({ file: "src/b.ts", line: 4, category: "bug" }), commitSha: "abc1234", files: ["src/b.ts"] },
      { finding: finding({ file: "src/c.ts" }), files: ["src/c.ts"] },
    ],
    applyReport: "ok",
    verification: verificationOutcome(),
    diagnostics,
  });

  assert.ok(report.includes("### Fixed interactively (2)"));
  assert.ok(report.includes("Commit: abc1234"));
  assert.ok(report.includes("Commit: none (auto-commit declined)"));
});

test("full report omits the interactive section when nothing was fixed that way", () => {
  const report = renderFullReport(ctx, {
    accepted: [finding()],
    deferred: [],
    rejected: [],
    applyReport: "ok",
    verification: verificationOutcome(),
    diagnostics,
  });
  assert.ok(!report.includes("Fixed interactively"));
});

test("compact none-accepted report accounts for interactive fixes", () => {
  const report = renderCompactReport(ctx, {
    reason: "none-accepted",
    deferred: [],
    rejected: [],
    fixed: [{ finding: finding(), commitSha: "abc1234", files: ["src/a.ts"] }],
    diagnostics,
  });

  assert.ok(report.includes("## No Batch-Applied Findings"));
  assert.ok(report.includes("1 was fixed interactively during triage"));
  assert.ok(report.includes("### Fixed interactively (1)"));
  assert.ok(report.includes("Commit: abc1234"));
});

test("chat summary counts interactive fixes only when present", () => {
  const base: AuditSummary = {
    ...summaryBase,
    status: "completed",
    scope: ".",
    fileCount: 5,
    totalMs: 60_000,
    reviewers: ["Security Engineer"],
    passes: 1,
    findingsCount: 3,
    acceptedCount: 1,
    fixedCount: 2,
    rejectedCount: 0,
    deferredCount: 0,
    verification: "skipped",
    verifyResults: [],
    reportPath: "r.md",
    expectedRuns: 1,
    receivedRuns: 1,
    malformedCount: 0,
    missingCount: 0,
    cacheHits: 0,
    freshRuns: 1,
  };

  assert.ok(renderChatSummary(base).includes("2 fixed interactively"));
  assert.ok(!renderChatSummary({ ...base, fixedCount: 0 }).includes("fixed interactively"));
});
