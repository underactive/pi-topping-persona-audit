import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { VerifierRetryComponent, type VerifierRetryDecision } from "../src/components/VerifierRetry.ts";
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
