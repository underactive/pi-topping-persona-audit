/**
 * Settings menu for /persona-audit-settings.
 *
 * Covers the progress table's activity meter — the MONITOR column — the Linus
 * Torvalds reviewer's register, reviewer cross-examinations, the fix→verify round cap,
 * reviewer rosters, and the dispatch model that inspects the repo to recommend
 * reviewers, and the optional Jev decision classifier (dispatcher categories and
 * triage suggestions). Values are chosen inline with the left/right keys and committed
 * with the Save
 * button; Esc closes without writing, since this is the only screen and has
 * nowhere to step back to. The dispatch row opens the same two-pane
 * model/thinking selector the phase picker uses, and Esc there returns here.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { getModelCatalogue, validateSavedChoice } from "@underactive/pi-topping-primitives/models";
import {
  AUTO_CLASSIFIER,
  availableClassifiers,
  classifierPickerOptions,
  modelName,
  selectJevModel,
  showClassifierPicker,
  type JevModel,
} from "@underactive/pi-topping-primitives/classifier";
import { MenuComponent, showOverlayPrompt, type MenuItem } from "./menuChrome.ts";
import { RetryModelSubView } from "./ModelPicker.ts";
import {
  DEFAULT_DECISION_SETTINGS,
  MAX_VERIFY_ROUNDS,
  METER_COLORS,
  METER_DIRECTIONS,
  MIN_VERIFY_ROUNDS,
  phaseModelChoiceLabel,
  CROSS_EXAMINATION_MODES,
  TEMPERAMENTS,
  type DecisionSettings,
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
const DECISION_ROW = "decisionClassifier";
const DECISION_SECTION = "Decision classifier";

export type SettingsMenuResult =
  | { action: "save"; draft: PersonaAuditConfig }
  | { action: "rosters"; draft: PersonaAuditConfig }
  | { action: "cancel" };

/**
 * Every classifier the registry can offer, plus the auto choice's model.
 * A registry without the classifier API (a test stub, an older pi) simply has
 * no classifiers, which reads as "the feature is unavailable", never an error.
 */
function classifierChoices(registry: ExtensionCommandContext["modelRegistry"]): {
  available: JevModel[];
  autoModel: string | undefined;
} {
  try {
    const available = availableClassifiers(registry);
    const auto = selectJevModel(registry);
    return { available, autoModel: auto ? modelName(auto) : undefined };
  } catch {
    return { available: [], autoModel: undefined };
  }
}

/** The stored selection as the picker writes it: `auto`, or `provider/model`. */
function classifierSelection(decision: DecisionSettings): string {
  const { provider, model } = decision;
  if (!provider || !model || provider === AUTO_CLASSIFIER || model === AUTO_CLASSIFIER) return AUTO_CLASSIFIER;
  return `${provider}/${model}`;
}

/** What the row shows for the current selection, including an unavailable pin. */
function decisionDisplayValue(
  decision: DecisionSettings | undefined,
  available: readonly JevModel[],
  autoModel: string | undefined,
): string {
  // An absent block still has a selection — auto — so the row shows what would
  // run, not whether the feature is switched on. That is the toggle's job.
  const selection = decision ?? DEFAULT_DECISION_SETTINGS;
  const selected = classifierSelection(selection);
  if (selected === AUTO_CLASSIFIER) {
    return autoModel ? `auto (${autoModel})` : "auto (no Jev model has credentials)";
  }
  return available.some((model) => modelName(model) === selected) ? selected : `${selected} (unavailable)`;
}

/** Apply a picked classifier value, turning the feature on for a first pick. */
function applyClassifierSelection(draft: PersonaAuditConfig, picked: string): void {
  const base = draft.decision ?? DEFAULT_DECISION_SETTINGS;
  if (picked === AUTO_CLASSIFIER) {
    draft.decision = { ...base, enabled: true, provider: AUTO_CLASSIFIER, model: AUTO_CLASSIFIER };
    return;
  }
  // A model id can itself contain slashes (`typesafe/jev-1.13`), so only the
  // first one separates the provider.
  const slash = picked.indexOf("/");
  const provider = slash > 0 ? picked.slice(0, slash) : picked;
  const model = slash > 0 ? picked.slice(slash + 1) : "";
  draft.decision = { ...base, enabled: true, provider, model: model || AUTO_CLASSIFIER };
}

/** The decision block, created from the defaults when a row is touched first. */
function decisionDraft(draft: PersonaAuditConfig): DecisionSettings {
  draft.decision ??= { ...DEFAULT_DECISION_SETTINGS };
  return draft.decision;
}

function cloneConfig(config: PersonaAuditConfig): PersonaAuditConfig {
  // Conditional spread: an unset slot must stay absent, not become `dispatch: undefined`.
  const { dispatch, decision, ...rest } = config;
  return {
    ...rest,
    meter: { ...config.meter },
    rosters: config.rosters.map((roster) => ({ ...roster, reviewers: [...roster.reviewers] })),
    ...(dispatch ? { dispatch: { ref: { ...dispatch.ref }, thinking: dispatch.thinking } } : {}),
    ...(decision ? { decision: { ...decision } } : {}),
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

    // The decision rows come after the dispatch row, so the phase and audit
    // settings keep their long-standing order and their muscle memory.
    const { available, autoModel } = classifierChoices(ctx.modelRegistry);
    const decisionItems: MenuItem[] = [
      {
        id: "decisionEnabled",
        label: "Use the decision classifier",
        value: draft.decision?.enabled === true,
        onChange: (value: boolean) => {
          decisionDraft(draft).enabled = value;
        },
      },
      {
        id: DECISION_ROW,
        label: "Decision classifier",
        displayValue: decisionDisplayValue(draft.decision, available, autoModel),
        description:
          "Cheap classifier that replaces the dispatcher agent session and badges findings with a suggested category and verdict. "
          + "Picking a model turns the feature on; Backspace returns to auto.",
        onSelect: () => {
          const selected = classifierSelection(draft.decision ?? DEFAULT_DECISION_SETTINGS);
          void showClassifierPicker(ctx, {
            title: "Decision classifier",
            options: classifierPickerOptions(available, autoModel, selected),
            selected,
          }).then((picked) => {
            if (picked === undefined) return;
            applyClassifierSelection(draft, picked);
            this.menu.setItemValue(DECISION_ROW, decisionDisplayValue(draft.decision, available, autoModel));
            this.menu.setToggleValue("decisionEnabled", draft.decision?.enabled === true);
          });
        },
      },
      {
        id: "decisionDispatcher",
        label: "Classifier names the reviewers",
        value: draft.decision?.useForDispatcher !== false,
        description: "Classify the repo fingerprint instead of running the dispatcher agent. Falls back to it on a timeout.",
        onChange: (value: boolean) => {
          decisionDraft(draft).useForDispatcher = value;
        },
      },
      {
        id: "decisionTriage",
        label: "Classifier suggests triage",
        value: draft.decision?.useForTriage === true,
        description: "Badge each finding with a suggested category, verdict, and change kind. Suggestions never set a status.",
        onChange: (value: boolean) => {
          decisionDraft(draft).useForTriage = value;
        },
      },
    ];

    this.menu = new MenuComponent(
      {
        title: "Persona-audit: Settings",
        fullWidth: true,
        sections: [
          { title: "", items },
          {
            title: DECISION_SECTION,
            description: "A fast non-agentic classifier. It never reads the repository, and every phase still works without it.",
            items: decisionItems,
          },
        ],
        onItemKey: (item, data) => {
          if (item.id !== DISPATCH_ROW && item.id !== DECISION_ROW) return false;
          if (data !== "\x7f" && data !== "\b" && !matchesKey(data, Key.delete)) return false;
          if (item.id === DISPATCH_ROW) {
            delete draft.dispatch;
            this.menu.setItemValue(DISPATCH_ROW, dispatchDisplayValue(draft));
            return true;
          }
          // Backspace on the classifier row returns it to auto rather than
          // clearing it, because "no classifier" and "auto" behave alike.
          if (!draft.decision) return true;
          applyClassifierSelection(draft, AUTO_CLASSIFIER);
          this.menu.setItemValue(DECISION_ROW, decisionDisplayValue(draft.decision, available, autoModel));
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
  const validated = validateSavedChoice(draft.dispatch, availableRefs);
  if (validated.dropped) {
    // Otherwise the row displays a model that no longer exists, and Save —
    // which writes cloneConfig(draft) verbatim — persists the dead ref again.
    delete draft.dispatch;
    ctx.ui.notify(
      `Dispatch model ${validated.dropped} is no longer offered by the registry; the row now reads "${DISPATCH_UNSET_LABEL}". Pick a replacement or save to clear it.`,
      "warning",
    );
  }

  return showOverlayPrompt<SettingsMenuResult>(ctx, (tui, theme, finish) =>
    new SettingsMenuComponent(tui, theme, ctx, draft, currentThinking, availableRefs, finish));
}
