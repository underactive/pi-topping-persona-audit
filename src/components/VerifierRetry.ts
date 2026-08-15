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
import { MenuComponent, showWidgetPrompt } from "./menuChrome.ts";

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

/** Keep long provider errors to roughly two wrapped lines so the overlay height stays bounded. */
const DETAIL_MAX = 140;

const MODEL_ROW = "verify-retry-model";

export const VERIFIER_RETRY_WIDGET_KEY = "persona-audit-verifier-retry";

export class VerifierRetryComponent implements Component {
  private readonly done: (result: VerifierRetryDecision) => void;
  private readonly modelView: RetryModelSubView;
  private readonly menu: MenuComponent;

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
    this.done = done;
    this.modelView = new RetryModelSubView(
      tui, theme, ctx, availableRefs, thinkingOverrides, currentThinking, current,
      "Retry model — re-run the verifier",
      "Model used to re-run the verifier and author regression tests for this run.",
    );

    this.menu = new MenuComponent(
      {
        title: "persona-audit · verifier run crashed",
        fullWidth: true,
        hints: ["↑↓ item", "⏎ select", "⇥ switch btn", "esc skip"],
        sections: [
          {
            title: "failure",
            items: [
              {
                id: "verify-failure",
                label: `verifier · ${current.label}`,
                description: `The verifier agent itself failed to run (not a fix verdict): ${truncateToWidth(normalizeFindingText(detail).replace(/\s+/g, " "), DETAIL_MAX, "…")}`,
              },
            ],
          },
          {
            title: "retry model",
            items: [
              {
                id: MODEL_ROW,
                label: "Model for the retried verifier",
                displayValue: this.modelView.displayValue(),
                description:
                  "Applies to the rest of the Verify phase — the saved phase config is unchanged.",
                onSelect: () => this.modelView.open(),
              },
            ],
          },
        ],
        buttons: [
          {
            id: "retry",
            label: "Retry verifier",
            primary: true,
            onSelect: () => {
              const model = this.modelView.selected;
              this.done({ retry: true, ...(model ? { model } : {}) });
            },
          },
          { id: "skip", label: "Skip verification", onSelect: () => this.done({ retry: false }) },
        ],
      },
      theme,
      // Esc is the non-destructive default: leave the fixes unjudged and let
      // the audit finish, which is the behavior before this checkpoint existed.
      () => this.done({ retry: false }),
      tui,
    );
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

  const result = await showWidgetPrompt<VerifierRetryDecision | undefined>(ctx, VERIFIER_RETRY_WIDGET_KEY, (tui, theme, finish) =>
    new VerifierRetryComponent(tui, theme, ctx, detail, current, available, thinkingOverrides, currentThinking, finish));

  return result ?? skip;
}
