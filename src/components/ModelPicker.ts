/**
 * Per-phase model + thinking picker, shown after the ExpertPicker confirms
 * reviewers. One overview screen lists the four audit phases (Review,
 * Triage, Implement, Verify); opening a row shows a two-pane model/thinking
 * selector scoped to that phase. Esc on the overview steps back to the
 * reviewer picker and Cancel aborts the audit; Esc in a slot view returns to
 * the overview without discarding the other slots.
 *
 * Ported from pi-moa-plan's `src/moaModelPicker.ts` (`TwoPaneModelThinking`)
 * and `src/moaSetupOverlay.ts` (overview/slot navigation shape). Models and
 * thinking levels both come from the model registry (see
 * `@underactive/pi-topping-primitives/models`), so a confirmed selection is usable by
 * construction and nothing verifies it after the picker closes.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  getModelCatalogue,
  registryLevelOptions,
  TwoPaneModelThinking,
  validateSavedChoice,
} from "@underactive/pi-topping-primitives/models";

import {
  defaultThinkingForModel,
  loadPersonaAuditConfig,
  modelRefLabel,
  phaseModelChoiceLabel,
  PHASE_SLOTS,
  updatePersonaAuditConfig,
  type ModelRef,
  type PhaseModelChoice,
  type PhaseModelSelection,
  type PhaseSlot,
  type ThinkingLevel,
} from "../modelConfig.ts";
import {
  MenuComponent,
  renderMenuBottomBorder,
  renderMenuContentRow,
  renderMenuSeparator,
  renderMenuTopBorder,
  showOverlayPrompt,
  wrapText,
  type MenuItem,
} from "./menuChrome.ts";

export type { TwoPaneModelThinking } from "@underactive/pi-topping-primitives/models";

export type PhaseModelPickerResult =
  | { action: "start"; selections: PhaseModelSelection }
  | { action: "back"; selections: PhaseModelSelection }
  | { action: "cancel" };

export interface SeededPhases {
  selections: PhaseModelSelection;
  /** `provider/id` of each distinct saved choice the registry no longer lists. */
  dropped: string[];
}

/**
 * Seed phase slots from this run's unsaved picks, then saved config, then the
 * session model. A saved choice is atomic, so a retired ref takes its thinking
 * level with it; the replacement model may not support that level. `initial`
 * is never revalidated because it came from this session's own picker.
 */
export function seedPhaseSelections(
  saved: Partial<PhaseModelSelection>,
  initial: PhaseModelSelection | undefined,
  available: readonly ModelRef[],
  fallbackRef: ModelRef,
  thinkingFor: (ref: ModelRef) => ThinkingLevel,
): SeededPhases {
  const selections = {} as PhaseModelSelection;
  const dropped = new Set<string>();
  for (const slot of PHASE_SLOTS) {
    const seeded = initial?.[slot];
    if (seeded) {
      selections[slot] = seeded;
      continue;
    }
    const validated = validateSavedChoice(saved[slot], available);
    if (validated.dropped) dropped.add(validated.dropped);
    selections[slot] = validated.choice ?? { ref: fallbackRef, thinking: thinkingFor(fallbackRef) };
  }
  return { selections, dropped: [...dropped] };
}

/**
 * Caution shown under the thinking pane when the effective level is "off" —
 * either the model exposes no thinking mode at all, or the user picked "off" on
 * one that has it. A no-reasoning pass is where the implement phase loses
 * exact-text edits and the verifier misjudges diffs, so the picker flags the
 * choice rather than letting it pass silently. Returns undefined for any real
 * thinking level. `options` is the model's levels from `thinkingOptionsForModel`.
 */
export function thinkingOffWarning(options: ThinkingLevel[], selected: ThinkingLevel): string | undefined {
  if (selected !== "off") return undefined;
  const lead = options.some((level) => level !== "off")
    ? "Thinking is turned off for this model"
    : "This model has no thinking mode";
  return `⚠ ${lead} — it runs in a single pass with no reasoning step, which makes it less reliable at careful multi-step work like landing exact-text edits or judging diffs. A thinking-capable model is recommended.`;
}

/** Model rows the picker has always shown; the shared body cap also counts header, filter and scroll rows. */
const PICKER_LIST_ROWS = 10;

/** Header plus a possible scroll row, and the filter row while one is typed. */
function pickerBodyRows(filter: string): number {
  return PICKER_LIST_ROWS + 2 + (filter ? 1 : 0);
}

/** Bind the shared unframed picker to persona-audit's thinking and keyboard policy. */
export function createPhaseModelPicker(
  tui: TUI,
  theme: Theme,
  refs: ModelRef[],
  thinkingOverrides: Record<string, ThinkingLevel>,
  currentThinking: ThinkingLevel,
  ctx: ExtensionCommandContext,
): TwoPaneModelThinking {
  return new TwoPaneModelThinking({
    theme,
    refs,
    marker: "❯ ",
    maxVisibleRows: pickerBodyRows(""),
    backKeys: [Key.escape, Key.ctrl("c")],
    requestRender: () => tui.requestRender(),
    levelOptions: registryLevelOptions(ctx.modelRegistry),
    preferredLevel: (ref, options) => defaultThinkingForModel(
      modelRefLabel(ref), thinkingOverrides, currentThinking, options,
    ),
  });
}

const PICKER_HINT = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back";

function renderFramedPicker(
  th: Theme,
  innerWidth: number,
  bodyWidth: number,
  title: string,
  description: string,
  twoPane: TwoPaneModelThinking,
): string[] {
  twoPane.setMaxVisibleRows(pickerBodyRows(twoPane.snapshot().filter));
  const pickerLines = twoPane.render(bodyWidth);
  const snapshot = twoPane.snapshot();
  const warning = snapshot.thinking && thinkingOffWarning(snapshot.levelOptions, snapshot.thinking);
  if (warning) {
    pickerLines.push("", ...wrapText(warning, bodyWidth).map((line) => th.fg("warning", line)));
  }
  const { actionRow, hintRows } = twoPane.renderFooter(bodyWidth, PICKER_HINT);
  return [
    renderMenuTopBorder(th, innerWidth, title),
    ...wrapText(description, bodyWidth).map((line) => renderMenuContentRow(th, innerWidth, th.fg("muted", ` ${line}`))),
    renderMenuSeparator(th, innerWidth),
    ...pickerLines.map((line) => renderMenuContentRow(th, innerWidth, ` ${line}`)),
    renderMenuSeparator(th, innerWidth),
    renderMenuContentRow(th, innerWidth, actionRow),
    renderMenuSeparator(th, innerWidth),
    // Hints keep the two-column inset every persona-audit footer uses (innerWidth = bodyWidth + 2).
    ...hintRows.map((line) => renderMenuContentRow(th, innerWidth, `  ${line}`)),
    renderMenuBottomBorder(th, innerWidth),
  ];
}

/**
 * The retry-model sub-screen shared by ReviewerRetryComponent and
 * VerifierRetryComponent: a TwoPaneModelThinking wrapped in its own framed
 * border, opened from a menu row and closed back to it on confirm/back. Each
 * owner keeps its own MenuComponent (their overview rows differ) and calls
 * `open()`/`handleInput()`/`displayValue()` from their own handleInput/render.
 */
export class RetryModelSubView {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly twoPane: TwoPaneModelThinking;
  private readonly currentLabel: string;
  private readonly currentRef: ModelRef | undefined;
  private readonly borderTitle: string;
  private readonly description: string;
  private model: PhaseModelChoice | undefined;
  private active = false;

  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionCommandContext,
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    current: { label: string; ref?: ModelRef },
    borderTitle: string,
    description: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.currentLabel = current.label;
    this.currentRef = current.ref;
    this.borderTitle = borderTitle;
    this.description = description;
    this.twoPane = createPhaseModelPicker(tui, theme, availableRefs, thinkingOverrides, currentThinking, ctx);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The model picked so far, if the user changed it from the run's current model. */
  get selected(): PhaseModelChoice | undefined {
    return this.model;
  }

  displayValue(): string {
    return this.model ? phaseModelChoiceLabel(this.model) : `${this.currentLabel} (unchanged)`;
  }

  open(): void {
    this.active = true;
    this.twoPane.reset(this.model?.ref ?? this.currentRef);
    this.tui.requestRender();
  }

  private close(): void {
    this.active = false;
    this.tui.requestRender();
  }

  /** Routes input while active. Returns true when the selection changed, so the owner can refresh its menu row. */
  handleInput(data: string): boolean {
    const action = this.twoPane.handleInput(data);
    if (action === "confirm") {
      this.model = this.twoPane.getSelected();
      this.close();
      return true;
    }
    if (action === "back") this.close();
    return false;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 2);
    return renderFramedPicker(this.theme, innerWidth, bodyWidth, this.borderTitle, this.description, this.twoPane);
  }

  invalidate(): void {
    this.twoPane.invalidate();
  }
}

interface PhaseSlotDescriptor {
  slot: PhaseSlot;
  menuLabel: string;
  /** One-line purpose shown under the overview row, to inform the model choice. */
  summary: string;
  title: string;
  description: string;
}

const PHASE_SLOT_DESCRIPTORS: readonly PhaseSlotDescriptor[] = [
  {
    slot: "review",
    menuLabel: "Review",
    summary: "Reads the whole scope once per reviewer × pass — the token bulk, and the finding ceiling.",
    title: "Review — reviewer personas read the scope",
    description: "Runs once per selected reviewer × pass, judging the audited files against its persona. This model applies to every selected reviewer and pass in this run.",
  },
  {
    slot: "triage",
    menuLabel: "Triage",
    summary: "One read-only pass: dedupes overlapping findings, recommends apply/reject/defer.",
    title: "Triage — adjudicator reconciles findings",
    description: "Deduplicates and annotates reviewer findings with apply/reject/defer recommendations before the findings-review overlay.",
  },
  {
    slot: "implement",
    menuLabel: "Implement",
    summary: "One edit-capable pass that applies your accepted fixes — later gate repairs and regression tests also write to your tree.",
    title: "Implement — adjudicator applies accepted fixes",
    description: "Edits the repository to apply the findings you accept in the findings-review overlay.",
  },
  {
    slot: "verify",
    menuLabel: "Verify",
    summary: "Judges each fix against its pre-fix diff; writes regression tests for severe fixes.",
    title: "Verify — verifier judges whether each fix landed",
    description: "Diffs every fixed file against its pre-fix snapshot to rule on whether the accepted finding was actually addressed, then authors regression tests for high-severity bug and security fixes.",
  },
];

type View = "overview" | "slot";

class PhaseModelPickerComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly selections: PhaseModelSelection;
  private readonly thinkingOverrides: Record<string, ThinkingLevel>;
  private readonly done: (result: PhaseModelPickerResult) => void;
  private readonly twoPane: TwoPaneModelThinking;
  private readonly menu: MenuComponent;
  private view: View = "overview";
  private selectedSlot: PhaseSlot = "review";

  constructor(
    tui: TUI,
    theme: Theme,
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    ctx: ExtensionCommandContext,
    selections: PhaseModelSelection,
    done: (result: PhaseModelPickerResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.selections = selections;
    this.thinkingOverrides = thinkingOverrides;
    this.done = done;
    this.twoPane = createPhaseModelPicker(tui, theme, availableRefs, thinkingOverrides, currentThinking, ctx);

    const slotItem = (descriptor: PhaseSlotDescriptor): MenuItem => ({
      id: descriptor.slot,
      label: descriptor.menuLabel,
      displayValue: this.slotDisplayValue(descriptor.slot),
      description: descriptor.summary,
      onSelect: () => this.openSlot(descriptor.slot),
    });

    this.menu = new MenuComponent(
      {
        title: "Persona-audit - phase models",
        fullWidth: true,
        hints: ["↑↓ item", "←→ value", "⇥ switch btn", "⏎ select", "esc back"],
        sections: [{ title: "", items: PHASE_SLOT_DESCRIPTORS.map(slotItem) }],
        buttons: [
          {
            id: "start",
            label: "Continue",
            primary: true,
            onSelect: () => this.done({ action: "start", selections: { ...this.selections } }),
          },
          { id: "cancel", label: "Cancel", onSelect: () => this.done({ action: "cancel" }) },
        ],
      },
      theme,
      () => this.done({ action: "back", selections: { ...this.selections } }),
      tui,
    );
  }

  private slotDisplayValue(slot: PhaseSlot): string {
    return phaseModelChoiceLabel(this.selections[slot]);
  }

  private openSlot(slot: PhaseSlot): void {
    this.view = "slot";
    this.selectedSlot = slot;
    this.twoPane.reset(this.selections[slot].ref);
    this.tui.requestRender();
  }

  private closeSlot(): void {
    this.view = "overview";
    this.tui.requestRender();
  }

  private confirmSlot(): void {
    const selection = this.twoPane.getSelected();
    this.selections[this.selectedSlot] = selection;
    // Mutating the shared map (not just `selections`) means reopening the same
    // model under a different slot in this session preselects this thinking level.
    this.thinkingOverrides[modelRefLabel(selection.ref)] = selection.thinking;
    this.menu.setItemValue(this.selectedSlot, this.slotDisplayValue(this.selectedSlot));
    this.closeSlot();
  }

  private handleSlotInput(data: string): void {
    const action = this.twoPane.handleInput(data);
    if (action === "confirm") this.confirmSlot();
    else if (action === "back") this.closeSlot();
  }

  handleInput(data: string): void {
    if (this.view === "overview") this.menu.handleInput(data);
    else this.handleSlotInput(data);
  }

  render(width: number): string[] {
    if (this.view === "overview") return this.menu.render(width);

    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 2);
    const descriptor = PHASE_SLOT_DESCRIPTORS.find((d) => d.slot === this.selectedSlot)!;
    return renderFramedPicker(this.theme, innerWidth, bodyWidth, descriptor.title, descriptor.description, this.twoPane);
  }

  invalidate(): void {
    this.menu.invalidate();
    this.twoPane.invalidate();
  }
}

/**
 * Show the per-phase model + thinking picker. Returns `back` when the user
 * escapes out to the reviewer picker, and `cancel` when they abort or no
 * models are available. `initial` seeds the phases over the saved config, so
 * a `back` result handed straight back preserves the unsaved choices.
 */
export async function showPhaseModelPicker(
  ctx: ExtensionCommandContext,
  currentThinking: ThinkingLevel,
  initial?: PhaseModelSelection,
): Promise<PhaseModelPickerResult> {
  if (ctx.mode !== "tui") return { action: "cancel" };

  const catalogue = getModelCatalogue(ctx.modelRegistry);
  const available = catalogue.availableRefs();
  if (available.length === 0) {
    ctx.ui.notify("No models available.", "warning");
    return { action: "cancel" };
  }

  const saved = loadPersonaAuditConfig();
  const currentModelRef: ModelRef | undefined = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const fallbackRef = currentModelRef ?? available[0]!;
  const thinkingOverrides: Record<string, ThinkingLevel> = { ...saved.thinkingOverrides };

  const { selections, dropped } = seedPhaseSelections(
    saved.phases,
    initial,
    available,
    fallbackRef,
    (ref) => defaultThinkingForModel(
      modelRefLabel(ref),
      thinkingOverrides,
      currentThinking,
      catalogue.thinkingLevelsFor(ref),
    ),
  );
  if (dropped.length > 0) {
    ctx.ui.notify(
      `Saved phase ${dropped.length > 1 ? "models are" : "model is"} no longer offered by the registry (${dropped.join(", ")}); using ${modelRefLabel(fallbackRef)}. Choose a replacement before continuing.`,
      "warning",
    );
  }

  const result = await showOverlayPrompt<PhaseModelPickerResult>(ctx, (tui, theme, finish) =>
    new PhaseModelPickerComponent(tui, theme, available, thinkingOverrides, currentThinking, ctx, selections, finish));

  if (result.action !== "start") return result;

  const selectedThinking: Record<string, ThinkingLevel> = {};
  for (const slot of PHASE_SLOTS) {
    selectedThinking[modelRefLabel(result.selections[slot].ref)] = result.selections[slot].thinking;
  }
  const persisted = updatePersonaAuditConfig((current) => ({
    ...current,
    phases: { ...result.selections },
    thinkingOverrides: { ...current.thinkingOverrides, ...selectedThinking },
  }));
  if (!persisted.ok) ctx.ui.notify(`Could not save phase model settings: ${persisted.message}`, "warning");

  return result;
}
