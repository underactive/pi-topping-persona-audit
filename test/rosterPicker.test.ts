import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { COST_CONFIRM_RUN_THRESHOLD, type ExpertPickerTheme } from "../src/components/ExpertPicker.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import { TIERS } from "../src/components/ReviewerData.ts";
import { RosterPicker, showRosterPicker, type RosterPickerResult } from "../src/components/RosterPicker.ts";
import type { Roster } from "../src/modelConfig.ts";

const HIGHLIGHT = "\x1b[48;5;236m";
const WIDTH = 80;
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\u0003";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const SPACE = " ";
const BACKSPACE = "\u007f";
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme: ExpertPickerTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text) => text,
};

const ALL_NAMES = TIERS.flatMap((tier) => tier.reviewers).map((reviewer) => reviewer.name);

const SMALL_ROSTERS: Roster[] = [
  { name: "Alpha", reviewers: ["Principal Engineer"] },
  { name: "Bravo", reviewers: ["Security Engineer"] },
  { name: "Charlie", reviewers: ["Kent Beck", "Rob Pike"] },
];

function highlighted(lines: string[]): string | undefined {
  return lines.find((line) => line.startsWith(HIGHLIGHT));
}

function typeQuery(picker: RosterPicker, query: string): void {
  for (const char of query) picker.handleInput(char);
}

test("rosters render alphabetically under a Rosters divider with their members", () => {
  const rosters: Roster[] = [
    { name: "Zulu", reviewers: ["Security Engineer", "Missing Reviewer"] },
    { name: "Alpha", reviewers: ["Principal Engineer"] },
    { name: "Stale", reviewers: ["Missing Reviewer"] },
  ];
  const picker = new RosterPicker(theme, () => {}, rosters);
  const lines = picker.render(WIDTH);
  const rendered = lines.map(strip).join("\n");

  // Stale drops out entirely, so only two rosters remain defined.
  assert.match(rendered, /Select a roster \(2 defined\)/);
  assert.match(rendered, /↑↓ navigate · Enter confirm · Esc back/);
  assert.match(rendered, /Type to filter…/);
  assert.ok(lines.map(strip).some((line) => line.trimStart().startsWith("─ Rosters")));
  assert.ok(rendered.indexOf("─ Rosters") < rendered.indexOf("Alpha"));
  assert.ok(rendered.indexOf("Alpha") < rendered.indexOf("Zulu"));
  assert.doesNotMatch(rendered, /Missing Reviewer|Stale/);
  assert.match(rendered, /Alpha.*\n\s+Principal Engineer/);
  assert.match(rendered, /Zulu.*\n\s+Security Engineer/);

  const selected = highlighted(lines);
  assert.ok(selected);
  assert.equal(visibleWidth(selected), WIDTH);
  assert.match(strip(selected), /❯ ◇ Alpha/);
  assert.equal(lines.filter((line) => line.startsWith(HIGHLIGHT)).length, 1);
  assert.match(rendered, /1 reviewer × 1 pass = 1 reviewer run · selected files each/);
  assert.match(rendered, /✓ 1 selected — press Enter to confirm$/m);
  assert.equal(strip(lines.at(-1) ?? ""), "═".repeat(WIDTH));
});

test("typing filters by roster or member name, Backspace restores, and a miss shows the empty state", () => {
  let confirmed: RosterPickerResult | null | undefined;
  const picker = new RosterPicker(theme, (result) => { confirmed = result; }, [
    { name: "Zulu", reviewers: ["Security Engineer"] },
    { name: "Alpha", reviewers: ["Principal Engineer"] },
  ]);

  typeQuery(picker, "security");
  const filtered = picker.render(WIDTH).map(strip).join("\n");
  assert.match(filtered, /Filter: security/);
  assert.match(filtered, /❯ ◇ Zulu/);
  assert.match(filtered, /Security Engineer/);
  assert.doesNotMatch(filtered, /Alpha/);

  for (const _ of "security") picker.handleInput(BACKSPACE);
  const restored = picker.render(WIDTH).map(strip).join("\n");
  assert.match(restored, /Type to filter…/);
  assert.match(restored, /❯ ◇ Alpha/);
  assert.match(restored, /Zulu/);

  typeQuery(picker, "zzz");
  const empty = picker.render(WIDTH);
  const emptyRendered = empty.map(strip).join("\n");
  assert.match(emptyRendered, /No rosters match filter\./);
  assert.doesNotMatch(emptyRendered, /─ Rosters|Alpha|Zulu/);
  assert.equal(highlighted(empty), undefined);
  assert.match(emptyRendered, /0 reviewers × 1 pass = 0 reviewer runs/);
  assert.doesNotMatch(emptyRendered, /selected — press Enter/);

  // Nothing is highlighted, so Enter has nothing to confirm.
  picker.handleInput(ENTER);
  assert.equal(confirmed, undefined);
});

test("Enter on a roster above the cost threshold needs a second Enter and ignores Space and arrows", () => {
  const names = ALL_NAMES.slice(0, COST_CONFIRM_RUN_THRESHOLD + 1);
  let confirmed: RosterPickerResult | null | undefined;
  const picker = new RosterPicker(theme, (result) => { confirmed = result; }, [{ name: "Large", reviewers: names }]);
  const initial = picker.render(WIDTH).map(strip).join("\n");
  assert.match(initial, /7 reviewers × 1 pass = 7 reviewer runs · selected files each/);
  assert.match(initial, /✓ 7 selected — press Enter to confirm \(confirmation required\)/);

  picker.handleInput(SPACE);
  picker.handleInput(LEFT);
  picker.handleInput(RIGHT);
  picker.handleInput(ENTER);
  assert.equal(confirmed, undefined, "a large roster requires the second Enter warning");
  const gated = picker.render(WIDTH).map(strip).join("\n");
  assert.match(gated, /Press Enter again to launch this higher-cost run · Esc to revise/);
  assert.doesNotMatch(gated, /Filter: /, "Space must not leak into the filter");

  picker.handleInput(ENTER);
  assert.deepEqual(confirmed, { rosterName: "Large", selection: { reviewers: names, passes: 1 } });
});

test("a small roster confirms on one Enter with a copy of its members", () => {
  const roster: Roster = { name: "Core", reviewers: ["Principal Engineer", "Security Engineer"] };
  let confirmed: RosterPickerResult | null | undefined;
  const picker = new RosterPicker(theme, (result) => { confirmed = result; }, [roster], 5);
  assert.match(picker.render(WIDTH).map(strip).join("\n"), /2 reviewers × 1 pass = 2 reviewer runs · 5 files each/);

  picker.handleInput(ENTER);
  assert.deepEqual(confirmed, { rosterName: "Core", selection: { reviewers: roster.reviewers, passes: 1 } });
  assert.notEqual(confirmed?.selection.reviewers, roster.reviewers);
});

test("Esc revises a pending cost confirmation and moving the cursor clears it", () => {
  const large = ALL_NAMES.slice(0, COST_CONFIRM_RUN_THRESHOLD + 1);
  let confirmed: RosterPickerResult | null | undefined;
  const picker = new RosterPicker(theme, (result) => { confirmed = result; }, [
    { name: "Large", reviewers: large },
    { name: "Small", reviewers: ["Kent Beck"] },
  ]);

  picker.handleInput(ENTER);
  assert.match(picker.render(WIDTH).map(strip).join("\n"), /Press Enter again/);
  picker.handleInput(ESCAPE);
  assert.equal(confirmed, undefined, "Esc while gated only revises");
  assert.doesNotMatch(picker.render(WIDTH).map(strip).join("\n"), /Press Enter again/);

  picker.handleInput(ENTER);
  picker.handleInput(DOWN);
  const moved = picker.render(WIDTH).map(strip).join("\n");
  assert.doesNotMatch(moved, /Press Enter again/);
  assert.match(moved, /❯ ◇ Small/);
  picker.handleInput(ENTER);
  assert.deepEqual(confirmed, { rosterName: "Small", selection: { reviewers: ["Kent Beck"], passes: 1 } });
});

test("Esc and Ctrl+C step back with null when nothing is pending", () => {
  let escaped: RosterPickerResult | null | undefined;
  const escapedPicker = new RosterPicker(theme, (result) => { escaped = result; }, SMALL_ROSTERS);
  escapedPicker.handleInput(ESCAPE);
  assert.equal(escaped, null);

  let interrupted: RosterPickerResult | null | undefined;
  const interruptedPicker = new RosterPicker(theme, (result) => { interrupted = result; }, SMALL_ROSTERS);
  interruptedPicker.handleInput(CTRL_C);
  assert.equal(interrupted, null);
});

test("initialRosterName opens with the cursor on that roster", () => {
  const picker = new RosterPicker(theme, () => {}, SMALL_ROSTERS, 4, undefined, "Charlie");
  const lines = picker.render(WIDTH);
  const selected = highlighted(lines);
  assert.ok(selected);
  assert.match(strip(selected), /❯ ◇ Charlie/);
  assert.match(lines.map(strip).join("\n"), /2 reviewers × 1 pass = 2 reviewer runs · 4 files each/);

  // Matching is case-sensitive: an unknown name leaves the cursor on the first roster.
  const fallback = new RosterPicker(theme, () => {}, SMALL_ROSTERS, undefined, undefined, "charlie");
  assert.match(strip(highlighted(fallback.render(WIDTH)) ?? ""), /❯ ◇ Alpha/);
});

// ── Wrapper: showRosterPicker goes through a focused custom overlay ────────

interface MountedOverlay {
  send(...keys: string[]): void;
  render(width?: number): string[];
  result: Promise<RosterPickerResult | null>;
  options(): unknown;
}

/** Focused-overlay fake: Pi dispatches input straight to the component and settles on done. */
function mountOverlay(rosters: Roster[], terminalRows?: number, initialRosterName?: string): MountedOverlay {
  let component: Component | undefined;
  let capturedOptions: unknown;
  const host = {
    requestRender: () => {},
    ...(terminalRows === undefined ? {} : { terminal: { rows: terminalRows } }),
  };
  const ctx = {
    ui: {
      custom: <T>(
        factory: (tui: TUI, currentTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<T>((resolve) => {
          component = factory(host as unknown as TUI, theme as unknown as Theme, undefined as unknown as KeybindingsManager, resolve);
        });
      },
    },
  };

  const result = showRosterPicker(ctx, rosters, 3, initialRosterName);
  return {
    send: (...keys: string[]) => keys.forEach((key) => component?.handleInput?.(key)),
    render: (width = WIDTH) => component?.render(width) ?? [],
    result,
    options: () => capturedOptions,
  };
}

test("showRosterPicker opens a focused overlay with the shared prompt geometry", async () => {
  const overlay = mountOverlay(SMALL_ROSTERS);
  assert.deepEqual(overlay.options(), PROMPT_OVERLAY_OPTIONS);
  assert.match(overlay.render().map(strip).join("\n"), /Select a roster \(3 defined\)[\s\S]*3 files each/);
  overlay.send(ESCAPE);
  assert.equal(await overlay.result, null);
});

test("Escape and Ctrl+C both resolve the overlay with null", async () => {
  const escaped = mountOverlay(SMALL_ROSTERS);
  escaped.send(ESCAPE);
  assert.equal(await escaped.result, null);

  const ctrlC = mountOverlay(SMALL_ROSTERS);
  ctrlC.send(CTRL_C);
  assert.equal(await ctrlC.result, null);
});

test("the overlay resolves the chosen roster and honours the initial roster name", async () => {
  const overlay = mountOverlay(SMALL_ROSTERS, undefined, "Bravo");
  overlay.send(ENTER);
  assert.deepEqual(await overlay.result, {
    rosterName: "Bravo",
    selection: { reviewers: ["Security Engineer"], passes: 1 },
  });
});

test("the shared 75% viewport windows a long roster list on a short terminal", () => {
  const rosters: Roster[] = ALL_NAMES.slice(0, 12).map((name, index) => ({
    name: `Roster${String(index + 1).padStart(2, "0")}`,
    reviewers: [name],
  }));
  const overlay = mountOverlay(rosters, 24);
  const initial = overlay.render().map(strip);

  // 24 rows at the shared 75% budget leaves 18 rows: after 9 rows of chrome,
  // the divider plus two 3-row roster entries fill the list budget.
  const indicator = /(\d+)–(\d+) of 12/;
  const initialMatch = initial.map((line) => indicator.exec(line)).find(Boolean);
  assert.ok(initialMatch, "expected a scroll indicator on a short terminal");
  assert.equal(initialMatch[0], "1–2 of 12");
  assert.ok(initial.length <= 18, `render must fit the viewport, got ${initial.length} lines`);
  assert.doesNotMatch(initial.join("\n"), /Roster03/);

  overlay.send(DOWN, DOWN, DOWN, DOWN, DOWN);
  const scrolled = overlay.render().map(strip);
  const scrolledMatch = scrolled.map((line) => indicator.exec(line)).find(Boolean);
  assert.ok(scrolledMatch, "scroll indicator must survive scrolling");
  assert.equal(scrolledMatch[0], "5–6 of 12");
  assert.ok(scrolled.length <= 18, `scrolled render must still fit the viewport, got ${scrolled.length} lines`);
  // The cursor row is always inside the rendered window.
  assert.equal(scrolled.filter((line) => line.includes("❯")).length, 1);
  assert.match(scrolled.join("\n"), /❯ ◇ Roster06/);

  overlay.send(ESCAPE);
});
