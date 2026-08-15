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
 * `../modelCatalogue.ts`), so a confirmed selection is usable by
 * construction and nothing verifies it after the picker closes.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { getModelCatalogue } from "../modelCatalogue.ts";
import {
  defaultThinkingForModel,
  isThinkingLevel,
  loadPersonaAuditConfig,
  modelRefLabel,
  phaseModelChoiceLabel,
  PHASE_SLOTS,
  savePersonaAuditConfig,
  thinkingOptionsForModel,
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
  renderMenuFooterContents,
  renderMenuSeparator,
  renderMenuTopBorder,
  SELECTOR,
  showWidgetPrompt,
  twoPaneWidths,
  wrapText,
  type MenuFooterContents,
  type MenuItem,
} from "./menuChrome.ts";

export const MODEL_PICKER_WIDGET_KEY = "persona-audit-model-picker";

export type PhaseModelPickerResult =
  | { action: "start"; selections: PhaseModelSelection }
  | { action: "back"; selections: PhaseModelSelection }
  | { action: "cancel" };

const MAX_VISIBLE_ROWS = 10;
const SELECTED_ROW_SENTINEL = "\u0000";

/**
 * pi-tui's SelectList owns navigation and filtering, but its current renderer
 * hard-codes a different marker and only foreground-colors the active item.
 * Keep that behavior isolated here while matching the persona-audit overlays.
 */
class ConsistentSelectList extends SelectList {
  private readonly pickerTheme: Theme;

  constructor(items: SelectItem[], maxVisible: number, theme: Theme) {
    // SelectList exposes the selected line only through selectedText; the
    // sentinel carries that fact out to render() without changing navigation.
    const selectListTheme: SelectListTheme = {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => SELECTED_ROW_SENTINEL + theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    };
    super(items, maxVisible, selectListTheme);
    this.pickerTheme = theme;
  }

  override render(width: number): string[] {
    return super.render(width).map((line) => {
      if (!line.startsWith(SELECTED_ROW_SENTINEL)) return line;
      const row = line.slice(SELECTED_ROW_SENTINEL.length)
        .replace(/^((?:\x1b\[[0-9;]*m)*)\u2192 /, `$1${SELECTOR} `);
      const clipped = truncateToWidth(row, width, "…");
      return this.pickerTheme.bg("selectedBg", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
    });
  }
}

function parseRef(value: string): ModelRef {
  const idx = value.indexOf("/");
  return { provider: value.slice(0, idx), id: value.slice(idx + 1) };
}

function toModelItems(refs: ModelRef[]): SelectItem[] {
  return refs.map((r) => ({ value: modelRefLabel(r), label: modelRefLabel(r) }));
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

/**
 * Reusable two-pane selector: models on the left and model-specific thinking
 * levels on the right. The model filter always owns text input; Tab or the
 * left/right arrows move the selection focus between panes.
 */
export class TwoPaneModelThinking {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly thinkingOverrides: Record<string, ThinkingLevel>;
  private readonly currentThinking: ThinkingLevel;
  private readonly ctx: ExtensionCommandContext;
  private readonly modelItems: SelectItem[];
  private modelList: ConsistentSelectList;
  private levelList: ConsistentSelectList;
  private filter = "";
  private activePane: "model" | "level" | "buttons" = "model";
  private activeButton = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    availableRefs: ModelRef[],
    thinkingOverrides: Record<string, ThinkingLevel>,
    currentThinking: ThinkingLevel,
    ctx: ExtensionCommandContext,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.thinkingOverrides = thinkingOverrides;
    this.currentThinking = currentThinking;
    this.ctx = ctx;
    this.modelItems = toModelItems(availableRefs);
    this.modelList = new ConsistentSelectList([], 1, theme);
    this.levelList = new ConsistentSelectList([], 1, theme);
    this.reset();
  }

  reset(defaultRef?: ModelRef): void {
    this.filter = "";
    this.activePane = "model";
    this.activeButton = 0;
    this.rebuildModelList();
    if (defaultRef) {
      const defaultIndex = this.modelItems.findIndex((item) => item.value === modelRefLabel(defaultRef));
      if (defaultIndex >= 0) this.modelList.setSelectedIndex(defaultIndex);
    }
    this.rebuildThinkingList();
  }

  private rebuildModelList(): void {
    const items = this.filter.trim()
      ? fuzzyFilter(this.modelItems, this.filter, (item) => item.label)
      : this.modelItems;
    this.modelList = new ConsistentSelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS), this.theme);
    this.modelList.onSelectionChange = () => {
      this.rebuildThinkingList();
      this.tui.requestRender();
    };
  }

  private rebuildThinkingList(): void {
    const key = this.modelList.getSelectedItem()?.value;
    const registryLevels = key
      ? getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(parseRef(key))
      : [];
    const levels = thinkingOptionsForModel(registryLevels);
    const items = levels.map((level) => ({ value: level, label: level }));
    this.levelList = new ConsistentSelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_ROWS), this.theme);
    if (!key) return;
    const preferred = defaultThinkingForModel(key, this.thinkingOverrides, this.currentThinking, registryLevels);
    const preferredIndex = levels.indexOf(preferred);
    if (preferredIndex >= 0) this.levelList.setSelectedIndex(preferredIndex);
  }

  handleInput(data: string): "confirm" | "back" | undefined {
    if (matchesKey(data, Key.escape)) return "back";
    if (matchesKey(data, Key.tab)) {
      // Tab cycles Models → Thinking → action buttons → Models;
      // left/right continue to switch between Models and Thinking (or
      // between buttons, once the action bar is focused).
      this.activePane = this.activePane === "model" ? "level" : this.activePane === "level" ? "buttons" : "model";
      this.tui.requestRender();
      return undefined;
    }
    if (this.activePane === "buttons") {
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
        this.activeButton = this.activeButton === 0 ? 1 : 0;
        this.tui.requestRender();
        return undefined;
      }
      if (matchesKey(data, Key.enter)) {
        if (this.activeButton === 1) return "back";
        return this.modelList.getSelectedItem() && this.levelList.getSelectedItem()
          ? "confirm"
          : undefined;
      }
      return undefined;
    }
    if (matchesKey(data, Key.enter)) {
      return this.modelList.getSelectedItem() && this.levelList.getSelectedItem() ? "confirm" : undefined;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.activePane = this.activePane === "model" ? "level" : "model";
      this.tui.requestRender();
      return undefined;
    }
    if (data === "\x7f" || data === "\b") {
      this.activePane = "model";
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.rebuildModelList();
        this.rebuildThinkingList();
        this.tui.requestRender();
      }
      return undefined;
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.activePane = "model";
      this.filter += data;
      this.rebuildModelList();
      this.rebuildThinkingList();
      this.tui.requestRender();
      return undefined;
    }
    (this.activePane === "model" ? this.modelList : this.levelList).handleInput(data);
    this.tui.requestRender();
    return undefined;
  }

  getSelected(): { ref: ModelRef; thinking: ThinkingLevel } {
    const model = this.modelList.getSelectedItem();
    const level = this.levelList.getSelectedItem();
    if (!model || !level || !isThinkingLevel(level.value)) {
      throw new Error("Cannot confirm an empty model or thinking-level selection");
    }
    return { ref: parseRef(model.value), thinking: level.value };
  }

  render(bodyWidth: number): string[] {
    const { left: leftWidth, right: rightWidth } = twoPaneWidths(bodyWidth);
    const column = (text: string, width: number) => truncateToWidth(text, width, "", true);
    const paneDivider = this.theme.fg("border", "│");
    const headers = column(
      this.activePane === "model" ? this.theme.bold(this.theme.fg("accent", "Models")) : this.theme.bold("Models"),
      leftWidth,
    ) + paneDivider + column(
      ` ${this.activePane === "level" ? this.theme.bold(this.theme.fg("accent", "Thinking")) : this.theme.bold("Thinking")}`,
      rightWidth,
    );
    const modelLines = this.modelList.render(leftWidth);
    // Keep the gutter before thinking rows inside the pane width; the list itself
    // owns only the columns after that leading space.
    const levelLines = this.levelList.render(Math.max(0, rightWidth - 1));
    const rows = Math.max(modelLines.length, levelLines.length);
    const lines = [
      ...(this.filter ? [column(this.theme.fg("muted", `filter: ${this.filter}`), bodyWidth)] : []),
      headers,
    ];
    for (let index = 0; index < rows; index++) {
      const line = column(modelLines[index] ?? "", leftWidth)
        + paneDivider
        + column(` ${levelLines[index] ?? ""}`, rightWidth);
      lines.push(line);
    }
    const selectedLevel = this.levelList.getSelectedItem()?.value;
    if (selectedLevel && isThinkingLevel(selectedLevel)) {
      const key = this.modelList.getSelectedItem()?.value;
      const registryLevels = key
        ? getModelCatalogue(this.ctx.modelRegistry).thinkingLevelsFor(parseRef(key))
        : [];
      const warning = thinkingOffWarning(thinkingOptionsForModel(registryLevels), selectedLevel);
      if (warning) {
        lines.push("");
        for (const wline of wrapText(warning, bodyWidth)) lines.push(this.theme.fg("warning", wline));
      }
    }
    return lines;
  }

  renderFooter(bodyWidth: number, hints: string): MenuFooterContents {
    const buttonText = (label: string, index: number) => {
      const isActive = this.activeButton === index;
      const text = isActive ? `[ ${label} ]` : `‹ ${label} ›`;
      return isActive && this.activePane === "buttons"
        ? this.theme.bold(this.theme.fg("accent", text))
        : this.theme.fg("muted", text);
    };
    return renderMenuFooterContents(this.theme, bodyWidth, `${buttonText("Select", 0)}    ${buttonText("Cancel", 1)}`, hints);
  }

  invalidate(): void {
    this.modelList.invalidate();
    this.levelList.invalidate();
  }
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
    this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, thinkingOverrides, currentThinking, ctx);
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
    const th = this.theme;
    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 2);
    const hint = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back";
    const { actionRow, hintRow } = this.twoPane.renderFooter(bodyWidth, hint);
    return [
      renderMenuTopBorder(th, innerWidth, this.borderTitle),
      ...wrapText(this.description, bodyWidth).map((line) => renderMenuContentRow(th, innerWidth, th.fg("muted", ` ${line}`))),
      renderMenuSeparator(th, innerWidth),
      ...this.twoPane.render(bodyWidth).map((line) => renderMenuContentRow(th, innerWidth, ` ${line}`)),
      renderMenuSeparator(th, innerWidth),
      renderMenuContentRow(th, innerWidth, actionRow),
      renderMenuSeparator(th, innerWidth),
      renderMenuContentRow(th, innerWidth, hintRow),
      renderMenuBottomBorder(th, innerWidth),
    ];
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
    summary: "One edit-capable pass — the only phase that writes changes to your files.",
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
    this.twoPane = new TwoPaneModelThinking(tui, theme, availableRefs, thinkingOverrides, currentThinking, ctx);

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
            label: "Start audit",
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

    const th = this.theme;
    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 2);
    const descriptor = PHASE_SLOT_DESCRIPTORS.find((d) => d.slot === this.selectedSlot)!;
    const pickerLines = this.twoPane.render(bodyWidth);
    const hint = "type filters models • ↑↓ navigate pane • tab panes/buttons • ←→ switch/select • enter select • esc back";
    const { actionRow, hintRow } = this.twoPane.renderFooter(bodyWidth, hint);
    return [
      renderMenuTopBorder(th, innerWidth, descriptor.title),
      ...wrapText(descriptor.description, bodyWidth).map((line) => renderMenuContentRow(th, innerWidth, th.fg("muted", ` ${line}`))),
      renderMenuSeparator(th, innerWidth),
      ...pickerLines.map((line) => renderMenuContentRow(th, innerWidth, ` ${line}`)),
      renderMenuSeparator(th, innerWidth),
      renderMenuContentRow(th, innerWidth, actionRow),
      renderMenuSeparator(th, innerWidth),
      renderMenuContentRow(th, innerWidth, hintRow),
      renderMenuBottomBorder(th, innerWidth),
    ];
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

  const selections = {} as PhaseModelSelection;
  for (const slot of PHASE_SLOTS) {
    const seeded = initial?.[slot];
    const ref = seeded?.ref ?? saved.phases[slot]?.ref ?? fallbackRef;
    const thinking = seeded?.thinking
      ?? saved.phases[slot]?.thinking
      ?? defaultThinkingForModel(modelRefLabel(ref), thinkingOverrides, currentThinking, catalogue.thinkingLevelsFor(ref));
    selections[slot] = { ref, thinking };
  }

  const result = await showWidgetPrompt<PhaseModelPickerResult>(ctx, MODEL_PICKER_WIDGET_KEY, (tui, theme, finish) =>
    new PhaseModelPickerComponent(tui, theme, available, thinkingOverrides, currentThinking, ctx, selections, finish));

  if (result.action !== "start") return result;

  for (const slot of PHASE_SLOTS) {
    thinkingOverrides[modelRefLabel(result.selections[slot].ref)] = result.selections[slot].thinking;
  }
  try {
    savePersonaAuditConfig({ ...saved, phases: { ...result.selections }, thinkingOverrides });
  } catch (error) {
    ctx.ui.notify(`Could not save phase model settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }

  return result;
}
