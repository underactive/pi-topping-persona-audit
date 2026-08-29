import assert from "node:assert/strict";
import { test } from "node:test";
import { type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import {
  ReportViewer,
  type ReportViewerHeader,
  type ReportViewerHost,
  type ReportViewerTheme,
} from "../src/components/ReportViewer.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const WIDTH = 80;
const ROWS = 24;
const CLIP_BUDGET = Math.floor((ROWS * 75) / 100);

const theme: ReportViewerTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const header: ReportViewerHeader = {
  status: "completed",
  findingCount: 30,
  verification: "passed",
  reportPath: ".pi/persona-audit/audits/audit.md",
};

function report(lines = 30): string {
  return Array.from({ length: lines }, (_, index) => `- Item ${String(index + 1).padStart(2, "0")}`).join("\n");
}

function harness(text = report(), rows = ROWS) {
  let renders = 0;
  let closed = 0;
  const host: ReportViewerHost = {
    requestRender: () => { renders++; },
    terminal: { rows },
  };
  const viewer = new ReportViewer(text, header, theme, markdownTheme, () => { closed++; }, host);
  return {
    viewer,
    press: (key: string): void => viewer.handleInput(key),
    rendered: (width = WIDTH): string[] => viewer.render(width),
    visible: (width = WIDTH): string[] => viewer.render(width).slice(0, Math.floor((rows * 75) / 100)),
    footer: (width = WIDTH): string => viewer.render(width).at(-2) ?? "",
    renderRequests: (): number => renders,
    closes: (): number => closed,
  };
}

test("renders report chrome, position, and no lines beyond the overlay clip budget", () => {
  const ui = harness();
  const lines = ui.rendered();

  assert.ok(lines.length <= CLIP_BUDGET);
  assert.match(lines[0] ?? "", /Audit Report — completed · 30 findings · verification passed/);
  assert.match(lines[1] ?? "", /audit\.md/);
  assert.match(lines[lines.length - 2] ?? "", /↑↓ scroll.*u\/d page.*g\/G top\/bottom.*Esc close.*lines 1–12\/30/);
  assert.match(lines[lines.length - 1] ?? "", /^╚═+╝$/);
});

test("arrow keys scroll one rendered line and clamp at both ends", () => {
  const ui = harness();
  ui.rendered();
  ui.press(DOWN);
  assert.match(ui.footer(), /lines 2–13\/30/);
  assert.equal(ui.renderRequests(), 1);

  ui.press(UP);
  assert.match(ui.footer(), /lines 1–12\/30/);

  for (let index = 0; index < 100; index++) ui.press(DOWN);
  assert.match(ui.footer(), /lines 19–30\/30/);
  ui.press(DOWN);
  assert.match(ui.footer(), /lines 19–30\/30/);
});

test("page, top, and bottom keys navigate with two lines of overlap", () => {
  const ui = harness();
  ui.rendered();

  ui.press("d");
  assert.match(ui.footer(), /lines 11–22\/30/);
  ui.press("u");
  assert.match(ui.footer(), /lines 1–12\/30/);

  ui.press("G");
  assert.match(ui.footer(), /lines 19–30\/30/);
  ui.press("g");
  assert.match(ui.footer(), /lines 1–12\/30/);
});

test("Esc closes without requesting another render", () => {
  const ui = harness();
  ui.press("\x1b");

  assert.equal(ui.closes(), 1);
  assert.equal(ui.renderRequests(), 0);
});

test("width changes re-render Markdown lines, clamp the offset, and keep every line width-safe", () => {
  const ui = harness(`- ${"a long report line ".repeat(20)}\n${report(20)}`);
  ui.rendered(WIDTH);
  ui.press("G");
  const narrow = ui.visible(30);

  assert.ok(narrow.length <= CLIP_BUDGET);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 30, line);
  assert.match(ui.footer(30), /lines \d+–\d+\/\d+/);
});
