import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FindingsReview, type ReviewHost, type ReviewTheme } from "../src/components/FindingsReview.ts";
import type { Finding, FindingsReviewResult } from "../src/types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Stand-in for the theme's selected-row background, so tests can spot the highlight. */
const HIGHLIGHT = "\x1b[48;5;236m";

const theme: ReviewTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text) => text,
};

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const SPACE = " ";
const ESCAPE = "\x1b";
const ENTER = "\r";
const WIDTH = 80;

/** The height the overlay is shown with, and therefore the height the host clips at. */
const clipBudget = (rows: number): number => Math.floor((rows * 85) / 100);

/** A finding whose rationale and suggested change both wrap, as real ones do. */
function finding(n: number, overrides: Partial<Finding> = {}): Finding {
  const id = String(n).padStart(2, "0");
  return {
    reviewer: `Reviewer ${id}`,
    file: `src/file${id}.ts`,
    line: n,
    category: "bug",
    severity: "low",
    rationale: `Rationale ${id} explaining at length why this finding matters to a reader`,
    suggestedChange: `Change ${id} describing the edit in enough words to wrap the column`,
    recommendation: "apply",
    ...overrides,
  };
}

/**
 * Drives the overlay the way the host does: render at the overlay width, then
 * clip to the overlay height. Assertions run against the clipped lines, since
 * anything past the budget is dropped before the user ever sees it.
 */
function harness(findings: Finding[], rows: number) {
  const host: ReviewHost = { requestRender: () => {}, terminal: { rows } };
  const settled: (FindingsReviewResult | null)[] = [];
  const component = new FindingsReview(findings, theme, (result) => settled.push(result), host, async () => "handoff.md");
  const visible = (): string[] => component.render(WIDTH).slice(0, clipBudget(rows));
  return {
    component,
    press: (key: string): void => component.handleInput(key),
    rendered: (): string[] => component.render(WIDTH),
    visible,
    /** Every value handed to `done` — empty until the overlay resolves. */
    settled: (): (FindingsReviewResult | null)[] => settled,
    /** The highlighted row, which is also the row carrying the selection marker. */
    selected: (): string | undefined => visible().find((line) => line.includes(HIGHLIGHT)),
  };
}

const list = (count: number): Finding[] => Array.from({ length: count }, (_, i) => finding(i + 1));

test("the overlay never renders past the height the host clips at", () => {
  const rows = 24;
  const ui = harness(list(12), rows);

  for (let i = 1; i <= 12; i++) {
    const lines = ui.rendered();
    assert.ok(
      lines.length <= clipBudget(rows),
      `finding ${i}: rendered ${lines.length} lines, budget is ${clipBudget(rows)}`,
    );
    ui.press(DOWN);
  }
});

test("every finding can be selected without the marker scrolling out of view", () => {
  const ui = harness(list(12), 24);

  for (let i = 1; i <= 12; i++) {
    const row = ui.selected();
    assert.ok(row, `finding ${i} has a visible highlighted row`);
    assert.match(strip(row), new RegExp(`❯ .*Reviewer ${String(i).padStart(2, "0")}`));
    ui.press(DOWN);
  }

  // …and back up again, starting from where the descent left off.
  for (let i = 12; i >= 1; i--) {
    const row = ui.selected();
    assert.ok(row, `finding ${i} is still reachable going back up`);
    assert.match(strip(row), new RegExp(`❯ .*Reviewer ${String(i).padStart(2, "0")}`));
    ui.press(UP);
  }
});

test("a finding taller than the viewport pins to its top rather than vanishing", () => {
  const tall = finding(2, { rationale: "word ".repeat(200).trim(), suggestedChange: "edit ".repeat(200).trim() });
  const ui = harness([finding(1), tall, finding(3)], 20);

  ui.press(DOWN);
  const row = ui.selected();
  assert.ok(row, "the oversized finding still shows its selected row");
  assert.match(strip(row), /❯ .*Reviewer 02/);
});

test("the footer survives a list longer than the viewport", () => {
  const lines = harness(list(30), 24).visible().map(strip);

  assert.match(lines[lines.length - 1] ?? "", /^╚═+╝$/, "the bottom border is not clipped away");
  assert.match(lines[lines.length - 2] ?? "", /30 apply · 0 reject · 0 defer/);
  assert.match(lines[lines.length - 2] ?? "", /1\/30\s*║$/, "the footer counts the selection's position");
});

test("hidden findings are reported above and below the window", () => {
  const ui = harness(list(30), 24);
  for (let i = 0; i < 10; i++) ui.press(DOWN);

  const hint = ui.visible().map(strip).find((line) => line.includes("above") || line.includes("below"));
  assert.ok(hint, "a scroll hint appears once findings fall outside the window");
  assert.match(hint, /↑ \d+ above/);
  assert.match(hint, /↓ \d+ below/);
});

test("a list that fits shows no scroll hint", () => {
  const lines = harness(list(2), 40).visible().map(strip);

  assert.equal(lines.filter((line) => line.includes("above") || line.includes("below")).length, 0);
});

test("the selected row is highlighted across the full overlay width", () => {
  const row = harness(list(4), 40).selected();

  assert.ok(row);
  assert.equal(visibleWidth(row), WIDTH, "the highlight bar spans the whole overlay");
  assert.match(strip(row), /^║ {2}❯ \[APPLY] {2}low {6}Reviewer 01/);
});

test("status and severity columns hold their width as statuses cycle", () => {
  const ui = harness(list(3), 40);
  const reviewerColumn = (row: string): number => strip(row).indexOf("Reviewer");

  const applyRow = ui.selected();
  ui.press(SPACE);
  const rejectRow = ui.selected();
  ui.press(SPACE);
  const deferRow = ui.selected();

  assert.ok(applyRow && rejectRow && deferRow);
  assert.match(strip(rejectRow), /\[REJECT]/);
  assert.match(strip(deferRow), /\[DEFER]/);
  assert.equal(reviewerColumn(rejectRow), reviewerColumn(applyRow), "[REJECT] does not shift the reviewer column");
  assert.equal(reviewerColumn(deferRow), reviewerColumn(applyRow), "[DEFER] does not shift the reviewer column");
});

test("severe findings keep their uppercase emphasis without breaking alignment", () => {
  const ui = harness([finding(1, { severity: "critical" }), finding(2, { severity: "low" })], 40);

  const critical = ui.selected();
  ui.press(DOWN);
  const low = ui.selected();

  assert.ok(critical && low);
  assert.match(strip(critical), /CRITICAL/);
  assert.equal(strip(low).indexOf("Reviewer"), strip(critical).indexOf("Reviewer"));
});

test("one Esc arms the cancel rather than discarding the review", () => {
  const ui = harness(list(3), 24);

  ui.press(ESCAPE);

  assert.deepEqual(ui.settled(), [], "the overlay has not resolved yet");
  assert.ok(
    ui.visible().map(strip).some((line) => line.includes("Press Esc again to cancel")),
    "the armed state is spelled out in the footer",
  );
  assert.ok(ui.rendered().length <= clipBudget(24), "the confirmation line stays inside the height budget");
});

test("a second Esc confirms the cancel", () => {
  const ui = harness(list(3), 24);

  ui.press(ESCAPE);
  ui.press(ESCAPE);

  assert.deepEqual(ui.settled(), [null], "cancelling resolves null");
});

test("any other key disarms the cancel and keeps the triage decisions", () => {
  const ui = harness(list(3), 24);

  ui.press(SPACE);
  ui.press(ESCAPE);
  ui.press(DOWN);

  assert.ok(
    !ui.visible().map(strip).some((line) => line.includes("Press Esc again to cancel")),
    "the armed state clears once the user keeps working",
  );

  ui.press(ESCAPE);
  ui.press(ENTER);

  const [result] = ui.settled();
  assert.ok(result, "Enter still finishes the review after a disarmed Esc");
  assert.equal(result.rejected.length, 1, "the earlier reject survived the disarmed cancel");
  assert.equal(result.accepted.length, 2);
});
