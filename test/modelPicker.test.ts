import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { showPhaseModelPicker, thinkingOffWarning, TwoPaneModelThinking, type PhaseModelPickerResult } from "../src/components/ModelPicker.ts";
import { twoPaneWidths } from "../src/components/menuChrome.ts";
import { PHASE_SLOTS, type ThinkingLevel } from "../src/modelConfig.ts";

const HIGHLIGHT = "\x1b[48;5;236m";
const bgWidths: number[] = [];
const theme = {
  fg: (_color: string, text: string) => `\x1b[38;5;99m${text}\x1b[39m`,
  bg: (_color: string, text: string) => {
    bgWidths.push(visibleWidth(text));
    return `${HIGHLIGHT}${text}\x1b[49m`;
  },
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;
const context = {
  modelRegistry: {
    getAvailable: () => [{ provider: "test", id: "model", reasoning: false }],
  },
} as unknown as ExtensionCommandContext;
const currentThinking: ThinkingLevel = "medium";

const ESCAPE = "\x1b";
const TAB = "\t";
const RIGHT = "\x1b[C";
const ENTER = "\r";

/** Drive the overview through a stubbed host, since widgets never take focus. */
function runOverview(keys: string[]): Promise<PhaseModelPickerResult> {
  let handler: ((data: string) => unknown) | undefined;
  const ctx = {
    mode: "tui",
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
    ui: {
      notify: () => {},
      onTerminalInput: (h: (data: string) => unknown) => {
        handler = h;
        return () => { handler = undefined; };
      },
      setWidget: (_key: string, content?: (tui: TUI, theme: Theme) => unknown) => { content?.(tui, theme); },
    },
  } as unknown as ExtensionCommandContext;

  const result = showPhaseModelPicker(ctx, currentThinking);
  for (const key of keys) handler?.(key);
  return result;
}

test("esc on the phase overview steps back instead of cancelling the audit", async () => {
  const result = await runOverview([ESCAPE]);
  assert.equal(result.action, "back");
  // Every phase rides along so stepping forward again does not revert them.
  assert.deepEqual(
    result.action === "back" ? Object.keys(result.selections).sort() : [],
    [...PHASE_SLOTS].sort(),
  );
});

test("the phase overview's Cancel button still aborts the audit", async () => {
  assert.deepEqual(await runOverview([TAB, RIGHT, ENTER]), { action: "cancel" });
});

test("model picker normalizes SelectList rows to the persona-audit marker and highlight", () => {
  const picker = new TwoPaneModelThinking(
    tui,
    theme,
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    context,
  );
  bgWidths.length = 0;
  const lines = picker.render(50);
  const selected = lines.find((line) => line.includes(HIGHLIGHT));

  assert.ok(selected);
  assert.equal(visibleWidth(selected), 50);
  const { left, right } = twoPaneWidths(50);
  assert.deepEqual(bgWidths, [left, Math.max(0, right - 1)]);
  assert.match(selected, /❯ test\/model/);
  assert.match(selected, /❯ off/);
  assert.doesNotMatch(selected, /→/);
});

test("thinkingOffWarning flags off and no-thinking models, stays quiet on real levels", () => {
  assert.equal(thinkingOffWarning(["off", "low", "high"], "high"), undefined);
  assert.match(thinkingOffWarning(["off", "low", "high"], "off")!, /Thinking is turned off/);
  assert.match(thinkingOffWarning(["off"], "off")!, /no thinking mode/);
});

test("the model picker renders a warning when the selected thinking level is off", () => {
  const picker = new TwoPaneModelThinking(
    tui,
    theme,
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    context,
  );
  const lines = picker.render(50);
  assert.ok(lines.some((line) => line.includes("⚠")), "expected a thinking-off warning in the render");
});
