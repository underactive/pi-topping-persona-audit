import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  InspectionSpinner,
  type InspectionSpinnerHost,
  type InspectionSpinnerTheme,
} from "../src/components/InspectionSpinner.ts";

const createdSpinners: InspectionSpinner[] = [];
after(() => {
  for (const spinner of createdSpinners) spinner.dispose();
});

const theme: InspectionSpinnerTheme = {
  fg: (_color, text) => text,
};

function createSpinner(onRender: () => void = () => {}): InspectionSpinner {
  const host: InspectionSpinnerHost = { requestRender: onRender };
  const spinner = new InspectionSpinner(host, theme, "claude-haiku-4-5");
  createdSpinners.push(spinner);
  return spinner;
}

test("renders left-aligned animated feedback while the repo is inspected", async () => {
  let repaints = 0;
  const spinner = createSpinner(() => repaints++);
  const first = spinner.render(120)[0] ?? "";

  assert.match(first, /^⠋ Inspecting repo with claude-haiku-4-5…/);
  assert.match(first, / · 0:00 · ctrl\+shift\+c cancels$/);

  await new Promise((resolve) => setTimeout(resolve, 125));
  const next = spinner.render(120)[0] ?? "";
  assert.notEqual(next.slice(0, 1), first.slice(0, 1), "the left spinner frame advances");
  assert.ok(repaints > 0, "animation requests repaints");
});

test("dispose stops spinner repaints", async () => {
  let repaints = 0;
  const spinner = createSpinner(() => repaints++);
  await new Promise((resolve) => setTimeout(resolve, 125));

  spinner.dispose();
  const stoppedAt = repaints;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(repaints, stoppedAt, "disposing the spinner stops its timer");
});
