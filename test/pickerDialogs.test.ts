import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadPersonaAuditConfig } from "../src/modelConfig.ts";
import {
  dialogPhaseChoiceLabel,
  openExpertPickerDialog,
  openGuidanceDialog,
  openPhaseModelDialog,
  openReviewerSourceDialog,
  openRosterPickerDialog,
} from "../src/ui/picker-dialogs.ts";
import { createDialogHost, KEY, press, ROOMY_TERMINAL, screen, waitFor, type DialogHost } from "./helpers/dialog-harness.ts";

const MODELS = [
  { provider: "fakeprov", id: "alpha-reasoner", reasoning: true },
  { provider: "fakeprov", id: "beta-plain", reasoning: false },
];

function host(extra: Parameters<typeof createDialogHost>[0] = {}): DialogHost {
  return createDialogHost({ terminal: ROOMY_TERMINAL, models: MODELS, model: MODELS[0]!, ...extra });
}

test("the source route is the mockup's label and carries the initial focus", async () => {
  const h = host();
  const result = openReviewerSourceDialog(h.ctx, { rosterCount: 3, dispatcherLabel: "fakeprov/alpha-reasoner · medium", initial: "roster" });
  const dialog = await h.dialog();
  const text = screen(dialog, 104);
  assert.match(text, /PERSONA-AUDIT: CHOOSE REVIEWERS/);
  assert.match(text, /fakeprov\/alpha-reasoner · medium/);
  assert.match(text, /▸ Load reviewer roster/);
  await press(dialog, KEY.enter);
  assert.equal(await result, "roster");
});

test("the expert picker receives the real reviewer catalogue and returns the chosen reviewers", async () => {
  const h = host();
  const result = openExpertPickerDialog(h.ctx, 12, undefined);
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /Principal Engineer/);
  assert.match(screen(dialog, 104), /12 files each/);
  await press(dialog, KEY.space, KEY.enter);
  assert.deepEqual(await result, { reviewers: ["Principal Engineer"], passes: 1 });
});

test("the roster picker receives saved rosters, returns their members, and uses provider-independent reviewer labels", async () => {
  const h = host();
  const rosters = [{ name: "Quick", reviewers: ["Principal Engineer", "Security Engineer"] }];
  const result = openRosterPickerDialog(h.ctx, rosters, 12, undefined);
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /Quick/);
  await press(dialog, KEY.enter);
  assert.deepEqual(await result, { rosterName: "Quick", selection: { reviewers: rosters[0]!.reviewers, passes: 1 } });
});

test("phase selections are registry-backed, persist when continued, and use mockup model labels", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-phase-dialog-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const h = host();
    const result = openPhaseModelDialog(h.ctx, "medium", undefined, true);
    const dialog = await h.dialog();
    const text = screen(dialog, 104);
    assert.match(text, /fakeprov\/alpha-reasoner/);
    assert.doesNotMatch(text, /anthropic\/claude-sonnet/);
    assert.equal(dialogPhaseChoiceLabel({ ref: MODELS[0]!, thinking: "medium" }), "fakeprov/alpha-reasoner · medium");
    await press(dialog, KEY.tab, KEY.enter);
    const completed = await result;
    assert.equal(completed?.action, "start");
    if (completed?.action !== "start") throw new Error("phase picker did not continue");
    assert.equal(completed.selections.review.ref.provider, "fakeprov");
    assert.equal(completed.selections.review.ref.id, "alpha-reasoner");
    assert.equal(loadPersonaAuditConfig().phases.review?.ref.id, "alpha-reasoner");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("escaping the phase picker returns its choices without persisting them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-phase-dialog-back-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const h = host();
    const result = openPhaseModelDialog(h.ctx, "medium", undefined, true);
    const dialog = await h.dialog();
    await press(dialog, KEY.esc);
    const returned = await result;
    assert.equal(returned?.action, "back");
    assert.equal(loadPersonaAuditConfig().phases.review, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("guidance returns its draft and parses real image paths after the user starts", async () => {
  const h = host();
  const result = openGuidanceDialog(h.ctx, "Review authentication boundaries", true);
  const dialog = await h.dialog();
  assert.match(screen(dialog, 104), /Additional context/);
  await press(dialog, KEY.tab, KEY.enter);
  assert.deepEqual(await result, {
    action: "start",
    draft: "Review authentication boundaries",
    context: { text: "Review authentication boundaries", images: [] },
  });
});

test("a generated picker that throws is reported and returns undefined, which the audit treats as a cancel", async () => {
  const h = host({ failCustom: new Error("overlay unavailable") });
  assert.equal(await openExpertPickerDialog(h.ctx, 12, undefined), undefined);
  assert.deepEqual(h.notifications, [{ message: "Persona-audit expert picker dialog failed: overlay unavailable", type: "error" }]);
});

test("the generated pickers resolve fallback values without showing when the host is not a TUI", async () => {
  const h = host({ mode: "rpc" });
  assert.equal(await openReviewerSourceDialog(h.ctx, { rosterCount: 0, dispatcherLabel: "session model" }), null);
  assert.equal(await openExpertPickerDialog(h.ctx, 1), null);
  assert.equal(await openRosterPickerDialog(h.ctx, [], 1), null);
  assert.deepEqual(await openPhaseModelDialog(h.ctx, "off"), { action: "cancel" });
  assert.deepEqual(await openGuidanceDialog(h.ctx, "draft", true), { action: "cancel", draft: "draft" });
  assert.equal(h.customOptions.length, 0);
});


test("guidance reads its attachments for real: missing files warn, and an image blocks Start on a text-only model", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-audit-guidance-"));
  try {
    // The smallest valid PNG: the parser only checks that the file exists and is small enough.
    await writeFile(path.join(cwd, "screen.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const h = host({ cwd });
    const result = openGuidanceDialog(h.ctx, "Check the layout\nscreen.png\nmissing.webp", false);
    const dialog = await h.dialog();
    await waitFor(() => /1 image/.test(screen(dialog, 104)) || undefined, "the real parse to land");
    const text = screen(dialog, 104);
    assert.match(text, /Image file not found: missing\.webp/, "the real parser's warning, not the mockup's");
    assert.match(text, /does not declare image input support/);
    await press(dialog, KEY.tab, KEY.enter);
    assert.equal(h.shown.length, 1, "Start is refused while the model cannot take the image");
    assert.match(screen(dialog, 104), /GUIDANCE/i, "the dialog is still open");
    await press(dialog, KEY.right, KEY.enter);
    assert.deepEqual(await result, { action: "back", draft: "Check the layout\nscreen.png\nmissing.webp" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
