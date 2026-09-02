/**
 * Adjudicator-process-failure checkpoint — shown only when the reconcile agent
 * itself fails before producing recommendations. Skipping preserves the
 * existing all-defer fallback, so the user is offered a model swap first.
 *
 * The chosen model applies only to adjudication for this run and is deliberately
 * not written back to the saved phase config.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { normalizeFindingText } from "../dedup.ts";
import { getModelCatalogue } from "../modelCatalogue.ts";
import {
  loadPersonaAuditConfig,
  type ModelRef,
  type PhaseModelChoice,
  type ThinkingLevel,
} from "../modelConfig.ts";
import { sanitizeTerminalText } from "./AuditProgress.ts";
import { RetryMenuComponent } from "./RetryMenuComponent.ts";
import { showOverlayPrompt } from "./menuChrome.ts";

export interface AdjudicatorRetryDecision {
  retry: boolean;
  /** Set only when the user picked a different model for the retry. */
  model?: PhaseModelChoice;
}

/** Injected by index.ts so the orchestrator stays free of TUI dependencies. */
export type AdjudicatorFailurePrompt = (
  detail: string,
  /** The model the failed run used — a retry may already have changed it. */
  current: PhaseModelChoice | undefined,
) => Promise<AdjudicatorRetryDecision>;

const MODEL_ROW = "adjudicator-retry-model";

export class AdjudicatorRetryComponent extends RetryMenuComponent<AdjudicatorRetryDecision> {
  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    detail: string,
    current: { label: string; ref?: ModelRef },
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    done: (result: AdjudicatorRetryDecision) => void,
  ) {
    super(
      tui,
      theme,
      ctx,
      current,
      availableRefs,
      thinkingOverrides,
      currentThinking,
      done,
      {
        title: "persona-audit · adjudicator reconcile failed",
        hints: ["↑↓ item", "⏎ select", "⇥ switch btn", "esc continue"],
        modelRowId: MODEL_ROW,
        modelViewBorderTitle: "Retry model — re-run the adjudicator",
        modelViewDescription: "Model used to re-run adjudicator reconciliation for this audit.",
        failureItemId: "adjudicator-failure",
        failureLabel: `adjudicator · ${sanitizeTerminalText(current.label)}`,
        failureDescriptionPrefix: "The adjudicator failed to produce recommendations: ",
        failureDetail: sanitizeTerminalText(normalizeFindingText(detail)),
        retryModelLabel: "Model for the retried adjudicator",
        retryModelDescription: "Applies to adjudication for this run — the saved phase config is unchanged.",
        retryButtonLabel: "Retry adjudicator",
        declineButtonId: "continue",
        declineButtonLabel: "Continue without recommendations",
      },
    );
  }
}

export async function showAdjudicatorRetryPrompt(
  ctx: ExtensionCommandContext,
  detail: string,
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<AdjudicatorRetryDecision> {
  const skip: AdjudicatorRetryDecision = { retry: false };
  if (ctx.mode !== "tui") return skip;

  const available = getModelCatalogue(ctx.modelRegistry).availableRefs();
  if (available.length === 0) return skip;

  const thinkingOverrides = { ...loadPersonaAuditConfig().thinkingOverrides };
  return showOverlayPrompt<AdjudicatorRetryDecision>(ctx, (tui, theme, finish) =>
    new AdjudicatorRetryComponent(
      tui,
      theme,
      ctx,
      detail,
      current,
      available,
      thinkingOverrides,
      currentThinking,
      finish,
    ));
}
