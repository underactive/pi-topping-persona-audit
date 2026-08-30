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
  mode: "full",
  fileCount: 3,
  selection: { reviewers: ["Security Engineer"], passes: 2 },
  phaseModels: {
    review: { ref: { provider: "test", id: "vision" }, thinking: "high" },
    triage: { ref: { provider: "test", id: "model" }, thinking: "medium" },
    implement: { ref: { provider: "test", id: "model" }, thinking: "medium" },
    verify: { ref: { provider: "test", id: "model" }, thinking: "medium" },
  },
  draft: "",
  reviewModelSupportsImages: true,
};
const ENTER = "\r";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";
const TAB = "\t";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("summary renders reviewers, run details, and context action", () => {
  const component = new AuditSummaryComponent(tui, theme, config, () => {});
  const text = component.render(100).join("\n");
  assert.match(text, /Security Engineer/);
  assert.match(text, /Passes.*2/);
  assert.match(text, /Files.*3/);
  assert.match(text, /Additional context.*\(none\)/);
});

test("embedded editor preserves its draft when returning to and reopening the summary", async () => {
  const component = new AuditSummaryComponent(tui, theme, config, () => {});
  for (let index = 0; index < 5; index++) component.handleInput(DOWN);
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
  const results: AuditSummaryResult[] = [];
  const start = new AuditSummaryComponent(tui, theme, { ...config, draft: "notes" }, (value) => { results.push(value); });
  start.handleInput(TAB);
  start.handleInput(ENTER);
  await settle();
  assert.equal(results[0]?.action, "start");

  const cancel = new AuditSummaryComponent(tui, theme, config, (value) => { results.push(value); });
  cancel.handleInput(TAB);
  cancel.handleInput("\x1b[C");
  cancel.handleInput("\x1b[C");
  cancel.handleInput(ENTER);
  assert.equal(results[1]?.action, "cancel");
});
