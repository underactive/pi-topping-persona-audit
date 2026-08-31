import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { AuditSummaryComponent, showAuditSummary, type AuditSummaryConfig, type AuditSummaryResult } from "../src/components/AuditSummary.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
const config: AuditSummaryConfig = {
  cwd: process.cwd(),
  draft: "",
  reviewModelSupportsImages: true,
};
const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("guidance view renders the title and context action without audit details", () => {
  const component = new AuditSummaryComponent(tui, theme, config, () => {});
  const text = component.render(100).join("\n");
  assert.match(text, /Persona-audit - guidance/);
  assert.match(text, /Additional context.*\(none\)/);
  assert.doesNotMatch(text, /Security Engineer|Passes|Files|Review model|Guidance/);
});

test("summary and additional context views keep the same height", () => {
  const component = new AuditSummaryComponent(tui, theme, config, () => {});
  const summaryHeight = component.render(100).length;
  component.handleInput(ENTER);
  assert.equal(component.render(100).length, summaryHeight);
});

test("embedded editor preserves its draft when returning to and reopening the summary", async () => {
  const component = new AuditSummaryComponent(tui, theme, config, () => {});
  component.handleInput(ENTER);
  assert.match(component.render(100).join("\n"), /Additional reviewer context/);
  for (const char of "Focus auth") component.handleInput(char);
  component.handleInput(ESCAPE);
  await settle();
  assert.match(component.render(100).join("\n"), /10 chars/);
  component.handleInput(ENTER);
  assert.match(component.render(100).join("\n"), /Focus auth/);
});

test("escape returns Back with the current draft", async () => {
  let component: Component | undefined;
  let options: unknown;
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      custom: (factory: (host: TUI, currentTheme: Theme, keys: unknown, done: (result: AuditSummaryResult) => void) => Component, supplied: unknown) => {
        options = supplied;
        return new Promise<AuditSummaryResult>((resolve) => { component = factory(tui, theme, undefined, resolve); });
      },
    },
  } as unknown as ExtensionCommandContext;
  const result = showAuditSummary(ctx, { ...config, draft: "remember me" });
  component?.handleInput?.(ESCAPE);
  assert.deepEqual(await result, { action: "back", draft: "remember me" });
  assert.deepEqual(options, PROMPT_OVERLAY_OPTIONS);
});

test("Start and Cancel buttons return distinct outcomes", async () => {
  const startResult = await new Promise<AuditSummaryResult>((resolve) => {
    const start = new AuditSummaryComponent(tui, theme, { ...config, draft: "notes" }, resolve);
    start.handleInput(TAB);
    start.handleInput(ENTER);
  });
  assert.equal(startResult.action, "start");

  const cancelResult = await new Promise<AuditSummaryResult>((resolve) => {
    const cancel = new AuditSummaryComponent(tui, theme, config, resolve);
    cancel.handleInput(TAB);
    cancel.handleInput("\x1b[C");
    cancel.handleInput("\x1b[C");
    cancel.handleInput(ENTER);
  });
  assert.equal(cancelResult.action, "cancel");
});
