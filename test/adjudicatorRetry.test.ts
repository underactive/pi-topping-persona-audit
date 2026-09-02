import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  AdjudicatorRetryComponent,
  showAdjudicatorRetryPrompt,
  type AdjudicatorRetryDecision,
} from "../src/components/AdjudicatorRetry.ts";
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
const CTRL_C = "\u0003";

function mount(): { component: AdjudicatorRetryComponent; result: () => AdjudicatorRetryDecision | undefined } {
  let decision: AdjudicatorRetryDecision | undefined;
  const component = new AdjudicatorRetryComponent(
    tui,
    theme,
    context,
    DETAIL,
    { label: "test/model", ref: { provider: "test", id: "model" } },
    [{ provider: "test", id: "model" }],
    {},
    currentThinking,
    (result) => { decision = result; },
  );
  return { component, result: () => decision };
}

test("the checkpoint renders the failing model and its error detail", () => {
  const { component } = mount();
  const rendered = component.render(80).map(strip).join("\n");
  assert.match(rendered, /adjudicator reconcile failed/);
  assert.match(rendered, /adjudicator · test\/model/);
  assert.match(rendered, /CreditsError/);
  assert.match(rendered, /test\/model \(unchanged\)/);
});

test("Retry adjudicator keeps the current model when none was picked", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(ENTER);
  assert.deepEqual(result(), { retry: true });
});

test("Continue without recommendations declines the retry", () => {
  const { component, result } = mount();
  component.handleInput(TAB);
  component.handleInput(RIGHT);
  component.handleInput(ENTER);
  assert.deepEqual(result(), { retry: false });
});

test("Esc and Ctrl+C continue without recommendations", () => {
  for (const key of [ESCAPE, CTRL_C]) {
    const { component, result } = mount();
    component.handleInput(key);
    assert.deepEqual(result(), { retry: false });
  }
});

test("choosing a retry model records it and shows it on the overview", () => {
  const { component, result } = mount();
  component.handleInput(DOWN);
  component.handleInput(ENTER);
  assert.match(component.render(80).map(strip).join("\n"), /Retry model/);
  component.handleInput(ENTER);
  assert.match(component.render(80).map(strip).join("\n"), /test\/model \(thinking: /);
  component.handleInput(TAB);
  component.handleInput(ENTER);
  assert.equal(result()?.retry, true);
  assert.deepEqual(result()?.model?.ref, { provider: "test", id: "model" });
});

function mountPrompt(): { send(...keys: string[]): void; result: Promise<AdjudicatorRetryDecision>; options(): unknown } {
  let component: Component | undefined;
  let capturedOptions: unknown;
  const ctx = {
    mode: "tui",
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: false }] },
    ui: {
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: AdjudicatorRetryDecision) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<AdjudicatorRetryDecision>((resolve) => {
          component = factory(tui, theme, undefined, resolve);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  const result = showAdjudicatorRetryPrompt(
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

test("the checkpoint opens with the shared prompt geometry and settles on cancellation", async () => {
  const prompt = mountPrompt();
  assert.deepEqual(prompt.options(), PROMPT_OVERLAY_OPTIONS);
  prompt.send(ESCAPE);
  assert.deepEqual(await prompt.result, { retry: false });
});

test("non-TUI and empty-catalogue calls skip without opening an overlay", async () => {
  let opened = false;
  const makeContext = (mode: string, models: unknown[]) => ({
    mode,
    modelRegistry: { getAvailable: () => models },
    ui: { custom: () => { opened = true; throw new Error("should not open"); } },
  }) as unknown as ExtensionCommandContext;

  assert.deepEqual(
    await showAdjudicatorRetryPrompt(makeContext("rpc", [{ provider: "test", id: "model" }]), DETAIL, { label: "test/model" }, currentThinking),
    { retry: false },
  );
  assert.deepEqual(
    await showAdjudicatorRetryPrompt(makeContext("tui", []), DETAIL, { label: "test/model" }, currentThinking),
    { retry: false },
  );
  assert.equal(opened, false);
});
