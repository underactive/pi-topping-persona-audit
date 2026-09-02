import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ModelRef, PhaseModelChoice, ThinkingLevel } from "../modelConfig.ts";
import { RetryModelSubView } from "./ModelPicker.ts";
import { MenuComponent } from "./menuChrome.ts";

export interface SimpleRetryDecision {
  retry: boolean;
  model?: PhaseModelChoice;
}

export interface RetryMenuStrings {
  title: string;
  hints: string[];
  modelRowId: string;
  modelViewBorderTitle: string;
  modelViewDescription: string;
  failureItemId: string;
  failureLabel: string;
  failureDescriptionPrefix: string;
  failureDetail: string;
  retryModelLabel: string;
  retryModelDescription: string;
  retryButtonLabel: string;
  declineButtonId: string;
  declineButtonLabel: string;
}

const DETAIL_MAX = 140;

/** Shared modelView+menu wiring for single-failure retry checkpoints (verifier, adjudicator). */
export class RetryMenuComponent<T extends SimpleRetryDecision> implements Component {
  private readonly done: (result: T) => void;
  private readonly modelView: RetryModelSubView;
  private readonly menu: MenuComponent;
  private readonly modelRowId: string;

  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    current: { label: string; ref?: ModelRef },
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    done: (result: T) => void,
    strings: RetryMenuStrings,
  ) {
    this.done = done;
    this.modelRowId = strings.modelRowId;
    this.modelView = new RetryModelSubView(
      tui, theme, ctx, availableRefs, thinkingOverrides, currentThinking, current,
      strings.modelViewBorderTitle,
      strings.modelViewDescription,
    );

    const detailText = truncateToWidth(strings.failureDetail.replace(/\s+/g, " "), DETAIL_MAX, "…");

    this.menu = new MenuComponent(
      {
        title: strings.title,
        fullWidth: true,
        hints: strings.hints,
        sections: [
          {
            title: "failure",
            items: [
              {
                id: strings.failureItemId,
                label: strings.failureLabel,
                description: `${strings.failureDescriptionPrefix}${detailText}`,
              },
            ],
          },
          {
            title: "retry model",
            items: [
              {
                id: strings.modelRowId,
                label: strings.retryModelLabel,
                displayValue: this.modelView.displayValue(),
                description: strings.retryModelDescription,
                onSelect: () => this.modelView.open(),
              },
            ],
          },
        ],
        buttons: [
          {
            id: "retry",
            label: strings.retryButtonLabel,
            primary: true,
            onSelect: () => {
              const model = this.modelView.selected;
              this.done({ retry: true, ...(model ? { model } : {}) } as T);
            },
          },
          {
            id: strings.declineButtonId,
            label: strings.declineButtonLabel,
            onSelect: () => this.done({ retry: false } as T),
          },
        ],
      },
      theme,
      () => this.done({ retry: false } as T),
      tui,
    );
  }

  handleInput(data: string): void {
    if (!this.modelView.isActive) {
      this.menu.handleInput(data);
      return;
    }
    if (this.modelView.handleInput(data)) {
      this.menu.setItemValue(this.modelRowId, this.modelView.displayValue());
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
