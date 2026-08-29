import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ReviewerRetryComponent, showReviewerRetryPrompt, type ReviewerRetryDecision } from "../src/components/ReviewerRetry.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import type { ThinkingLevel } from "../src/modelConfig.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;
const context = {
  modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
} as unknown as ExtensionCommandContext;
const currentThinking: ThinkingLevel = "medium";

const failures = [
  { reviewer: "Code Quality Engineer", pass: 1, label: "Code Quality Engineer", detail: "API Error: overloaded" },
  { reviewer: "Security Engineer", pass: 2, label: "Security Engineer #2", detail: "idle timeout" },
];

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ENTER = "\r";
const ESCAPE = "\x1b";

function mount(): { component: ReviewerRetryComponent; result: () => ReviewerRetryDecision | undefined } {
  let decision: ReviewerRetryDecision | undefined;
  const component = new ReviewerRetryComponent(
    tui,
    theme,
    context,
    failures,
    { label: "test/model", ref: { provider: "test", id: "model" } },
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    (result) => {
      decision = result;
    },
  );
  return { component, result: () => decision };
}

test("failed passes default to retry and render their failure detail", () => {
  const { component } = mount();
  const rendered = component.render(80).map(strip).join("\n");

  assert.match(rendered, /failed passes \(2\)/);
  assert.match(rendered, /Code Quality Engineer.*‹retry›/);
  assert.match(rendered, /API Error: overloaded/);
  assert.match(rendered, /Security Engineer #2/);
  assert.match(rendered, /idle timeout/);
  assert.match(rendered, /test\/model \(unchanged\)/);
});

test("Continue retries every pass still marked retry", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(ENTER);

  assert.deepEqual(result(), {
    cancelled: false,
    retries: [
      { reviewer: "Code Quality Engineer", pass: 1 },
      { reviewer: "Security Engineer", pass: 2 },
    ],
  });
});

test("flipping a pass to skip drops it from the retry set", () => {
  const { component, result } = mount();
  component.handleInput(RIGHT);
  assert.match(component.render(80).map(strip).join("\n"), /Code Quality Engineer.*‹skip›/);

  component.handleInput(TAB);
  component.handleInput(ENTER);
  assert.deepEqual(result(), { cancelled: false, retries: [{ reviewer: "Security Engineer", pass: 2 }] });
});

test("Esc skips every failed pass without cancelling the audit", () => {
  const { component, result } = mount();
  component.handleInput(ESCAPE);

  assert.deepEqual(result(), { cancelled: false, retries: [] });
});

test("Cancel audit reports cancellation rather than an empty retry set", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(RIGHT);
  component.handleInput(ENTER);

  assert.deepEqual(result(), { cancelled: true, retries: [] });
});

test("choosing a retry model records it and shows it on the overview", () => {  const { component, result } = mount();
  // Down past both failure rows onto the retry-model row, then open the picker.
  component.handleInput(DOWN);
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  assert.match(component.render(80).map(strip).join("\n"), /Retry model/);

  // Confirm the preselected model/thinking pair.
  component.handleInput(ENTER);
  const overview = component.render(80).map(strip).join("\n");
  assert.match(overview, /test\/model \(thinking: /);

  component.handleInput(TAB);
  component.handleInput(ENTER);
  const decision = result();
  assert.equal(decision?.cancelled, false);
  assert.equal(decision?.retries.length, 2);
  assert.deepEqual(decision?.model?.ref, { provider: "test", id: "model" });
});

// ── Wrapper: showReviewerRetryPrompt goes through a focused custom overlay ──

const CTRL_C = "\u0003";

/** Focused-overlay fake: Pi dispatches input straight to the component and settles on done. */
function mountPrompt(): { send(...keys: string[]): void; result: Promise<ReviewerRetryDecision>; options(): unknown } {
  let component: Component | undefined;
  let capturedOptions: unknown;
  const ctx = {
    mode: "tui",
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
    ui: {
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: ReviewerRetryDecision) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<ReviewerRetryDecision>((resolve) => {
          component = factory(tui, theme, undefined, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const result = showReviewerRetryPrompt(
    ctx,
    failures,
    { label: "test/model", ref: { provider: "test", id: "model" } },
    currentThinking,
  );
  return {
    send: (...keys: string[]) => keys.forEach((key) => component?.handleInput?.(key)),
    result,
    options: () => capturedOptions,
  };
}

test("the checkpoint opens as a focused overlay with the shared prompt geometry", async () => {
  const prompt = mountPrompt();
  assert.deepEqual(prompt.options(), PROMPT_OVERLAY_OPTIONS);
  prompt.send(ESCAPE);
  assert.deepEqual(await prompt.result, { cancelled: false, retries: [] });
});

test("Ctrl+C settles the checkpoint like Escape", async () => {
  const prompt = mountPrompt();
  prompt.send(CTRL_C);
  assert.deepEqual(await prompt.result, { cancelled: false, retries: [] });
});
