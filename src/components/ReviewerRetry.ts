/**
 * Reviewer-failure checkpoint, shown after a batch of reviewer passes settles
 * with at least one failure and before the Triage phase. Each failed pass is
 * flipped between retry and skip with the left/right keys; the retry model row
 * opens the same two-pane model/thinking selector the phase picker uses.
 *
 * The chosen model applies only to the retried passes — it is deliberately not
 * written back to the saved phase config, since the passes that already
 * succeeded ran on the run's original review model.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { normalizeFindingText } from "../dedup.ts";
import { getModelCatalogue } from "../modelCatalogue.ts";
import {
  loadPersonaAuditConfig,
  type ModelRef,
  type PhaseModelChoice,
  type ThinkingLevel,
} from "../modelConfig.ts";
import { RetryModelSubView } from "./ModelPicker.ts";
import { MenuComponent, showWidgetPrompt, type ChoiceMenuItem, type MenuItem } from "./menuChrome.ts";

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

/** Keep long provider errors to roughly two wrapped lines so the overlay height stays bounded. */
const DETAIL_MAX = 140;

const RETRY = "retry";
const SKIP = "skip";
const MODEL_ROW = "retry-model";

export const REVIEWER_RETRY_WIDGET_KEY = "persona-audit-reviewer-retry";
/** Failure rows shown at once; the rest scroll with the cursor so the widget stays a fixed height. */
const MAX_VISIBLE_FAILURES = 4;

export class ReviewerRetryComponent implements Component {
  private readonly failures: ReviewerFailure[];
  private readonly dispositions: string[];
  private readonly done: (result: ReviewerRetryDecision) => void;
  private readonly modelView: RetryModelSubView;
  private readonly menu: MenuComponent;

  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    failures: ReviewerFailure[],
    current: { label: string; ref?: ModelRef },
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    done: (result: ReviewerRetryDecision) => void,
  ) {
    this.failures = failures;
    this.dispositions = failures.map(() => RETRY);
    this.done = done;
    this.modelView = new RetryModelSubView(
      tui, theme, ctx, availableRefs, thinkingOverrides, currentThinking, current,
      "Retry model — re-run the failed reviewer passes",
      "Model used to re-run the failed reviewer passes. Completed passes are not re-run.",
    );

    const failureItems: MenuItem[] = failures.map((failure, index): ChoiceMenuItem => ({
      id: `${failure.reviewer}\u0000${failure.pass}`,
      label: failure.label,
      values: [RETRY, SKIP],
      valueIndex: 0,
      description: truncateToWidth(normalizeFindingText(failure.detail).replace(/\s+/g, " "), DETAIL_MAX, "…"),
      onChange: (_valueIndex, displayValue) => {
        this.dispositions[index] = displayValue;
      },
    }));

    this.menu = new MenuComponent(
      {
        title: "persona-audit · reviewer passes failed",
        fullWidth: true,
        maxItemsPerSection: MAX_VISIBLE_FAILURES,
        hints: ["↑↓ item", "←→ retry/skip", "⏎ select", "⇥ switch btn", "esc skip all"],
        sections: [
          { title: `failed passes (${failures.length})`, items: failureItems },
          {
            title: "retry model",
            items: [
              {
                id: MODEL_ROW,
                label: "Model for retried passes",
                displayValue: this.modelView.displayValue(),
                description: "Applies to the retried passes only — completed passes keep the run's review model.",
                onSelect: () => this.modelView.open(),
              },
            ],
          },
        ],
        buttons: [
          { id: "continue", label: "Continue", primary: true, onSelect: () => this.finish() },
          { id: "cancel", label: "Cancel audit", onSelect: () => this.done({ cancelled: true, retries: [] }) },
        ],
      },
      theme,
      // Esc is the non-destructive default: skip every failed pass and let the
      // audit continue with the passes that succeeded.
      () => this.done({ cancelled: false, retries: [] }),
      tui,
    );
  }

  private finish(): void {
    const retries = this.failures
      .filter((_failure, index) => this.dispositions[index] === RETRY)
      .map((failure) => ({ reviewer: failure.reviewer, pass: failure.pass }));
    const model = this.modelView.selected;
    this.done({ cancelled: false, retries, ...(model ? { model } : {}) });
  }

  handleInput(data: string): void {
    if (!this.modelView.isActive) {
      this.menu.handleInput(data);
      return;
    }
    if (this.modelView.handleInput(data)) {
      this.menu.setItemValue(MODEL_ROW, this.modelView.displayValue());
    }
  }

  render(width: number): string[] {
    return this.modelView.isActive ? this.modelView.render(width) : this.menu.render(width);
  }

  invalidate(): void {
    this.menu.invalidate();
    this.modelView.invalidate();
  }
}

/**
 * Show the reviewer-failure checkpoint. Outside TUI mode, or with no models
 * available, every failed pass is skipped — which is the behavior the audit had
 * before this checkpoint existed.
 */
export async function showReviewerRetryPrompt(
  ctx: ExtensionCommandContext,
  failures: ReviewerFailure[],
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
): Promise<ReviewerRetryDecision> {
  const skipAll: ReviewerRetryDecision = { cancelled: false, retries: [] };
  if (ctx.mode !== "tui" || failures.length === 0) return skipAll;

  const available = getModelCatalogue(ctx.modelRegistry).availableRefs();
  if (available.length === 0) return skipAll;

  const thinkingOverrides = { ...loadPersonaAuditConfig().thinkingOverrides };

  const result = await showWidgetPrompt<ReviewerRetryDecision | undefined>(ctx, REVIEWER_RETRY_WIDGET_KEY, (tui, theme, finish) =>
    new ReviewerRetryComponent(tui, theme, ctx, failures, current, available, thinkingOverrides, currentThinking, finish));

  return result ?? skipAll;
}
