/**
 * Adapter between `PersonaAuditConfig` and the generated `/persona-audit-settings` dialog.
 *
 * Hand-written. The dialog itself is `./generated/persona-audit/admin.ts` (`SettingsMenu`, with the
 * roster manager and the dispatch and classifier sub-screens inside it), converted from the mockup
 * in `../opentui-dialogs`. This file translates the config in and the result out.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import {
  AUTO_CLASSIFIER,
  availableClassifiers,
  classifierPickerOptions,
  modelName,
  selectJevModel,
  type JevModel,
} from "@underactive/pi-topping-primitives/classifier";
import { validateSavedChoice, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";
import { createElement } from "react";
import {
  DEFAULT_DECISION_SETTINGS,
  type CrossExaminationMode,
  type DecisionSettings,
  type MeterDirection,
  type ModelRef,
  type PersonaAuditConfig,
  type Temperament,
} from "../modelConfig.ts";
import { DIALOG_MAX_HEIGHT, DIALOG_WIDTH } from "./dialog-fit.ts";
import { dialogReviewers, modelKey, readDialogModels, readModelRefs } from "./dialog-models.ts";
import type { Classifier, Model, ModelChoice, ReviewerInfo, Settings } from "./generated/persona-audit/data.ts";
import { SettingsMenu, type SettingsResult } from "./generated/persona-audit/admin.ts";

/** Reported to pi as the question the session is blocked on. */
export const SETTINGS_DIALOG_TITLE = "Persona-audit: Settings";

/** The classifier the dialog selects: `auto`, or `provider/model`. */
export function classifierSelection(decision: DecisionSettings | undefined): string {
  const { provider, model } = decision ?? DEFAULT_DECISION_SETTINGS;
  if (!provider || !model || provider === AUTO_CLASSIFIER || model === AUTO_CLASSIFIER) return AUTO_CLASSIFIER;
  return `${provider}/${model}`;
}

/** The config's dispatch model as the dialog holds it: `null` as the level of a model without thinking. */
function toDialogChoice(choice: NonNullable<PersonaAuditConfig["dispatch"]>, models: readonly Model[]): ModelChoice {
  const model = models.find((candidate) => candidate.id === modelKey(choice.ref));
  return { id: modelKey(choice.ref), level: model?.levels ? choice.thinking : null };
}

export function toDialogSettings(config: PersonaAuditConfig, models: readonly Model[]): Settings {
  return {
    meterColor: config.meter.color,
    meterDirection: config.meter.direction,
    temperament: config.temperament,
    maxVerifyRounds: config.maxVerifyRounds,
    crossExamination: config.crossExamination,
    rosters: config.rosters.map((roster) => ({ name: roster.name, reviewers: [...roster.reviewers] })),
    dispatch: config.dispatch ? toDialogChoice(config.dispatch, models) : undefined,
    decision: {
      enabled: config.decision?.enabled === true,
      model: classifierSelection(config.decision),
      useForDispatcher: config.decision?.useForDispatcher !== false,
      useForTriage: config.decision?.useForTriage === true,
    },
  };
}

/**
 * The config the user saved. Everything the dialog does not show (`phases`, `thinkingOverrides`,
 * the classifier's timeouts) comes from `initial`, and an untouched decision block stays absent.
 */
export function fromDialogSettings(initial: PersonaAuditConfig, draft: Settings, refs: readonly ModelRef[]): PersonaAuditConfig {
  const { dispatch: _dispatch, decision: _decision, ...rest } = initial;
  const ref = draft.dispatch ? refs.find((candidate) => modelKey(candidate) === draft.dispatch?.id) : undefined;
  /** The dialog's selection: `auto`, or `provider/model` where the model id may itself hold slashes. */
  const picked = draft.decision.model;
  const slash = picked.indexOf("/");
  const decision: DecisionSettings = {
    ...(initial.decision ?? DEFAULT_DECISION_SETTINGS),
    enabled: draft.decision.enabled,
    provider: picked === AUTO_CLASSIFIER ? AUTO_CLASSIFIER : slash > 0 ? picked.slice(0, slash) : picked,
    model: picked === AUTO_CLASSIFIER ? AUTO_CLASSIFIER : slash > 0 ? picked.slice(slash + 1) || AUTO_CLASSIFIER : AUTO_CLASSIFIER,
    useForDispatcher: draft.decision.useForDispatcher,
    useForTriage: draft.decision.useForTriage,
  };
  const untouched = initial.decision === undefined
    && !decision.enabled
    && picked === AUTO_CLASSIFIER
    && decision.useForDispatcher === DEFAULT_DECISION_SETTINGS.useForDispatcher
    && decision.useForTriage === DEFAULT_DECISION_SETTINGS.useForTriage;
  return {
    ...rest,
    meter: { color: draft.meterColor as PersonaAuditConfig["meter"]["color"], direction: draft.meterDirection as MeterDirection },
    temperament: draft.temperament as Temperament,
    crossExamination: draft.crossExamination as CrossExaminationMode,
    maxVerifyRounds: draft.maxVerifyRounds,
    rosters: draft.rosters.map((roster) => ({ name: roster.name, reviewers: [...roster.reviewers] })),
    ...(ref && draft.dispatch ? { dispatch: { ref: { ...ref }, thinking: (draft.dispatch.level ?? "off") as ThinkingLevel } } : {}),
    ...(untouched ? {} : { decision }),
  };
}

/** The classifiers the registry can offer, and the model `auto` would pick. A registry without the API has none. */
function classifierChoices(ctx: ExtensionCommandContext): { available: JevModel[]; autoModel: string | undefined } {
  try {
    const auto = selectJevModel(ctx.modelRegistry);
    return { available: availableClassifiers(ctx.modelRegistry), autoModel: auto ? modelName(auto) : undefined };
  } catch {
    return { available: [], autoModel: undefined };
  }
}

/**
 * The pick list in the dialog's shape. A pinned classifier the registry no longer offers is
 * marked "no longer offered", which the dialog reads as unavailable.
 */
export function toDialogClassifiers(available: readonly JevModel[], autoModel: string | undefined, selected: string): Classifier[] {
  return classifierPickerOptions(available, autoModel, selected).map((option) => ({
    value: option.value,
    label: option.label,
    detail: option.description === "unavailable" ? "no longer offered by the registry" : (option.description ?? ""),
  }));
}

export interface SettingsDialogProps {
  initial: Settings;
  models: Model[];
  reviewers: ReviewerInfo[];
  classifiers: Classifier[];
  autoClassifier: string | null;
  sessionModel?: ModelChoice;
}

/**
 * Show the generated settings dialog. Resolves with the config the user saved, or `null` when they
 * cancelled. Resolves with `undefined` when the dialog failed; the failure has been reported by
 * then, so the command handler never sees it thrown.
 */
export async function openSettingsDialog(
  ctx: ExtensionCommandContext,
  config: PersonaAuditConfig,
): Promise<PersonaAuditConfig | null | undefined> {
  try {
    const refs = readModelRefs(ctx);
    const draft = structuredClone(config);
    const validated = validateSavedChoice(draft.dispatch, refs);
    if (validated.dropped) {
      // Otherwise the row names a model that no longer exists, and Save would persist the dead ref again.
      delete draft.dispatch;
      ctx.ui.notify(
        `Dispatch model ${validated.dropped} is no longer offered by the registry; the row now reads "Session model (not set)". Pick a replacement or save to clear it.`,
        "warning",
      );
    }
    const models = readDialogModels(ctx, refs);
    const { available, autoModel } = classifierChoices(ctx);
    const sessionRef = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    const sessionModel = sessionRef && models.some((model) => model.id === modelKey(sessionRef))
      ? toDialogChoice({ ref: sessionRef, thinking: "off" }, models)
      : undefined;
    const props: SettingsDialogProps = {
      initial: toDialogSettings(draft, models),
      models,
      reviewers: dialogReviewers(),
      classifiers: toDialogClassifiers(available, autoModel, classifierSelection(draft.decision)),
      autoClassifier: autoModel ?? null,
      ...(sessionModel ? { sessionModel } : {}),
    };
    const result = await showOpenTuiDialog<SettingsResult>(
      ctx,
      (done) => createElement(SettingsMenu, {
        ...props,
        width: DIALOG_WIDTH,
        notify: (message, kind) => ctx.ui.notify(message, kind),
        onDone: done,
      }),
      { title: SETTINGS_DIALOG_TITLE, width: DIALOG_WIDTH, maxHeight: DIALOG_MAX_HEIGHT, fallback: { action: "cancel" } },
    );
    return result.action === "save" ? fromDialogSettings(draft, result.draft, refs) : null;
  } catch (error) {
    ctx.ui.notify(`Persona-audit settings dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return undefined;
  }
}
