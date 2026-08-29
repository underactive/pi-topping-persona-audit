import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { displayDirectory, showPurgeMenu, type PurgeMenuResult } from "../src/components/PurgeMenu.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import type { ArtifactEntry } from "../src/artifacts.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

const entries: ArtifactEntry[] = [
  { id: "report", kind: "report", absPath: "/report", displayPath: "report.md", isDirectory: false, sizeBytes: 1024, mtimeMs: Date.now() - 86_400_000 },
  { id: "progress", kind: "progress", absPath: "/progress", displayPath: "progress.md", isDirectory: false, sizeBytes: 4, mtimeMs: Date.now() },
  { id: "snapshot", kind: "snapshot-set", absPath: "/snapshot", displayPath: "snapshot/", isDirectory: true, sizeBytes: 5, mtimeMs: Date.now() },
  { id: "handoff", kind: "handoff", absPath: "/handoff", displayPath: "handoff.md", isDirectory: false, sizeBytes: 2, mtimeMs: Date.now(), detail: "resumable" },
  { id: "cache", kind: "cache", absPath: "/cache", displayPath: "cache.json", isDirectory: false, sizeBytes: 3, mtimeMs: Date.now() },
];

function mount(preTagged = new Set<string>(), preserveCacheTags = false) {
  let component: Component | undefined;
  let capturedOptions: unknown;
  // Focused-overlay fake: Pi dispatches input straight to the component.
  const ctx = { ui: {
    custom: (
      factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: PurgeMenuResult) => void) => Component,
      options?: unknown,
    ) => {
      capturedOptions = options;
      return new Promise<PurgeMenuResult>((resolve) => { component = factory(tui, theme, undefined, resolve); });
    },
  } } as unknown as ExtensionCommandContext;
  return {
    result: showPurgeMenu(ctx, entries, preTagged, preserveCacheTags),
    send: (...keys: string[]) => keys.forEach((key) => component?.handleInput?.(key)),
    render: () => (component?.render(100) ?? []).map(strip).join("\n"),
    overlayOptions: () => capturedOptions,
  };
}

test("purge menu renders categorized tagged rows and keeps cache untagged", () => {
  const menu = mount(new Set(["report", "cache"]));
  assert.deepEqual(menu.overlayOptions(), PROMPT_OVERLAY_OPTIONS);
  const rendered = menu.render();
  assert.match(rendered, /Audit reports · \//);
  assert.match(rendered, /Progress snapshots · \//);
  assert.match(rendered, /permanent record of findings/);
  assert.match(rendered, /Partial reports saved while an audit runs/);
  assert.match(rendered, /Deferred findings saved for later review/);
  assert.match(rendered, /Copies of files before accepted fixes/);
  assert.match(rendered, /Cached reviewer outputs for unchanged runs/);
  assert.match(rendered, /1 KB.*1d/);
  assert.match(rendered, /resumable/);
  assert.match(rendered, /Reviewer cache/);
  assert.match(rendered, /cache\.json.*OFF/);
  menu.send("\x1b");
});

test("space toggles a row and Purge tagged resolves its ids", async () => {
  const menu = mount();
  menu.send(" ", "\t", "\r");
  assert.deepEqual(await menu.result, { action: "purge", tagged: new Set(["report"]) });
});

test("P previews the selected artifact while preserving tags", async () => {
  const menu = mount(new Set(["report"]));
  menu.send("P");
  assert.deepEqual(await menu.result, { action: "preview", entry: entries[0], tagged: new Set(["report"]) });

  const restored = mount(new Set(["cache"]), true);
  restored.send("\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "P");
  assert.deepEqual(await restored.result, { action: "preview", entry: entries[4], tagged: new Set(["cache"]) });
});

test("section directories shorten paths below the home directory", () => {
  assert.equal(displayDirectory(path.join(homedir(), "persona-audit", "cache", "item.json")), "~/persona-audit/cache");
});

test("escape cancels", async () => {
  const menu = mount();
  menu.send("\x1b");
  assert.equal(await menu.result, undefined);
});
