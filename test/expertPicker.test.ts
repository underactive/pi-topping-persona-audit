import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ExpertPicker, type ExpertPickerTheme } from "../src/components/ExpertPicker.ts";
import { TIERS } from "../src/components/ReviewerData.ts";
import { getPersonality } from "../src/skillContent.ts";
import type { ReviewerSelection } from "../src/types.ts";

const HIGHLIGHT = "\x1b[48;5;236m";
const WIDTH = 80;
const ENTER = "\r";
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
