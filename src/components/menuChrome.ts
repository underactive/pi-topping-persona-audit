/**
 * Box-drawing chrome and the reusable settings-menu component behind the
 * phase model picker's overview screen and the `/persona-audit-settings` menu.
 *
 * Ported from pi-moa-plan's `src/menu.ts` (subset): the primitives and
 * `MenuComponent` used by an overview/slot-navigation picker. The two-pane
 * category/detail menu (`TwoPaneMenuComponent`) and the standalone
 * `showMenu` helper are not ported — persona-audit's picker builds its own
 * two-pane model/thinking view instead.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, type OverlayOptions, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

/** A boolean setting that can be changed with Space. */
export interface ToggleMenuItem {
  id: string;
  label: string;
  value: boolean;
  onChange?: (value: boolean) => void;
}

/** An Enter-activated row, optionally with a right-aligned displayed value. */
export interface ActionMenuItem {
  id: string;
  label: string;
  displayValue?: string;
  /** Dimmed helper text wrapped under the row. */
  description?: string;
  onSelect?: () => void;
}

/** A setting whose values are selected inline with the left/right keys. */
export interface ChoiceMenuItem {
  id: string;
  label: string;
  values: string[];
  valueIndex: number;
  /** Dimmed helper text wrapped under the row. */
  description?: string;
  /** Show only the selected value, for a value list too wide to inline in full. */
  compact?: boolean;
  onChange?: (valueIndex: number, displayValue: string) => void;
}

export type MenuItem = ToggleMenuItem | ActionMenuItem | ChoiceMenuItem;

export interface MenuButton {
  id: string;
  label: string;
  primary?: boolean;
  onSelect: () => void;
}

export interface MenuSection {
  /** Empty renders a blank spacer instead of a divider, for a section needing no label. */
  title: string;
  /** Dimmed explanatory text rendered directly below the section heading. */
  description?: string;
  items: MenuItem[];
}

export interface MenuConfig {
  title: string;
  sections: MenuSection[];
  buttons?: MenuButton[];
  /** Expand the menu frame to the available overlay width rather than its content width. */
  fullWidth?: boolean;
  hints?: string[];
  /**
   * Cap the item rows a section renders at once, scrolling the rest with the
   * cursor, so a tall menu stays inside the overlay's height budget.
   */
  maxItemsPerSection?: number;
  /** Handle a key against the selected item before standard menu navigation. */
  onItemKey?: (item: MenuItem, data: string) => boolean;
  /** Initially focused item, used when reopening sequential overlays. */
  initialItemId?: string;
}

export interface MenuResult<T> {
  applied: boolean;
  values: T;
}

const DEFAULT_HINTS = ["↑↓ item", "←→ value", "⏎ select", "esc cancel"];
const MIN_WIDTH = 36;
const MAX_WIDTH = 76;
/** Glyph rendered before the selected row. */
export const SELECTOR = "❯";
const UNSELECTED_SELECTOR = " ".repeat(SELECTOR.length);

/** Internal viewport budget for scrollable prompt content. */
export const OVERLAY_HEIGHT_PERCENT = 75;
export const FALLBACK_TERMINAL_ROWS = 40;

function isToggleItem(item: MenuItem): item is ToggleMenuItem {
  return "value" in item;
}

function isChoiceItem(item: MenuItem): item is ChoiceMenuItem {
  return "values" in item;
}

// ── Shared box-drawing primitives ──────────────────────────────────────────

export function renderMenuTopBorder(theme: Pick<Theme, "fg">, innerWidth: number, title: string): string {
  const shown = truncateToWidth(title, Math.max(0, innerWidth - 4));
  const label = ` ${shown} `;
  const fill = Math.max(0, innerWidth - 2 - visibleWidth(label));
  return theme.fg("border", "══")
    + theme.fg("accent", label)
    + theme.fg("border", "═".repeat(fill));
}

export function renderMenuBottomBorder(theme: Pick<Theme, "fg">, innerWidth: number, counter = ""): string {
  return theme.fg("border", "═".repeat(Math.max(0, innerWidth - visibleWidth(counter))) + counter);
}

export function renderMenuSectionDivider(theme: Pick<Theme, "fg">, innerWidth: number, title: string): string {
  const shown = truncateToWidth(title, Math.max(0, innerWidth - 3));
  return theme.fg("border", `─ ${shown} ${"─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(shown)))}`);
}

export function renderMenuSeparator(theme: Pick<Theme, "fg">, innerWidth: number): string {
  return theme.fg("border", "─".repeat(innerWidth));
}

// ── Framed chrome ────────────────────────────────────────────────
// Overlays float over the transcript, so they draw their own edges. Widgets are
// docked to the editor and inherit the terminal's, so they stay frameless.
// Every helper here renders `innerWidth + 2` columns.

export function renderFramedTop(theme: Pick<Theme, "fg">, innerWidth: number, title: string): string {
  const shown = truncateToWidth(title, Math.max(0, innerWidth - 4));
  const label = ` ${shown} `;
  const fill = Math.max(0, innerWidth - 2 - visibleWidth(label));
  return theme.fg("border", "╔══") + theme.fg("accent", label) + theme.fg("border", "═".repeat(fill) + "╗");
}

export function renderFramedRow(theme: Pick<Theme, "fg">, innerWidth: number, content: string): string {
  const shown = truncateToWidth(content, innerWidth, "");
  const padded = shown + " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  return theme.fg("border", "║") + padded + theme.fg("border", "║");
}

export function renderFramedBottom(theme: Pick<Theme, "fg">, innerWidth: number): string {
  return theme.fg("border", `╚${"═".repeat(innerWidth)}╝`);
}

export function renderMenuContentRow(theme: MenuTheme, innerWidth: number, content: string, selected = false): string {
  const shown = truncateToWidth(content, innerWidth, "");
  const padded = shown + " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  return selected ? theme.bg("selectedBg", padded) : padded;
}

/** Word-wrap `text` into lines of at most `maxCols` visible columns. */
export function wrapText(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [];
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const wordWidth = visibleWidth(word);
    const addWidth = current ? 1 + wordWidth : wordWidth;
    if (width + addWidth <= maxCols) {
      current = current ? `${current} ${word}` : word;
      width += addWidth;
      continue;
    }
    if (current) lines.push(current);
    const truncated = truncateToWidth(word, maxCols, "…");
    current = truncated;
    width = visibleWidth(truncated);
  }
  if (current) lines.push(current);
  return lines;
}

export function twoPaneWidths(innerWidth: number): { left: number; right: number } {
  const left = Math.max(1, Math.floor((innerWidth - 1) / 2));
  return { left, right: Math.max(0, innerWidth - left - 1) };
}

export interface MenuFooterContents {
  topDivider: string;
  actionRow: string;
  hintDivider: string;
  hintRow: string;
}

/** Standard two-row footer contents for nested TUI windows: actions, then hints. */
export function renderMenuFooterContents(theme: MenuTheme, innerWidth: number, actions: string, hints: string): MenuFooterContents {
  /** Keep every returned content row frame-safe for callers that add borders directly. */
  const fit = (content: string) => {
    const shown = truncateToWidth(content, innerWidth, "");
    return shown + " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  };
  const rightAlignedActions = `${" ".repeat(Math.max(0, innerWidth - visibleWidth(actions) - 2))}${actions}  `;
  return {
    topDivider: theme.fg("border", "─".repeat(innerWidth)),
    actionRow: fit(rightAlignedActions),
    hintDivider: theme.fg("border", "─".repeat(innerWidth)),
    hintRow: theme.fg("dim", fit(`  ${hints}`)),
  };
}

/** Standard framed two-row footer: right-justified actions above keyboard hints. */
function renderMenuFooter(theme: MenuTheme, innerWidth: number, actions: string, hints: string): string[] {
  const { topDivider, actionRow, hintDivider, hintRow } = renderMenuFooterContents(theme, innerWidth, actions, hints);
  return [
    topDivider,
    renderMenuContentRow(theme, innerWidth, actionRow),
    hintDivider,
    renderMenuContentRow(theme, innerWidth, hintRow),
  ];
}

/** The slice of Theme that MenuComponent needs. Structural so tests can supply a stub. */
export interface MenuTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg", text: string): string;
  bold(text: string): string;
}

// ── MenuComponent ───────────────────────────────────────────────────────────

/** Reusable box-drawing menu supporting toggle settings and action/value rows. */
export class MenuComponent implements Component {
  private readonly title: string;
  private readonly sections: MenuSection[];
  private readonly hints: string[];
  private readonly buttons: MenuButton[];
  private readonly fullWidth: boolean;
  private readonly maxItemsPerSection: number | undefined;
  private readonly onItemKey: ((item: MenuItem, data: string) => boolean) | undefined;
  private readonly theme: MenuTheme;
  private readonly done: (result: MenuResult<Record<string, boolean>>) => void;
  private readonly tui: TUI | undefined;
  private readonly initialValues: Record<string, boolean>;
  private readonly initialChoiceValues: Record<string, number> = {};
  private readonly values: Record<string, boolean> = {};
  private readonly items: MenuItem[] = [];
  private cursor = 0;
  private focusedPane: "items" | "buttons" = "items";
  private buttonIndex = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    config: MenuConfig,
    theme: MenuTheme,
    done: (result: MenuResult<Record<string, boolean>>) => void,
    tui?: TUI,
  ) {
    this.theme = theme;
    this.done = done;
    this.tui = tui;
    this.title = config.title;
    this.sections = config.sections;
    this.buttons = config.buttons ?? [];
    this.fullWidth = config.fullWidth ?? false;
    this.maxItemsPerSection = config.maxItemsPerSection;
    this.onItemKey = config.onItemKey;
    this.hints = config.hints ?? (this.buttons.length > 0
      ? ["↑↓ item", "←→ value", "⇥ switch btn", "⏎ select", "esc cancel"]
      : DEFAULT_HINTS);
    this.buttonIndex = Math.max(0, this.buttons.findIndex((button) => button.primary));
    for (const section of this.sections) {
      for (const item of section.items) {
        this.items.push(item);
        if (isToggleItem(item)) this.values[item.id] = item.value;
        else if (isChoiceItem(item)) this.initialChoiceValues[item.id] = item.valueIndex;
      }
    }
    this.initialValues = { ...this.values };
    const initialCursor = config.initialItemId
      ? this.items.findIndex((item) => item.id === config.initialItemId)
      : -1;
    if (initialCursor >= 0) this.cursor = initialCursor;
  }

  /** Update an action row in place without rebuilding the menu. */
  setItemValue(id: string, displayValue: string | undefined): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || isToggleItem(item) || isChoiceItem(item)) return;
    item.displayValue = displayValue;
    this.invalidate();
    this.tui?.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ applied: false, values: { ...this.initialValues } });
      return;
    }
    if (matchesKey(data, Key.tab) && this.buttons.length > 0) {
      this.focusedPane = this.focusedPane === "items" ? "buttons" : "items";
      this.invalidate();
      this.tui?.requestRender();
      return;
    }
    if (this.focusedPane === "buttons") {
      if (matchesKey(data, Key.left)) {
        this.buttonIndex = (this.buttonIndex - 1 + this.buttons.length) % this.buttons.length;
        this.invalidate();
      } else if (matchesKey(data, Key.right)) {
        this.buttonIndex = (this.buttonIndex + 1) % this.buttons.length;
        this.invalidate();
      } else if (matchesKey(data, Key.enter)) {
        this.buttons[this.buttonIndex]?.onSelect();
      }
      this.tui?.requestRender();
      return;
    }
    if (this.items.length === 0) return;
    if (this.onItemKey?.(this.items[this.cursor]!, data)) {
      this.tui?.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
      this.invalidate();
    } else if (matchesKey(data, Key.down)) {
      this.cursor = (this.cursor + 1) % this.items.length;
      this.invalidate();
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const item = this.items[this.cursor]!;
      if (isChoiceItem(item) && item.values.length > 0) {
        const delta = matchesKey(data, Key.left) ? -1 : 1;
        item.valueIndex = (item.valueIndex + delta + item.values.length) % item.values.length;
        item.onChange?.(item.valueIndex, item.values[item.valueIndex]!);
        this.invalidate();
      }
    } else if (matchesKey(data, Key.space)) {
      const item = this.items[this.cursor]!;
      if (isToggleItem(item)) {
        const value = !this.values[item.id];
        this.values[item.id] = value;
        item.onChange?.(value);
        this.invalidate();
      }
    } else if (matchesKey(data, Key.enter)) {
      const item = this.items[this.cursor]!;
      if (!isToggleItem(item) && !isChoiceItem(item)) item.onSelect?.();
      else if (this.buttons.length === 0 && this.items.every(isToggleItem)) {
        this.done({ applied: true, values: { ...this.values } });
      }
    }
    this.tui?.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    const lines = this.buildLines(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private preferredWidth(): number {
    const candidates = [MIN_WIDTH - 2, 5 + this.title.length, 2 + this.hints.join("  ").length];
    for (const section of this.sections) {
      candidates.push(3 + section.title.length);
      for (const item of section.items) {
        if (isToggleItem(item)) candidates.push(15 + item.label.length);
        else if (isChoiceItem(item)) {
          candidates.push(8 + item.label.length + (item.compact
            ? item.values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0) + 4
            : item.values.reduce((sum, value) => sum + visibleWidth(value) + 2, 0)));
        }
        else candidates.push(6 + item.label.length + visibleWidth(item.displayValue ?? "Not set"));
      }
    }
    if (this.buttons.length > 0) candidates.push(this.buttons.reduce((sum, button) => sum + button.label.length + 8, 0));
    return 2 + Math.max(...candidates);
  }

  private buildLines(maxWidth: number): string[] {
    const { theme } = this;
    const desiredWidth = this.fullWidth
      ? maxWidth
      : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this.preferredWidth()));
    const innerWidth = Math.max(0, Math.min(desiredWidth, maxWidth));
    const lines = [renderMenuTopBorder(theme, innerWidth, this.title)];
    let flatIndex = 0;
    for (const section of this.sections) {
      lines.push(section.title
        ? renderMenuSectionDivider(theme, innerWidth, section.title)
        : renderMenuContentRow(theme, innerWidth, ""));
      if (section.description) {
        const indent = "    ";
        lines.push(...wrapText(section.description, Math.max(0, innerWidth - indent.length - 2)).map((line) =>
          renderMenuContentRow(theme, innerWidth, theme.fg("dim", indent + line)),
        ));
      }
      const [from, to] = this.itemWindow(section, flatIndex);
      if (from > 0) lines.push(renderMenuContentRow(theme, innerWidth, theme.fg("dim", `    ↑ ${from} more`)));
      for (const [index, item] of section.items.entries()) {
        // The cursor indexes every item, so hidden rows still advance it.
        const selected = flatIndex++ === this.cursor;
        if (index < from || index >= to) continue;
        lines.push(this.renderItemRow(item, selected, innerWidth));
        const descriptionRows = this.renderDescriptionRows(item, innerWidth);
        lines.push(...descriptionRows);
        if (descriptionRows.length > 0 && index < to - 1) {
          lines.push(renderMenuContentRow(theme, innerWidth, ""));
        }
      }
      const below = section.items.length - to;
      if (below > 0) lines.push(renderMenuContentRow(theme, innerWidth, theme.fg("dim", `    ↓ ${below} more`)));
      lines.push(renderMenuContentRow(theme, innerWidth, ""));
    }
    if (this.buttons.length > 0) {
      const texts = this.buttons.map((button, index) => {
        const isActive = index === this.buttonIndex;
        const text = isActive ? `[ ${button.label} ]` : `‹ ${button.label} ›`;
        return isActive && this.focusedPane === "buttons"
          ? theme.bold(theme.fg("accent", text))
          : theme.fg("muted", text);
      });
      lines.push(...renderMenuFooter(theme, innerWidth, texts.join("    "), this.hints.join("  ")));
    } else {
      lines.push(renderMenuSeparator(theme, innerWidth), renderMenuContentRow(theme, innerWidth, theme.fg("dim", `  ${this.hints.join("  ")}`)));
    }
    const changed = Object.entries(this.values).filter(([id, value]) => this.initialValues[id] !== value).length
      + this.items.filter((item) => isChoiceItem(item) && item.valueIndex !== this.initialChoiceValues[item.id]).length;
    const counter = changed > 0 ? `[ ${changed} changed ]` : `[ ${this.cursor + 1}/${this.items.length} ]`;
    lines.push(renderMenuBottomBorder(theme, innerWidth, counter));
    return lines.map((line) => truncateToWidth(line, innerWidth, ""));
  }

  /** Slice of a capped section's items to render, kept centred on the cursor. */
  private itemWindow(section: MenuSection, sectionStart: number): [number, number] {
    const cap = this.maxItemsPerSection;
    const total = section.items.length;
    if (!cap || total <= cap) return [0, total];
    const local = this.cursor - sectionStart;
    const anchor = local >= 0 && local < total ? local : 0;
    const from = Math.min(Math.max(0, anchor - Math.floor((cap - 1) / 2)), total - cap);
    return [from, from + cap];
  }

  private renderDescriptionRows(item: MenuItem, innerWidth: number): string[] {
    if (isToggleItem(item) || !item.description) return [];
    // Indent to the label column so the text reads as part of the row above it.
    const indent = "    ";
    return wrapText(item.description, Math.max(0, innerWidth - indent.length - 2)).map((line) =>
      renderMenuContentRow(this.theme, innerWidth, this.theme.fg("dim", indent + line)),
    );
  }

  private renderItemRow(item: MenuItem, selected: boolean, innerWidth: number): string {
    const th = this.theme;
    const marker = selected ? th.bold(th.fg("accent", SELECTOR)) : UNSELECTED_SELECTOR;
    if (isToggleItem(item)) {
      const value = this.values[item.id]!;
      const state = value ? "ON" : "OFF";
      const label = truncateToWidth(item.label, Math.max(0, innerWidth - 15));
      const left = `  ${marker} [${value ? th.fg("success", "■") : th.fg("muted", " ")}] ${th.fg("text", label)}`;
      return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(1, innerWidth - visibleWidth(left) - state.length - 2))}${value ? th.fg("success", state) : th.fg("muted", state)}  `, selected);
    }
    if (isChoiceItem(item)) {
      const parts = item.compact
        ? th.fg("accent", `‹ ${item.values[item.valueIndex] ?? ""} ›`)
        : item.values.map((value, index) => {
          const text = index === item.valueIndex ? `‹${value}›` : value;
          return index === item.valueIndex ? th.fg("accent", text) : th.fg("muted", text);
        }).join("  ");
      const left = `  ${marker} ${selected ? th.fg("accent", item.label) : th.fg("text", item.label)}`;
      return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(2, innerWidth - visibleWidth(left) - visibleWidth(parts) - 2))}${parts}  `, selected);
    }
    const value = item.displayValue ?? "Not set";
    const maxValue = Math.max(0, innerWidth - Math.min(16, visibleWidth(item.label)) - 7);
    const shownValue = truncateToWidth(value, maxValue, "...");
    const maxLabel = Math.max(0, innerWidth - visibleWidth(shownValue) - 7);
    const label = truncateToWidth(item.label, maxLabel, "...");
    const left = `  ${marker} ${selected ? th.fg("accent", label) : th.fg("text", label)}`;
    const right = selected ? th.fg("text", shownValue) : th.fg("muted", shownValue);
    return renderMenuContentRow(th, innerWidth, `${left}${" ".repeat(Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right) - 2))}${right}  `, selected);
  }
}

// ── Shared custom-overlay prompt handshake ───────────────────────────────
// Every persona-audit interactive prompt (ExpertPicker, the phase model
// picker, the reviewer/verifier retry checkpoints, the settings menu, the
// purge menu) is a genuine user wait, so each one goes through
// ctx.ui.custom(..., { overlay: true }) — the API Pi brackets with
// ui_prompt_start / ui_prompt_end lifecycle events. showOverlayPrompt is that
// handshake, factored out so each site only supplies how to construct its own
// component.
//
// Pi owns everything the retired widget handshake did manually: keyboard
// focus, settle-once behavior, component disposal, keyboard dispatch, and
// Kitty key-release filtering for focused overlays.

/**
 * Shared geometry for every persona-audit prompt overlay. Overlays remain
 * floating, anchor near the terminal bottom, and paint over the editor while
 * open with two rows above and three rows below for visual separation.
 * Scrollable components retain their own 75% viewport budgets.
 */
export const PROMPT_OVERLAY_OPTIONS: {
  overlay: true;
  overlayOptions: OverlayOptions;
} = {
  overlay: true,
  overlayOptions: {
    anchor: "bottom-center",
    width: "100%",
    maxHeight: "100%",
    margin: { left: 0, right: 0, top: 2, bottom: 3 },
  },
};

/**
 * The slice of pi's extension `ui` every show* prompt needs to open a focused
 * custom overlay. Structural so tests can supply a stub.
 */
export interface OverlayPromptUi {
  custom<T>(
    factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions;
    },
  ): Promise<T>;
}

/**
 * Open a focused custom overlay with the shared prompt geometry and resolve
 * with whatever the component hands to `done`. Pi brackets the whole call as
 * one user-prompt lifecycle span.
 */
export function showOverlayPrompt<T>(
  ctx: { ui: OverlayPromptUi },
  create: (tui: TUI, theme: Theme, done: (value: T) => void) => Component,
): Promise<T> {
  return ctx.ui.custom<T>((tui, theme, _keybindings, done) => create(tui, theme, done), PROMPT_OVERLAY_OPTIONS);
}
