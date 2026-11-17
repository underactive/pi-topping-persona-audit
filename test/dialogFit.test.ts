import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { DIALOG_MAX_HEIGHT, DIALOG_WIDTH, FILL_ROOM, MIN_DIALOG_SIZE, type TerminalSize } from "../src/ui/dialog-fit.ts";
import { PurgeMenu, SettingsMenu } from "../src/ui/generated/persona-audit/admin.ts";
import {
  ARTIFACTS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_SETTINGS as SAMPLE_SETTINGS,
  FINDINGS,
  FIX_DIFF,
  FIX_FINDING,
  FIX_VERDICT,
  REPORT,
  REPORT_PATH,
  REVIEWER_FAILURES,
  ROSTERS,
  SESSION_MODEL,
} from "../src/ui/generated/persona-audit/data.ts";
import { FindingsReview } from "../src/ui/generated/persona-audit/findings-review.ts";
import { ExpertPicker, RosterPicker } from "../src/ui/generated/persona-audit/pickers.ts";
import { GuidanceSummary, PhaseModelPicker, RetryCheckpoint, ReviewerSourceMenu } from "../src/ui/generated/persona-audit/prompts.ts";
import { FixGate, ReportViewer } from "../src/ui/generated/persona-audit/viewers.ts";
import { dialogReviewers } from "../src/ui/dialog-models.ts";
import { largest, measureSteps, type Screen } from "./helpers/measure.ts";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const repeat = (key: string, times: number): string[] => Array.from({ length: times }, () => key);

/** A terminal with room to spare: every dialog takes its full size in it. */
const ROOMY: TerminalSize = { columns: 160, rows: 80 };

/**
 * Every generated dialog, with a key script that walks it through each screen it can show, and
 * a fragment of the key legend its last screen ends with. The legend is the dialog's bottom row,
 * so finding it on a screen proves that screen was not cut off at the bottom.
 */
interface DialogScript {
  name: string;
  element: () => ReactNode;
  steps: string[][];
  /** Rows the dialog's tallest screen took at the full size, when pi still measured it against a threshold. */
  fullRows: number;
  legend: RegExp;
}

const many = Array.from({ length: 5 }, (_, k) => ARTIFACTS.map((artifact) => ({ ...artifact, id: `${artifact.id}-${k}` }))).flat();
const longChat = Array.from({ length: 6 }, (_, k) => ({
  role: k % 2 ? ("assistant" as const) : ("user" as const),
  text: `Message ${k + 1}: keep the cookie scope unchanged, and explain why the flags matter for session fixation before you change anything else.`,
}));

const DIALOGS: DialogScript[] = [
  {
    name: "settings: menu, rosters, a roster's slots, the reviewer picker over a slot",
    element: () => createElement(SettingsMenu, { width: DIALOG_WIDTH, initial: structuredClone(SAMPLE_SETTINGS), onDone: () => {} }),
    steps: [[""], [...repeat(DOWN, 5), ENTER], [ENTER], [ENTER]],
    fullRows: 33,
    legend: /esc cancel/,
  },
  {
    name: "settings: the dispatch model's two-pane picker",
    element: () => createElement(SettingsMenu, { width: DIALOG_WIDTH, initial: structuredClone(SAMPLE_SETTINGS), onDone: () => {} }),
    steps: [[""], [...repeat(DOWN, 6), ENTER]],
    fullRows: 33,
    legend: /esc back/,
  },
  {
    name: "purge: a long list, a preview and the confirmation",
    element: () => createElement(PurgeMenu, { width: DIALOG_WIDTH, artifacts: many, onDone: () => {} }),
    steps: [[""], ["p"], [ESC], [TAB, ENTER]],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /enter|esc/,
  },
  {
    name: "reviewer source",
    element: () => createElement(ReviewerSourceMenu, { width: DIALOG_WIDTH, rosterCount: 4, dispatcherLabel: "anthropic/claude-haiku-5-5 · off", onDone: () => {} }),
    steps: [[""]],
    fullRows: 15,
    legend: /esc cancel audit/,
  },
  {
    name: "expert picker, filling the room as it does in pi",
    element: () => createElement(ExpertPicker, {
      width: DIALOG_WIDTH, budget: FILL_ROOM, fileCount: 23, reviewers: dialogReviewers(),
      initial: { reviewers: ["Principal Engineer", "Security Engineer"], passes: 1 }, onDone: () => {},
    }),
    steps: [[""], [" "], [DOWN], [" "], [RIGHT], [RIGHT], [RIGHT], [ENTER], [ENTER], ...Array.from("security", (key) => [key])],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /esc back/,
  },
  {
    name: "roster picker, filling the room as it does in pi",
    element: () => createElement(RosterPicker, { width: DIALOG_WIDTH, budget: FILL_ROOM, fileCount: 23, rosters: ROSTERS, reviewers: dialogReviewers(), onDone: () => {} }),
    steps: [[""], [DOWN], [ENTER], ...Array.from("backend", (key) => [key])],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /esc back/,
  },
  {
    name: "phase models and a phase's model picker",
    element: () => createElement(PhaseModelPicker, { width: DIALOG_WIDTH, initial: DEFAULT_PHASE_MODELS, offerGuidance: true, onDone: () => {} }),
    steps: [[""], [ENTER], [DOWN], [ENTER]],
    fullRows: 34,
    legend: /esc/,
  },
  {
    name: "guidance summary and editor",
    element: () => createElement(GuidanceSummary, {
      width: DIALOG_WIDTH, initialDraft: "Focus on session and billing changes.\ndocs/screens/login.png\ndocs/missing.png", supportsImages: false, onDone: () => {},
    }),
    steps: [[""], [ENTER], ["x"], ["\x13"]],
    fullRows: 34,
    legend: /esc/,
  },
  {
    name: "reviewer retry and its model picker",
    element: () => createElement(RetryCheckpoint, { width: DIALOG_WIDTH, kind: "reviewer", current: SESSION_MODEL, failures: REVIEWER_FAILURES, onDone: () => {} }),
    steps: [[""], [RIGHT], [DOWN], [DOWN], [ENTER]],
    fullRows: 29,
    legend: /esc back/,
  },
  {
    name: "findings review, expanded",
    element: () => createElement(FindingsReview, { width: DIALOG_WIDTH, findings: FINDINGS, onDone: () => {} }),
    steps: [[""], [RIGHT], [DOWN], [TAB]],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /esc cancel/,
  },
  {
    name: "Fix Now gate with notes and a long chat",
    element: () => createElement(FixGate, {
      width: DIALOG_WIDTH, finding: FIX_FINDING, diff: FIX_DIFF, verdict: FIX_VERDICT,
      warnings: ["Auto-commit is off for this fix.", "src/server/session.ts had uncommitted changes before the fix; they are kept and excluded from the commit."],
      commitPlanned: false, attempt: 2, chat: longChat, onDone: () => {},
    }),
    steps: [[""], ["c"], [ESC], [TAB]],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /discard/,
  },
  {
    name: "report viewer",
    element: () => createElement(ReportViewer, { width: DIALOG_WIDTH, title: "Audit Report", path: REPORT_PATH, markdown: REPORT, onDone: () => {} }),
    steps: [[""], [DOWN]],
    fullRows: Number.POSITIVE_INFINITY,
    legend: /g\/G top\/bottom/,
  },
];

/** The visible columns a dialog of `width` leaves: its panel keeps two blank columns on the right. */
const visible = (width: number): number => width - 2;

test("the dialogs ask pi for the whole height and lay out their own rows", () => {
  assert.equal(DIALOG_MAX_HEIGHT, 1);
  assert.deepEqual(MIN_DIALOG_SIZE, { columns: 80, rows: 24 });
});

for (const dialog of DIALOGS) {
  test(`full size: ${dialog.name} keeps its ${DIALOG_WIDTH}-column layout where there is room`, async () => {
    const screens = await measureSteps(dialog.element(), dialog.steps, ROOMY);
    const size = largest(screens);
    assert.equal(size.columns, visible(DIALOG_WIDTH));
    if (Number.isFinite(dialog.fullRows)) assert.ok(size.rows <= dialog.fullRows, `${size.rows} rows, up from ${dialog.fullRows}`);
  });

  test(`80×24: ${dialog.name} fits every screen with its controls on screen`, async () => {
    const screens: Screen[] = await measureSteps(dialog.element(), dialog.steps, MIN_DIALOG_SIZE);
    screens.forEach((screen, index) => {
      assert.ok(screen.size.columns <= visible(MIN_DIALOG_SIZE.columns), `screen ${index} reaches column ${screen.size.columns}: it is wider than the room\n${screen.text}`);
      assert.ok(screen.size.rows <= MIN_DIALOG_SIZE.rows, `screen ${index} has ${screen.size.rows} rows`);
    });
    const last = screens.at(-1)!;
    assert.match(last.text, dialog.legend, `the key legend is cut off the last screen\n${last.text}`);
    for (const [index, screen] of screens.entries()) {
      assert.match(screen.text, /─{20,}/, `screen ${index} lost its footer rules\n${screen.text}`);
    }
  });
}

test("80×24: the Fix Now gate gives up its rationale, gaps and old chat before the diff", async () => {
  const [screen] = await measureSteps(createElement(FixGate, {
    width: DIALOG_WIDTH, finding: { ...FIX_FINDING, rationale: FIX_FINDING.rationale.repeat(4) }, diff: FIX_DIFF, verdict: FIX_VERDICT,
    warnings: ["Auto-commit is off for this fix."], commitPlanned: true, attempt: 1, chat: longChat, onDone: () => {},
  }), [[""]], MIN_DIALOG_SIZE);
  const text = screen!.text;
  assert.match(text, /^.*…\s*$/m, "the rationale is cut to a row ending in …");
  assert.match(text, /Message 6/, "the newest chat line stays");
  assert.doesNotMatch(text, /Message 1:/, "the oldest chat lines give way");
  const diffRows = text.split("\n").filter((line) => /^\s*▌\s+(diff --git|index |--- |\+\+\+ |@@|[+-])/.test(line));
  assert.ok(diffRows.length >= 3, `the diff keeps three rows (${diffRows.length})\n${text}`);
  assert.match(text, /esc esc discard/, "the legend is on screen");
});

test("below 80×24 a dialog keeps its 80×24 layout, and pi cuts what does not fit", async () => {
  const [small] = await measureSteps(createElement(ReviewerSourceMenu, {
    width: DIALOG_WIDTH, rosterCount: 1, dispatcherLabel: "session model", onDone: () => {},
  }), [[""]], { columns: 60, rows: 20 });
  // Laid out for 80 columns, it reaches the edge of a 60-column room instead of keeping two blank columns.
  assert.equal(small!.size.columns, 60);
});
