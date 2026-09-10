/**
 * Settings menu for /persona-audit-settings.
 *
 * Covers the progress table's activity meter — the MONITOR column — the Linus
 * Torvalds reviewer's register, reviewer cross-examinations, the fix→verify round cap,
 * reviewer rosters, and the dispatch model that inspects the repo to recommend
 * reviewers. Values are chosen inline with the left/right keys and committed
 * with the Save
 * button; Esc closes without writing, since this is the only screen and has
 * nowhere to step back to. The dispatch row opens the same two-pane
 * model/thinking selector the phase picker uses, and Esc there returns here.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { getModelCatalogue } from "../modelCatalogue.ts";
import { MenuComponent, showOverlayPrompt, type MenuItem } from "./menuChrome.ts";
import { RetryModelSubView } from "./ModelPicker.ts";
import {
  MAX_VERIFY_ROUNDS,
  METER_COLORS,
  METER_DIRECTIONS,
  MIN_VERIFY_ROUNDS,
  phaseModelChoiceLabel,
  CROSS_EXAMINATION_MODES,
  TEMPERAMENTS,
  type MeterDirection,
  type ModelRef,
  type PersonaAuditConfig,
  type CrossExaminationMode,
  type Temperament,
  type ThinkingLevel,
} from "../modelConfig.ts";

/** Direction labels, keyed by `MeterDirection` value. */
const DIRECTION_LABELS: Record<MeterDirection, string> = {
  ltr: "Left to Right",
  rtl: "Right to Left",
};

/** Temperament labels, keyed by `Temperament` value. */
const TEMPERAMENT_LABELS: Record<Temperament, string> = {
  calibrated: "neutral (min)",
  caustic: "caustic",
  lkml: "LKML (max)",
};

/** Cross-examination-pass labels, keyed by the persisted mode. */
const CROSS_EXAMINATION_LABELS: Record<CrossExaminationMode, string> = {
  off: "off",
  "red-team": "red team specialists",
  all: "all reviewers",
};

/** The selectable round counts, MIN..MAX, as the display strings the row cycles through. */
const VERIFY_ROUND_VALUES: string[] = Array.from(
  { length: MAX_VERIFY_ROUNDS - MIN_VERIFY_ROUNDS + 1 },
  (_, i) => String(i + MIN_VERIFY_ROUNDS),
);

const DISPATCH_ROW = "dispatch";
const DISPATCH_UNSET_LABEL = "Session model (not set)";

export type SettingsMenuResult =
  | { action: "save"; draft: PersonaAuditConfig }
  | { action: "rosters"; draft: PersonaAuditConfig }
  | { action: "cancel" };

function cloneConfig(config: PersonaAuditConfig): PersonaAuditConfig {
  // Conditional spread: an unset dispatch slot must stay absent, not become `dispatch: undefined`.
  const { dispatch, ...rest } = config;
  return {
    ...rest,
    meter: { ...config.meter },
    rosters: config.rosters.map((roster) => ({ ...roster, reviewers: [...roster.reviewers] })),
    ...(dispatch ? { dispatch: { ref: { ...dispatch.ref }, thinking: dispatch.thinking } } : {}),
  };
}

function dispatchDisplayValue(draft: PersonaAuditConfig): string {
  return draft.dispatch ? phaseModelChoiceLabel(draft.dispatch) : DISPATCH_UNSET_LABEL;
}

/** The settings rows plus the dispatch model sub-screen, routed by whether the sub-screen is open. */
class SettingsMenuComponent implements Component {
  private readonly menu: MenuComponent;
  private readonly modelView: RetryModelSubView | undefined;
  private readonly draft: PersonaAuditConfig;

  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    draft: PersonaAuditConfig,
    currentThinking: ThinkingLevel,
    availableRefs: ModelRef[],
    finish: (result: SettingsMenuResult) => void,
  ) {
    this.draft = draft;
    const sessionRef: ModelRef | undefined = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    const currentRef = draft.dispatch?.ref ?? sessionRef;
    this.modelView = availableRefs.length > 0
      ? new RetryModelSubView(
        tui, theme, ctx, availableRefs, {}, currentThinking,
        {
          label: draft.dispatch ? phaseModelChoiceLabel(draft.dispatch) : "session model",
          ...(currentRef ? { ref: currentRef } : {}),
        },
        "Dispatch model — inspects the repo and recommends reviewers",
        "Cheap model that fingerprints the repo and picks 3–10 reviewers before an audit. It reads files but never edits them.",
      )
      : undefined;

    const items: MenuItem[] = [
      {
        id: "meterColor",
        label: "Token activity monitor color",
        values: [...METER_COLORS],
        valueIndex: METER_COLORS.indexOf(draft.meter.color),
        compact: true,
        onChange: (index: number) => {
          draft.meter.color = METER_COLORS[index]!;
        },
      },
      {
        id: "meterDirection",
        label: "Token activity monitor direction",
        values: METER_DIRECTIONS.map((direction) => DIRECTION_LABELS[direction]),
        valueIndex: METER_DIRECTIONS.indexOf(draft.meter.direction),
        compact: true,
        onChange: (index: number) => {
          draft.meter.direction = METER_DIRECTIONS[index]!;
        },
      },
      {
        id: "temperament",
        label: "Linus Torvalds temperament",
        values: TEMPERAMENTS.map((temperament) => TEMPERAMENT_LABELS[temperament]),
        valueIndex: TEMPERAMENTS.indexOf(draft.temperament),
        compact: true,
        onChange: (index: number) => {
          draft.temperament = TEMPERAMENTS[index]!;
        },
      },
      {
        id: "maxVerifyRounds",
        label: "Max fix + verify rounds",
        description: `Round 1 verifies; the rest auto-repair. ${MIN_VERIFY_ROUNDS} turns auto-repair off.`,
        values: VERIFY_ROUND_VALUES,
        valueIndex: draft.maxVerifyRounds - MIN_VERIFY_ROUNDS,
        compact: true,
        onChange: (index: number) => {
          draft.maxVerifyRounds = index + MIN_VERIFY_ROUNDS;
        },
      },
      {
        id: "crossExamination",
        label: "Cross-examination pass",
        description: "Second pass where reviewers dispute or extend each other's findings.",
        values: CROSS_EXAMINATION_MODES.map((mode) => CROSS_EXAMINATION_LABELS[mode]),
        valueIndex: CROSS_EXAMINATION_MODES.indexOf(draft.crossExamination),
        compact: true,
        onChange: (index: number) => {
          draft.crossExamination = CROSS_EXAMINATION_MODES[index]!;
        },
      },
      {
        id: "rosters",
        label: "Reviewer rosters",
        displayValue: `${draft.rosters.length} configured`,
        description: "Create or edit reusable reviewer combinations.",
        onSelect: () => finish({ action: "rosters", draft: cloneConfig(draft) }),
      },
      {
        id: DISPATCH_ROW,
        label: "Dispatch model",
        displayValue: dispatchDisplayValue(draft),
        description: "Cheap model that inspects the repo and recommends reviewers. Backspace clears; unset uses the session model.",
        onSelect: () => {
          if (!this.modelView) {
            ctx.ui.notify("No models available.", "warning");
            return;
          }
          this.modelView.open();
        },
      },
    ];

    this.menu = new MenuComponent(
      {
        title: "Persona-audit: Settings",
        fullWidth: true,
        sections: [{ title: "", items }],
        onItemKey: (item, data) => {
          if (item.id !== DISPATCH_ROW) return false;
          if (data !== "\x7f" && data !== "\b" && !matchesKey(data, Key.delete)) return false;
          delete draft.dispatch;
          this.menu.setItemValue(DISPATCH_ROW, dispatchDisplayValue(draft));
          return true;
        },
        buttons: [
          { id: "save", label: "Save", primary: true, onSelect: () => finish({ action: "save", draft: cloneConfig(draft) }) },
          { id: "cancel", label: "Cancel", onSelect: () => finish({ action: "cancel" }) },
        ],
      },
      theme,
      () => finish({ action: "cancel" }),
      tui,
    );
  }

  handleInput(data: string): void {
    if (!this.modelView?.isActive) {
      this.menu.handleInput(data);
      return;
    }
    if (this.modelView.handleInput(data)) {
      const selected = this.modelView.selected;
      if (selected) this.draft.dispatch = { ref: { ...selected.ref }, thinking: selected.thinking };
      this.menu.setItemValue(DISPATCH_ROW, dispatchDisplayValue(this.draft));
    }
  }

  render(width: number): string[] {
    return this.modelView?.isActive ? this.modelView.render(width) : this.menu.render(width);
  }

  invalidate(): void {
    this.menu.invalidate();
    this.modelView?.invalidate();
  }
}

/** Show one settings screen. Roster management resolves so the caller can open its sequential overlay. */
export function showSettingsMenu(
  ctx: ExtensionCommandContext,
  initial: PersonaAuditConfig,
  currentThinking: ThinkingLevel,
): Promise<SettingsMenuResult> {
  const draft = cloneConfig(initial);
  const availableRefs = getModelCatalogue(ctx.modelRegistry).availableRefs();

  return showOverlayPrompt<SettingsMenuResult>(ctx, (tui, theme, finish) =>
    new SettingsMenuComponent(tui, theme, ctx, draft, currentThinking, availableRefs, finish));
}
