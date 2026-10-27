import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";
import { showSettingsMenu, type SettingsMenuResult } from "../src/components/SettingsMenu.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import {
  DEFAULT_METER_SETTINGS,
  DEFAULT_CROSS_EXAMINATION_MODE,
  DEFAULT_TEMPERAMENT,
  DEFAULT_VERIFY_ROUNDS,
  type MeterSettings,
  type PersonaAuditConfig,
  type CrossExaminationMode,
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
const BACKSPACE = "\x7f";
/** Row 7: color, direction, temperament, max-rounds, crossExamination, rosters, then dispatch. */
const TO_DISPATCH_ROW = [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN];

interface Mounted {
  send(...keys: string[]): void;
  render(width?: number): string;
  result: Promise<SettingsMenuResult>;
  settled(): boolean;
  overlayOptions(): unknown;
  warnings(): string[];
}

const config = (
  meter: MeterSettings,
  temperament: Temperament = DEFAULT_TEMPERAMENT,
  maxVerifyRounds: number = DEFAULT_VERIFY_ROUNDS,
  crossExamination: CrossExaminationMode = DEFAULT_CROSS_EXAMINATION_MODE,
): PersonaAuditConfig => ({
  phases: {},
  thinkingOverrides: {},
  meter,
  temperament,
  crossExamination,
  maxVerifyRounds,
  rosters: [],
});

function mount(initial: PersonaAuditConfig = config(DEFAULT_METER_SETTINGS), nested: readonly string[] = []): Mounted {
  let component: Component | undefined;
  let settled = false;
  let capturedOptions: unknown;
  let customCalls = 0;
  const warnings: string[] = [];

  // Focused-overlay fake: Pi dispatches input straight to the component and
  // settles the overlay when the component calls done.
  const ctx = {
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "model", reasoning: false }],
      getModelsOfType: () => [
        { type: "classifier", provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" },
        { type: "classifier", provider: "openrouter", id: "typesafe/jev-1.13", api: "openai-completions" },
      ],
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
      findOfType: (_type: string, provider: string, id: string) =>
        provider === "typesafe" && id === "jev-latest" ? { provider, id } : undefined,
    },
    ui: {
      notify: (message: string, level: string) => {
        if (level === "warning") warnings.push(message);
      },
      custom: (
        factory: (host: TUI, currentTheme: Theme, keybindings: unknown, done: (value: SettingsMenuResult) => void) => Component,
        options?: unknown,
      ) => {
        customCalls += 1;
        // A nested overlay (the classifier picker) is driven with the supplied
        // keys and resolves with whatever it selected, like pi would.
        if (customCalls > 1) {
          let picked!: SettingsMenuResult;
          const overlay = factory(tui, theme, getKeybindings(), (value) => {
            picked = value;
          });
          for (const key of nested) overlay.handleInput?.(key);
          return Promise.resolve(picked);
        }
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

  const result = showSettingsMenu(ctx, initial, "medium");
  return {
    send: (...keys: string[]) => {
      for (const key of keys) component?.handleInput?.(key);
    },
    render: (width = 56) => (component?.render(width) ?? []).map(strip).join("\n"),
    result,
    settled: () => settled,
    overlayOptions: () => capturedOptions,
    warnings: () => [...warnings],
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

test("the cross-examination row renders, cycles, and saves", async () => {
  const menu = mount();
  assert.match(menu.render(), /Cross-examination pass\s+‹ red team specialists ›/);
  menu.send(DOWN, DOWN, DOWN, DOWN, RIGHT);
  assert.match(menu.render(), /Cross-examination pass\s+‹ all reviewers ›/);
  menu.send(TAB, ENTER);
  assert.deepEqual(
    await menu.result,
    { action: "save", draft: config(DEFAULT_METER_SETTINGS, DEFAULT_TEMPERAMENT, DEFAULT_VERIFY_ROUNDS, "all") },
  );
});

test("Reviewer rosters action carries the complete staged draft", async () => {
  const initial = config(DEFAULT_METER_SETTINGS);
  initial.rosters = [{ name: "Core5", reviewers: ["Principal Engineer"] }];
  const menu = mount(initial);
  assert.match(menu.render(), /Reviewer rosters\s+1 configured/);

  menu.send(RIGHT, DOWN, DOWN, DOWN, DOWN, DOWN, ENTER);
  assert.deepEqual(await menu.result, {
    action: "rosters",
    draft: { ...initial, meter: { color: "accent", direction: "rtl" } },
  });
});

test("the dispatch row shows the session fallback until a model is chosen", async () => {
  const menu = mount();
  assert.match(menu.render(), /Dispatch model\s+Session model \(not set\)/);

  const seeded = config(DEFAULT_METER_SETTINGS);
  seeded.dispatch = { ref: { provider: "test", id: "model" }, thinking: "off" };
  const seededMenu = mount(seeded);
  assert.match(seededMenu.render(), /Dispatch model\s+test\/model \(thinking: off\)/);

  menu.send(TAB, ENTER);
  seededMenu.send(TAB, ENTER);
  await Promise.all([menu.result, seededMenu.result]);
});

test("a retired dispatch model is cleared, warned about, and not saved again", async () => {
  const initial = config(DEFAULT_METER_SETTINGS);
  initial.dispatch = { ref: { provider: "gone", id: "model" }, thinking: "medium" };
  const menu = mount(initial);

  assert.match(menu.render(), /Dispatch model\s+Session model \(not set\)/);
  assert.deepEqual(menu.warnings(), [
    'Dispatch model gone/model is no longer offered by the registry; the row now reads "Session model (not set)". Pick a replacement or save to clear it.',
  ]);

  menu.send(TAB, ENTER);
  const saved = await menu.result;
  assert.equal(saved.action, "save");
  assert.equal(saved.action === "save" && "dispatch" in saved.draft, false);
});

test("Enter on the dispatch row opens the two-pane picker and Esc returns to the menu", async () => {
  const menu = mount();
  menu.send(...TO_DISPATCH_ROW, ENTER);
  assert.match(menu.render(), /Dispatch model — inspects the repo/);
  assert.doesNotMatch(menu.render(), /Persona-audit: Settings/);
  assert.ok(!menu.settled());

  menu.send(ESCAPE);
  assert.match(menu.render(), /Persona-audit: Settings/);
  assert.ok(!menu.settled(), "Esc in the sub-screen must not close the settings menu");

  menu.send(TAB, ENTER);
  assert.deepEqual(await menu.result, { action: "save", draft: config(DEFAULT_METER_SETTINGS) });
});

test("confirming a dispatch model stores it in the saved draft and Backspace removes the key", async () => {
  const menu = mount();
  menu.send(...TO_DISPATCH_ROW, ENTER, ENTER);
  assert.match(menu.render(), /Dispatch model\s+test\/model \(thinking: off\)/);
  menu.send(TAB, ENTER);
  const saved = await menu.result;
  assert.equal(saved.action, "save");
  assert.deepEqual(saved.action === "save" ? saved.draft.dispatch : undefined, {
    ref: { provider: "test", id: "model" },
    thinking: "off",
  });

  const seeded = config(DEFAULT_METER_SETTINGS);
  seeded.dispatch = { ref: { provider: "test", id: "model" }, thinking: "off" };
  const cleared = mount(seeded);
  cleared.send(...TO_DISPATCH_ROW, BACKSPACE);
  assert.match(cleared.render(), /Session model \(not set\)/);
  cleared.send(TAB, ENTER);
  const clearedResult = await cleared.result;
  assert.equal(clearedResult.action, "save");
  assert.equal(clearedResult.action === "save" && "dispatch" in clearedResult.draft, false, "clearing must drop the key entirely");
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

// ── the decision-classifier section ──────────────────────────────────────────

const DECISION_TOGGLE_ROW = 7;
const DECISION_CLASSIFIER_ROW = 8;

test("the decision section renders the classifier row and its three toggles", () => {
  const menu = mount();
  const rendered = menu.render();

  assert.match(rendered, /Decision classifier/);
  assert.match(rendered, /Use the decision classifier/);
  assert.match(rendered, /Classifier names the reviewers/);
  assert.match(rendered, /Classifier suggests triage/);
  assert.match(rendered, /auto \(typesafe\/jev-latest\)/, "auto resolves to the first credentialed model");
  // The dispatch row keeps its long-standing position, above the new section.
  assert.match(rendered, /Dispatch model/);
});

test("the decision toggles change the draft and Save persists them", async () => {
  const menu = mount();
  menu.send(...Array.from({ length: DECISION_TOGGLE_ROW }, () => DOWN), " ", TAB, ENTER);

  const saved = await menu.result;
  assert.equal(saved.action, "save");
  if (saved.action !== "save") return;
  assert.deepEqual(saved.draft.decision, {
    enabled: true,
    provider: "auto",
    model: "auto",
    timeoutMs: 3000,
    circuitBreakerEnabled: true,
    circuitBreakerCooldownSeconds: 30,
    useForDispatcher: true,
    useForTriage: false,
  });
});

test("the classifier row opens the picker, and a pick turns the feature on", async () => {
  // Enter on the row opens the picker; Enter there selects the highlighted
  // `auto` row, which is enough to opt in.
  const menu = mount(config(DEFAULT_METER_SETTINGS), [ENTER]);
  menu.send(...Array.from({ length: DECISION_CLASSIFIER_ROW }, () => DOWN), ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(menu.render(), /Decision classifier\s+auto \(typesafe\/jev-latest\)/);
  assert.match(menu.render(), /\[■\] Use the decision classifier/, "picking a model turns the feature on");

  menu.send(TAB, ENTER);
  const saved = await menu.result;
  assert.equal(saved.action, "save");
  if (saved.action !== "save") return;
  assert.equal(saved.draft.decision?.enabled, true);
  assert.equal(saved.draft.decision?.provider, "auto");
});

test("the picker's second row pins that classifier and Save persists it", async () => {
  // Down then Enter selects the first credentialed model after `auto`.
  const menu = mount(config(DEFAULT_METER_SETTINGS), [DOWN, ENTER]);
  menu.send(...Array.from({ length: DECISION_CLASSIFIER_ROW }, () => DOWN), ENTER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(menu.render(), /Decision classifier\s+typesafe\/jev-latest/);

  menu.send(TAB, ENTER);
  const saved = await menu.result;
  assert.equal(saved.action, "save");
  if (saved.action !== "save") return;
  assert.equal(saved.draft.decision?.provider, "typesafe");
  assert.equal(saved.draft.decision?.model, "jev-latest");
});

test("Backspace on the classifier row returns the selection to auto", async () => {
  const initial = config(DEFAULT_METER_SETTINGS);
  initial.decision = {
    enabled: true,
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    timeoutMs: 3000,
    circuitBreakerEnabled: true,
    circuitBreakerCooldownSeconds: 30,
    useForDispatcher: true,
    useForTriage: false,
  };
  const menu = mount(initial);
  assert.match(menu.render(), /Decision classifier\s+openrouter\/typesafe\/jev-1\.13/);

  menu.send(...Array.from({ length: DECISION_CLASSIFIER_ROW }, () => DOWN), BACKSPACE);
  assert.match(menu.render(), /Decision classifier\s+auto/);

  menu.send(TAB, ENTER);
  const saved = await menu.result;
  assert.equal(saved.action, "save");
  if (saved.action !== "save") return;
  assert.equal(saved.draft.decision?.provider, "auto");
  assert.equal(saved.draft.decision?.model, "auto");
  assert.equal(saved.draft.decision?.enabled, true, "the feature stays on; only the pin is cleared");
});
