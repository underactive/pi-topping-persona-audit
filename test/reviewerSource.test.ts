import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import {
  showReviewerSourceMenu,
  type ReviewerSource,
  type ReviewerSourceOptions,
} from "../src/components/ReviewerSource.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\u0003";

interface Notification {
  message: string;
  type: "info" | "warning" | "error" | undefined;
}

interface Mounted {
  send(...keys: string[]): void;
  render(width?: number): string;
  result: Promise<ReviewerSource | null>;
  settled(): boolean;
  notifications: Notification[];
  overlayOptions(): unknown;
}

const DEFAULT_OPTIONS: ReviewerSourceOptions = { rosterCount: 2, dispatcherLabel: "claude-haiku-4-5" };

function mount(options: Partial<ReviewerSourceOptions> = {}): Mounted {
  let component: Component | undefined;
  let settled = false;
  let capturedOptions: unknown;
  const notifications: Notification[] = [];

  // Focused-overlay fake: Pi dispatches input straight to the component and
  // settles the overlay when the component calls done.
  const ctx = {
    ui: {
      custom: <T>(
        factory: (host: TUI, currentTheme: Theme, keybindings: KeybindingsManager, done: (value: T) => void) => Component,
        overlayOptions?: unknown,
      ) => {
        capturedOptions = overlayOptions;
        return new Promise<T>((resolve) => {
          component = factory(tui, theme, undefined as unknown as KeybindingsManager, (value) => {
            settled = true;
            resolve(value);
          });
        });
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  };

  const result = showReviewerSourceMenu(ctx, { ...DEFAULT_OPTIONS, ...options });
  return {
    send: (...keys: string[]) => {
      for (const key of keys) component?.handleInput?.(key);
    },
    render: (width = 80) => (component?.render(width) ?? []).map(strip).join("\n"),
    result,
    settled: () => settled,
    notifications,
    overlayOptions: () => capturedOptions,
  };
}

test("the menu lists the three sources with the dispatcher label and roster count", () => {
  const menu = mount();
  const rendered = menu.render();

  assert.deepEqual(menu.overlayOptions(), PROMPT_OVERLAY_OPTIONS);
  assert.match(rendered, /Persona-audit: Choose reviewers/);
  assert.match(rendered, /❯ Inspect repo \+ recommend reviewers\s+claude-haiku-4-5/);
  assert.match(rendered, /fingerprints the repo/);
  assert.match(rendered, /Load reviewer roster\s+2 defined/);
  assert.match(rendered, /Pick a saved roster from \/persona-audit-settings\./);
  assert.match(rendered, /Manually select reviewers/);
  assert.match(rendered, /Choose individual reviewers and passes from the tiered list\./);
  assert.match(rendered, /↑↓ item  ⏎ select  esc cancel audit/);
  assert.doesNotMatch(rendered, /Not set/);
  assert.equal(menu.settled(), false);

  menu.send(ESCAPE);
});

test("Enter resolves the highlighted source", async () => {
  const recommend = mount();
  recommend.send(ENTER);
  assert.equal(await recommend.result, "recommend");
  assert.ok(recommend.settled());

  const roster = mount();
  roster.send(DOWN, ENTER);
  assert.equal(await roster.result, "roster");

  const manual = mount();
  manual.send(DOWN, DOWN, ENTER);
  assert.equal(await manual.result, "manual");
});

test("Esc and Ctrl+C cancel the audit with null", async () => {
  const escaped = mount();
  escaped.send(DOWN, ESCAPE);
  assert.equal(await escaped.result, null);
  assert.ok(escaped.settled());

  const interrupted = mount();
  interrupted.send(CTRL_C);
  assert.equal(await interrupted.result, null);
});

test("the roster row warns instead of resolving when no rosters are defined", async () => {
  const menu = mount({ rosterCount: 0 });
  assert.match(menu.render(), /Load reviewer roster\s+0 defined/);

  menu.send(DOWN, ENTER);
  assert.equal(menu.settled(), false, "the menu must stay open");
  assert.deepEqual(menu.notifications, [
    { message: "No rosters defined — create one in /persona-audit-settings", type: "warning" },
  ]);

  // Still open: another row resolves as usual.
  menu.send(DOWN, ENTER);
  assert.equal(await menu.result, "manual");
  assert.equal(menu.notifications.length, 1);
});

test("initial: \"manual\" opens with the cursor on the manual row", async () => {
  const menu = mount({ initial: "manual" });
  const rendered = menu.render();
  assert.match(rendered, /❯ Manually select reviewers/);
  assert.doesNotMatch(rendered, /❯ Inspect repo/);

  menu.send(ENTER);
  assert.equal(await menu.result, "manual");
});
