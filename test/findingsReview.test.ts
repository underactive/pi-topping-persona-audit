import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FindingsReview, type ReviewHost, type ReviewTheme } from "../src/components/FindingsReview.ts";
import type { Finding, FindingsReviewOutcome, FindingsReviewResult, ReviewSessionState } from "../src/types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Stand-in for the theme's selected-row background, so tests can spot the highlight. */
const HIGHLIGHT = "\x1b[48;5;236m";

const theme: ReviewTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text) => text,
};

const tagged: ReviewTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (_color, text) => text,
  bold: (text) => `<b>${text}</b>`,
};

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const SPACE = " ";
const ESCAPE = "\x1b";
const ENTER = "\r";
const WIDTH = 80;

/** The height the overlay is shown with, and therefore the height the host clips at. */
const clipBudget = (rows: number): number => Math.floor((rows * 75) / 100);

/** A finding with a one-line summary and the longer rationale and suggested change real ones carry. */
function finding(n: number, overrides: Partial<Finding> = {}): Finding {
  const id = String(n).padStart(2, "0");
  return {
    reviewer: `Reviewer ${id}`,
    file: `src/file${id}.ts`,
    line: n,
    category: "bug",
    severity: "low",
    summary: `Summary ${id} stating the problem in plain words`,
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
function harness(findings: Finding[], rows: number, restore?: ReviewSessionState, activeTheme: ReviewTheme = theme) {
  const host: ReviewHost = { requestRender: () => {}, terminal: { rows } };
  const settled: FindingsReviewOutcome[] = [];
  const component = new FindingsReview(findings, activeTheme, (outcome) => settled.push(outcome), host, async () => "handoff.md", undefined, restore);
  const visible = (): string[] => component.render(WIDTH).slice(0, clipBudget(rows));
  return {
    component,
    press: (key: string): void => component.handleInput(key),
    rendered: (): string[] => component.render(WIDTH),
    visible,
    /** The visible lines with colors stripped, joined for multi-line matching. */
    text: (): string => visible().map(strip).join("\n"),
    /** Every value handed to `done` — empty until the overlay resolves. */
    settled: (): FindingsReviewOutcome[] => settled,
    /** The finalized result of the first settle, when it was Enter. */
    result: (): FindingsReviewResult | undefined =>
      settled[0]?.kind === "finalized" ? settled[0].result : undefined,
    /** The highlighted row, which is also the row carrying the selection marker. */
    selected: (): string | undefined => visible().find((line) => line.includes(HIGHLIGHT)),
  };
}

const list = (count: number): Finding[] => Array.from({ length: count }, (_, i) => finding(i + 1));

test("the overlay never renders past the height the host clips at", () => {
  const rows = 24;
  const ui = harness(list(12), rows);

  for (let i = 1; i <= 12; i++) {
    const before = ui.rendered().length;
    assert.ok(before <= clipBudget(rows), `finding ${i} before expanding: rendered ${before} lines, budget is ${clipBudget(rows)}`);
    ui.press(RIGHT);
    const after = ui.rendered().length;
    assert.ok(after <= clipBudget(rows), `finding ${i} expanded: rendered ${after} lines, budget is ${clipBudget(rows)}`);
    ui.press(DOWN);
  }
});

test("every finding can be selected without the marker scrolling out of view", () => {
  const ui = harness(list(12), 24);

  for (let i = 1; i <= 12; i++) {
    const row = ui.selected();
    assert.ok(row, `finding ${i} has a visible highlighted row`);
    assert.match(strip(row), new RegExp(`❯ .*Reviewer ${String(i).padStart(2, "0")}`));
    ui.press(RIGHT);
    assert.match(strip(ui.selected() ?? ""), new RegExp(`⌄ .*Reviewer ${String(i).padStart(2, "0")}`), `finding ${i} stays visible while expanded`);
    ui.press(DOWN);
  }

  // …and back up again, starting from where the descent left off. Every finding
  // the descent opened is still open, so each row comes back with its ⌄.
  for (let i = 12; i >= 1; i--) {
    const row = ui.selected();
    assert.ok(row, `finding ${i} is still reachable going back up`);
    assert.match(strip(row), new RegExp(`⌄ .*Reviewer ${String(i).padStart(2, "0")}`), `finding ${i} is still open`);
    ui.press(UP);
  }
});

test("a finding taller than the viewport pins to its top rather than vanishing", () => {
  const tall = finding(2, { summary: "word ".repeat(200).trim(), rationale: "more ".repeat(200).trim() });
  const ui = harness([finding(1), tall, finding(3)], 20);

  ui.press(DOWN);
  let row = ui.selected();
  assert.ok(row, "the oversized summary still shows its selected row");
  assert.match(strip(row), /❯ .*Reviewer 02/);

  ui.press(RIGHT);
  row = ui.selected();
  assert.ok(row, "expanding it keeps the selected row on screen");
  assert.match(strip(row), /⌄ .*Reviewer 02/);
});

test("the marker turns downward only while the finding is expanded", () => {
  const ui = harness(list(3), 40);

  assert.match(strip(ui.selected() ?? ""), /^║ {2}❯ \[APPLY]/);

  ui.press(RIGHT);
  assert.match(strip(ui.selected() ?? ""), /^║ {2}⌄ \[APPLY]/, "expanding points the marker down");

  ui.press(LEFT);
  assert.match(strip(ui.selected() ?? ""), /^║ {2}❯ \[APPLY]/, "collapsing restores the chevron");

  ui.press(RIGHT);
  ui.press(DOWN);
  assert.match(strip(ui.selected() ?? ""), /^║ {2}❯ \[APPLY]/, "the finding the highlight lands on starts collapsed");
  const leftBehind = ui.visible().map(strip).find((line) => line.includes("Reviewer 01"));
  assert.match(leftBehind ?? "", /^║ {2}⌄ \[APPLY]/, "the finding left behind keeps its downward marker");
});

test("an open finding keeps its downward marker while the highlight is elsewhere", () => {
  const review = harness(list(2), 40, undefined, tagged).component;
  review.handleInput(RIGHT);
  review.handleInput(DOWN);
  // The tags count toward each row's width, so render wide enough that no row is clipped.
  const rows = review.render(200).map((line) => strip(line));

  assert.match(rows.find((line) => line.includes("Reviewer 01")) ?? "", /^<border>║<\/border> {2}<dim>⌄<\/dim>/, "the unselected open row points down, dimmed");
  assert.match(rows.find((line) => line.includes("Reviewer 02")) ?? "", /^<border>║<\/border> {2}<b><accent>❯<\/accent><\/b>/, "the selected collapsed row keeps the bold chevron");
});

test("PageUp and PageDown move through one rendered page and clamp at both ends", () => {
  const ui = harness(list(30), 24);

  ui.rendered();
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/);

  // Collapsed findings are five lines each and the body holds nine, so the
  // second finding straddles the page boundary and the third is the first to fit.
  ui.press(PAGE_DOWN);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 03/);

  ui.press(PAGE_UP);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/);

  for (let i = 0; i < 100; i++) ui.press(PAGE_DOWN);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 30/);

  ui.press(PAGE_DOWN);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 30/);

  for (let i = 0; i < 100; i++) ui.press(PAGE_UP);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/);
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

test("every row renders its location in bold text, selected or not", () => {
  const review = harness([finding(1), finding(2)], 40, undefined, tagged).component;
  // The tags count toward each row's width, so render wide enough that no row is clipped.
  const text = review.render(200).join("\n");

  assert.match(text, /Reviewer 01 <b><text>src\/file01\.ts:1<\/text><\/b>/, "the selected row");
  assert.match(text, /Reviewer 02 <b><text>src\/file02\.ts:2<\/text><\/b>/, "an unselected row");
});

test("A, R, and D set the selected finding directly", () => {
  const ui = harness([finding(1)], 40);
  const statusRow = (): string => strip(ui.selected() ?? "");

  ui.press("R");
  assert.match(statusRow(), /\[REJECT]/);
  ui.press("D");
  assert.match(statusRow(), /\[DEFER]/);
  ui.press("A");
  assert.match(statusRow(), /\[APPLY]/);
});

test("O no longer overrides a deferred finding", () => {
  const ui = harness([finding(1, { recommendation: "defer" })], 40);
  const statusRow = (): string => strip(ui.selected() ?? "");

  assert.match(statusRow(), /\[DEFER]/);
  ui.press("A");
  assert.match(statusRow(), /\[APPLY]/);
  ui.press("O");
  assert.match(statusRow(), /\[APPLY]/);
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

test("the cancel confirmation counts Fix Now fixes that cancelling keeps", () => {
  const findings = list(3);
  const ui = harness(findings, 40, {
    statuses: ["fixed", "fixed", "apply"],
    selectedIndex: 2,
    fixed: new Map([
      [0, { finding: findings[0]!, commitSha: "abc1234", files: ["src/file01.ts"] }],
      [1, { finding: findings[1]!, commitSha: "def5678", files: ["src/file02.ts"] }],
    ]),
  });

  ui.press(ESCAPE);

  // The confirmation wraps inside the frame, so rejoin its lines before matching.
  const text = ui.visible().map((line) => strip(line).replace(/^║\s*|\s*║$/g, "")).join(" ");
  assert.match(text, /Press Esc again to cancel the audit — 2 Fix Now fixes kept, no others applied · any other key resumes/);
  assert.doesNotMatch(text, /no fixes applied/);
  assert.ok(ui.rendered().length <= clipBudget(40), "the wrapped confirmation stays inside the height budget");
});

test("a second Esc confirms the cancel", () => {
  const ui = harness(list(3), 24);

  ui.press(ESCAPE);
  ui.press(ESCAPE);

  assert.deepEqual(ui.settled(), [{ kind: "cancelled" }], "cancelling resolves the cancelled outcome");
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

  const result = ui.result();
  assert.ok(result, "Enter still finishes the review after a disarmed Esc");
  assert.equal(result.rejected.length, 1, "the earlier reject survived the disarmed cancel");
  assert.equal(result.accepted.length, 2);
});

test("an expanded finding renders labeled summary, rationale, and suggested-change sections", () => {
  const ui = harness([
    finding(1, {
      summary: "The parser keeps all output after the question.",
      rationale: "Open Question regex captures all remaining output as the question shown to the user",
      suggestedChange: "Stop at the next heading before opening the editor.",
    }),
  ], 60);
  ui.press(RIGHT);
  const rendered = ui.text();

  assert.ok(rendered.indexOf("Summary:") < rendered.indexOf("Rationale (bug):"));
  assert.ok(rendered.indexOf("Rationale (bug):") < rendered.indexOf("Suggested Change:"));
  assert.match(rendered, /Reviewer 01 src\/file01\.ts:1/);
  assert.match(rendered, /parser keeps all output/i);
  assert.match(rendered, /Rationale \(bug\):[^\n]*\n[^\n]*Open Question regex/);
  assert.doesNotMatch(rendered, /bug:1 —/);
  assert.match(rendered, /Stop at the next heading/);
  assert.doesNotMatch(rendered, /→ Stop at the next heading/, "the suggested change is a labeled block, not an arrow-prefixed line");
});

test("findings without a summary defensively display the rationale as their summary", () => {
  const rendered = harness([finding(1, { summary: undefined })], 60).text();

  assert.match(rendered, /Summary:[^\n]*\n[^\n]*Rationale 01 explaining/);
  assert.doesNotMatch(rendered, /Rationale \(/, "the fallback shows in the Summary block, not as an expanded Rationale");
});

// ── Expand / collapse ─────────────────────────────────────────────────────────

test("findings open collapsed to their row and Summary", () => {
  const text = harness(list(2), 60).text();

  assert.match(text, /Reviewer 01 src\/file01\.ts:1[^\n]*\n[^\n]*Summary:[^\n]*\n[^\n]*Summary 01 stating the problem/);
  assert.match(text, /Reviewer 02 src\/file02\.ts:2[^\n]*\n[^\n]*Summary:[^\n]*\n[^\n]*Summary 02 stating the problem/);
  assert.doesNotMatch(text, /Rationale \(|Suggested Change:/);
  assert.doesNotMatch(text, /Rationale 0\d explaining|Change 0\d describing/);
});

test("→ expands only the highlighted finding and ← collapses it again", () => {
  const ui = harness(list(2), 60);

  ui.press(RIGHT);
  let text = ui.text();
  assert.match(text, /Summary 01 stating the problem/, "the Summary stays above the details");
  assert.match(text, /Rationale \(bug\):[^\n]*\n[^\n]*Rationale 01 explaining/);
  assert.match(text, /Suggested Change:[^\n]*\n[^\n]*Change 01 describing/);
  assert.doesNotMatch(text, /Rationale 02 explaining|Change 02 describing/, "the unselected finding stays collapsed");

  ui.press(RIGHT);
  assert.equal(ui.text(), text, "a second → changes nothing");

  ui.press(LEFT);
  text = ui.text();
  assert.doesNotMatch(text, /Rationale \(|Suggested Change:/);
  assert.match(text, /Summary 01 stating the problem/, "the Summary remains after collapsing");

  ui.press(LEFT);
  assert.equal(ui.text(), text, "a second ← changes nothing");
});

test("a finding stays expanded when the highlight moves away from it", () => {
  const ui = harness(list(3), 60);

  ui.press(RIGHT);
  ui.press(DOWN);
  assert.match(strip(ui.selected() ?? ""), /❯ .*Reviewer 02/, "↓ lands on a still-collapsed finding");
  assert.match(ui.text(), /Rationale \(bug\):[^\n]*\n[^\n]*Rationale 01 explaining/, "the finding ↓ left is still open");

  ui.press(RIGHT);
  assert.match(ui.text(), /Rationale 02 explaining/, "the newly highlighted finding opens alongside it");

  ui.press(UP);
  assert.match(strip(ui.selected() ?? ""), /⌄ .*Reviewer 01/, "↑ returns to a finding that is still open");
  assert.match(ui.text(), /Rationale 02 explaining/, "the finding ↑ left keeps its details");

  ui.press(LEFT);
  assert.doesNotMatch(ui.text(), /Rationale 01 explaining/, "← collapses only the highlighted finding");
  assert.match(ui.text(), /Rationale 02 explaining/, "the other finding stays open");
});

test("PageDown and PageUp leave an expanded finding open", () => {
  const ui = harness(list(30), 24);

  ui.press(RIGHT);
  assert.match(ui.text(), /Rationale \(/);

  ui.press(PAGE_DOWN);
  assert.doesNotMatch(strip(ui.selected() ?? ""), /Reviewer 01/, "the highlight moved off the expanded finding");

  ui.press(RIGHT);
  ui.press(PAGE_UP);
  const row = ui.selected();
  assert.ok(row, "paging back lands on a finding");
  assert.match(strip(row), /⌄ .*Reviewer 01/, "it is the one the first page left open");
  assert.match(ui.text(), /Rationale 01 explaining/, "its details are still beneath its row");
});

test("expanding a finding low in the window scrolls its details into view", () => {
  const ui = harness(list(30), 40);
  for (let i = 0; i < 8; i++) ui.press(DOWN);

  ui.press(RIGHT);

  assert.match(strip(ui.selected() ?? ""), /Reviewer 09/, "the highlighted row stays on screen");
  assert.match(ui.text(), /Suggested Change:[^\n]*\n[^\n]*Change 09 describing/, "the last detail block is scrolled into view");
});

test("S re-sorts without collapsing the highlighted finding", () => {
  const ui = harness([finding(1, { file: "src/z.ts", severity: "critical" }), finding(2, { file: "src/a.ts" })], 60);

  ui.press(DOWN);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/, "file mode lists z.ts second");
  ui.press(RIGHT);
  ui.press("S");

  const text = ui.text();
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/, "priority mode keeps the same finding highlighted");
  assert.ok(text.indexOf("Reviewer 01") < text.indexOf("Reviewer 02"), "critical now sorts first");
  assert.match(text, /Change 01 describing/, "the finding stays expanded after re-sorting");
});

test("→ and ← are inert with no findings", () => {
  const ui = harness([], 40);

  ui.press(RIGHT);
  ui.press(LEFT);

  assert.ok(ui.text().includes("No findings to review."));
  assert.deepEqual(ui.settled(), []);
});

test("a degradation note renders as a header warning, and only when provided", () => {
  const host: ReviewHost = { requestRender: () => {}, terminal: { rows: 40 } };
  const note = "adjudicator output was unparsable — findings triaged without recommendations";

  const withNote = new FindingsReview([finding(1)], theme, () => {}, host, async () => "handoff.md", note);
  assert.ok(
    withNote.render(WIDTH).map(strip).some((line) => line.includes("⚠ adjudicator output was unparsable")),
    "the warning line appears in the header",
  );

  const withoutNote = new FindingsReview([finding(1)], theme, () => {}, host, async () => "handoff.md");
  assert.ok(
    !withoutNote.render(WIDTH).map(strip).some((line) => line.includes("⚠")),
    "no warning line without a note",
  );
});

// ── Fix Now ────────────────────────────────────────────────────────────────

test("F resolves a fixNow outcome carrying the original index and current state", () => {
  const ui = harness(list(3), 40);

  ui.press(SPACE); // first finding → reject
  ui.press(DOWN);
  ui.press(RIGHT);
  ui.press("f");

  const [outcome] = ui.settled();
  assert.ok(outcome && outcome.kind === "fixNow");
  assert.equal(outcome.index, 1, "the second finding's original index");
  assert.deepEqual(outcome.state.statuses, ["reject", "apply", "apply"]);
  assert.equal(outcome.state.selectedIndex, 1);
  assert.deepEqual(outcome.state.expanded, [1]);

  const restored = harness(list(3), 40, outcome.state);
  assert.ok(restored.visible().map(strip).some((line) => line.includes("Rationale (")), "the expanded finding reopens expanded");
});

test("every open finding is restored after a Fix Now round-trip", () => {
  const findings = list(3);
  const ui = harness(findings, 60);

  ui.press(RIGHT);
  ui.press(DOWN);
  ui.press(RIGHT);
  ui.press("f");

  const [outcome] = ui.settled();
  assert.ok(outcome && outcome.kind === "fixNow");
  assert.deepEqual(outcome.state.expanded, [0, 1], "both open findings are named by original index");

  const restored = harness(findings, 60, outcome.state);
  const text = restored.text();
  assert.match(strip(restored.selected() ?? ""), /⌄ .*Reviewer 02/, "the highlighted finding reopens open");
  assert.match(text, /Rationale 01 explaining/, "the finding the highlight left is open again too");
  assert.match(text, /Rationale 02 explaining/);
});

test("restore state round-trips statuses, cursor, and fixed lock", () => {
  const findings = list(3);
  const state: ReviewSessionState = {
    statuses: ["reject", "fixed", "defer"],
    selectedIndex: 1,
    fixed: new Map([[1, { finding: findings[1]!, commitSha: "abc1234", files: ["src/file02.ts"] }]]),
    handoffPath: "handoff.md",
  };
  const ui = harness(findings, 40, state);

  const row = ui.selected();
  assert.ok(row, "the cursor lands back on the previously selected finding");
  assert.match(strip(row), /\[FIXED]\s+low\s+Reviewer 02 @abc1234/);

  ui.press(ENTER);
  const result = ui.result();
  assert.ok(result);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.deferred.length, 1);
  assert.equal(result.fixed.length, 1);
  assert.equal(result.fixed[0]?.commitSha, "abc1234");
  assert.equal(result.accepted.length, 0);
  assert.equal(result.handoffPath, "handoff.md");
});

test("Space, A, R, D, and F are inert on a fixed finding", () => {
  const findings = list(2);
  const state: ReviewSessionState = {
    statuses: ["fixed", "apply"],
    selectedIndex: 0,
    fixed: new Map([[0, { finding: findings[0]!, commitSha: "abc1234", files: ["src/file01.ts"] }]]),
  };
  const ui = harness(findings, 40, state);

  ui.press(SPACE);
  ui.press("A");
  ui.press("R");
  ui.press("D");
  ui.press("F");

  assert.deepEqual(ui.settled(), [], "F does not resolve on a fixed finding");
  const row = ui.selected();
  assert.ok(row);
  assert.match(strip(row), /\[FIXED]/, "the status did not cycle");
});

test("the footer counts fixed findings separately", () => {
  const findings = list(3);
  const state: ReviewSessionState = {
    statuses: ["fixed", "apply", "apply"],
    selectedIndex: 0,
    fixed: new Map([[0, { finding: findings[0]!, commitSha: "abc1234", files: ["src/file01.ts"] }]]),
  };
  const lines = harness(findings, 40, state).visible().map(strip);

  assert.ok(lines.some((line) => /2 apply · 0 reject · 0 defer · 1 fixed/.test(line)));
});

test("S cycles file, priority, reviewer, and blast-radius ordering", () => {
  const findings = [
    finding(1, { file: "src/z.ts", severity: "low", reviewer: "Beta", blastRadius: { score: 10, level: "low", reasons: [] } }),
    finding(2, { file: "src/a.ts", severity: "critical", reviewer: "Gamma", blastRadius: { score: 40, level: "medium", reasons: ["no tests"] } }),
    finding(3, { file: "src/m.ts", severity: "high", reviewer: "Alpha", blastRadius: { score: 80, level: "critical", reasons: ["imported by 20 modules"] } }),
  ];
  const ui = harness(findings, 60);

  assert.match(strip(ui.selected() ?? ""), /Gamma/, "file mode sorts a.ts first");
  ui.press("S");
  assert.match(strip(ui.selected() ?? ""), /Gamma/, "priority mode keeps the selected finding highlighted");
  ui.press(DOWN);
  assert.match(strip(ui.selected() ?? ""), /Alpha/, "priority orders critical before high before low");
  ui.press("S");
  assert.match(strip(ui.selected() ?? ""), /Alpha/, "reviewer mode follows the selected finding");
  ui.press(UP);
  assert.match(strip(ui.selected() ?? ""), /Alpha/, "reviewer mode orders Alpha first");
  ui.press("S");
  assert.match(strip(ui.selected() ?? ""), /Alpha/, "blast mode orders the highest score first");
  ui.press(RIGHT);
  assert.ok(ui.visible().map(strip).some((line) => line.includes("blast Critical: imported by 20 modules")), "the blast bucket shows in the expanded Rationale block");
});

test("sort mode round-trips through Fix Now state", () => {
  const findings = [finding(1), finding(2, { severity: "critical" })];
  const ui = harness(findings, 40);
  ui.press("S");
  ui.press(UP);
  ui.press("F");

  const [outcome] = ui.settled();
  assert.ok(outcome && outcome.kind === "fixNow");
  assert.equal(outcome.state.sortMode, "priority");

  const restored = harness(findings, 40, outcome.state);
  assert.match(strip(restored.selected() ?? ""), /Reviewer 02/);
  assert.ok(restored.visible().map(strip).some((line) => line.includes("S sort: priority")));
});

test("the keybind help lists direct triage keys, sorting, and fix now", () => {
  const help = harness(list(1), 40).visible().map(strip).join(" ").replace(/║/g, " ").replace(/\s+/g, " ");
  assert.match(help, /↑↓ navigate/);
  assert.match(help, /→ expand/);
  assert.match(help, /← collapse/);
  assert.match(help, /A apply/);
  assert.match(help, /R reject/);
  assert.match(help, /D defer/);
  assert.match(help, /PgUp\/PgDn page/);
  assert.match(help, /S sort: file/);
  assert.match(help, /Space cycle/);
  assert.match(help, /F fix now/);
  assert.match(help, /Esc cancel/);
  assert.doesNotMatch(help, /Esc Esc cancel/);
  assert.doesNotMatch(help, /O defer-override/);
});

test("priority sort leads with exploitability while default remains file-grouped", () => {
  const findings = [
    finding(1, { file: "src/a.ts", severity: "critical", exploitability: "theoretical" }),
    finding(2, { file: "src/z.ts", severity: "low", exploitability: "direct" }),
  ];
  const ui = harness(findings, 50);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 01/, "default file mode selects a.ts first");
  ui.press("S");
  ui.press(UP);
  assert.match(strip(ui.selected() ?? ""), /Reviewer 02/, "direct outranks higher-severity theoretical");
});

test("finding details render exploitability, disputes, and deferral reasons consistently", () => {
  const details = finding(1, {
    recommendation: "defer",
    recommendationReason: "Wait for the parser rewrite.",
    exploitability: "conditional",
    exploitabilityReason: "Requires admin configuration.",
    disputes: [{ reviewer: "Reviewer B", verdict: "overstated", reason: "The default disables it." }],
  });
  const ui = harness([details], 60);
  ui.press(RIGHT);
  const text = ui.text();
  assert.match(text, /Exploitability:[^\n]*\n[^\n]*conditional — Requires admin configuration\./);
  assert.match(text, /\n[^\S\n]*║[^\n]*\n[^\n]*Disputed by Reviewer B \(overstated\):[^\n]*\n[^\n]*The default disables it\./);
  assert.match(text, /\n[^\S\n]*║[^\n]*\n[^\n]*⚑ Why defer:[^\n]*\n[^\n]*Wait for the parser rewrite\./);

  const colored = harness([details], 60, undefined, tagged);
  colored.press(RIGHT);
  const coloredText = colored.rendered().join("\n");
  // Built as pattern strings, not RegExps, so the callers can splice them into a larger expression.
  const heading = (label: string): string => `<b><mdHeading>${label}</mdHeading></b>`;
  assert.ok(coloredText.includes(heading("Summary:")), "Summary heading");
  assert.ok(coloredText.includes(heading("Rationale (bug):")), "Rationale heading");
  assert.ok(coloredText.includes(heading("Exploitability:")), "Exploitability heading");
  assert.ok(coloredText.includes(`<warning>⚑</warning> <b><mdHeading>Disputed by Reviewer B (overstated):`), "Disputed heading");
  assert.ok(coloredText.includes(heading("Suggested Change:")), "Suggested Change heading");
  assert.ok(coloredText.includes(`<warning>⚑</warning> ${heading("Why defer:")}`), "Why defer heading");
  assert.match(coloredText, /<muted>The default disables it\.<\/muted>/);
  assert.match(coloredText, /<muted>Wait for the parser rewrite\.<\/muted>/);
  assert.doesNotMatch(coloredText, /<warning>(?:Exploitability:|Disputed by|Why defer:)/);
  assert.doesNotMatch(coloredText, /<(?:success|error|warning|dim)><b>/, "headings never wear a status color");
});

test("detail headings keep one shared color, whatever block they label", () => {
  const ui = harness([finding(1, {
    recommendation: "defer",
    recommendationReason: "Wait for the rewrite.",
    disputes: [{ reviewer: "R B", verdict: "overstated", reason: "The default disables it." }],
    exploitability: "conditional",
  })], 60, undefined, tagged);
  ui.press(RIGHT);
  // The label, not the closing tags: a long heading is clipped at the frame by the tagged theme's width.
  const headings = [...ui.rendered().join("\n").matchAll(/<b><(\w+)>([A-Z][^<\n]{0,40}:)/g)]
    .map((match) => ({ color: match[1] ?? "", label: (match[2] ?? "").replace(/\s+$/, "") }))
    .filter(({ label }) => !/^──/.test(label));

  assert.ok(headings.length >= 5, `expected the detail block headings, saw ${headings.length}`);
  for (const { color, label } of headings) {
    assert.equal(color, "mdHeading", `${label} keeps the shared heading color`);
  }
});

test("identifiers in finding text are colored while the prose around them stays muted", () => {
  // One construct per block, each short enough to survive the tagged theme's width inflation.
  const ui = harness([finding(1, {
    summary: "`wrapText` drops state",
    rationale: "See resolveScroll()",
    suggestedChange: "at src/a.ts:1",
  })], 60, undefined, tagged);
  ui.press(RIGHT);
  const text = ui.rendered().join("\n");

  assert.ok(text.includes("<mdCode>wrapText</mdCode><muted> drops state</muted>"), "an inline code span, then prose");
  assert.ok(text.includes("<muted>See </muted><syntaxFunction>resolveScroll()</syntaxFunction>"), "a call in prose");
  assert.ok(text.includes("<muted>at </muted><syntaxString>src/a.ts:1</syntaxString>"), "a path in prose");
  assert.doesNotMatch(text, /<code>/, "a segment is never painted twice");
});

test("a fenced block in the suggested change is painted as one block", () => {
  // The overlay's sanitizer strips newlines from finding text, so a fence arrives already on one line.
  const ui = harness([finding(1, { suggestedChange: "```ts return null;```" })], 60, undefined, tagged);
  ui.press(RIGHT);
  const text = ui.rendered().join("\n");

  assert.ok(text.includes("<mdCodeBlock>```ts return null;```</mdCodeBlock>"), "the fence is one segment");
  assert.doesNotMatch(text, /<mdCode>/, "nothing inside a fence is parsed as an inline code span");
});

test("a rejected finding's reason and disputes are colored like any other prose", () => {
  const ui = harness([finding(1, {
    recommendation: "defer",
    recommendationReason: "keep `h`",
    disputes: [{ reviewer: "Reviewer B", verdict: "overstated", reason: "An unmatched ` backtick" }],
  })], 60, undefined, tagged);
  ui.press(RIGHT);
  const text = ui.rendered().join("\n");

  assert.ok(text.includes("<muted>keep </muted><mdCode>h</mdCode>"), "a code span inside a flagged block");
  assert.ok(text.includes("<muted>An unmatched ` backtick</muted>"), "an unmatched backtick stays prose");
});

test("a reject recommendation flags its reason in the error color", () => {
  const rejected = finding(1, { recommendation: "reject", recommendationReason: "The caller already validates it." });
  const ui = harness([rejected], 60, undefined, tagged);
  ui.press(RIGHT);
  const text = ui.rendered().join("\n");

  assert.match(text, /<error>⚑<\/error> <b><mdHeading>Why reject:<\/mdHeading><\/b>/);
  assert.match(text, /<muted>The caller already validates it\.<\/muted>/);
});

test("wide characters in finding details are never cut at the frame", () => {
  const rationale = "审".repeat(60);
  const ui = harness([finding(1, { rationale, summary: "wide text" })], 50);
  ui.press(RIGHT);
  const joined = ui.visible().map(strip).join("").replace(/[║\s]/g, "");

  assert.ok(joined.includes(rationale), "every wide character survives wrapping and framing");
  for (const row of ui.visible()) {
    assert.ok(visibleWidth(row) <= WIDTH, `row width ${visibleWidth(row)} exceeds ${WIDTH}`);
  }
});

test("long unbroken tokens wrap without losing or marking characters", () => {
  const rationale = `https://example.com/${"a".repeat(100)}`;
  const ui = harness([finding(1, { rationale, summary: "long URL" })], 50);
  ui.press(RIGHT);
  const joined = ui.visible().map(strip).join("").replace(/[║\s]/g, "");

  assert.ok(joined.includes(rationale), "the URL survives wrapping without inserted ellipses");
});

test("finding details render the complete long dispute reason", () => {
  const reason = `${"Evidence stays on the reachable startup path. ".repeat(6)}setImmediate remains on the executed path.`;
  const ui = harness([finding(1, {
    disputes: [{ reviewer: "Reviewer B", verdict: "overstated", reason }],
  })], 50);
  ui.press(RIGHT);
  const text = ui.text().replace(/║/g, " ").replace(/\s+/g, " ");

  assert.ok(text.includes(reason), "the dispute reason is not cut off in the review overlay");
});
