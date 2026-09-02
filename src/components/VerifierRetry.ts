/**
 * Verifier-*process*-failure checkpoint — shown only when the verifier agent
 * itself dies before producing any verdicts (most often a provider-level
 * error: credits, rate limit, context). Skipping leaves every accepted
 * finding at "cannot-verify", so the user is offered a model swap first.
 *
 * This is distinct from ordinary "not-fixed"/"partial" verdicts or a failed
 * verification script: those are normal verifier *output*, not a process
 * failure, and trigger the orchestrator's automatic gate-repair loop instead
 * of this checkpoint — no user action is needed for them to be retried.
 *
 * The chosen model applies to the rest of the Verify phase — the verifier retry
 * and the regression-test authoring run that follows it — but is deliberately
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
import { RetryMenuComponent } from "./RetryMenuComponent.ts";
import { showOverlayPrompt } from "./menuChrome.ts";

/** What the user decided to do about the failed verifier run. */
export interface VerifierRetryDecision {
  retry: boolean;
  /** Set only when the user picked a different model for the retry. */
  model?: PhaseModelChoice;
}

/** Injected by index.ts so the orchestrator stays free of TUI dependencies. */
export type VerifierFailurePrompt = (
  detail: string,
  /** The model the failed run used — a retry may already have changed it. */
  current: PhaseModelChoice | undefined,
) => Promise<VerifierRetryDecision>;

const MODEL_ROW = "verify-retry-model";

export class VerifierRetryComponent extends RetryMenuComponent<VerifierRetryDecision> {
  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    detail: string,
    current: { label: string; ref?: ModelRef },
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    done: (result: VerifierRetryDecision) => void,
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
        title: "persona-audit · verifier run crashed",
        hints: ["↑↓ item", "⏎ select", "⇥ switch btn", "esc skip"],
        modelRowId: MODEL_ROW,
        modelViewBorderTitle: "Retry model — re-run the verifier",
        modelViewDescription: "Model used to re-run the verifier and author regression tests for this run.",
        failureItemId: "verify-failure",
        failureLabel: `verifier · ${current.label}`,
        failureDescriptionPrefix: "The verifier agent itself failed to run (not a fix verdict): ",
        failureDetail: normalizeFindingText(detail),
        retryModelLabel: "Model for the retried verifier",
        retryModelDescription: "Applies to the rest of the Verify phase — the saved phase config is unchanged.",
        retryButtonLabel: "Retry verifier",
        declineButtonId: "skip",
        declineButtonLabel: "Skip verification",
      },
    );
  }
}

/**
 * Show the verifier-failure checkpoint. Outside TUI mode, or with no models
 * available, the failure is skipped — which is the behavior the audit had
 * before this checkpoint existed.
 */
export async function showVerifierRetryPrompt(
  ctx: ExtensionCommandContext,
  detail: string,
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<VerifierRetryDecision> {
  const skip: VerifierRetryDecision = { retry: false };
  if (ctx.mode !== "tui") return skip;

  const available = getModelCatalogue(ctx.modelRegistry).availableRefs();
  if (available.length === 0) return skip;

  const thinkingOverrides = { ...loadPersonaAuditConfig().thinkingOverrides };

  const result = await showOverlayPrompt<VerifierRetryDecision>(ctx, (tui, theme, finish) =>
    new VerifierRetryComponent(tui, theme, ctx, detail, current, available, thinkingOverrides, currentThinking, finish));

  return result;
}
