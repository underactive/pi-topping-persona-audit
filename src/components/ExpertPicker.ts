import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Roster } from "../modelConfig.ts";
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
const REVIEWER_NAMES = new Set(ALL_REVIEWERS.map((reviewer) => reviewer.name));
const TIER_LABELS = new Map(TIERS.map((tier) => [tier.tier, tier.label]));
const COST_CONFIRM_RUN_THRESHOLD = 6;
const LIST_CHROME_ROWS = 9;
const FALLBACK_WIDTH = 80;

type PickerEntry =
  | { kind: "roster"; roster: Roster }
  | { kind: "reviewer"; reviewer: ReviewerInfo };

export interface ExpertPickerHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

export interface ExpertPickerTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

/** Reviewer picker with optional roster shortcuts followed by the unchanged tiered reviewer list. */
export class ExpertPicker implements Component {
  private selected = new Set<string>();
  private passes = 1;
  private query = "";
  private awaitingCostConfirm = false;
  private entryIndex = 0;
  private scrollOffset = 0;
  private entries: PickerEntry[] = [];
  private readonly rosters: Roster[];
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
    rosters: Roster[] = [],
  ) {
    this.theme = theme;
    this.done = done;
    this.fileCount = fileCount;
    this.host = host;
    this.rosters = rosters
      .map((roster) => ({ ...roster, reviewers: roster.reviewers.filter((name) => REVIEWER_NAMES.has(name)) }))
      .filter((roster) => roster.reviewers.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (initial) {
      this.selected = new Set(initial.reviewers);
      this.passes = initial.passes;
    }
    this.rebuildEntries();
    const firstSelected = this.entries.findIndex(
      (entry) => entry.kind === "reviewer" && this.selected.has(entry.reviewer.name),
    );
    if (firstSelected > 0) {
      this.entryIndex = firstSelected;
      this.adjustScroll();
    }
  }

  private viewportHeight(): number {
    const rows = this.host?.terminal?.rows ?? 0;
    return Math.max(10, Math.floor(((rows > 0 ? rows : FALLBACK_TERMINAL_ROWS) * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private currentRoster(): Roster | undefined {
    const entry = this.entries[this.entryIndex];
    return entry?.kind === "roster" ? entry.roster : undefined;
  }

  private effectiveSelection(): ReviewerSelection {
    const roster = this.currentRoster();
    if (roster) return { reviewers: [...roster.reviewers], passes: 1 };
    return {
      reviewers: ALL_REVIEWERS.filter((reviewer) => this.selected.has(reviewer.name)).map((reviewer) => reviewer.name),
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
    const rosters = this.rosters.filter((roster) =>
      !query || norm(roster.name).includes(query) || roster.reviewers.some((name) => norm(name).includes(query)));
    const reviewers = ALL_REVIEWERS.filter((reviewer) =>
      !query
      || norm(reviewer.name).includes(query)
      || norm(reviewer.description).includes(query)
      || norm(reviewer.focusAreas.join(" ")).includes(query));
    this.entries = [
      ...rosters.map((roster): PickerEntry => ({ kind: "roster", roster })),
      ...reviewers.map((reviewer): PickerEntry => ({ kind: "reviewer", reviewer })),
    ];
    this.entryIndex = Math.min(this.entryIndex, Math.max(0, this.entries.length - 1));
    this.adjustScroll();
  }

  private section(entry: PickerEntry): string {
    return entry.kind === "roster" ? "Rosters" : TIER_LABELS.get(entry.reviewer.tier) ?? entry.reviewer.tier;
  }

  private entryRows(entry: PickerEntry, width: number): number {
    return entry.kind === "roster"
      ? 2 + wrapText(entry.roster.reviewers.join(", "), width - 8).length
      : 2 + wrapText(entry.reviewer.description, width - 8).length
        + wrapText(entry.reviewer.focusAreas.join(" · "), width - 8).length;
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
      if (this.needsCostConfirm() && !this.awaitingCostConfirm) {
        this.awaitingCostConfirm = true;
        this.invalidate();
        return;
      }
      this.done(selection);
      return;
    }
    if (matchesKey(data, Key.space)) {
      const entry = this.entries[this.entryIndex];
      if (entry?.kind !== "reviewer") return;
      const name = entry.reviewer.name;
      if (this.selected.has(name)) this.selected.delete(name);
      else this.selected.add(name);
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
      if (this.currentRoster()) return;
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
    const roster = this.currentRoster();
    const effective = this.effectiveSelection();
    const lines = [
      renderMenuTopBorder(t, width, `Select reviewers (${roster ? `${roster.name} roster` : `${this.selected.size} selected`})`),
      "",
      " " + t.fg("dim", `↑↓ navigate · Space toggle · ←→ passes (${roster ? 1 : this.passes}) · Enter confirm · Esc cancel`),
      " " + (this.query ? t.fg("accent", `Filter: ${this.query}`) : t.fg("dim", "Type to filter…")),
      "",
    ];
    if (this.entries.length === 0) {
      lines.push("  " + t.fg("warning", this.rosters.length > 0
        ? "No reviewers or rosters match filter."
        : "No reviewers match filter."));
    } else {
      const end = Math.min(this.visibleEnd(this.scrollOffset, width), this.entries.length);
      let section: string | undefined;
      for (let index = this.scrollOffset; index < end; index++) {
        const entry = this.entries[index]!;
        const nextSection = this.section(entry);
        if (nextSection !== section) {
          section = nextSection;
          lines.push(" " + renderMenuSectionDivider(t, width - 1, section));
        }
        const current = index === this.entryIndex;
        const pointer = current ? t.bold(t.fg("accent", SELECTOR)) : " ";
        if (entry.kind === "roster") {
          const name = current ? t.bold(t.fg("accent", entry.roster.name)) : t.bold(entry.roster.name);
          lines.push(renderMenuContentRow(t, width, `  ${pointer} ◇ ${name}`, current));
          for (const memberLine of wrapText(entry.roster.reviewers.join(", "), width - 8)) {
            lines.push(`      ${t.fg("muted", memberLine)}`);
          }
        } else {
          const reviewer = entry.reviewer;
          const checked = this.selected.has(reviewer.name);
          const checkbox = checked ? t.fg("success", "✓") : t.fg("dim", "○");
          const name = checked
            ? t.fg("success", t.bold(reviewer.name))
            : current ? t.bold(t.fg("accent", reviewer.name)) : t.bold(reviewer.name);
          lines.push(renderMenuContentRow(t, width, `  ${pointer} ${checkbox} ${name}`, current));
          for (const text of wrapText(reviewer.description, width - 8)) lines.push(`      ${t.fg("muted", text)}`);
          for (const text of wrapText(reviewer.focusAreas.join(" · "), width - 8)) lines.push(`      ${t.fg("dim", text)}`);
        }
        lines.push("");
      }
      if (this.entries.length > end - this.scrollOffset) {
        lines.push(" " + t.fg("dim", `  ${this.scrollOffset + 1}–${end} of ${this.entries.length}`));
      }
    }
    lines.push(" " + t.fg(effective.reviewers.length ? "accent" : "dim", this.renderCostPreview()));
    if (this.awaitingCostConfirm) {
      lines.push(" " + t.fg("warning", "Press Enter again to launch this higher-cost run · Esc to revise"));
    } else if (effective.reviewers.length > 0) {
      lines.push(" " + t.fg("success", `✓ ${effective.reviewers.length} selected — press Enter to confirm${this.needsCostConfirm() ? " (confirmation required)" : ""}`));
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
  rosters: Roster[] = [],
): Promise<ReviewerSelection | null> {
  return showOverlayPrompt<ReviewerSelection | null>(ctx, (tui, theme, finish) =>
    new ExpertPicker(theme, finish, fileCount, tui, initial, rosters));
}
