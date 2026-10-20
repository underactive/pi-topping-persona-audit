import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  seedPhaseSelections,
  showPhaseModelPicker,
  thinkingOffWarning,
  createPhaseModelPicker,
  RetryModelSubView,
  type PhaseModelPickerResult,
} from "../src/components/ModelPicker.ts";
import { modelThinkingPaneWidths } from "@underactive/pi-topping-primitives/models";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import {
  PHASE_SLOTS,
  type ModelRef,
  type PhaseModelSelection,
  type ThinkingLevel,
} from "../src/modelConfig.ts";

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
  const picker = createPhaseModelPicker(
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
  const picker = createPhaseModelPicker(
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
  const picker = createPhaseModelPicker(
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

test("the framed model picker renders a warning when the selected thinking level is off", () => {
  const picker = new RetryModelSubView(
    tui,
    theme,
    context,
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    { label: "test/model", ref: { provider: "test", id: "model" } },
    "Retry model",
    "Choose a model for this retry.",
  );
  picker.open();
  const lines = picker.render(50);
  assert.ok(lines.some((line) => line.includes("⚠")), "expected a thinking-off warning in the render");
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(plain.some((line) => line.startsWith("  type filters models")), "footer hints keep the two-column inset");
  for (const line of lines) assert.equal(visibleWidth(line), 50);
});

test("the framed model picker keeps ten model rows with or without a filter", () => {
  for (const count of [9, 10, 11, 15]) {
    const refs: ModelRef[] = Array.from({ length: count }, (_, index) => ({ provider: "test", id: `model-${index}` }));
    const view: RetryModelSubView = new RetryModelSubView(
      tui,
      theme,
      context,
      refs,
      {},
      currentThinking,
      { label: "test/model-0", ref: refs[0]! },
      "Retry model",
      "Choose a model for this retry.",
    );
    view.open();
    for (const filter of ["", "model"]) {
      for (const key of filter) view.handleInput(key);
      const lines: string[] = view.render(80);
      const modelRows = lines.filter((line) => /test\/model-\d+/.test(line)).length;
      assert.equal(modelRows, Math.min(count, 10), `count=${count} filter=${filter}`);
      assert.equal(lines.some((line) => /\(\d+\/\d+\)/.test(line)), count > 10, `scroll count=${count} filter=${filter}`);
      for (const line of lines) assert.equal(visibleWidth(line), 80);
    }
  }
});

test("seedPhaseSelections replaces a retired saved model and recomputes thinking", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const seeded = seedPhaseSelections(
    { review: { ref: { provider: "gone", id: "retired" }, thinking: "max" } },
    undefined,
    [fallbackRef],
    fallbackRef,
    () => "low",
  );

  assert.deepEqual(seeded.selections.review, { ref: fallbackRef, thinking: "low" });
  assert.deepEqual(seeded.dropped, ["gone/retired"]);
});

test("seedPhaseSelections preserves live saved choices and gives initial choices precedence", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const live = { ref: { provider: "saved", id: "live" }, thinking: "high" } as const;
  const unsaved = { ref: { provider: "unsaved", id: "picked" }, thinking: "xhigh" } as const;
  const initial: PhaseModelSelection = {
    review: unsaved,
    triage: unsaved,
    implement: unsaved,
    verify: unsaved,
  };

  const savedOnly = seedPhaseSelections(
    { review: live },
    undefined,
    [fallbackRef, live.ref],
    fallbackRef,
    () => "low",
  );
  assert.deepEqual(savedOnly.selections.review, live);

  const initialWins = seedPhaseSelections(
    { review: live },
    initial,
    [fallbackRef, live.ref],
    fallbackRef,
    () => "low",
  );
  assert.deepEqual(initialWins.selections.review, unsaved);
  assert.deepEqual(initialWins.dropped, [], "initial choices are not revalidated against the catalogue");
});

test("seedPhaseSelections reports each retired saved model once", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const retired = { ref: { provider: "gone", id: "retired" }, thinking: "medium" } as const;
  const seeded = seedPhaseSelections(
    { review: retired, triage: retired },
    undefined,
    [fallbackRef],
    fallbackRef,
    () => "off",
  );

  assert.deepEqual(seeded.dropped, ["gone/retired"]);
});
