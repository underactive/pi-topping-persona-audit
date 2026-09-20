/**
 * Cached view of the models pi reports as usable, with the thinking levels the
 * registry declares for each.
 *
 * The registry is the only authority the picker consults: it decides both which
 * models may be selected and which thinking levels each one supports, so a
 * confirmed selection needs no further verification. Whether a model actually
 * answers is decided when it runs, not here.
 *
 * Ported from pi-moa-plan's `src/modelCatalogue.ts`.
 */

import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  isThinkingLevel,
  modelRefLabel,
  type ModelRef,
  type PhaseModelChoice,
  type ThinkingLevel,
} from "./modelConfig.ts";

export interface ModelCatalogue {
  /** Selectable models, sorted by `provider/id`. */
  availableRefs(): ModelRef[];
  /** Levels the registry declares for a model, in pi's canonical order. */
  thinkingLevelsFor(ref: ModelRef): ThinkingLevel[];
}

/** The slice of pi's `ModelRegistry` a catalogue is built from. */
export interface CatalogueRegistry {
  getAvailable(): Model<Api>[];
}

// Lives for as long as the registry object itself: pi hands extensions a stable
// registry per session, and dropping the registry drops its catalogue with it.
const CATALOGUES = new WeakMap<CatalogueRegistry, ModelCatalogue>();

export function getModelCatalogue(registry: CatalogueRegistry): ModelCatalogue {
  const cached = CATALOGUES.get(registry);
  if (cached) return cached;
  const built = buildCatalogue(registry);
  CATALOGUES.set(registry, built);
  return built;
}

function buildCatalogue(registry: CatalogueRegistry): ModelCatalogue {
  const levels = new Map<string, ThinkingLevel[]>();
  for (const model of registry.getAvailable()) {
    const key = `${model.provider}/${model.id}`;
    if (levels.has(key)) continue;
    levels.set(key, getSupportedThinkingLevels(model).filter(isThinkingLevel));
  }

  const refs = [...levels.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const slash = key.indexOf("/");
      return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
    });

  return {
    availableRefs: () => [...refs],
    thinkingLevelsFor: (ref) => levels.get(modelRefLabel(ref)) ?? [],
  };
}

/**
 * Drop a saved model choice the registry no longer lists.
 *
 * Providers retire models between runs. An unvalidated ref either fails with
 * "Model not found" or, worse, can resolve a same-named model under another
 * provider. Matching is exact on provider and id: fuzzy resolution is the
 * behavior being prevented. Returns the dropped label so callers can name the
 * model that went away.
 */
export function validateSavedChoice(
  choice: PhaseModelChoice | undefined,
  available: readonly ModelRef[],
): { choice?: PhaseModelChoice; dropped?: string } {
  if (!choice) return {};
  // An empty catalogue means nothing resolves at all; dropping every saved
  // choice there would trade one clear failure for a confusing warning.
  if (available.length === 0) return { choice };
  const label = modelRefLabel(choice.ref);
  return available.some((ref) => modelRefLabel(ref) === label) ? { choice } : { dropped: label };
}
