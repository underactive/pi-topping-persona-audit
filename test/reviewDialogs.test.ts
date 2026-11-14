import assert from "node:assert/strict";
import test from "node:test";
import { showFindingsReview } from "../src/components/FindingsReview.ts";
import { showReportViewer } from "../src/components/ReportViewer.ts";
import { showReviewerRetryPrompt, type ReviewerFailure } from "../src/components/ReviewerRetry.ts";
import { TriageSuggestionFeed } from "../src/decision/triage.ts";
import type { Finding, FixedFinding, ReviewSessionState } from "../src/types.ts";
import {
  dialogRetryModelToPhaseChoice,
  openFindingsReviewDialog,
  openFixGateDialog,
  openRetryCheckpointDialog,
} from "../src/ui/review-dialogs.ts";
import { createDialogHost, KEY, press, ROOMY_TERMINAL, screen, settle, waitFor, waitForResult } from "./helpers/dialog-harness.ts";

const MODELS = [
  { provider: "fakeprov", id: "alpha-reasoner", reasoning: true },
  { provider: "fakeprov", id: "beta-plain", reasoning: false },
];
const MODEL_REFS = MODELS.map(({ provider, id }) => ({ provider, id }));
const failures: ReviewerFailure[] = [
  { reviewer: "Security Engineer", pass: 2, label: "Security Engineer #2", detail: "rate limit" },
  { reviewer: "Data Engineer", pass: 1, label: "Data Engineer", detail: "malformed output" },
];
const firstFinding: Finding = {
  reviewer: "Security Engineer",
  file: "src/session.ts",
  line: 12,
  category: "security",
  severity: "high",
  summary: "The session cookie lacks secure flags.",
  rationale: "The cookie can be read by page scripts.",
  suggestedChange: "Set HttpOnly and Secure.",
  recommendation: "apply",
  blastRadius: { score: 80, level: "high", reasons: ["auth path"] },
};
const secondFinding: Finding = {
  reviewer: "Testing Engineer",
  file: "src/retry.ts",
  line: 4,
  category: "bug",
  severity: "medium",
  rationale: "A timeout can retry a non-idempotent request.",
  suggestedChange: "Require an idempotency key.",
  recommendation: "reject",
};

function host() {
  return createDialogHost({ terminal: ROOMY_TERMINAL, models: MODELS, model: MODELS[0] });
}

test("the retry adapter uses registry models and maps the exact failed passes back", async () => {
  const h = host();
  const result = openRetryCheckpointDialog(
    h.ctx,
    "reviewer",
    { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] },
    "medium",
    MODEL_REFS,
    { failures },
  );
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /fakeprov\/alpha-reasoner/);
  assert.doesNotMatch(screen(dialog, 104), /anthropic\/claude/);

  assert.match(screen(dialog, 104), /enter pick model/);
  await press(dialog, KEY.right, KEY.down, KEY.down, KEY.enter);
  assert.match(screen(dialog, 104), /esc back/);
  await press(dialog, KEY.down, KEY.enter, KEY.tab, KEY.enter);
  assert.match(screen(dialog, 104), /tab buttons/);
  await press(dialog, KEY.tab, KEY.enter);
  const decision = await waitForResult(result, "reviewer retry checkpoint to return a decision");
  assert.deepEqual(decision, {
    kind: "reviewer",
    cancelled: false,
    retries: [{ reviewer: "Data Engineer", pass: 1 }],
    model: { id: "fakeprov/beta-plain", level: "off" },
  });
  assert.deepEqual(dialogRetryModelToPhaseChoice(decision.model, MODEL_REFS), {
    ref: MODEL_REFS[1],
    thinking: "off",
  });
});

test("the adjudicator and verifier retry checkpoints return their distinct actions", async () => {
  const adjudicatorHost = host();
  const adjudicator = openRetryCheckpointDialog(
    adjudicatorHost.ctx,
    "adjudicator",
    { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] },
    "medium",
    MODEL_REFS,
    { detail: "reconciliation failed" },
  );
  const adjudicatorDialog = await adjudicatorHost.dialog();
  await press(adjudicatorDialog, KEY.tab, KEY.right, KEY.enter);
  assert.deepEqual(await waitForResult(adjudicator, "adjudicator checkpoint to return a decision"), { kind: "adjudicator", retry: false });

  const verifierHost = host();
  const verifier = openRetryCheckpointDialog(
    verifierHost.ctx,
    "verifier",
    { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] },
    "medium",
    MODEL_REFS,
    { detail: "verifier process failed" },
  );
  const verifierDialog = await verifierHost.dialog();
  await press(verifierDialog, KEY.tab, KEY.right, KEY.enter);
  assert.deepEqual(await waitForResult(verifier, "verifier checkpoint to return a decision"), { kind: "verifier", retry: false });
});

test("the retry prompt selects the generated dialog when the terminal meets its measured threshold", async () => {
  const h = host();
  const result = showReviewerRetryPrompt(
    h.ctx,
    failures,
    { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] },
    "medium",
  );
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /REVIEWER PASSES FAILED/);
  assert.equal(h.customOptions.length, 2, "one invisible size probe and one generated overlay");
  await press(dialog, KEY.tab, KEY.right, KEY.enter);
  assert.deepEqual(await waitForResult(result, "reviewer retry wrapper to return a decision"), { cancelled: true, retries: [] });
});

test("Findings Review carries Fix Now state and real fixed records across reopen", async () => {
  const h = host();
  const firstFixed: FixedFinding = { finding: secondFinding, commitSha: "beef12", files: ["src/retry.ts", "test/retry.test.ts"] };
  const initial: ReviewSessionState = {
    statuses: ["defer", "fixed"],
    selectedIndex: 0,
    sortMode: "reviewer",
    expanded: [0],
    fixed: new Map([[1, firstFixed]]),
    handoffPath: ".pi/persona-audit/handoffs/existing.md",
  };
  const outcome = openFindingsReviewDialog(h.ctx, [firstFinding, secondFinding], ROOMY_TERMINAL.rows, undefined, initial);
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /@beef12/);
  await press(dialog, "f");
  const fixNow = await waitForResult(outcome, "Findings Review Fix Now outcome");
  assert.equal(fixNow?.kind, "fixNow");
  if (fixNow?.kind !== "fixNow") throw new Error("review did not return Fix Now");
  assert.equal(fixNow.index, 0);
  assert.deepEqual(fixNow.state.statuses, ["defer", "fixed"]);
  assert.equal(fixNow.state.fixed.get(1), firstFixed);
  assert.equal(fixNow.state.handoffPath, initial.handoffPath);

  const secondFixed: FixedFinding = { finding: firstFinding, commitSha: "a11ce0", files: ["src/session.ts"] };
  const restored: ReviewSessionState = {
    ...fixNow.state,
    statuses: ["fixed", "fixed"],
    fixed: new Map([...fixNow.state.fixed, [0, secondFixed]]),
  };
  const priorDialogCount = h.shown.length;
  const final = openFindingsReviewDialog(h.ctx, [firstFinding, secondFinding], ROOMY_TERMINAL.rows, undefined, restored);
  const reopened = await waitFor(() => h.shown.length > priorDialogCount ? h.shown.at(-1) : undefined, "reopened Findings Review dialog");
  assert.match(screen(reopened, 104), /@a11ce0/);
  await press(reopened, KEY.enter);
  const finalized = await waitForResult(final, "reopened Findings Review final outcome");
  assert.equal(finalized?.kind, "finalized");
  if (finalized?.kind !== "finalized") throw new Error("review did not finalize");
  assert.deepEqual(finalized.result.fixed, [secondFixed, firstFixed]);
  assert.equal(finalized.result.handoffPath, initial.handoffPath);
});

test("Findings Review writes handoffs with the real deferred findings and shows live classifier results", async () => {
  const h = host();
  const feed = new TriageSuggestionFeed();
  let handedOff: Finding[] = [];
  const result = openFindingsReviewDialog(
    h.ctx,
    [firstFinding],
    ROOMY_TERMINAL.rows,
    undefined,
    undefined,
    feed,
    async (deferred) => {
      handedOff = deferred;
      return ".pi/persona-audit/handoffs/actual.md";
    },
  );
  const dialog = await h.dialog();
  assert.doesNotMatch(screen(dialog, 104), /Classifier suggestion/);
  feed.set(0, {
    category: "security",
    categoryConfidence: 0.93,
    verdict: "apply",
    verdictConfidence: 0.87,
    changeKind: "behavior",
    changeKindConfidence: 0.71,
    model: "fakeprov/classifier",
    latencyMs: 12,
  });
  await settle(dialog);
  assert.match(screen(dialog, 104), /Classifier suggestion \(advisory\)/);

  await press(dialog, "d", "h", KEY.enter);
  const finalized = await waitForResult(result, "Findings Review handoff outcome");
  assert.equal(finalized?.kind, "finalized");
  if (finalized?.kind !== "finalized") throw new Error("review did not finalize");
  assert.deepEqual(handedOff, [firstFinding]);
  assert.deepEqual(finalized.result.deferred, [firstFinding]);
  assert.equal(finalized.result.handoffPath, ".pi/persona-audit/handoffs/actual.md");
});

test("Findings Review wrapper routes through the generated overlay at a fitting size", async () => {
  const h = host();
  const result = showFindingsReview(h.ctx, [firstFinding], {
    slug: "audit",
    isoDate: "2026-11-12",
    scope: "src/",
    reviewers: ["Security Engineer"],
  });
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /FINDINGS REVIEW/);
  assert.equal(h.customOptions.length, 2, "one invisible size probe and one generated overlay");
  await press(dialog, "f");
  assert.equal((await waitForResult(result, "Findings Review wrapper outcome")).kind, "fixNow");
});

test("the Fix Now adapter returns the generated gate decision", async () => {
  const h = host();
  const decision = openFixGateDialog(h.ctx, firstFinding, {
    diff: "@@ -1 +1 @@\n-const secure = false;\n+const secure = true;",
    verdictNote: "verifier: fixed",
    warnings: ["Auto-commit is off for this fix."],
    commitPlanned: false,
    attempt: 2,
    chatHistory: [{ role: "user", text: "Keep the cookie scope unchanged." }],
  }, ROOMY_TERMINAL.rows);
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /Accept/);
  assert.match(screen(dialog, 104), /without commit|no commit/i);
  await press(dialog, "a");
  assert.equal(await waitForResult(decision, "Fix Now gate decision"), "accept");
});

test("report wrapper routes through the generated viewer and closes on Enter", async () => {
  const h = host();
  const shown = showReportViewer(h.ctx, "# Report\n\nA short report body.", {
    status: "completed",
    findingCount: 1,
    verification: "passed",
    reportPath: ".pi/persona-audit/reports/report.md",
  });
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /Audit Report — completed · 1 findings · verification passed/i);
  assert.match(screen(dialog, 104), /A short report body/);
  assert.equal(h.customOptions.length, 2, "one invisible size probe and one generated overlay");
  await press(dialog, KEY.enter);
  await waitForResult(shown, "report viewer to close");
});
