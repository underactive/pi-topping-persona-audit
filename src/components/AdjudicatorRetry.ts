/**
 * Adjudicator-process-failure checkpoint — shown only when the reconcile agent
 * itself fails before producing recommendations. Skipping preserves the
 * existing all-defer fallback, so the user is offered a model swap first.
 *
 * The chosen model applies only to adjudication for this run and is deliberately
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
import { sanitizeTerminalText } from "./AuditProgress.ts";
import { RetryModelSubView } from "./ModelPicker.ts";
import { MenuComponent, showOverlayPrompt } from "./menuChrome.ts";

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

const DETAIL_MAX = 140;
const MODEL_ROW = "adjudicator-retry-model";

export class AdjudicatorRetryComponent implements Component {
  private readonly done: (result: AdjudicatorRetryDecision) => void;
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
    done: (result: AdjudicatorRetryDecision) => void,
  ) {
    this.done = done;
    this.modelView = new RetryModelSubView(
      tui, theme, ctx, availableRefs, thinkingOverrides, currentThinking, current,
      "Retry model — re-run the adjudicator",
      "Model used to re-run adjudicator reconciliation for this audit.",
    );

    this.menu = new MenuComponent(
      {
        title: "persona-audit · adjudicator reconcile failed",
        fullWidth: true,
        hints: ["↑↓ item", "⏎ select", "⇥ switch btn", "esc continue"],
        sections: [
          {
            title: "failure",
            items: [
              {
                id: "adjudicator-failure",
                label: `adjudicator · ${sanitizeTerminalText(current.label)}`,
                description: `The adjudicator failed to produce recommendations: ${truncateToWidth(sanitizeTerminalText(normalizeFindingText(detail).replace(/\s+/g, " ")), DETAIL_MAX, "…")}`,
              },
            ],
          },
          {
            title: "retry model",
            items: [
              {
                id: MODEL_ROW,
                label: "Model for the retried adjudicator",
                displayValue: this.modelView.displayValue(),
                description: "Applies to adjudication for this run — the saved phase config is unchanged.",
                onSelect: () => this.modelView.open(),
              },
            ],
          },
        ],
        buttons: [
          {
            id: "retry",
            label: "Retry adjudicator",
            primary: true,
            onSelect: () => {
              const model = this.modelView.selected;
              this.done({ retry: true, ...(model ? { model } : {}) });
            },
          },
          {
            id: "continue",
            label: "Continue without recommendations",
            onSelect: () => this.done({ retry: false }),
          },
        ],
      },
      theme,
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
