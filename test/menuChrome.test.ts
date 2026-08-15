import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MenuComponent, SELECTOR, type MenuConfig } from "../src/components/menuChrome.ts";

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
