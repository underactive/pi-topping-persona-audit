/**
 * First reviewer-selection screen of /persona-audit: how reviewers get chosen.
 *
 * Offers three routes — let a dispatcher agent inspect the repo and recommend
 * reviewers, load a saved roster, or pick reviewers by hand from the tiered
 * list. Esc here cancels the audit, since there is no earlier screen to step
 * back to; later screens step back to this one.
 */

import { MenuComponent, type ActionMenuItem, type OverlayPromptUi, showOverlayPrompt } from "./menuChrome.ts";

export type ReviewerSource = "recommend" | "roster" | "manual";

export interface ReviewerSourceOptions {
  /** Saved rosters available to the roster route. */
  rosterCount: number;
  /** Model label shown against the recommend row. */
  dispatcherLabel: string;
  /** Initially focused route, used when a later screen steps back here. */
  initial?: ReviewerSource;
}

/** The slice of pi's extension `ui` this menu needs: a focused overlay plus notifications. */
export interface ReviewerSourceUi extends OverlayPromptUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Show the reviewer-source menu; resolves null when the user cancels the audit. */
export function showReviewerSourceMenu(
  ctx: { ui: ReviewerSourceUi },
  options: ReviewerSourceOptions,
): Promise<ReviewerSource | null> {
  return showOverlayPrompt<ReviewerSource | null>(ctx, (tui, theme, finish) => {
    const items: ActionMenuItem[] = [
      {
        id: "recommend",
        label: "Inspect repo + recommend reviewers",
        displayValue: options.dispatcherLabel,
        description: "A cheap dispatcher agent fingerprints the repo and picks 3–10 reviewers; you can adjust them before continuing.",
        onSelect: () => finish("recommend"),
      },
      {
        id: "roster",
        label: "Load reviewer roster",
        displayValue: `${options.rosterCount} defined`,
        description: "Pick a saved roster from /persona-audit-settings.",
        onSelect: () => {
          if (options.rosterCount === 0) {
            ctx.ui.notify("No rosters defined — create one in /persona-audit-settings", "warning");
            return;
          }
          finish("roster");
        },
      },
      {
        id: "manual",
        label: "Manually select reviewers",
        // An explicit empty value keeps MenuComponent from filling the column with "Not set".
        displayValue: "",
        description: "Choose individual reviewers and passes from the tiered list.",
        onSelect: () => finish("manual"),
      },
    ];

    return new MenuComponent(
      {
        title: "Persona-audit: Choose reviewers",
        fullWidth: true,
        sections: [{ title: "", items }],
        hints: ["↑↓ item", "⏎ select", "esc cancel audit"],
        initialItemId: options.initial,
      },
      theme,
      () => finish(null),
      tui,
    );
  });
}
