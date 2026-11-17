import assert from "node:assert/strict";
import test from "node:test";
import { TriageSuggestionFeed, type TriageSuggestion } from "../src/decision/triage.ts";
import type { Finding, FixedFinding, ReviewSessionState, ReviewSortMode } from "../src/types.ts";
import { MIN_DIALOG_SIZE } from "../src/ui/dialog-fit.ts";
import {
  showAdjudicatorRetryPrompt,
  showReviewerRetryPrompt,
  showVerifierRetryPrompt,
  type ReviewerFailure,
} from "../src/ui/retry-prompts.ts";
import {
  dialogRetryModelToPhaseChoice,
  findingsComparator,
  openFindingsReviewDialog,
  openFixGateDialog,
  openRetryCheckpointDialog,
  showFindingsReview,
  showReportViewer,
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

test("the retry prompt opens the generated dialog, with no size probe first", async () => {
  const h = host();
  const result = showReviewerRetryPrompt(
    h.ctx,
    failures,
    { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] },
    "medium",
  );
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /REVIEWER PASSES FAILED/);
  assert.equal(h.customOptions.length, 1, "the generated overlay is the only thing shown");
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
  const outcome = openFindingsReviewDialog(h.ctx, [firstFinding, secondFinding], undefined, initial);
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
  const final = openFindingsReviewDialog(h.ctx, [firstFinding, secondFinding], undefined, restored);
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

test("Findings Review wrapper routes through the generated overlay", async () => {
  const h = host();
  const result = showFindingsReview(h.ctx, [firstFinding], {
    slug: "audit",
    isoDate: "2026-11-12",
    scope: "src/",
    reviewers: ["Security Engineer"],
  });
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /FINDINGS REVIEW/);
  assert.equal(h.customOptions.length, 1, "the generated overlay is the only thing shown");
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
  });
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
  assert.equal(h.customOptions.length, 1, "the generated overlay is the only thing shown");
  await press(dialog, KEY.enter);
  await waitForResult(shown, "report viewer to close");
});

test("on an 80×24 terminal the retry prompt still opens the generated dialog, at 80 columns", async () => {
  const h = createDialogHost({ terminal: MIN_DIALOG_SIZE, models: MODELS, model: MODELS[0] });
  const result = showReviewerRetryPrompt(h.ctx, failures, { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] }, "medium");
  const dialog = await h.dialog();
  const lines = dialog.render(MIN_DIALOG_SIZE.columns).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.length <= MIN_DIALOG_SIZE.rows, `the checkpoint fits ${MIN_DIALOG_SIZE.rows} rows (${lines.length})`);
  assert.match(lines.join("\n"), /REVIEWER PASSES FAILED/);
  assert.match(lines.join("\n"), /Continue\s+Cancel audit/, "the buttons are on screen, uncut");
  await press(dialog, KEY.esc);
  assert.deepEqual(await waitForResult(result, "reviewer retry on a small terminal"), { cancelled: false, retries: [] });
});

test("the retry prompts decline without showing anything outside TUI mode or with no models", async () => {
  const current = { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] };
  const rpc = createDialogHost({ mode: "rpc", models: MODELS, model: MODELS[0] });
  assert.deepEqual(await showReviewerRetryPrompt(rpc.ctx, failures, current, "medium"), { cancelled: false, retries: [] });
  assert.deepEqual(await showAdjudicatorRetryPrompt(rpc.ctx, "boom", current, "medium"), { retry: false });
  assert.deepEqual(await showVerifierRetryPrompt(rpc.ctx, "boom", current, "medium"), { retry: false });
  assert.equal(rpc.customOptions.length, 0);

  const empty = createDialogHost({ terminal: ROOMY_TERMINAL, models: [] });
  assert.deepEqual(await showReviewerRetryPrompt(empty.ctx, failures, current, "medium"), { cancelled: false, retries: [] });
  assert.deepEqual(await showAdjudicatorRetryPrompt(empty.ctx, "boom", current, "medium"), { retry: false });
  assert.deepEqual(await showVerifierRetryPrompt(empty.ctx, "boom", current, "medium"), { retry: false });
  assert.deepEqual(await showReviewerRetryPrompt(host().ctx, [], current, "medium"), { cancelled: false, retries: [] }, "no failures, nothing to ask");
  assert.equal(empty.customOptions.length, 0);
});

test("a retry checkpoint that cannot open is reported and declined", async () => {
  const h = createDialogHost({ terminal: ROOMY_TERMINAL, models: MODELS, model: MODELS[0], failCustom: new Error("overlay refused") });
  const current = { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] };
  assert.deepEqual(await showVerifierRetryPrompt(h.ctx, "boom", current, "medium"), { retry: false });
  assert.match(h.notifications.at(-1)?.message ?? "", /verifier retry dialog failed: overlay refused/);
});

test("the adjudicator checkpoint keeps a picked retry model only when retrying", async () => {
  const h = host();
  const result = showAdjudicatorRetryPrompt(h.ctx, "reconciliation\nfailed", { label: "fakeprov/alpha-reasoner", ref: MODEL_REFS[0] }, "medium");
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /reconciliation failed/, "the detail is shown on one line");
  // Down to the model row and open it; pick the second model, Enter to its thinking pane, Enter
  // to confirm; then Tab to the buttons and Retry.
  await press(dialog, KEY.down, KEY.enter, KEY.down, KEY.enter, KEY.enter);
  assert.match(screen(dialog, 104), /fakeprov\/beta-plain · off/, "the overview shows the picked model");
  await press(dialog, KEY.tab, KEY.enter);
  assert.deepEqual(await waitForResult(result, "adjudicator retry"), { retry: true, model: { ref: MODEL_REFS[1], thinking: "off" } });
});

// ── The review's order ─────────────────────────────────────────────────────

function sortable(n: number, overrides: Partial<Finding> = {}): Finding {
  const id = String(n).padStart(2, "0");
  return {
    reviewer: `Reviewer ${id}`,
    file: `src/file${id}.ts`,
    line: n,
    category: "bug",
    severity: "low",
    rationale: `Rationale ${id}`,
    suggestedChange: `Change ${id}`,
    recommendation: "apply",
    ...overrides,
  };
}

function suggestion(overrides: Partial<TriageSuggestion> = {}): TriageSuggestion {
  return {
    category: "security",
    categoryConfidence: 0.91,
    verdict: "apply",
    verdictConfidence: 0.72,
    changeKind: "behavior",
    changeKindConfidence: 0.65,
    model: "typesafe/jev-latest",
    latencyMs: 120,
    ...overrides,
  } as TriageSuggestion;
}

/** The findings' indexes in the order the comparator puts them under `sort`. */
function ordered(findings: Finding[], sort: ReviewSortMode, feed?: TriageSuggestionFeed): number[] {
  const compare = findingsComparator(findings, feed);
  return findings.map((_, index) => index).sort((a, b) => compare(sort, a, b));
}

test("the review orders by file, priority, reviewer and blast radius as the extension always has", () => {
  const findings = [
    sortable(1, { file: "src/z.ts", severity: "low", reviewer: "beta", blastRadius: { score: 10, level: "low", reasons: [] } }),
    sortable(2, { file: "src/a.ts", severity: "critical", reviewer: "Gamma", blastRadius: { score: 40, level: "medium", reasons: [] } }),
    sortable(3, { file: "src/m.ts", severity: "high", reviewer: "Alpha", blastRadius: { score: 80, level: "critical", reasons: [] } }),
  ];
  assert.deepEqual(ordered(findings, "file"), [1, 2, 0]);
  assert.deepEqual(ordered(findings, "priority"), [1, 2, 0], "without exploitability, severity decides");
  assert.deepEqual(ordered(findings, "reviewer"), [2, 0, 1], "reviewer names compare without case");
  assert.deepEqual(ordered(findings, "blast"), [2, 1, 0], "the widest reach first");
});

test("priority leads with exploitability, ahead of severity", () => {
  const findings = [
    sortable(1, { file: "src/a.ts", severity: "critical", exploitability: "theoretical" }),
    sortable(2, { file: "src/z.ts", severity: "low", exploitability: "direct" }),
    sortable(3, { file: "src/m.ts", severity: "critical" }),
  ];
  assert.deepEqual(ordered(findings, "priority"), [1, 0, 2], "direct outranks theoretical, and no exploitability sorts last");
});

test("the suggested sort orders by the classifier's verdict, then its category, and degrades to priority", () => {
  const findings = [
    sortable(1, { file: "a.ts", triageSuggestion: suggestion({ verdict: "reject", verdictConfidence: 0.9, category: "style", categoryConfidence: 0.8 }) }),
    sortable(2, { file: "b.ts", triageSuggestion: suggestion({ verdict: "apply", verdictConfidence: 0.7, category: "security", categoryConfidence: 0.9 }) }),
    sortable(3, { file: "c.ts", triageSuggestion: suggestion({ verdict: "defer", verdictConfidence: 0.8, category: "bug", categoryConfidence: 0.9 }) }),
    sortable(4, { file: "d.ts" }),
  ];
  assert.deepEqual(ordered(findings, "suggested"), [1, 2, 0, 3]);
  const plain = [sortable(1, { file: "a.ts", severity: "low" }), sortable(2, { file: "b.ts", severity: "critical" })];
  assert.deepEqual(ordered(plain, "suggested"), [1, 0], "with no suggestions it is the priority order");
});

test("the suggested sort reads the live feed, which is where suggestions arrive", () => {
  const findings = [sortable(1, { file: "a.ts" }), sortable(2, { file: "b.ts" })];
  const feed = new TriageSuggestionFeed();
  assert.deepEqual(ordered(findings, "suggested", feed), [0, 1]);
  feed.set(1, suggestion({ verdict: "apply" }));
  feed.set(0, suggestion({ verdict: "reject" }));
  assert.deepEqual(ordered(findings, "suggested", feed), [1, 0]);
});

test("the review dialog lists findings in the extension's order", async () => {
  const h = host();
  const findings = [
    sortable(1, { file: "src/a.ts", severity: "critical", exploitability: "theoretical" }),
    sortable(2, { file: "src/z.ts", severity: "low", exploitability: "direct" }),
  ];
  const outcome = openFindingsReviewDialog(h.ctx, findings);
  const dialog = await h.dialog();
  const rows = () => screen(dialog, 104).split("\n").flatMap((line) => line.match(/src\/[az]\.ts:\d/g) ?? []);
  assert.deepEqual(rows(), ["src/a.ts:1", "src/z.ts:2"], "file order");
  await press(dialog, "s");
  assert.deepEqual(rows(), ["src/z.ts:2", "src/a.ts:1"], "priority: direct exploitability first, though less severe");
  await press(dialog, KEY.esc, KEY.esc);
  assert.equal((await waitForResult(outcome, "review cancel"))?.kind, "cancelled");
});
