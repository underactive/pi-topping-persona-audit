/**
 * Roster picker for the "Load reviewer roster" route of /persona-audit.
 *
 * Lists the saved rosters alphabetically with their members, filters as you
 * type on roster or member name, and hands back the chosen roster's members
 * as a one-pass reviewer selection. A roster above the shared cost threshold
 * keeps ExpertPicker's second-Enter confirmation gate; Esc steps back to the
 * reviewer-source menu rather than cancelling the audit.
 */

import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Roster } from "../modelConfig.ts";
import type { ReviewerSelection } from "../types.ts";
import { COST_CONFIRM_RUN_THRESHOLD, type ExpertPickerHost, type ExpertPickerTheme } from "./ExpertPicker.ts";
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
import { TIERS } from "./ReviewerData.ts";

const REVIEWER_NAMES = new Set(TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => reviewer.name)));
/** Header block, range indicator, cost footer, and bottom border rows around the list. */
const LIST_CHROME_ROWS = 9;
const FALLBACK_WIDTH = 80;

export interface RosterPickerResult {
  rosterName: string;
  selection: ReviewerSelection;
}

/** Single-select roster list with type-to-filter and the shared cost confirmation gate. */
export class RosterPicker implements Component {
  private query = "";
  private awaitingCostConfirm = false;
  private entryIndex = 0;
  private scrollOffset = 0;
  private entries: Roster[] = [];
  private readonly rosters: Roster[];
  private readonly theme: ExpertPickerTheme;
  private readonly done: (result: RosterPickerResult | null) => void;
  private readonly fileCount: number | undefined;
  private readonly host: ExpertPickerHost | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedViewport: number | undefined;

  constructor(
    theme: ExpertPickerTheme,
    done: (result: RosterPickerResult | null) => void,
    rosters: Roster[],
    fileCount?: number,
    host?: ExpertPickerHost,
    initialRosterName?: string,
  ) {
    this.theme = theme;
    this.done = done;
    this.fileCount = fileCount;
    this.host = host;
    // Drop members that no longer exist in the reviewer data, then any roster left empty by that.
    this.rosters = rosters
      .map((roster) => ({ ...roster, reviewers: roster.reviewers.filter((name) => REVIEWER_NAMES.has(name)) }))
      .filter((roster) => roster.reviewers.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    this.rebuildEntries();
    const initialIndex = initialRosterName === undefined
      ? -1
      : this.entries.findIndex((roster) => roster.name === initialRosterName);
    if (initialIndex > 0) {
      this.entryIndex = initialIndex;
      this.adjustScroll();
    }
  }

  private viewportHeight(): number {
    const rows = this.host?.terminal?.rows ?? 0;
    return Math.max(10, Math.floor(((rows > 0 ? rows : FALLBACK_TERMINAL_ROWS) * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private currentRoster(): Roster | undefined {
    return this.entries[this.entryIndex];
  }

  private needsCostConfirm(): boolean {
    return (this.currentRoster()?.reviewers.length ?? 0) > COST_CONFIRM_RUN_THRESHOLD;
  }

  private rebuildEntries(): void {
    const norm = (text: string) => text.toLowerCase().replace(/\s+/g, "");
    const query = norm(this.query);
    this.entries = this.rosters.filter((roster) =>
      !query || norm(roster.name).includes(query) || roster.reviewers.some((name) => norm(name).includes(query)));
    this.entryIndex = Math.min(this.entryIndex, Math.max(0, this.entries.length - 1));
    this.adjustScroll();
  }

  private entryRows(roster: Roster, width: number): number {
    return 2 + wrapText(roster.reviewers.join(", "), width - 8).length;
  }

  private visibleEnd(offset: number, width: number): number {
    const budget = Math.max(this.viewportHeight() - LIST_CHROME_ROWS, 3);
    let rows = 0;
    let end = offset;
    while (end < this.entries.length) {
      // The single "Rosters" divider is charged to the first visible entry.
      const needed = this.entryRows(this.entries[end]!, width) + (end === offset ? 1 : 0);
      if (end > offset && rows + needed > budget) break;
      rows += needed;
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
    const count = this.currentRoster()?.reviewers.length ?? 0;
    const fileText = this.fileCount === undefined ? "selected files" : `${this.fileCount} file${this.fileCount === 1 ? "" : "s"}`;
    return `${count} reviewer${count === 1 ? "" : "s"} × 1 pass = ${count} reviewer run${count === 1 ? "" : "s"} · ${fileText} each`;
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
      const roster = this.currentRoster();
      if (!roster) return;
      if (this.needsCostConfirm() && !this.awaitingCostConfirm) {
        this.awaitingCostConfirm = true;
        this.invalidate();
        return;
      }
      this.done({ rosterName: roster.name, selection: { reviewers: [...roster.reviewers], passes: 1 } });
      return;
    }
    // A roster has no toggles or pass count, so the manual-picker keys are inert here.
    if (matchesKey(data, Key.space) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) return;
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
    const count = this.currentRoster()?.reviewers.length ?? 0;
    const lines = [
      renderMenuTopBorder(t, width, `Select a roster (${this.rosters.length} defined)`),
      "",
      " " + t.fg("dim", "↑↓ navigate · Enter confirm · Esc back"),
      " " + (this.query ? t.fg("accent", `Filter: ${this.query}`) : t.fg("dim", "Type to filter…")),
      "",
    ];
    if (this.entries.length === 0) {
      lines.push("  " + t.fg("warning", "No rosters match filter."));
    } else {
      const end = Math.min(this.visibleEnd(this.scrollOffset, width), this.entries.length);
      lines.push(" " + renderMenuSectionDivider(t, width - 1, "Rosters"));
      for (let index = this.scrollOffset; index < end; index++) {
        const roster = this.entries[index]!;
        const current = index === this.entryIndex;
        const pointer = current ? t.bold(t.fg("accent", SELECTOR)) : " ";
        const name = current ? t.bold(t.fg("accent", roster.name)) : t.bold(roster.name);
        lines.push(renderMenuContentRow(t, width, `  ${pointer} ◇ ${name}`, current));
        for (const memberLine of wrapText(roster.reviewers.join(", "), width - 8)) {
          lines.push(`      ${t.fg("muted", memberLine)}`);
        }
        lines.push("");
      }
      if (this.entries.length > end - this.scrollOffset) {
        lines.push(" " + t.fg("dim", `  ${this.scrollOffset + 1}–${end} of ${this.entries.length}`));
      }
    }
    lines.push(" " + t.fg(count > 0 ? "accent" : "dim", this.renderCostPreview()));
    if (this.awaitingCostConfirm) {
      lines.push(" " + t.fg("warning", "Press Enter again to launch this higher-cost run · Esc to revise"));
    } else if (count > 0) {
      lines.push(" " + t.fg("success", `✓ ${count} selected — press Enter to confirm${this.needsCostConfirm() ? " (confirmation required)" : ""}`));
    }
    lines.push(t.fg("border", "═".repeat(width)));
    this.cachedViewport = this.viewportHeight();
    this.cachedLines = lines;
    return lines;
  }
}

/** Open the roster picker as a focused overlay; resolves null when the user steps back. */
export async function showRosterPicker(
  ctx: { ui: OverlayPromptUi },
  rosters: Roster[],
  fileCount?: number,
  initialRosterName?: string,
): Promise<RosterPickerResult | null> {
  return showOverlayPrompt<RosterPickerResult | null>(ctx, (tui, theme, finish) =>
    new RosterPicker(theme, finish, rosters, fileCount, tui, initialRosterName));
}
