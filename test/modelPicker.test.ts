import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { modelThinkingPaneWidths, showPhaseModelPicker, smartTruncateModelLabel, thinkingOffWarning, TwoPaneModelThinking, type PhaseModelPickerResult } from "../src/components/ModelPicker.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
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

/** Drive the overview through a focused-overlay fake: Pi dispatches input straight to the component. */
function runOverview(keys: string[]): { result: Promise<PhaseModelPickerResult>; options: () => unknown } {
  let component: Component | undefined;
  let capturedOptions: unknown;
  const ctx = {
    mode: "tui",
    model: { provider: "test", id: "model" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
    ui: {
      notify: () => {},
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (result: PhaseModelPickerResult) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<PhaseModelPickerResult>((resolve) => {
          component = factory(tui, theme, undefined, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const result = showPhaseModelPicker(ctx, currentThinking);
  for (const key of keys) component?.handleInput?.(key);
  return { result, options: () => capturedOptions };
}

test("esc on the phase overview steps back instead of cancelling the audit", async () => {
  const overview = runOverview([ESCAPE]);
  assert.deepEqual(overview.options(), PROMPT_OVERLAY_OPTIONS);
  const result = await overview.result;
  assert.equal(result.action, "back");
  // Every phase rides along so stepping forward again does not revert them.
  assert.deepEqual(
    result.action === "back" ? Object.keys(result.selections).sort() : [],
    [...PHASE_SLOTS].sort(),
  );
});

test("ctrl+c on the phase overview steps back like esc", async () => {
  const result = await runOverview(["\u0003"]).result;
  assert.equal(result.action, "back");
});

test("ctrl+c inside a slot view returns to the overview instead of settling the picker", async () => {
  // Enter opens the review slot view; ctrl+c must step back to the overview
  // (not settle), so the overview's Cancel button still resolves afterwards.
  const result = await runOverview([ENTER, "\u0003", TAB, RIGHT, ENTER]).result;
  assert.deepEqual(result, { action: "cancel" });
});

test("TwoPaneModelThinking treats ctrl+c as back", () => {
  const picker = new TwoPaneModelThinking(
    tui,
    theme,
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    context,
  );
  assert.equal(picker.handleInput("\u0003"), "back");
});

test("the phase overview's Cancel button still aborts the audit", async () => {
  assert.deepEqual(await runOverview([TAB, RIGHT, ENTER]).result, { action: "cancel" });
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
  const { left } = modelThinkingPaneWidths(50);
  assert.deepEqual(bgWidths, [left]);
  assert.match(selected, /❯ test\/model/);
  assert.match(selected, /❯ off/);
  assert.doesNotMatch(selected, /→/);
});

test("model picker moves the selection highlight with pane focus", () => {
  const picker = new TwoPaneModelThinking(
    tui,
    theme,
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    context,
  );
  const { left, right } = modelThinkingPaneWidths(50);

  bgWidths.length = 0;
  picker.render(50);
  assert.deepEqual(bgWidths, [left]);

  picker.handleInput(RIGHT);
  bgWidths.length = 0;
  picker.render(50);
  assert.deepEqual(bgWidths, [right]);
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

test("smartTruncateModelLabel keeps last segment, first segment, and collapses skipped runs", () => {
  const result = smartTruncateModelLabel("openai/accounts/org-1/models/gpt-4o-mini", 20);
  // Last segment survives.
  assert.ok(result.endsWith("gpt-4o-mini"), `last segment should survive, got: ${result}`);
  // First segment kept.
  assert.ok(result.startsWith("openai/"), `first segment should be kept, got: ${result}`);
  // Skipped runs collapse to a single ellipsis.
  const ellipsisCount = (result.match(/…/g) ?? []).length;
  assert.equal(ellipsisCount, 1, `expected exactly 1 ellipsis, got ${ellipsisCount}: ${result}`);
  // Fits within maxWidth.
  assert.ok(visibleWidth(result) <= 20, `expected width <= 20, got ${visibleWidth(result)}: ${result}`);
});

test("smartTruncateModelLabel falls back to skeleton when even minimal segments don't fit", () => {
  const result = smartTruncateModelLabel("openai/accounts/org-1/models/gpt-4o-mini", 10);
  // Starts with the skeleton prefix.
  assert.ok(result.startsWith("…/"), `expected skeleton prefix, got: ${result}`);
  // The model name is truncated — shorter than the original.
  const suffix = result.slice("…/".length);
  assert.ok(suffix.length < "gpt-4o-mini".length, `expected model name truncated, got suffix: ${suffix}`);
  // Fits within maxWidth.
  assert.ok(visibleWidth(result) <= 10, `expected width <= 10, got ${visibleWidth(result)}: ${result}`);
});
