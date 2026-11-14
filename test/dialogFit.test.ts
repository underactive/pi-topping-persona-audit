import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { dialogFits, DIALOG_MAX_HEIGHT, FIX_GATE_DIALOG_SIZE, FINDINGS_REVIEW_DIALOG_SIZE, MIN_SIZE_PROBE_HOST_VERSION, PURGE_DIALOG_SIZE, readTerminalSize, REPORT_VIEWER_DIALOG_SIZE, RETRY_DIALOG_SIZE, SETTINGS_DIALOG_SIZE } from "../src/ui/dialog-fit.ts";
import { PurgeMenu, SettingsMenu } from "../src/ui/generated/persona-audit/admin.ts";
import { ARTIFACTS, DEFAULT_PHASE_MODELS, DEFAULT_SETTINGS as SAMPLE_SETTINGS, ROSTERS } from "../src/ui/generated/persona-audit/data.ts";
import { ExpertPicker, RosterPicker } from "../src/ui/generated/persona-audit/pickers.ts";
import { GuidanceSummary, PhaseModelPicker, ReviewerSourceMenu, RetryCheckpoint } from "../src/ui/generated/persona-audit/prompts.ts";
import { FindingsReview as OpenTuiFindingsReview } from "../src/ui/generated/persona-audit/findings-review.ts";
import { FixGate as OpenTuiFixGate, ReportViewer as OpenTuiReportViewer } from "../src/ui/generated/persona-audit/viewers.ts";
import { FINDINGS, FIX_DIFF, FIX_FINDING, FIX_VERDICT, REPORT, REPORT_PATH, REVIEWER_FAILURES, SESSION_MODEL } from "../src/ui/generated/persona-audit/data.ts";
import { PICKER_DIALOG_SIZE } from "../src/ui/picker-dialogs.ts";
import { dialogReviewers } from "../src/ui/dialog-models.ts";
import { FRAME_ROWS } from "../src/ui/generated/ui.ts";
import { createDialogHost } from "./helpers/dialog-harness.ts";
import { largest, measureSteps } from "./helpers/measure.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const repeat = (key: string, times: number): string[] => Array.from({ length: times }, () => key);

test("dialogFits needs every column and every row of the dialog", () => {
  for (const dialog of [SETTINGS_DIALOG_SIZE, PURGE_DIALOG_SIZE, RETRY_DIALOG_SIZE, FINDINGS_REVIEW_DIALOG_SIZE, FIX_GATE_DIALOG_SIZE, REPORT_VIEWER_DIALOG_SIZE, ...Object.values(PICKER_DIALOG_SIZE)]) {
    assert.equal(dialogFits(dialog, dialog), true, "a terminal exactly the dialog's size fits it");
    assert.equal(dialogFits({ columns: dialog.columns + 60, rows: dialog.rows + 30 }, dialog), true);
    assert.equal(dialogFits({ columns: dialog.columns - 1, rows: dialog.rows + 30 }, dialog), false, "one column short");
    assert.equal(dialogFits({ columns: dialog.columns + 60, rows: dialog.rows - 1 }, dialog), false, "one row short");
    assert.equal(dialogFits(undefined, dialog), false, "an unknown size counts as too small");
  }
});

test("the settings threshold holds its widest and tallest screen", async () => {
  const settings = (): ReturnType<typeof createElement> => createElement(SettingsMenu, { width: SETTINGS_DIALOG_SIZE.columns, initial: structuredClone(SAMPLE_SETTINGS), onDone: () => {} });
  const screens = await measureSteps(settings(), [
    [""],
    // The roster list, a roster's slots and the reviewer picker over a slot.
    [...repeat(DOWN, 5), ENTER],
    [ENTER],
    [ENTER],
  ]);
  const screensOfPickers = await measureSteps(settings(), [
    [...repeat(DOWN, 6), ENTER], // the dispatch model's two-pane picker
  ]);
  const classifier = await measureSteps(settings(), [[...repeat(DOWN, 8), ENTER]]);
  const measured = largest([...screens, ...screensOfPickers, ...classifier]);
  // The panel reserves two columns to the right of its contents.
  assert.deepEqual(measured, { columns: SETTINGS_DIALOG_SIZE.columns - 2, rows: SETTINGS_DIALOG_SIZE.rows });
  assert.equal(DIALOG_MAX_HEIGHT, 1, "the fit rule compares rows directly, which holds only while a dialog may use every row");
});

test("each pre-run dialog threshold matches the widest and tallest screen it can draw", async () => {
  const { source, experts, rosters, phases, guidance } = PICKER_DIALOG_SIZE;
  const sourceScreen = await measureSteps(createElement(ReviewerSourceMenu, {
    width: source.columns, rosterCount: 4, dispatcherLabel: "anthropic/claude-haiku-5-5 · off", onDone: () => {},
  }), [[""]]);
  const expertSteps = [
    [""], [" "], [DOWN], [" "], ["\x1b[C"], ["\x1b[C"], ["\x1b[C"], [ENTER], [ENTER],
    ...Array.from("security", (key) => [key]),
  ];
  const expertScreens = await measureSteps(createElement(ExpertPicker, {
    width: experts.columns, budget: Math.max(1, experts.rows - FRAME_ROWS - 14), fileCount: 23,
    initial: { reviewers: ["Principal Engineer", "Security Engineer"], passes: 1 }, reviewers: dialogReviewers(), onDone: () => {},
  }), expertSteps);
  const rosterScreens = await measureSteps(createElement(RosterPicker, {
    width: rosters.columns, budget: Math.max(1, rosters.rows - FRAME_ROWS - 14), fileCount: 23,
    rosters: ROSTERS, reviewers: dialogReviewers(), onDone: () => {},
  }), [[""], [DOWN], [ENTER], ...Array.from("backend", (key) => [key])]);
  const phaseScreens = await measureSteps(createElement(PhaseModelPicker, {
    width: phases.columns, initial: DEFAULT_PHASE_MODELS, offerGuidance: true, onDone: () => {},
  }), [[""], [ENTER], [DOWN], [ENTER]]);
  const guidanceScreens = await measureSteps(createElement(GuidanceSummary, {
    width: guidance.columns, initialDraft: "Focus on session and billing changes.\ndocs/screens/login.png\ndocs/missing.png", supportsImages: false, onDone: () => {},
  }), [[""], [ENTER], ["x"], ["\x13"]]);
  const cases = [
    ["source", source, largest(sourceScreen)],
    ["experts", experts, largest(expertScreens)],
    ["rosters", rosters, largest(rosterScreens)],
    ["phases", phases, largest(phaseScreens)],
    ["guidance", guidance, largest(guidanceScreens)],
  ] as const;
  for (const [name, threshold, measured] of cases) {
    assert.deepEqual(measured.columns, threshold.columns - 2, `${name} columns`);
    assert.ok(measured.rows <= threshold.rows, `${name}: ${measured.rows} rows do not fit ${threshold.rows}`);
  }
  assert.match(expertScreens.at(-1)!.text, /esc back/, "expert picker keeps the key hints");
  assert.match(rosterScreens.at(-1)!.text, /esc back/, "roster picker keeps the key hints");
  assert.match(phaseScreens.at(-1)!.text, /esc models/, "phase model sub-picker keeps the key hints");
  assert.ok(guidanceScreens[1]!.text.includes("esc/ctrl+s"), "guidance editor keeps its key hints");
});

test("the purge threshold keeps its buttons and key hints on screen however long the list", async () => {
  const many = Array.from({ length: 5 }, (_, k) => ARTIFACTS.map((artifact) => ({ ...artifact, id: `${artifact.id}-${k}` }))).flat();
  const { columns, rows } = PURGE_DIALOG_SIZE;
  const purge = (): ReturnType<typeof createElement> => createElement(PurgeMenu, { width: columns, height: Math.max(rows - 6, 20), artifacts: many, onDone: () => {} });
  // The list, a preview, and the confirmation, each in a terminal of exactly the threshold's rows.
  const screens = await measureSteps(purge(), [[""], ["p"], ["\x1b"], ["\t", ENTER]], { columns, rows });
  for (const screen of screens) {
    assert.ok(screen.size.rows <= rows, `a screen of ${screen.size.rows} rows does not fit ${rows}`);
    assert.ok(screen.size.columns <= columns - 2, `a screen of ${screen.size.columns} columns does not fit ${columns}`);
  }
  assert.match(screens[0]!.text, /esc cancel/, "the list keeps its key hints");
  assert.match(screens[0]!.text, /Purge tagged/, "the list keeps its buttons");
});

test("readTerminalSize reads the TUI's terminal and shows nothing", async () => {
  const host = createDialogHost({ terminal: { columns: 132, rows: 43 } });
  assert.deepEqual(await readTerminalSize(host.ctx, MIN_SIZE_PROBE_HOST_VERSION), { columns: 132, rows: 43 });
  assert.equal(host.shown.length, 0, "the probe dialog is dropped, not shown");
});

test("readTerminalSize does not probe a pi older than 1.3.0, and reports an unreadable terminal as unknown", async () => {
  const old = createDialogHost({ terminal: { columns: 132, rows: 43 } });
  assert.equal(await readTerminalSize(old.ctx, "1.2.0"), undefined);
  assert.equal(old.customOptions.length, 0);
  assert.equal(await readTerminalSize(createDialogHost().ctx, MIN_SIZE_PROBE_HOST_VERSION), undefined, "a TUI with no terminal size");
  assert.equal(await readTerminalSize(createDialogHost({ failCustom: new Error("no overlay") }).ctx, MIN_SIZE_PROBE_HOST_VERSION), undefined);
});

test("review dialog thresholds cover their tallest nested screens and retain controls", async () => {
  const reviewerRetry = await measureSteps(createElement(RetryCheckpoint, {
    width: RETRY_DIALOG_SIZE.columns,
    kind: "reviewer",
    current: SESSION_MODEL,
    failures: REVIEWER_FAILURES,
    onDone: () => {},
  }), [[""], ["\u001b[C"], [DOWN], [DOWN], [ENTER]], RETRY_DIALOG_SIZE);
  const findings = await measureSteps(createElement(OpenTuiFindingsReview, {
    width: FINDINGS_REVIEW_DIALOG_SIZE.columns,
    height: FINDINGS_REVIEW_DIALOG_SIZE.rows,
    findings: FINDINGS,
    onDone: () => {},
  }), [[""], ["\u001b[C"], [DOWN]], FINDINGS_REVIEW_DIALOG_SIZE);
  const fixGate = await measureSteps(createElement(OpenTuiFixGate, {
    width: FIX_GATE_DIALOG_SIZE.columns,
    height: FIX_GATE_DIALOG_SIZE.rows,
    finding: FIX_FINDING,
    diff: FIX_DIFF,
    verdict: FIX_VERDICT,
    warnings: ["Auto-commit is off for this fix."],
    commitPlanned: false,
    attempt: 2,
    onDone: () => {},
  }), [[""]], FIX_GATE_DIALOG_SIZE);
  const report = await measureSteps(createElement(OpenTuiReportViewer, {
    width: REPORT_VIEWER_DIALOG_SIZE.columns,
    height: REPORT_VIEWER_DIALOG_SIZE.rows,
    title: "Audit Report",
    path: REPORT_PATH,
    markdown: REPORT,
    onDone: () => {},
  }), [[""]], REPORT_VIEWER_DIALOG_SIZE);

  const measured = [
    ["retry model picker", RETRY_DIALOG_SIZE, largest(reviewerRetry)],
    ["findings review", FINDINGS_REVIEW_DIALOG_SIZE, largest(findings)],
    ["Fix Now gate", FIX_GATE_DIALOG_SIZE, largest(fixGate)],
    ["report viewer", REPORT_VIEWER_DIALOG_SIZE, largest(report)],
  ] as const;
  for (const [name, threshold, actual] of measured) {
    assert.equal(actual.columns, threshold.columns - 2, `${name} content width`);
    assert.ok(actual.rows <= threshold.rows, `${name}: ${actual.rows} rows do not fit ${threshold.rows}`);
  }
  assert.match(reviewerRetry.at(-1)!.text, /esc back/, "retry model picker keeps its back hint");
  assert.match(findings[0]!.text, /enter.*finish/i, "findings review keeps the finish hint");
  assert.match(fixGate[0]!.text, /Accept/, "Fix Now gate keeps its accept action");
  assert.match(report[0]!.text, /g\/G top\/bottom/, "report viewer keeps its navigation hint");
});

