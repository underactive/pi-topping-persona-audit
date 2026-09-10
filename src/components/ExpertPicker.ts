import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ReviewerInfo, ReviewerSelection } from "../types.ts";
import { TIERS } from "./ReviewerData.ts";
import {
  FALLBACK_TERMINAL_ROWS,
  OVERLAY_HEIGHT_PERCENT,
  type OverlayPromptUi,
  renderMenuContentRow,
  renderMenuSectionDivider,
  renderMenuTopBorder,
  SELECTOR,
  showOverlayPrompt,
  wrapText,
} from "./menuChrome.ts";

const ALL_REVIEWERS: ReviewerInfo[] = TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => ({ ...reviewer, tier: tier.tier })));
const TIER_LABELS = new Map(TIERS.map((tier) => [tier.tier, tier.label]));
/** Reviewer runs above which a picker demands a second Enter before launching. */
export const COST_CONFIRM_RUN_THRESHOLD = 6;
const LIST_CHROME_ROWS = 9;
const FALLBACK_WIDTH = 80;

export interface ExpertPickerHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

export interface ExpertPickerTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export interface ExpertPickerOptions {
  single?: boolean;
  excluded?: ReadonlySet<string>;
}

/** Tiered reviewer picker: one cross-tier list with type-to-filter, Space toggle, and pass count. */
export class ExpertPicker implements Component {
  private selected = new Set<string>();
  private passes = 1;
  private query = "";
  private awaitingCostConfirm = false;
  private entryIndex = 0;
  private scrollOffset = 0;
  private entries: ReviewerInfo[] = [];
  private readonly reviewers: ReviewerInfo[];
  private readonly single: boolean;
  private readonly excluded: ReadonlySet<string>;
  private readonly theme: ExpertPickerTheme;
  private readonly done: (result: ReviewerSelection | null) => void;
  private readonly fileCount: number | undefined;
  private readonly host: ExpertPickerHost | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedViewport: number | undefined;

  constructor(
    theme: ExpertPickerTheme,
    done: (result: ReviewerSelection | null) => void,
    fileCount?: number,
    host?: ExpertPickerHost,
    initial?: ReviewerSelection,
    options: ExpertPickerOptions = {},
  ) {
    this.theme = theme;
    this.done = done;
    this.fileCount = fileCount;
    this.host = host;
    this.single = options.single ?? false;
    this.excluded = options.excluded ?? new Set<string>();
    this.reviewers = ALL_REVIEWERS.filter((reviewer) => !this.excluded.has(reviewer.name));
    if (initial) {
      this.selected = new Set(initial.reviewers);
      this.passes = initial.passes;
    }
    this.rebuildEntries();
    const firstSelected = this.entries.findIndex((entry) => this.selected.has(entry.name));
    if (firstSelected > 0) {
      this.entryIndex = firstSelected;
      this.adjustScroll();
    }
  }

  private viewportHeight(): number {
    const rows = this.host?.terminal?.rows ?? 0;
    return Math.max(10, Math.floor(((rows > 0 ? rows : FALLBACK_TERMINAL_ROWS) * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private effectiveSelection(): ReviewerSelection {
    if (this.single) {
      const current = this.entries[this.entryIndex];
      return { reviewers: current ? [current.name] : [], passes: 1 };
    }
    return {
      reviewers: this.reviewers.filter((reviewer) => this.selected.has(reviewer.name)).map((reviewer) => reviewer.name),
      passes: this.passes,
    };
  }

  private needsCostConfirm(): boolean {
    const selection = this.effectiveSelection();
    return selection.passes > 1 || selection.reviewers.length * selection.passes > COST_CONFIRM_RUN_THRESHOLD;
  }

  private rebuildEntries(): void {
    const norm = (text: string) => text.toLowerCase().replace(/\s+/g, "");
    const query = norm(this.query);
    this.entries = this.reviewers.filter((reviewer) =>
      !query
      || norm(reviewer.name).includes(query)
      || norm(reviewer.description).includes(query)
      || norm(reviewer.focusAreas.join(" ")).includes(query));
    this.entryIndex = Math.min(this.entryIndex, Math.max(0, this.entries.length - 1));
    this.adjustScroll();
  }

  private section(entry: ReviewerInfo): string {
    return TIER_LABELS.get(entry.tier) ?? entry.tier;
  }

  private entryRows(entry: ReviewerInfo, width: number): number {
    return 2 + wrapText(entry.description, width - 8).length + wrapText(entry.focusAreas.join(" · "), width - 8).length;
  }

  private visibleEnd(offset: number, width: number): number {
    const budget = Math.max(this.viewportHeight() - LIST_CHROME_ROWS, 3);
    let rows = 0;
    let priorSection: string | undefined;
    let end = offset;
    while (end < this.entries.length) {
      const entry = this.entries[end]!;
      const section = this.section(entry);
      const needed = this.entryRows(entry, width) + (section === priorSection ? 0 : 1);
      if (end > offset && rows + needed > budget) break;
      rows += needed;
      priorSection = section;
      end++;
      if (rows >= budget) break;
    }
    return Math.max(offset + 1, end);
  }

  private adjustScroll(): void {
    if (this.entryIndex < this.scrollOffset) this.scrollOffset = this.entryIndex;
    const width = this.cachedWidth ?? FALLBACK_WIDTH;
    while (this.entryIndex >= this.visibleEnd(this.scrollOffset, width) && this.scrollOffset < this.entryIndex) {
      this.scrollOffset++;
    }
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.entries.length - 1));
  }

  private renderCostPreview(): string {
    const selection = this.effectiveSelection();
    const count = selection.reviewers.length;
    const runs = count * selection.passes;
    const fileText = this.fileCount === undefined ? "selected files" : `${this.fileCount} file${this.fileCount === 1 ? "" : "s"}`;
    return `${count} reviewer${count === 1 ? "" : "s"} × ${selection.passes} pass${selection.passes === 1 ? "" : "es"} = ${runs} reviewer run${runs === 1 ? "" : "s"} · ${fileText} each`;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.host?.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.awaitingCostConfirm) {
        this.awaitingCostConfirm = false;
        this.invalidate();
      } else this.done(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selection = this.effectiveSelection();
      if (selection.reviewers.length === 0) return;
      if (this.single) {
        this.done(selection);
        return;
      }
      if (this.needsCostConfirm() && !this.awaitingCostConfirm) {
        this.awaitingCostConfirm = true;
        this.invalidate();
        return;
      }
      this.done(selection);
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (this.single) return;
      const entry = this.entries[this.entryIndex];
      if (!entry) return;
      if (this.selected.has(entry.name)) this.selected.delete(entry.name);
      else this.selected.add(entry.name);
      this.awaitingCostConfirm = false;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const delta = matchesKey(data, Key.up) ? -1 : 1;
      const next = Math.min(this.entries.length - 1, Math.max(0, this.entryIndex + delta));
      if (next !== this.entryIndex) {
        this.entryIndex = next;
        this.awaitingCostConfirm = false;
        this.adjustScroll();
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.single) return;
      const delta = matchesKey(data, Key.left) ? -1 : 1;
      this.passes = Math.min(5, Math.max(1, this.passes + delta));
      this.awaitingCostConfirm = false;
      this.invalidate();
      return;
    }
    if (data === "\u0008" || data === "\u007f") {
      if (this.query) {
        this.query = this.query.slice(0, -1);
        this.rebuildEntries();
        this.invalidate();
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) < 0x7f) {
      this.query += data;
      this.rebuildEntries();
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedViewport === this.viewportHeight()) return this.cachedLines;
    this.cachedWidth = width;
    this.adjustScroll();
    const t = this.theme;
    const effective = this.effectiveSelection();
    const lines = [
      renderMenuTopBorder(t, width, this.single
        ? "Select a reviewer"
        : `Select reviewers (${this.selected.size} selected)`),
      "",
      " " + t.fg("dim", this.single
        ? "↑↓ navigate · Enter confirm · Esc cancel"
        : `↑↓ navigate · Space toggle · ←→ passes (${this.passes}) · Enter confirm · Esc back`),
      " " + (this.query ? t.fg("accent", `Filter: ${this.query}`) : t.fg("dim", "Type to filter…")),
      "",
    ];
    if (this.entries.length === 0) {
      lines.push("  " + t.fg("warning", "No reviewers match filter."));
    } else {
      const end = Math.min(this.visibleEnd(this.scrollOffset, width), this.entries.length);
      let section: string | undefined;
      for (let index = this.scrollOffset; index < end; index++) {
        const reviewer = this.entries[index]!;
        const nextSection = this.section(reviewer);
        if (nextSection !== section) {
          section = nextSection;
          lines.push(" " + renderMenuSectionDivider(t, width - 1, section));
        }
        const current = index === this.entryIndex;
        const pointer = current ? t.bold(t.fg("accent", SELECTOR)) : " ";
        const checked = this.single ? current : this.selected.has(reviewer.name);
        const checkbox = checked ? t.fg("success", "✓") : t.fg("dim", "○");
        const name = checked
          ? t.fg("success", t.bold(reviewer.name))
          : current ? t.bold(t.fg("accent", reviewer.name)) : t.bold(reviewer.name);
        lines.push(renderMenuContentRow(t, width, `  ${pointer} ${checkbox} ${name}`, current));
        for (const text of wrapText(reviewer.description, width - 8)) lines.push(`      ${t.fg("muted", text)}`);
        for (const text of wrapText(reviewer.focusAreas.join(" · "), width - 8)) lines.push(`      ${t.fg("dim", text)}`);
        lines.push("");
      }
      if (this.entries.length > end - this.scrollOffset) {
        lines.push(" " + t.fg("dim", `  ${this.scrollOffset + 1}–${end} of ${this.entries.length}`));
      }
    }
    if (!this.single) {
      lines.push(" " + t.fg(effective.reviewers.length ? "accent" : "dim", this.renderCostPreview()));
      if (this.awaitingCostConfirm) {
        lines.push(" " + t.fg("warning", "Press Enter again to launch this higher-cost run · Esc to revise"));
      } else if (effective.reviewers.length > 0) {
        lines.push(" " + t.fg("success", `✓ ${effective.reviewers.length} selected — press Enter to confirm${this.needsCostConfirm() ? " (confirmation required)" : ""}`));
      }
    }
    lines.push(t.fg("border", "═".repeat(width)));
    this.cachedViewport = this.viewportHeight();
    this.cachedLines = lines;
    return lines;
  }
}

export async function showExpertPicker(
  ctx: { ui: OverlayPromptUi },
  fileCount?: number,
  initial?: ReviewerSelection,
  options: ExpertPickerOptions = {},
): Promise<ReviewerSelection | null> {
  return showOverlayPrompt<ReviewerSelection | null>(ctx, (tui, theme, finish) =>
    new ExpertPicker(theme, finish, fileCount, tui, initial, options));
}
