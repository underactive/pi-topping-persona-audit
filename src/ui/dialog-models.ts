/**
 * What every generated persona-audit dialog needs from the extension: the registry's models and
 * the reviewer catalogue, in the shapes the dialogs take. Hand-written; the dialogs themselves
 * are generated from the mockups in `../pi-topping-mockups`.
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  COMMON_THINKING_LEVELS,
  defaultThinkingForModel,
  getModelCatalogue,
  thinkingOptionsForModel,
  type ThinkingLevel,
} from "@underactive/pi-topping-primitives/models";
import { TIERS } from "../components/ReviewerData.ts";
import { modelRefLabel, type ModelRef } from "../modelConfig.ts";
import type { Model, ReviewerInfo } from "./generated/persona-audit/data.ts";
import type { Level } from "./generated/splash/data.ts";

/** The dialogs identify a model by one string; `provider/id` is unique where an id alone is not. */
export const modelKey = modelRefLabel;

/** How the picker's thinking pane describes each level pi can offer. */
const LEVEL_INFO: Record<ThinkingLevel, Level> = {
  off: { id: "off", label: "Off", depth: 0, desc: "Answer directly, no extended thinking" },
  minimal: { id: "minimal", label: "Minimal", depth: 1, desc: "Fastest, barely any reasoning" },
  low: { id: "low", label: "Low", depth: 1, desc: "Brief check before answering" },
  medium: { id: "medium", label: "Medium", depth: 2, desc: "Balanced depth for everyday tasks" },
  high: { id: "high", label: "High", depth: 3, desc: "Thorough, for complex multi-step work" },
  xhigh: { id: "xhigh", label: "XHigh", depth: 4, desc: "Very deep reasoning; slow" },
  max: { id: "max", label: "Max", depth: 4, desc: "Deepest reasoning; slowest, priciest" },
};

/**
 * A registry model in the dialog's shape. `supported` is what the registry reports for it, or
 * `undefined` for a model pi does not list: it gets no thinking levels, as a model without a
 * thinking mode does.
 */
function toDialogModel(ref: ModelRef, supported?: readonly string[]): Model {
  if (!supported) return { id: modelKey(ref), name: ref.id, provider: ref.provider, tags: [], levels: null };
  const options = thinkingOptionsForModel(supported, { fallback: COMMON_THINKING_LEVELS });
  return {
    id: modelKey(ref),
    name: ref.id,
    provider: ref.provider,
    tags: [],
    levels: options.map((level) => LEVEL_INFO[level]),
    defaultLevel: defaultThinkingForModel(modelKey(ref), {}, "off", supported),
  };
}

/**
 * The models a dialog lists: the registry's, plus `pinned` when pi no longer offers it, so a row
 * keeps naming a model whose credentials were removed instead of showing an empty key.
 * `levelsOf` reads the levels the registry reports for one model.
 */
export function toDialogModels(
  refs: readonly ModelRef[],
  pinned: readonly ModelRef[] = [],
  levelsOf: (ref: ModelRef) => readonly string[] | undefined = () => undefined,
): Model[] {
  const models = refs.map((ref) => toDialogModel(ref, levelsOf(ref)));
  for (const ref of pinned) {
    if (!models.some((model) => model.id === modelKey(ref))) models.push(toDialogModel(ref));
  }
  return models;
}

/** The thinking levels the registry reports for `ref`; undefined when it does not list the model. */
function registryLevels(ctx: ExtensionContext, ref: ModelRef): readonly string[] | undefined {
  const model = ctx.modelRegistry.find(ref.provider, ref.id);
  return model ? getSupportedThinkingLevels(model) : undefined;
}

/** The registry's model refs, or none when it cannot be read: a registry read is display-only. */
export function readModelRefs(ctx: ExtensionContext): ModelRef[] {
  try {
    return getModelCatalogue(ctx.modelRegistry).availableRefs();
  } catch {
    return [];
  }
}

/** The models to offer, from the registry, with `pinned` kept when the registry dropped it. */
export function readDialogModels(ctx: ExtensionContext, refs: readonly ModelRef[], pinned: readonly ModelRef[] = []): Model[] {
  return toDialogModels(refs, pinned, (ref) => registryLevels(ctx, ref));
}

/** The reviewer catalogue in the dialogs' flat shape: each reviewer with its tier. */
export function dialogReviewers(): ReviewerInfo[] {
  return TIERS.flatMap((tier) =>
    tier.reviewers.map((reviewer) => ({ ...reviewer, tier: tier.tier, tierLabel: tier.label })));
}
