import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ExpertPicker, showExpertPicker, type ExpertPickerTheme } from "../src/components/ExpertPicker.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import { TIERS } from "../src/components/ReviewerData.ts";
import { getPersonality } from "../src/skillContent.ts";
import type { ReviewerSelection } from "../src/types.ts";

const HIGHLIGHT = "\x1b[48;5;236m";
const WIDTH = 80;
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\u0003";
const DOWN = "\x1b[B";
const SPACE = " ";
const BACKSPACE = "\u007f";
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme: ExpertPickerTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text) => text,
};

function highlighted(lines: string[]): string | undefined {
  return lines.find((line) => line.startsWith(HIGHLIGHT));
}

/** Filter down to a single match, toggle it, then clear the filter. */
function toggleByFilter(picker: ExpertPicker, query: string): void {
  for (const char of query) picker.handleInput(char);
  picker.handleInput(SPACE);
  for (const _ of query) picker.handleInput(BACKSPACE);
}

test("expert picker opens on the reviewer list under a tier header", () => {
  const picker = new ExpertPicker(theme, () => {});
  const lines = picker.render(WIDTH);
  const selected = highlighted(lines);

  assert.ok(selected);
  assert.equal(visibleWidth(selected), WIDTH);
  assert.match(strip(selected), /❯ .*Principal Engineer/);
  assert.ok(lines.map(strip).some((line) => line.trimStart().startsWith("─ Holistic")));
});

test("expert picker reopens with a restored selection scrolled into view", () => {
  // Security Engineer sits past the first viewport, so this only renders if the
  // constructor moves the cursor onto the restored selection.
  const restored: ReviewerSelection = { reviewers: ["Security Engineer"], passes: 2 };
  let confirmed: ReviewerSelection | null | undefined;
  const picker = new ExpertPicker(theme, (result) => { confirmed = result; }, undefined, undefined, restored);

  const lines = picker.render(WIDTH).map(strip);
  assert.ok(lines.some((line) => line.includes("passes (2)")));
  assert.ok(lines.some((line) => line.includes("✓ Security Engineer")));

  // passes > 1 needs the cost confirmation before the selection is returned.
  picker.handleInput(ENTER);
  assert.equal(confirmed, undefined);
  picker.handleInput(ENTER);
  assert.deepEqual(confirmed, restored);
});

test("expert picker moves the marker between reviewers, never onto a tier header", () => {
  const picker = new ExpertPicker(theme, () => {});
  const selected = highlighted(picker.render(WIDTH));

  assert.ok(selected);
  assert.equal(visibleWidth(selected), WIDTH);
  assert.match(strip(selected), /❯ .*Principal Engineer/);

  picker.handleInput(DOWN);
  const moved = picker.render(WIDTH);
  const movedSelected = highlighted(moved);
  assert.ok(movedSelected);
  assert.match(strip(movedSelected), /❯ .*Software Architect/);
  assert.equal(moved.filter((line) => line.startsWith(HIGHLIGHT)).length, 1);

  // Holistic holds five reviewers: a fifth DOWN crosses into Specialist, and
  // the header row between tiers must never absorb a keypress.
  picker.handleInput(DOWN);
  picker.handleInput(DOWN);
  picker.handleInput(DOWN);
  picker.handleInput(DOWN);
  const crossed = picker.render(WIDTH);
  const crossedSelected = highlighted(crossed);
  assert.ok(crossedSelected);
  assert.match(strip(crossedSelected), /❯ .*Code Quality Engineer/);
  assert.equal(crossed.filter((line) => line.startsWith(HIGHLIGHT)).length, 1);

  const crossedStripped = crossed.map(strip);
  const dividerIdx = crossedStripped.findIndex((line) => line.trimStart().startsWith("─ Specialist"));
  assert.ok(dividerIdx >= 0);
  assert.ok(dividerIdx < crossed.findIndex((line) => line.startsWith(HIGHLIGHT)));
});

test("expert picker confirms a selection spanning every tier", () => {
  let confirmed: ReviewerSelection | null | undefined;
  const picker = new ExpertPicker(theme, (result) => { confirmed = result; });

  toggleByFilter(picker, "principal"); // holistic
  toggleByFilter(picker, "security"); // specialist
  toggleByFilter(picker, "fowler"); // persona

  picker.handleInput(ENTER);
  assert.deepEqual(confirmed, {
    reviewers: ["Principal Engineer", "Security Engineer", "Martin Fowler"],
    passes: 1,
  });
});

test("every picker reviewer resolves to a personality", () => {
  const names = TIERS.flatMap((t) => t.reviewers).map((r) => r.name);
  assert.equal(names.length, 40);
  for (const name of names) assert.ok(getPersonality(name), name);
});

// ── Wrapper: showExpertPicker goes through a focused custom overlay ────────

interface MountedOverlay {
  picker(): ExpertPicker | undefined;
  send(...keys: string[]): void;
  render(width?: number): string[];
  result: Promise<ReviewerSelection | null>;
  options(): unknown;
}

/** Focused-overlay fake: Pi dispatches input straight to the component and settles on done. */
function mountOverlay(terminalRows?: number): MountedOverlay {
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

  const result = showExpertPicker(ctx, 3);
  return {
    picker: () => component as ExpertPicker | undefined,
    send: (...keys: string[]) => keys.forEach((key) => component?.handleInput?.(key)),
    render: (width = WIDTH) => component?.render(width) ?? [],
    result,
    options: () => capturedOptions,
  };
}

test("showExpertPicker opens a focused overlay with the shared prompt geometry", async () => {
  const overlay = mountOverlay();
  assert.deepEqual(overlay.options(), PROMPT_OVERLAY_OPTIONS);
  overlay.send(ESCAPE);
  assert.equal(await overlay.result, null);
});

test("Escape and Ctrl+C both cancel the picker overlay", async () => {
  const escaped = mountOverlay();
  escaped.send(ESCAPE);
  assert.equal(await escaped.result, null);

  const ctrlC = mountOverlay();
  ctrlC.send(CTRL_C);
  assert.equal(await ctrlC.result, null);
});

test("the shared 75% viewport stays scrollable and unclipped on a short terminal", () => {
  const overlay = mountOverlay(20);
  const initial = overlay.render().map(strip);

  // 20 rows at the shared 75% budget leaves 15 rows; the 40-reviewer list
  // must window with a scroll indicator instead of overflowing the viewport.
  const indicator = /(\d+)–(\d+) of 40/;
  const initialMatch = initial.map((line) => indicator.exec(line)).find(Boolean);
  assert.ok(initialMatch, "expected a scroll indicator on a short terminal");
  assert.ok(initial.length <= 15, `render must fit the viewport, got ${initial.length} lines`);

  overlay.send(DOWN, DOWN, DOWN, DOWN, DOWN);
  const scrolled = overlay.render().map(strip);
  const scrolledMatch = scrolled.map((line) => indicator.exec(line)).find(Boolean);
  assert.ok(scrolledMatch, "scroll indicator must survive scrolling");
  assert.ok(Number(scrolledMatch[1]) > Number(initialMatch![1]), "window must advance with the cursor");
  assert.ok(scrolled.length <= 15, `scrolled render must still fit the viewport, got ${scrolled.length} lines`);
  // The cursor row is always inside the rendered window.
  assert.equal(scrolled.filter((line) => line.includes("❯")).length, 1);

  overlay.send(ESCAPE);
});
