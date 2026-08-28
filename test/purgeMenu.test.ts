import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { showPurgeMenu, PURGE_MENU_WIDGET_KEY } from "../src/components/PurgeMenu.ts";
import type { ArtifactEntry } from "../src/artifacts.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

const entries: ArtifactEntry[] = [
  { id: "report", kind: "report", absPath: "/report", displayPath: "report.md", isDirectory: false, sizeBytes: 1024, mtimeMs: Date.now() - 86_400_000 },
  { id: "handoff", kind: "handoff", absPath: "/handoff", displayPath: "handoff.md", isDirectory: false, sizeBytes: 2, mtimeMs: Date.now(), detail: "resumable" },
  { id: "cache", kind: "cache", absPath: "/cache", displayPath: "cache.json", isDirectory: false, sizeBytes: 3, mtimeMs: Date.now() },
];

function mount(preTagged = new Set<string>()) {
  let component: Component | undefined;
  let handler: ((data: string) => unknown) | undefined;
  const ctx = { ui: {
    onTerminalInput: (fn: (data: string) => unknown) => { handler = fn; return () => { handler = undefined; }; },
    setWidget: (key: string, content?: (host: TUI, currentTheme: Theme) => Component) => { assert.equal(key, PURGE_MENU_WIDGET_KEY); if (content) component = content(tui, theme); },
  } } as unknown as ExtensionCommandContext;
  return { result: showPurgeMenu(ctx, entries, preTagged), send: (...keys: string[]) => keys.forEach((key) => handler?.(key)), render: () => (component?.render(100) ?? []).map(strip).join("\n") };
}

test("purge menu renders categorized tagged rows and keeps cache untagged", () => {
  const menu = mount(new Set(["report", "cache"]));
  const rendered = menu.render();
  assert.match(rendered, /Audit reports/);
  assert.match(rendered, /1 KB.*1d/);
  assert.match(rendered, /resumable/);
  assert.match(rendered, /Reviewer cache/);
  assert.match(rendered, /cache\.json.*OFF/);
  menu.send("\x1b");
});

test("space toggles a row and Purge tagged resolves its ids", async () => {
  const menu = mount();
  menu.send(" ", "\t", "\r");
  assert.deepEqual(await menu.result, new Set(["report"]));
});

test("escape cancels", async () => {
  const menu = mount();
  menu.send("\x1b");
  assert.equal(await menu.result, undefined);
});
