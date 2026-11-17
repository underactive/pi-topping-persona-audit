/**
 * The three retry checkpoints an audit can stop at, each the generated `RetryCheckpoint` dialog:
 *
 * - reviewer: after a batch of reviewer passes settles with at least one failure, before Triage.
 *   Each failed pass is set to retry or skip; Cancel audit stops the run.
 * - adjudicator: when the reconcile agent itself fails before producing recommendations.
 *   Declining keeps the all-defer fallback.
 * - verifier: when the verifier agent itself fails to run (not a fix verdict). Declining skips
 *   verification.
 *
 * A model picked for the retry applies to that retry only and is deliberately not written back
 * to the saved phase config. Outside TUI mode, with no models available, or when the dialog
 * fails (it has said why), the checkpoint is declined, which is what the audit did before these
 * checkpoints existed.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModelCatalogue } from "@underactive/pi-topping-primitives/models";
import type { ModelRef, PhaseModelChoice, ThinkingLevel } from "../modelConfig.ts";
import { dialogRetryModelToPhaseChoice, openRetryCheckpointDialog } from "./review-dialogs.ts";

/** A reviewer pass that failed, as shown in the checkpoint. */
export interface ReviewerFailure {
  reviewer: string;
  pass: number;
  /** Row label from the progress table ("Security Engineer" or "Security Engineer #2"). */
  label: string;
  /** Why the pass failed, as recorded on the progress row. */
  detail: string;
}

/** What the user decided to do about the failed passes. */
export interface ReviewerRetryDecision {
  /** True only when the user explicitly cancels the audit. */
  cancelled: boolean;
  retries: { reviewer: string; pass: number }[];
  /** Set only when the user picked a different model for the retries. */
  model?: PhaseModelChoice;
}

/** Injected by index.ts so the orchestrator stays free of TUI dependencies. */
export type ReviewerFailurePrompt = (
  failures: ReviewerFailure[],
  current: PhaseModelChoice | undefined,
) => Promise<ReviewerRetryDecision>;

/** What the user decided to do about the failed adjudicator run. */
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

/** The models a retry may switch to, or none when the checkpoint cannot be shown. */
function retryModels(ctx: ExtensionCommandContext): ModelRef[] {
  return ctx.mode === "tui" ? getModelCatalogue(ctx.modelRegistry).availableRefs() : [];
}

/** Show the reviewer-failure checkpoint. Declining it skips every failed pass. */
export async function showReviewerRetryPrompt(
  ctx: ExtensionCommandContext,
  failures: ReviewerFailure[],
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<ReviewerRetryDecision> {
  const skipAll: ReviewerRetryDecision = { cancelled: false, retries: [] };
  if (failures.length === 0) return skipAll;
  const available = retryModels(ctx);
  if (available.length === 0) return skipAll;

  const result = await openRetryCheckpointDialog(ctx, "reviewer", current, currentThinking, available, { failures });
  if (result?.kind !== "reviewer") return skipAll;
  const model = result.model ? dialogRetryModelToPhaseChoice(result.model, available) : undefined;
  return { cancelled: result.cancelled, retries: result.retries, ...(model ? { model } : {}) };
}

/** Show the adjudicator-failure checkpoint. Declining it keeps the all-defer fallback. */
export async function showAdjudicatorRetryPrompt(
  ctx: ExtensionCommandContext,
  detail: string,
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<AdjudicatorRetryDecision> {
  const available = retryModels(ctx);
  if (available.length === 0) return { retry: false };

  const result = await openRetryCheckpointDialog(ctx, "adjudicator", current, currentThinking, available, { detail });
  if (result?.kind !== "adjudicator") return { retry: false };
  const model = result.model ? dialogRetryModelToPhaseChoice(result.model, available) : undefined;
  return { retry: result.retry, ...(result.retry && model ? { model } : {}) };
}

/** Show the verifier-failure checkpoint. Declining it skips verification. */
export async function showVerifierRetryPrompt(
  ctx: ExtensionCommandContext,
  detail: string,
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<VerifierRetryDecision> {
  const available = retryModels(ctx);
  if (available.length === 0) return { retry: false };

  const result = await openRetryCheckpointDialog(ctx, "verifier", current, currentThinking, available, { detail });
  if (result?.kind !== "verifier") return { retry: false };
  const model = result.model ? dialogRetryModelToPhaseChoice(result.model, available) : undefined;
  return { retry: result.retry, ...(result.retry && model ? { model } : {}) };
}
