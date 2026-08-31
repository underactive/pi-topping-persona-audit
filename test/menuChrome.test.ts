import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  MenuComponent,
  PROMPT_OVERLAY_OPTIONS,
  SELECTOR,
  showOverlayPrompt,
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
      margin: { left: 0, right: 0, bottom: 0 },
    },
  });

  // Whatever the component hands to done resolves the returned promise.
  capturedDone!("picked");
  assert.equal(await result, "picked");
});
