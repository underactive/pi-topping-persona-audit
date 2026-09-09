import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { showSettingsMenu, type SettingsMenuResult } from "../src/components/SettingsMenu.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import {
  DEFAULT_METER_SETTINGS,
  DEFAULT_TEMPERAMENT,
  DEFAULT_VERIFY_ROUNDS,
  type MeterSettings,
  type PersonaAuditConfig,
  type Temperament,
} from "../src/modelConfig.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const TAB = "\t";
const ENTER = "\r";
const ESCAPE = "\x1b";

interface Mounted {
  send(...keys: string[]): void;
  render(width?: number): string;
  result: Promise<SettingsMenuResult>;
  settled(): boolean;
  overlayOptions(): unknown;
}

const config = (
  meter: MeterSettings,
  temperament: Temperament = DEFAULT_TEMPERAMENT,
  maxVerifyRounds: number = DEFAULT_VERIFY_ROUNDS,
): PersonaAuditConfig => ({
  phases: {},
  thinkingOverrides: {},
  meter,
  temperament,
  maxVerifyRounds,
  rosters: [],
});

function mount(initial: PersonaAuditConfig = config(DEFAULT_METER_SETTINGS)): Mounted {
  let component: Component | undefined;
  let settled = false;
  let capturedOptions: unknown;

  // Focused-overlay fake: Pi dispatches input straight to the component and
  // settles the overlay when the component calls done.
  const ctx = {
    ui: {
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: SettingsMenuResult) => void) => Component,
        options?: unknown,
      ) => {
        capturedOptions = options;
        return new Promise<SettingsMenuResult>((resolve) => {
          component = factory(tui, theme, undefined, (value) => {
            settled = true;
            resolve(value);
          });
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  const result = showSettingsMenu(ctx, initial);
  return {
    send: (...keys: string[]) => {
      for (const key of keys) component?.handleInput?.(key);
    },
    render: (width = 56) => (component?.render(width) ?? []).map(strip).join("\n"),
    result,
    settled: () => settled,
    overlayOptions: () => capturedOptions,
  };
}

test("the menu shows one compact row per setting, seeded from the saved values", () => {
  const menu = mount(config({ color: "warning", direction: "ltr" }, "lkml"));
  const rendered = menu.render();

  assert.match(rendered, /Persona-audit: Settings/);
  assert.match(rendered, /❯ Token activity monitor color\s+‹ warning ›/);
  assert.match(rendered, /Token activity monitor direction\s+‹ Left to Right ›/);
  assert.match(rendered, /Linus Torvalds temperament\s+‹ LKML \(max\) ›/);
  // A compact row lists only the selected value, so the row fits one line.
  assert.doesNotMatch(rendered, /borderAccent/);
  assert.match(rendered, /\[ Save \]/);

  menu.send(TAB, ENTER);
});

test("Save resolves the cycled values and settles the overlay", async () => {
  const menu = mount(config({ color: "accent", direction: "rtl" }));
  assert.deepEqual(menu.overlayOptions(), PROMPT_OVERLAY_OPTIONS);
  menu.send(RIGHT, DOWN, LEFT, DOWN, RIGHT, TAB, ENTER);

  assert.deepEqual(await menu.result, { action: "save", draft: config({ color: "border", direction: "ltr" }, "caustic") });
  assert.ok(menu.settled());
});

test("cycling wraps around every value list", async () => {
  const menu = mount(config({ color: "accent", direction: "rtl" }));
  menu.send(LEFT, DOWN, RIGHT);
  assert.match(menu.render(), /‹ thinkingLevel ›/);

  menu.send(DOWN, LEFT);
  assert.match(menu.render(), /‹ LKML \(max\) ›/);

  menu.send(TAB, ENTER);
  assert.deepEqual(await menu.result, { action: "save", draft: config({ color: "thinkingLevel", direction: "ltr" }, "lkml") });
});

test("the max-rounds row renders the saved count and cycles to a new one on Save", async () => {
  const menu = mount(config(DEFAULT_METER_SETTINGS, DEFAULT_TEMPERAMENT, 5));
  assert.match(menu.render(), /Max fix \+ verify rounds\s+‹ 5 ›/);

  // Row 4: color, direction, temperament, then max-rounds.
  menu.send(DOWN, DOWN, DOWN, RIGHT);
  assert.match(menu.render(), /Max fix \+ verify rounds\s+‹ 6 ›/);

  menu.send(TAB, ENTER);
  assert.deepEqual(await menu.result, { action: "save", draft: config(DEFAULT_METER_SETTINGS, DEFAULT_TEMPERAMENT, 6) });
});

test("Reviewer rosters action carries the complete staged draft", async () => {
  const initial = config(DEFAULT_METER_SETTINGS);
  initial.rosters = [{ name: "Core5", reviewers: ["Principal Engineer"] }];
  const menu = mount(initial);
  assert.match(menu.render(), /Reviewer rosters\s+1 configured/);

  menu.send(RIGHT, DOWN, DOWN, DOWN, DOWN, ENTER);
  assert.deepEqual(await menu.result, {
    action: "rosters",
    draft: { ...initial, meter: { color: "accent", direction: "rtl" } },
  });
});

test("Cancel and Esc both discard the edits", async () => {
  const cancelled = mount();
  cancelled.send(RIGHT, TAB, RIGHT, ENTER);
  assert.deepEqual(await cancelled.result, { action: "cancel" });

  const escaped = mount();
  escaped.send(RIGHT, ESCAPE);
  assert.deepEqual(await escaped.result, { action: "cancel" });
  assert.ok(escaped.settled());
});
