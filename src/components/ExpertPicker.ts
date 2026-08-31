import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ReviewerSelection, ReviewerInfo } from "../types.ts";
import { TIERS } from "./ReviewerData.ts";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, type OverlayPromptUi, renderMenuContentRow, renderMenuSectionDivider, renderMenuTopBorder, SELECTOR, showOverlayPrompt, wrapText } from "./menuChrome.ts";

/** Every reviewer in tier order, so the flat list still reads Holistic → Specialist → Persona. */
const ALL_REVIEWERS: ReviewerInfo[] = TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => ({ ...reviewer, tier: tier.tier })));
const TIER_LABELS = new Map(TIERS.map((tier) => [tier.tier, tier.label]));

const COST_CONFIRM_RUN_THRESHOLD = 6;
const REVIEWER_LIST_CHROME_ROWS = 9;

/** Width assumed for scroll math before the first render. */
const FALLBACK_WIDTH = 80;

/** The slice of pi's `TUI` the picker needs. Structural so tests can supply a stub. */
export interface ExpertPickerHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of pi's theme used by the picker, kept structural for render tests. */
export interface ExpertPickerTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

/**
 * Expert picker, rendered as a focused custom overlay: one multi-select list
 * of all 40 reviewers, grouped under tier headers, so a selection can mix
 * tiers freely. Each reviewer renders as a card — name header with pointer,
 * indented description and focus areas below, blank line between cards.
 *
 * Tier headers are render-only artifacts. The cursor indexes
 * `filteredReviewers` alone, so navigation never has to step over a
 * non-selectable row.
 *
 * The overlay takes keyboard focus, so Pi dispatches input straight to this
 * component's `handleInput`; repaints go through the host's `requestRender`.
 */
export class ExpertPicker implements Component {
  private selected = new Set<string>();
  private passes = 1;
  private query = "";
  private awaitingCostConfirm = false;

  private reviewerIndex = 0;
  private reviewerScrollOffset = 0;
  private filteredReviewers: ReviewerInfo[] = [];

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
  ) {
    this.theme = theme;
    this.done = done;
    this.fileCount = fileCount;
    this.host = host;
    if (initial) {
      this.selected = new Set(initial.reviewers);
      this.passes = initial.passes;
    }
    this.rebuildFilteredReviewers();
    // A restored selection can sit well past the first viewport, so open on it
    // rather than at the top where it would look like nothing is selected.
    const firstSelected = this.filteredReviewers.findIndex((r) => this.selected.has(r.name));
    if (firstSelected > 0) {
      this.reviewerIndex = firstSelected;
      this.adjustReviewerScroll();
    }
  }

  /** Rows the picker may use: the internal 75% viewport budget of the terminal. */
  private viewportHeight(): number {
    const rows = this.host?.terminal?.rows ?? 0;
    return Math.max(10, Math.floor(((rows > 0 ? rows : FALLBACK_TERMINAL_ROWS) * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private needsCostConfirm(): boolean {
    return this.passes > 1 || this.selected.size * this.passes > COST_CONFIRM_RUN_THRESHOLD;
  }

  private rebuildFilteredReviewers(): void {
    if (this.query.length === 0) {
      this.filteredReviewers = ALL_REVIEWERS;
    } else {
      const q = this.query.toLowerCase().replace(/\s+/g, "");
      const norm = (text: string) => text.toLowerCase().replace(/\s+/g, "");
      this.filteredReviewers = ALL_REVIEWERS.filter(
        (r) =>
          norm(r.name).includes(q) ||
          norm(r.description).includes(q) ||
          norm(r.focusAreas.join(" ")).includes(q),
      );
    }
    if (this.reviewerIndex >= this.filteredReviewers.length) {
      this.reviewerIndex = Math.max(0, this.filteredReviewers.length - 1);
    }
    this.adjustReviewerScroll();
  }

  private getVisibleReviewerCount(viewportHeight: number, width: number): number {
    // Fixed overhead: title border(1) + blank(1) + keybinds(1) + filter(1)
    //                 + blank(1) + cost preview(1) + scroll indicator(1)
    //                 + confirm hint(1) + footer(1) = 9. Card rows below are
    //                 sized from their wrapped text, plus one row per tier header.
    const budget = Math.max(viewportHeight - REVIEWER_LIST_CHROME_ROWS, 3);
    let rows = 0;
    let count = 0;
    let headedTier: string | undefined;
    for (let i = this.reviewerScrollOffset; i < this.filteredReviewers.length; i++) {
      const reviewer = this.filteredReviewers[i];
      if (!reviewer) continue;
      if (reviewer.tier !== headedTier) {
        headedTier = reviewer.tier;
        rows += 1;
      }
      rows += 2 + wrapText(reviewer.description, width - 8).length + wrapText(reviewer.focusAreas.join(" · "), width - 8).length;
      if (rows > budget) break;
      count += 1;
    }
    return Math.max(count, 1);
  }

  private adjustReviewerScroll(): void {
    const visibleCount = this.getVisibleReviewerCount(this.viewportHeight(), this.cachedWidth ?? FALLBACK_WIDTH);
    if (this.reviewerIndex < this.reviewerScrollOffset) {
      this.reviewerScrollOffset = this.reviewerIndex;
    } else if (this.reviewerIndex >= this.reviewerScrollOffset + visibleCount) {
      this.reviewerScrollOffset = this.reviewerIndex - visibleCount + 1;
    }
    const maxScroll = Math.max(0, this.filteredReviewers.length - visibleCount);
    if (this.reviewerScrollOffset > maxScroll) this.reviewerScrollOffset = maxScroll;
  }

  private renderCostPreview(): string {
    const reviewerCount = this.selected.size;
    const runCount = reviewerCount * this.passes;
    const fileText = this.fileCount === undefined ? "selected files" : `${this.fileCount} file${this.fileCount === 1 ? "" : "s"}`;
    return `${reviewerCount} reviewer${reviewerCount === 1 ? "" : "s"} × ${this.passes} pass${this.passes === 1 ? "" : "es"} = ${runCount} reviewer run${runCount === 1 ? "" : "s"} · ${fileText} each`;
  }

  // ── Component interface ─────────────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.host?.requestRender();
  }

  handleInput(data: string): void {
    // Ctrl+C is Escape here: the overlay owns keyboard focus, so the host's
    // usual Ctrl+C handling is out of reach while the picker is open.
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.awaitingCostConfirm) {
        this.awaitingCostConfirm = false;
        this.invalidate();
        return;
      }
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      // Confirm selection. Multi-pass or large runs require a second Enter so
      // users cannot accidentally launch expensive reviewer batches.
      if (this.selected.size > 0) {
        if (this.needsCostConfirm() && !this.awaitingCostConfirm) {
          this.awaitingCostConfirm = true;
          this.invalidate();
          return;
        }
        this.done({ reviewers: ALL_REVIEWERS.filter((r) => this.selected.has(r.name)).map((r) => r.name), passes: this.passes });
      }
      return;
    }

    if (matchesKey(data, Key.space)) {
      const current = this.filteredReviewers[this.reviewerIndex];
      if (current) {
        if (this.selected.has(current.name)) {
          this.selected.delete(current.name);
        } else {
          this.selected.add(current.name);
        }
        this.awaitingCostConfirm = false;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.reviewerIndex > 0) {
        this.reviewerIndex--;
        this.adjustReviewerScroll();
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.reviewerIndex < this.filteredReviewers.length - 1) {
        this.reviewerIndex++;
        this.adjustReviewerScroll();
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta = matchesKey(data, Key.left) ? -1 : 1;
      this.passes = Math.min(5, Math.max(1, this.passes + delta));
      this.awaitingCostConfirm = false;
      this.invalidate();
      return;
    }

    // Backspace for filter editing
    if (data === "\u0008" || data === "\u007f") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.rebuildFilteredReviewers();
        this.invalidate();
      }
      return;
    }

    // Printable chars for filtering
    if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) < 0x7f) {
      this.query += data;
      this.rebuildFilteredReviewers();
      this.invalidate();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedViewport === this.viewportHeight()) return this.cachedLines;

    const lines: string[] = [];
    const t = this.theme;

    lines.push(renderMenuTopBorder(t, width, `Select reviewers (${this.selected.size} selected)`));
    lines.push("");
    lines.push(" " + t.fg("dim", `↑↓ navigate · Space toggle · ←→ passes (${this.passes}) · Enter confirm · Esc cancel`));

    if (this.query.length > 0) {
      lines.push(" " + t.fg("accent", `Filter: ${this.query}`));
    } else {
      lines.push(" " + t.fg("dim", "Type to filter…"));
    }
    lines.push("");

    if (this.filteredReviewers.length === 0) {
      lines.push("  " + t.fg("warning", "No reviewers match filter."));
    } else {
      const visibleCount = this.getVisibleReviewerCount(this.viewportHeight(), width);
      const endIdx = Math.min(this.reviewerScrollOffset + visibleCount, this.filteredReviewers.length);
      // Tracks the last header drawn so a tier scrolled into mid-list still gets labelled.
      let headedTier: string | undefined;

      for (let i = this.reviewerScrollOffset; i < endIdx; i++) {
        const reviewer = this.filteredReviewers[i];
        if (!reviewer) continue;

        if (reviewer.tier !== headedTier) {
          headedTier = reviewer.tier;
          // Total lookup: both the map and every `reviewer.tier` are derived from TIERS.
          lines.push(" " + renderMenuSectionDivider(t, width - 1, TIER_LABELS.get(reviewer.tier)!));
        }

        const isCurrent = i === this.reviewerIndex;
        const isSelected = this.selected.has(reviewer.name);

        const checkbox = isSelected ? t.fg("success", "✓") : t.fg("dim", "○");
        const pointer = isCurrent ? t.bold(t.fg("accent", SELECTOR)) : " ";
        const nameText = isSelected
          ? t.fg("success", t.bold(reviewer.name))
          : isCurrent
            ? t.bold(t.fg("accent", reviewer.name))
            : t.bold(reviewer.name);
        lines.push(renderMenuContentRow(t, width, `  ${pointer} ${checkbox} ${nameText}`, isCurrent));

        const descWrapped = wrapText(reviewer.description, width - 8);
        for (const dl of descWrapped) {
          lines.push(`      ${t.fg("muted", dl)}`);
        }

        const focusText = reviewer.focusAreas.join(" · ");
        const focusWrapped = wrapText(focusText, width - 8);
        for (const fl of focusWrapped) {
          lines.push(`      ${t.fg("dim", fl)}`);
        }

        lines.push("");
      }

      const total = this.filteredReviewers.length;
      if (total > visibleCount) {
        lines.push(" " + t.fg("dim", `  ${this.reviewerScrollOffset + 1}–${endIdx} of ${total}`));
      }
    }

    lines.push(" " + t.fg(this.selected.size > 0 ? "accent" : "dim", this.renderCostPreview()));

    if (this.awaitingCostConfirm) {
      lines.push(" " + t.fg("warning", "Press Enter again to launch this higher-cost run · Esc to revise"));
    } else if (this.selected.size > 0) {
      const suffix = this.needsCostConfirm() ? " (confirmation required)" : "";
      lines.push(
        " " + t.fg("success", `✓ ${this.selected.size} selected — press Enter to confirm${suffix}`),
      );
    }

    lines.push(t.fg("border", "═".repeat(width)));

    this.cachedWidth = width;
    this.cachedViewport = this.viewportHeight();
    this.cachedLines = lines;
    return lines;
  }
}

/**
 * Show the expert picker as a focused overlay and return the selection result.
 * `initial` reopens the picker with that selection restored and the cursor on
 * it, so stepping back from a later screen does not discard it.
 */
export async function showExpertPicker(
  ctx: { ui: OverlayPromptUi },
  fileCount?: number,
  initial?: ReviewerSelection,
): Promise<ReviewerSelection | null> {
  return showOverlayPrompt<ReviewerSelection | null>(ctx, (tui, theme, finish) =>
    new ExpertPicker(theme, finish, fileCount, tui, initial));
}
