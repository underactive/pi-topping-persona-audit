import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DECISION_SETTINGS, sanitizePersonaAuditSettings, type PersonaAuditConfig } from "../src/modelConfig.ts";
import { fromDialogSettings, openSettingsDialog, toDialogClassifiers, toDialogSettings } from "../src/ui/settings-dialog.ts";
import { toDialogModels } from "../src/ui/dialog-models.ts";
import { createDialogHost, KEY, press, ROOMY_TERMINAL, screen, type DialogHost } from "./helpers/dialog-harness.ts";

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true },
  { provider: "ollama", id: "llama3", reasoning: false },
];
const REFS = [{ provider: "anthropic", id: "claude-sonnet-5-5" }, { provider: "ollama", id: "llama3" }];

function baseConfig(): PersonaAuditConfig {
  return sanitizePersonaAuditSettings({});
}

function host(extra: Parameters<typeof createDialogHost>[0] = {}): DialogHost {
  return createDialogHost({ terminal: ROOMY_TERMINAL, models: MODELS, model: REFS[0]!, ...extra });
}

/** Open the dialog, wait for it to be shown and hand back what it resolves with. */
async function open(h: DialogHost, config: PersonaAuditConfig) {
  const result = openSettingsDialog(h.ctx, config);
  return { result, dialog: await h.dialog() };
}

test("a config survives the trip through the dialog's shape unchanged", () => {
  const models = toDialogModels(REFS, [], (ref) => (ref.provider === "anthropic" ? ["off", "low", "medium", "high"] : undefined));
  const plain = baseConfig();
  const configured: PersonaAuditConfig = {
    ...baseConfig(),
    meter: { color: "accent", direction: "ltr" },
    temperament: "caustic",
    crossExamination: "all",
    maxVerifyRounds: 7,
    rosters: [{ name: "Quick", reviewers: ["Principal Engineer", "Security Engineer"] }],
    dispatch: { ref: REFS[0]!, thinking: "high" },
    decision: { ...DEFAULT_DECISION_SETTINGS, enabled: true, provider: "typesafe", model: "jev-1.13", useForTriage: true, timeoutMs: 1234 },
    thinkingOverrides: { "anthropic/claude-sonnet-5-5": "low" },
  };
  for (const config of [plain, configured]) {
    assert.deepEqual(fromDialogSettings(config, toDialogSettings(config, models), REFS), config);
  }
});

test("a model without a thinking mode is held as level null and comes back as off", () => {
  const models = toDialogModels(REFS, [], () => undefined);
  const config: PersonaAuditConfig = { ...baseConfig(), dispatch: { ref: REFS[1]!, thinking: "off" } };
  assert.deepEqual(toDialogSettings(config, models).dispatch, { id: "ollama/llama3", level: null });
  assert.deepEqual(fromDialogSettings(config, toDialogSettings(config, models), REFS).dispatch, config.dispatch);
});

test("the classifier list marks a pin the registry no longer offers as unavailable", () => {
  const list = toDialogClassifiers([], undefined, "typesafe/jev-9");
  assert.deepEqual(list.map((c) => c.value), ["auto", "typesafe/jev-9"]);
  assert.match(list[0]!.detail, /no Jev model has credentials/);
  assert.ok(list[1]!.detail.startsWith("no "), "the dialog reads a detail starting 'no ' as unavailable");
});

test("saving without a change returns the config as it was", async () => {
  const config = baseConfig();
  const h = host();
  const { result, dialog } = await open(h, config);
  assert.match(screen(dialog, 104), /PERSONA-AUDIT: SETTINGS/);
  await press(dialog, KEY.tab, KEY.enter);
  assert.deepEqual(await result, config);
  assert.deepEqual(h.notifications, []);
});

test("the dialog is shown as an overlay of its own width, over the full height", async () => {
  const h = host();
  const { result, dialog } = await open(h, baseConfig());
  assert.deepEqual(h.customOptions.at(-1), {
    overlay: true,
    blocked: { kind: "question", message: "Persona-audit: Settings" },
    overlayOptions: { width: 104, maxHeight: "100%" },
  });
  await press(dialog, KEY.esc);
  await result;
});

test("changed rows and the decision classifier come back in the config", async () => {
  const config = baseConfig();
  const h = host();
  const { result, dialog } = await open(h, config);
  await press(dialog, KEY.right); // monitor colour: thinkingLevel -> accent
  await press(dialog, KEY.down, KEY.down, KEY.down, KEY.left); // 3 rounds -> 2
  await press(dialog, ...Array.from({ length: 4 }, () => KEY.down)); // from row 3 down to "Use the decision classifier"
  await press(dialog, KEY.space);
  await press(dialog, KEY.tab, KEY.enter);
  const saved = await result;
  assert.ok(saved);
  assert.equal(saved.meter.color, "accent");
  assert.equal(saved.maxVerifyRounds, 2);
  assert.deepEqual(saved.decision, { ...DEFAULT_DECISION_SETTINGS, enabled: true });
  const { meter: _meter, maxVerifyRounds: _rounds, decision: _decision, ...untouched } = saved;
  const { meter: _m, maxVerifyRounds: _r, decision: _d, ...original } = config;
  assert.deepEqual(untouched, original, "nothing else changed");
});

test("the dispatch model is chosen from the registry's models and cleared with backspace", async () => {
  const config = baseConfig();
  const h = host();
  const { result, dialog } = await open(h, config);
  await press(dialog, ...Array.from({ length: 6 }, () => KEY.down), KEY.enter);
  assert.match(screen(dialog, 104), /anthropic\/claude-sonnet-5-5|claude-sonnet-5-5/, "the picker lists the registry's model");
  assert.doesNotMatch(screen(dialog, 104), /Claude Opus/, "and not the mockup's sample catalogue");
  await press(dialog, KEY.enter, KEY.enter);
  await press(dialog, KEY.tab, KEY.enter);
  const saved = await result;
  assert.ok(saved?.dispatch);
  assert.deepEqual(saved.dispatch.ref, REFS[0]);

  const again = host();
  const second = await open(again, saved);
  await press(second.dialog, ...Array.from({ length: 6 }, () => KEY.down), KEY.backspace, KEY.tab, KEY.enter);
  assert.equal((await second.result)?.dispatch, undefined);
});

test("esc cancels", async () => {
  const h = host();
  const { result, dialog } = await open(h, baseConfig());
  await press(dialog, KEY.esc);
  assert.equal(await result, null);
});

test("a dispatch model the registry no longer offers is dropped with a warning", async () => {
  const config: PersonaAuditConfig = { ...baseConfig(), dispatch: { ref: { provider: "gone", id: "model" }, thinking: "low" } };
  const h = host();
  const { result, dialog } = await open(h, config);
  assert.match(screen(dialog, 104), /Session model \(not set\)/);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!.message, /gone\/model is no longer offered/);
  assert.equal(h.notifications[0]!.type, "warning");
  await press(dialog, KEY.tab, KEY.enter);
  assert.equal((await result)?.dispatch, undefined);
});

test("outside TUI mode nothing is shown and the answer is a cancel", async () => {
  const h = host({ mode: "rpc" });
  assert.equal(await openSettingsDialog(h.ctx, baseConfig()), null);
  assert.equal(h.customOptions.length, 0);
});

test("a dialog that cannot open is reported and answers undefined, so the caller can fall back", async () => {
  const h = host({ failCustom: new Error("no overlay") });
  assert.equal(await openSettingsDialog(h.ctx, baseConfig()), undefined);
  assert.deepEqual(h.notifications, [{ message: "Persona-audit settings dialog failed: no overlay", type: "error" }]);
});
