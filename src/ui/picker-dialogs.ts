/**
 * Adapters for the generated pre-run dialogs: reviewer source, manual picker, roster picker,
 * phase model picker and additional guidance. Each preserves the real extension's data/config
 * lifecycle while translating to and from the mockup's shapes.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import {
  defaultThinkingForModel,
  getModelCatalogue,
  isThinkingLevel,
  type ThinkingLevel,
} from "@underactive/pi-topping-primitives/models";
import { createElement } from "react";
import { parseAdditionalContext, type AdditionalContext } from "../additionalContext.ts";
import {
  loadPersonaAuditConfig,
  modelRefLabel,
  updatePersonaAuditConfig,
  type ModelRef,
  type PhaseModelChoice,
  type PhaseModelSelection,
  type PhaseSlot,
} from "../modelConfig.ts";
import { seedPhaseSelections } from "../components/ModelPicker.ts";
import type { ReviewerSelection } from "../types.ts";
import { DIALOG_MAX_HEIGHT, type TerminalSize } from "./dialog-fit.ts";
import { dialogReviewers, modelKey, readDialogModels } from "./dialog-models.ts";
import { FRAME_ROWS } from "./generated/ui.ts";
import { ExpertPicker, RosterPicker, type Selection } from "./generated/persona-audit/pickers.ts";
import { GuidanceSummary, PhaseModelPicker, ReviewerSourceMenu, type GuidanceResult, type PhaseModelsResult, type ReviewerSource } from "./generated/persona-audit/prompts.ts";
import type { ModelChoice, Phase } from "./generated/persona-audit/data.ts";
import type { Model as DialogModel } from "./generated/splash/data.ts";

const WIDTH = 104;

export interface PickerDialogSizes {
  source: TerminalSize;
  experts: TerminalSize;
  rosters: TerminalSize;
  phases: TerminalSize;
  guidance: TerminalSize;
}

/** Room reserved by the widest / tallest of the screens for each pre-run picker. */
export const PICKER_DIALOG_SIZE: PickerDialogSizes = {
  source: { columns: WIDTH, rows: 15 },
  experts: { columns: WIDTH, rows: 34 },
  rosters: { columns: WIDTH, rows: 34 },
  phases: { columns: WIDTH, rows: 34 },
  guidance: { columns: WIDTH, rows: 34 },
};

function sizeOptions(title: string) {
  return { title, width: WIDTH, maxHeight: DIALOG_MAX_HEIGHT };
}

function reportFailure(ctx: ExtensionCommandContext, label: string, error: unknown): void {
  ctx.ui.notify(`${label} dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export const dialogPhaseChoiceLabel = (choice: PhaseModelChoice): string =>
  `${modelRefLabel(choice.ref)} · ${choice.thinking}`;

export async function openReviewerSourceDialog(
  ctx: ExtensionCommandContext,
  options: { rosterCount: number; dispatcherLabel: string; initial?: ReviewerSource },
): Promise<ReviewerSource | null | undefined> {
  try {
    return await showOpenTuiDialog<ReviewerSource | null>(
      ctx,
      (done) => createElement(ReviewerSourceMenu, { width: WIDTH, ...options, onDone: done }),
      { ...sizeOptions("Persona-audit: Choose reviewers"), fallback: null },
    );
  } catch (error) {
    reportFailure(ctx, "Persona-audit reviewer source", error);
    return undefined;
  }
}

export async function openExpertPickerDialog(
  ctx: ExtensionCommandContext,
  fileCount: number,
  initial?: ReviewerSelection,
  terminal?: TerminalSize,
): Promise<ReviewerSelection | null | undefined> {
  const reviewers = dialogReviewers();
  const budget = terminal ? Math.max(1, terminal.rows - FRAME_ROWS - 14) : 17;
  try {
    const result = await showOpenTuiDialog<Selection | null>(
      ctx,
      (done) => createElement(ExpertPicker, {
        width: WIDTH,
        budget,
        fileCount,
        reviewers,
        ...(initial ? { initial } : {}),
        onDone: done,
      }),
      { ...sizeOptions("Persona-audit: Select reviewers"), fallback: null },
    );
    return result ? { reviewers: [...result.reviewers], passes: result.passes } : null;
  } catch (error) {
    reportFailure(ctx, "Persona-audit expert picker", error);
    return undefined;
  }
}

export async function openRosterPickerDialog(
  ctx: ExtensionCommandContext,
  rosters: readonly { name: string; reviewers: string[] }[],
  fileCount: number,
  initialName?: string,
  terminal?: TerminalSize,
): Promise<{ rosterName: string; selection: ReviewerSelection } | null | undefined> {
  const reviewers = dialogReviewers();
  const budget = terminal ? Math.max(1, terminal.rows - FRAME_ROWS - 14) : 17;
  try {
    const result = await showOpenTuiDialog<RosterPickerResult>(
      ctx,
      (done) => createElement(RosterPicker, {
        width: WIDTH,
        budget,
        rosters: rosters.map((roster) => ({ name: roster.name, reviewers: [...roster.reviewers] })),
        reviewers,
        fileCount,
        ...(initialName ? { initialName } : {}),
        onDone: done,
      }),
      { ...sizeOptions("Persona-audit: Load reviewer roster"), fallback: null },
    );
    return result ? { rosterName: result.rosterName, selection: { reviewers: [...result.selection.reviewers], passes: result.selection.passes } } : null;
  } catch (error) {
    reportFailure(ctx, "Persona-audit roster picker", error);
    return undefined;
  }
}

/** Type alias isolates the callback's exact shape without broadening it to unknown. */
type RosterPickerResult = { rosterName: string; selection: Selection } | null;

function toDialogChoice(choice: PhaseModelChoice, models: readonly DialogModel[]): ModelChoice {
  const model = models.find((candidate) => candidate.id === modelRefLabel(choice.ref));
  return { id: modelRefLabel(choice.ref), level: model?.levels ? choice.thinking : null };
}

function fromDialogChoice(choice: ModelChoice, refs: readonly ModelRef[]): PhaseModelChoice | undefined {
  const ref = refs.find((candidate) => modelKey(candidate) === choice.id);
  if (!ref) return undefined;
  const thinking: ThinkingLevel = isThinkingLevel(choice.level) ? choice.level : "off";
  return { ref: { ...ref }, thinking };
}

function toDialogPhaseModels(selections: PhaseModelSelection, models: readonly DialogModel[]): Record<Phase, ModelChoice> {
  return {
    review: toDialogChoice(selections.review, models),
    triage: toDialogChoice(selections.triage, models),
    implement: toDialogChoice(selections.implement, models),
    verify: toDialogChoice(selections.verify, models),
  };
}

function fromDialogPhaseModels(selections: Record<Phase, ModelChoice>, refs: readonly ModelRef[]): PhaseModelSelection | undefined {
  const mapped = {} as PhaseModelSelection;
  for (const slot of ["review", "triage", "implement", "verify"] as const satisfies readonly PhaseSlot[]) {
    const choice = fromDialogChoice(selections[slot], refs);
    if (!choice) return undefined;
    mapped[slot] = choice;
  }
  return mapped;
}

export async function openPhaseModelDialog(
  ctx: ExtensionCommandContext,
  currentThinking: ThinkingLevel,
  initial?: PhaseModelSelection,
  offerGuidance = false,
): Promise<{ action: "start" | "guidance" | "back"; selections: PhaseModelSelection } | { action: "cancel" } | undefined> {
  try {
    const catalogue = getModelCatalogue(ctx.modelRegistry);
    const refs = catalogue.availableRefs();
    if (refs.length === 0) {
      ctx.ui.notify("No models available.", "warning");
      return { action: "cancel" };
    }
    const saved = loadPersonaAuditConfig();
    const sessionRef: ModelRef | undefined = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    const fallbackRef = sessionRef ?? refs[0]!;
    const overrides = { ...saved.thinkingOverrides };
    const seeded = seedPhaseSelections(
      saved.phases,
      initial,
      refs,
      fallbackRef,
      (ref) => defaultThinkingForModel(modelRefLabel(ref), overrides, currentThinking, catalogue.thinkingLevelsFor(ref)),
    );
    if (seeded.dropped.length > 0) {
      ctx.ui.notify(
        `Saved phase ${seeded.dropped.length > 1 ? "models are" : "model is"} no longer offered by the registry (${seeded.dropped.join(", ")}); using ${modelRefLabel(fallbackRef)}. Choose a replacement before continuing.`,
        "warning",
      );
    }
    const pinned = Object.values(seeded.selections).map((choice) => choice.ref);
    const models = readDialogModels(ctx, refs, pinned);
    const initialModels = toDialogPhaseModels(seeded.selections, models);
    const result = await showOpenTuiDialog<PhaseModelsResult>(
      ctx,
      (done) => createElement(PhaseModelPicker, { width: WIDTH, initial: initialModels, offerGuidance, models, onDone: done }),
      { ...sizeOptions("Persona-audit - phase models"), fallback: { action: "cancel" } },
    );
    if (result.action === "cancel") return result;
    const selections = fromDialogPhaseModels(result.selections, refs);
    if (!selections) {
      ctx.ui.notify("The phase model selection is no longer offered by the registry. Choose it again.", "warning");
      return { action: "back", selections: seeded.selections };
    }
    if (result.action === "start" || result.action === "guidance") {
      const selectedThinking: Record<string, ThinkingLevel> = {};
      for (const slot of ["review", "triage", "implement", "verify"] as const) {
        selectedThinking[modelRefLabel(selections[slot].ref)] = selections[slot].thinking;
      }
      const persisted = updatePersonaAuditConfig((current) => ({
        ...current,
        phases: { ...selections },
        thinkingOverrides: { ...current.thinkingOverrides, ...selectedThinking },
      }));
      if (!persisted.ok) ctx.ui.notify(`Could not save phase model settings: ${persisted.message}`, "warning");
    }
    return { action: result.action, selections };
  } catch (error) {
    reportFailure(ctx, "Persona-audit phase model picker", error);
    return undefined;
  }
}

export async function openGuidanceDialog(
  ctx: ExtensionCommandContext,
  draft: string,
  reviewModelSupportsImages: boolean,
): Promise<{ action: "start"; draft: string; context: AdditionalContext } | { action: "back" | "cancel"; draft: string } | undefined> {
  try {
    const result = await showOpenTuiDialog<GuidanceResult>(
      ctx,
      (done) => createElement(GuidanceSummary, { width: WIDTH, initialDraft: draft, supportsImages: reviewModelSupportsImages, onDone: done }),
      { ...sizeOptions("Persona-audit - guidance"), fallback: { action: "cancel", draft } },
    );
    if (result.action === "back" || result.action === "cancel") return { action: result.action, draft: result.draft };
    const parsed = await parseAdditionalContext(result.draft, ctx.cwd);
    if (parsed.warnings.length) ctx.ui.notify(parsed.warnings.join("; "), "warning");
    return { action: "start", draft: result.draft, context: parsed.context };
  } catch (error) {
    reportFailure(ctx, "Persona-audit guidance", error);
    return undefined;
  }
}

