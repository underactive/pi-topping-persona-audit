import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  FULLSCREEN_OVERLAY_RESERVE_ROWS,
  FULLSCREEN_WIDGET_RESERVE_ROWS,
  MenuComponent,
  overlayViewportRows,
  PROMPT_OVERLAY_OPTIONS,
  SELECTOR,
  showOverlayPrompt,
  usableTerminalRows,
  type MenuConfig,
  type OverlayPromptUi,
} from "../src/components/menuChrome.ts";

const HIGHLIGHT = "\x1b[48;5;236m";
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => `${HIGHLIGHT}${text}\x1b[49m`,
  bold: (text: string) => text,
} as unknown as Theme;

const config: MenuConfig = {
  title: "test menu",
  fullWidth: true,
  sections: [{
    title: "items",
    items: [
      { id: "first", label: "First", displayValue: "ready", onSelect: () => {} },
      { id: "second", label: "Second", displayValue: "ready", onSelect: () => {} },
    ],
  }],
};

test("menu uses ❯ and a full-width selected-row background", () => {
  assert.equal(SELECTOR, "❯");
  const menu = new MenuComponent(config, theme, () => {});
  const selected = menu.render(60).find((line) => line.includes(HIGHLIGHT));

  assert.ok(selected);
  assert.equal(visibleWidth(selected), 60);
  assert.match(strip(selected), /^  ❯ First/);

  menu.handleInput("\x1b[B");
  const moved = menu.render(60).find((line) => line.includes(HIGHLIGHT));
  assert.ok(moved);
  assert.match(strip(moved), /^  ❯ Second/);
});

test("showOverlayPrompt opens a focused overlay with the exact shared geometry", async () => {
  let capturedOptions: unknown;
  let factoryCalled = false;
  const ui: OverlayPromptUi = {
    custom: <T>(
      factory: (tui: TUI, currentTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
      options?: unknown,
    ) => {
      capturedOptions = options;
      factoryCalled = true;
      return new Promise<T>((resolve) => {
        const component = factory({ requestRender: () => {} } as unknown as TUI, theme, undefined as unknown as KeybindingsManager, (value: T) => resolve(value));
        assert.equal(typeof component.render, "function");
      });
    },
  };

  let capturedDone: ((value: string) => void) | undefined;
  const result = showOverlayPrompt<string>({ ui }, (_tui, _theme, done) => {
    capturedDone = done;
    return { render: () => ["ok"], invalidate: () => {} };
  });

  assert.ok(factoryCalled);
  assert.deepEqual(capturedOptions, PROMPT_OVERLAY_OPTIONS);
  assert.deepEqual(capturedOptions, {
    overlay: true,
    overlayOptions: {
      anchor: "bottom-center",
      width: "100%",
      maxHeight: "100%",
      margin: { left: 0, right: 0, top: 2, bottom: 3 },
    },
  });

  // Whatever the component hands to done resolves the returned promise.
  capturedDone!("picked");
  assert.equal(await result, "picked");
});

test("usableTerminalRows takes the reserve off only in fullscreen", () => {
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "fullscreen" }, 5), 35);
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "regular" }, 5), 40);
  assert.equal(usableTerminalRows({ terminal: { rows: 40 } }, 5), 40, "a host that reports no mode reserves nothing");
  assert.equal(usableTerminalRows({ terminal: { rows: 40 }, mode: "fullscreen" }, 5, "regular"), 40, "an explicit mode overrides the host's");
});

test("usableTerminalRows falls back when the height is unknown and never drops below one row", () => {
  for (const terminal of [{ rows: 0 }, { rows: -1 }, {}, undefined]) {
    assert.equal(usableTerminalRows({ terminal }, 5), 40, `regular fallback for ${JSON.stringify(terminal)}`);
    assert.equal(usableTerminalRows({ terminal, mode: "fullscreen" }, 5), 35, `fullscreen fallback for ${JSON.stringify(terminal)}`);
  }
  assert.equal(usableTerminalRows(undefined, 5), 40, "no host at all uses the fallback");
  assert.equal(usableTerminalRows({ terminal: { rows: 3 }, mode: "fullscreen" }, 5), 1);
});

test("overlayViewportRows keeps today's 75% budget in both modes and honours each floor", () => {
  assert.equal(overlayViewportRows({ terminal: { rows: 40 }, mode: "regular" }, 1), 30);
  assert.equal(overlayViewportRows({ terminal: { rows: 40 }, mode: "fullscreen" }, 1), 30, "overlays paint over the dock, so fullscreen reserves nothing");
  assert.equal(overlayViewportRows({ terminal: { rows: 8 } }, 10), 10);
  assert.equal(overlayViewportRows({ terminal: { rows: 1 } }, 1), 1);
  assert.equal(overlayViewportRows(undefined, 1), 30, "no host budgets against the 40-row fallback");
});

test("the docked widget reserves more of a fullscreen terminal than an overlay", () => {
  assert.ok(FULLSCREEN_WIDGET_RESERVE_ROWS > FULLSCREEN_OVERLAY_RESERVE_ROWS);
});
