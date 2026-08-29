import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { VerifierRetryComponent, showVerifierRetryPrompt, type VerifierRetryDecision } from "../src/components/VerifierRetry.ts";
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

const DETAIL = '401 {"type":"error","error":{"type":"CreditsError","message":"Insufficient balance."}}';

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ENTER = "\r";
const ESCAPE = "\x1b";

function mount(): { component: VerifierRetryComponent; result: () => VerifierRetryDecision | undefined } {
  let decision: VerifierRetryDecision | undefined;
  const component = new VerifierRetryComponent(
    tui,
    theme,
    context,
    DETAIL,
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

test("the checkpoint renders the failing model and its error detail", () => {
  const { component } = mount();
  const rendered = component.render(80).map(strip).join("\n");

  assert.match(rendered, /verifier run crashed/);
  assert.match(rendered, /verifier · test\/model/);
  assert.match(rendered, /CreditsError/);
  assert.match(rendered, /test\/model \(unchanged\)/);
});

test("Retry verifier keeps the current model when none was picked", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(ENTER);

  assert.deepEqual(result(), { retry: true });
});

test("Skip verification declines the retry", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(RIGHT);
  component.handleInput(ENTER);

  assert.deepEqual(result(), { retry: false });
});

test("Esc skips verification rather than retrying", () => {
  const { component, result } = mount();
  component.handleInput(ESCAPE);

  assert.deepEqual(result(), { retry: false });
});

test("choosing a retry model records it and shows it on the overview", () => {
  const { component, result } = mount();
  // Down past the failure row onto the retry-model row, then open the picker.
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  assert.match(component.render(80).map(strip).join("\n"), /Retry model/);

  component.handleInput(ENTER);
  assert.match(component.render(80).map(strip).join("\n"), /test\/model \(thinking: /);

  component.handleInput(TAB);
  component.handleInput(ENTER);
  const decision = result();
  assert.equal(decision?.retry, true);
  assert.deepEqual(decision?.model?.ref, { provider: "test", id: "model" });
});

// ── Wrapper: showVerifierRetryPrompt goes through a focused custom overlay ──

const CTRL_C = "\u0003";

/** Focused-overlay fake: Pi dispatches input straight to the component and settles on done. */
function mountPrompt(): { send(...keys: string[]): void; result: Promise<VerifierRetryDecision>; options(): unknown } {
  let component: Component | undefined;
  let capturedOptions: unknown;
  const ctx = {
    mode: "tui",
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
    ui: {
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: VerifierRetryDecision) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<VerifierRetryDecision>((resolve) => {
          component = factory(tui, theme, undefined, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const result = showVerifierRetryPrompt(
    ctx,
    DETAIL,
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
  assert.deepEqual(await prompt.result, { retry: false });
});

test("Ctrl+C settles the checkpoint like Escape", async () => {
  const prompt = mountPrompt();
  prompt.send(CTRL_C);
  assert.deepEqual(await prompt.result, { retry: false });
});
