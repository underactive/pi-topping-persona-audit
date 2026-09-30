import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { handoffRelPath, renderDeferredHandoff, writeReportFile } from "../report.ts";
import { gitHeadCommit } from "../git.ts";
import { compareFindingsByExploitability } from "../findingOrder.ts";
import { SEVERITY_ORDER } from "../types.ts";
import type { Finding, FindingRecommendation, FindingsReviewOutcome, FindingsReviewResult, FindingStatus, FixedFinding, ReviewSessionState, ReviewSortMode } from "../types.ts";
import { sanitizeTerminalText } from "./AuditProgress.ts";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, renderFramedBottom, renderFramedRow, renderFramedTop, SELECTOR, showOverlayPrompt } from "./menuChrome.ts";

interface WrappedDetailBlock {
  heading: string;
  content: string[];
  /** Theme color of a ⚑ drawn before the heading; blocks without one show no flag. */
  flag?: ThemeColor;
}

/** The blocks → reveals beneath a finding's Summary, wrapped to one width. */
interface WrappedFindingDetails {
  rationale: string[];
  suggestedChange: string[];
  reason?: WrappedDetailBlock;
  exploitability?: string[];
  disputes?: WrappedDetailBlock[];
  derivedFrom?: WrappedDetailBlock;
}

interface ReviewItem {
  finding: Finding;
  /** Position in the original findings array — flatGroups reorders, and Fix Now must name the source finding. */
  originalIndex: number;
  status: FindingStatus;
  /** Wrapped summary lines, cached per width — arrow-key navigation invalidates the render cache on every keystroke, so this avoids re-wrapping every finding just to redraw the visible window. */
  summaryCache?: { width: number; lines: string[] };
  /** Wrapped detail lines, cached per width — only the expanded finding needs them, so they are wrapped on first expansion. */
  detailsCache?: WrappedFindingDetails & { width: number };
}

/** Body-line range a single finding occupies, used to keep the selection on screen. */
interface LineSpan {
  start: number;
  end: number;
}

/** The slice of pi's `TUI` the overlay needs. Structural so tests can supply a stub. */
export interface ReviewHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of pi's `Theme` the overlay needs. Structural so tests can supply a stub. */
export interface ReviewTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

const STATUS_CYCLE: FindingStatus[] = ["apply", "reject", "defer"];
const SORT_CYCLE: ReviewSortMode[] = ["file", "priority", "reviewer", "blast"];
const SORT_LABELS: Record<ReviewSortMode, string> = {
  file: "file",
  priority: "priority",
  reviewer: "reviewer",
  blast: "blast radius",
};
const PAGE_OVERLAP = 2;

/** Render order for recommendation groups — Apply first, Defer second, Reject last. */
const RENDER_ORDER: FindingRecommendation[] = ["apply", "defer", "reject"];

/** Human-readable labels for recommendation sections. */
const REC_LABELS: Record<FindingRecommendation, string> = {
  apply: "Recommended: Apply",
  defer: "Recommended: Defer",
  reject: "Recommended: Reject",
};

const STATUS_LABELS: Record<FindingStatus, string> = {
  apply: "[APPLY]",
  reject: "[REJECT]",
  defer: "[DEFER]",
  fixed: "[FIXED]",
};
const STATUS_COLORS: Record<FindingStatus, ThemeColor> = {
  apply: "success",
  reject: "warning",
  defer: "dim",
  fixed: "success",
};
/** Widest status label and severity name, so the reviewer column holds still as statuses cycle. */
const STATUS_WIDTH = 8;
const SEVERITY_WIDTH = 8;

/** Columns left for detail text inside the frame, the row indent, and the heading indent. */
const detailWidth = (width: number): number => Math.max(2, width - 6);

/**
 * Findings review overlay — displays findings grouped by adjudicator recommendation.
 * Within each recommendation group, findings are sub-grouped by file when the file sort is active.
 * Every finding shows its status row and Summary; → expands the highlighted
 * finding's remaining details, ← collapses them, and moving the highlight
 * collapses them as well, so at most one finding is open at a time.
 * The user cycles through apply → reject → defer states per finding.
 * Cancel requires confirmation; confirming returns a `{ kind: "cancelled" }` outcome
 * (the orchestrator writes a partial report and applies no fixes).
 *
 * Findings vary in height with word wrapping and expansion, so the body is
 * measured as it is built and scrolled in line space; see {@link resolveScroll}.
 */
export class FindingsReview implements Component {
  private items: ReviewItem[];
  private selectedIndex = 0;
  /** Whether the highlighted finding shows its detail blocks beneath the Summary. */
  private detailsExpanded = false;
  private sortMode: ReviewSortMode;
  /** Offset into the body's rendered lines — not an index into the findings. */
  private scrollOffset = 0;
  private readonly theme: ReviewTheme;
  private readonly done: (outcome: FindingsReviewOutcome) => void;
  private readonly tui: ReviewHost;
  private readonly fixedByIndex: Map<number, FixedFinding>;
  private readonly onWriteHandoff: (deferred: Finding[]) => Promise<string>;
  private handoffNote: string | undefined;
  private lastHandoffPath: string | undefined;
  private handoffWriting = false;
  private awaitingCancelConfirm = false;
  private pendingPageDelta = 0;
  private cachedWidth: number | undefined;
  private cachedHeight: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    findings: Finding[],
    theme: ReviewTheme,
    done: (outcome: FindingsReviewOutcome) => void,
    tui: ReviewHost,
    onWriteHandoff: (deferred: Finding[]) => Promise<string>,
    degradationNote?: string,
    restore?: ReviewSessionState,
  ) {
    this.degradationNote = degradationNote;
    this.items = findings.map((f, index) => ({
      finding: f,
      originalIndex: index,
      status: restore?.statuses[index] ?? f.recommendation ?? "apply",
    }));
    this.fixedByIndex = new Map(restore?.fixed ?? []);
    this.sortMode = restore?.sortMode ?? "file";
    this.theme = theme;
    this.done = done;
    this.tui = tui;
    this.onWriteHandoff = onWriteHandoff;
    this.populateGroups();
    if (restore) {
      this.selectedIndex = Math.max(0, Math.min(restore.selectedIndex, this.flatGroups.length - 1));
      this.lastHandoffPath = restore.handoffPath;
      this.detailsExpanded = restore.detailsExpanded ?? false;
    }
  }

  /** Snapshot the mutable review state so a Fix Now round-trip can reopen the overlay unchanged. */
  private captureState(): ReviewSessionState {
    return {
      statuses: this.items.map((item) => item.status),
      selectedIndex: this.selectedIndex,
      sortMode: this.sortMode,
      detailsExpanded: this.detailsExpanded,
      fixed: new Map(this.fixedByIndex),
      handoffPath: this.lastHandoffPath,
    };
  }

  /** Adjudication degradation to surface in the header (recommendations are defaults, not judgments). */
  private readonly degradationNote?: string;

  // ── Group findings by recommendation, then sort within each section ────

  private readonly flatGroups: { groupRec: FindingRecommendation; groupLabel: string; item: ReviewItem }[] = [];
  private readonly recCounts = new Map<FindingRecommendation, number>();

  private compareItems(left: ReviewItem, right: ReviewItem): number {
    const severity = SEVERITY_ORDER.indexOf(left.finding.severity) - SEVERITY_ORDER.indexOf(right.finding.severity);
    const file = left.finding.file.localeCompare(right.finding.file);
    const line = left.finding.line - right.finding.line;
    const original = left.originalIndex - right.originalIndex;

    switch (this.sortMode) {
      case "file":
        return file || line || severity || original;
      case "priority":
        return compareFindingsByExploitability(left.finding, right.finding) || original;
      case "reviewer": {
        const reviewer = left.finding.reviewer.localeCompare(right.finding.reviewer, undefined, { sensitivity: "base" });
        return reviewer || severity || file || line || original;
      }
      case "blast": {
        const blast = (right.finding.blastRadius?.score ?? -1) - (left.finding.blastRadius?.score ?? -1);
        return blast || severity || file || line || original;
      }
    }
  }

  private populateGroups(): void {
    this.flatGroups.length = 0;
    for (const rec of RENDER_ORDER) {
      const items = this.items
        .filter((item) => (item.finding.recommendation ?? "apply") === rec)
        .sort((left, right) => this.compareItems(left, right));
      for (const item of items) {
        this.flatGroups.push({
          groupRec: rec,
          groupLabel: this.sortMode === "file" ? item.finding.file : "",
          item,
        });
      }
    }

    this.recCounts.clear();
    for (const entry of this.flatGroups) {
      this.recCounts.set(entry.groupRec, (this.recCounts.get(entry.groupRec) ?? 0) + 1);
    }
  }

  private cycleSortMode(): void {
    const selected = this.flatGroups[this.selectedIndex]?.item;
    const next = (SORT_CYCLE.indexOf(this.sortMode) + 1) % SORT_CYCLE.length;
    this.sortMode = SORT_CYCLE[next]!;
    this.populateGroups();
    this.selectedIndex = selected ? Math.max(0, this.flatGroups.findIndex((entry) => entry.item === selected)) : 0;
    this.scrollOffset = 0;
    this.invalidate();
  }

  // ── Component interface ─────────────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  private setSelectedStatus(status: Exclude<FindingStatus, "fixed">): void {
    const current = this.flatGroups[this.selectedIndex];
    if (current && current.item.status !== "fixed") {
      current.item.status = status;
      this.invalidate();
    }
  }

  /** Move the highlight. Leaving a finding collapses its details, so the next one opens compact. */
  private select(index: number): void {
    if (index === this.selectedIndex) return;
    this.selectedIndex = index;
    this.detailsExpanded = false;
  }

  handleInput(data: string): void {
    // Two-step abort. Triage decisions live only in this component, and the
    // adjudicator's annotations are never persisted, so a single stray Esc
    // would discard the whole review with nothing to reload it from.
    if (matchesKey(data, Key.escape)) {
      if (!this.awaitingCancelConfirm) {
        this.awaitingCancelConfirm = true;
        this.invalidate();
        return;
      }
      this.done({ kind: "cancelled" });
      return;
    }
    if (this.awaitingCancelConfirm) {
      this.awaitingCancelConfirm = false;
      this.invalidate();
    }

    if (data === "s" || data === "S") {
      this.cycleSortMode();
      return;
    }

    if (data === "h" || data === "H") {
      if (this.handoffWriting) return;

      const deferred = this.items.filter((item) => item.status === "defer").map((item) => item.finding);
      if (deferred.length === 0) {
        this.handoffNote = "No deferred items to hand off yet.";
        this.invalidate();
        return;
      }

      this.handoffNote = "Writing handoff…";
      this.handoffWriting = true;
      this.invalidate();
      void Promise.resolve()
        .then(() => this.onWriteHandoff(deferred))
        .then((path) => {
          this.lastHandoffPath = path;
          this.handoffNote = `Wrote ${deferred.length} deferred item(s) → ${path}`;
          this.invalidate();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.handoffNote = `Handoff write failed: ${message}`;
          this.invalidate();
        })
        .finally(() => {
          this.handoffWriting = false;
          this.invalidate();
          this.tui.requestRender();
        });
      return;
    }

    if (data === "a" || data === "A") {
      this.setSelectedStatus("apply");
      return;
    }
    if (data === "r" || data === "R") {
      this.setSelectedStatus("reject");
      return;
    }
    if (data === "d" || data === "D") {
      this.setSelectedStatus("defer");
      return;
    }

    // Fix Now: hand the highlighted finding to the interactive fix flow.
    if (data === "f" || data === "F") {
      const current = this.flatGroups[this.selectedIndex];
      if (current && current.item.status !== "fixed") {
        this.done({ kind: "fixNow", index: current.item.originalIndex, state: this.captureState() });
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.done({ kind: "finalized", result: this.buildResult() });
      return;
    }

    if (matchesKey(data, Key.space)) {
      const current = this.flatGroups[this.selectedIndex];
      if (current && current.item.status !== "fixed") {
        const idx = STATUS_CYCLE.indexOf(current.item.status);
        current.item.status = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) {
        this.select(this.selectedIndex - 1);
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      const total = this.flatGroups.length;
      if (this.selectedIndex < total - 1) {
        this.select(this.selectedIndex + 1);
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.right)) {
      if (!this.detailsExpanded && this.flatGroups.length > 0) {
        this.detailsExpanded = true;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.left)) {
      if (this.detailsExpanded) {
        this.detailsExpanded = false;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.pendingPageDelta--;
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.pendingPageDelta++;
      this.invalidate();
      return;
    }
  }

  /**
   * Lines the component renders before clipping its scrollable viewport.
   * `render` is handed only a width, so the internal budget is rederived here.
   */
  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    const usable = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
    return Math.max(1, Math.floor((usable * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private wrapSummary(item: ReviewItem, width: number): string[] {
    if (item.summaryCache && item.summaryCache.width === width) return item.summaryCache.lines;
    const lines = wrapTextWithAnsi(sanitizeTerminalText(item.finding.summary || item.finding.rationale), detailWidth(width));
    item.summaryCache = { width, lines };
    return lines;
  }

  private wrapDetails(item: ReviewItem, width: number): WrappedFindingDetails {
    if (item.detailsCache && item.detailsCache.width === width) return item.detailsCache;
    const columns = detailWidth(width);
    const rationale = wrapTextWithAnsi(sanitizeTerminalText(item.finding.rationale), columns);
    const suggestedChange = wrapTextWithAnsi(sanitizeTerminalText(item.finding.suggestedChange), columns);
    let reason: WrappedDetailBlock | undefined;
    if (item.finding.recommendationReason && item.finding.recommendation !== "apply") {
      const rejected = item.finding.recommendation === "reject";
      reason = {
        heading: rejected ? "Why reject:" : "Why defer:",
        content: wrapTextWithAnsi(sanitizeTerminalText(item.finding.recommendationReason), columns),
        flag: rejected ? "error" : "warning",
      };
    }
    const exploitability = item.finding.exploitability
      ? wrapTextWithAnsi(
          `${item.finding.exploitability}${item.finding.exploitabilityReason ? ` — ${sanitizeTerminalText(item.finding.exploitabilityReason)}` : ""}`,
          columns,
        )
      : undefined;
    const disputes = item.finding.disputes?.map((dispute): WrappedDetailBlock => ({
      heading: `Disputed by ${sanitizeTerminalText(dispute.reviewer)} (${dispute.verdict}):`,
      content: wrapTextWithAnsi(sanitizeTerminalText(dispute.reason), columns),
      flag: "warning",
    }));
    const derivedFrom = item.finding.derivedFrom?.length
      ? {
          heading: "Derived from:",
          content: wrapTextWithAnsi(
            item.finding.derivedFrom.map((source) => sanitizeTerminalText(source)).join(", "),
            columns,
          ),
        }
      : undefined;
    const cache = { width, rationale, suggestedChange, reason, exploitability, disputes, derivedFrom };
    item.detailsCache = cache;
    return cache;
  }

  /** The blocks → reveals beneath the Summary: rationale, evidence, and the proposed edit. */
  private detailBlocks(item: ReviewItem, width: number): WrappedDetailBlock[] {
    const wrapped = this.wrapDetails(item, width);
    const blast = this.sortMode === "blast" ? item.finding.blastRadius : undefined;
    // The bucket stays a content line: headings are not wrapped, so a long reason list would be clipped at the frame.
    const blastInfo = blast
      ? [`blast ${blast.level[0]!.toUpperCase()}${blast.level.slice(1)}${blast.reasons.length > 0 ? `: ${blast.reasons.slice(0, 2).map(sanitizeTerminalText).join(", ")}` : ""}`]
      : [];
    return [
      { heading: `Rationale (${item.finding.category}):`, content: [...blastInfo, ...wrapped.rationale] },
      ...(wrapped.exploitability ? [{ heading: "Exploitability:", content: wrapped.exploitability }] : []),
      ...(wrapped.disputes ?? []),
      ...(wrapped.derivedFrom ? [wrapped.derivedFrom] : []),
      { heading: "Suggested Change:", content: wrapped.suggestedChange },
      ...(wrapped.reason ? [wrapped.reason] : []),
    ];
  }

  /**
   * Apply one page movement after the body has been measured. Findings have
   * variable heights, so the target is a rendered-line offset rather than a
   * fixed number of finding rows.
   */
  private applyPage(spans: LineSpan[], bodyHeight: number, bodyLength: number, direction: -1 | 1): void {
    const pageStep = Math.max(1, bodyHeight - PAGE_OVERLAP);
    const maxOffset = Math.max(0, bodyLength - bodyHeight);
    const targetOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + direction * pageStep));
    if (spans.length === 0) return;
    if (targetOffset === this.scrollOffset) {
      // The last page can still contain an unselected finding even when the
      // offset is already clamped at the end (and likewise at the top).
      if (bodyLength > bodyHeight && direction > 0 && this.selectedIndex < spans.length - 1) {
        this.select(spans.length - 1);
      } else if (bodyLength > bodyHeight && direction < 0 && this.selectedIndex > 0) {
        this.select(0);
      }
      return;
    }

    const step = direction > 0 ? 1 : -1;
    const fitsTargetPage = (span: LineSpan): boolean =>
      span.start >= targetOffset && span.end <= targetOffset + bodyHeight;
    let targetIndex: number | undefined;

    for (let index = this.selectedIndex + step; index >= 0 && index < spans.length; index += step) {
      if (fitsTargetPage(spans[index]!)) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex === undefined) {
      for (let index = this.selectedIndex + step; index >= 0 && index < spans.length; index += step) {
        if (spans[index]!.start >= targetOffset) {
          targetIndex = index;
          break;
        }
      }
    }
    targetIndex ??= direction > 0 ? spans.length - 1 : Math.max(0, this.selectedIndex - 1);

    this.scrollOffset = targetOffset;
    this.select(targetIndex);
  }

  /**
   * Scroll the body so the selected finding is fully visible, in line space.
   * A finding's height depends on how its summary wraps and on whether it is
   * the expanded one, so scrolling by finding count cannot keep the selection
   * inside the window.
   */
  private resolveScroll(spans: LineSpan[], bodyHeight: number, bodyLength: number): number {
    let scroll = this.scrollOffset;
    const span = spans[this.selectedIndex];
    if (span) {
      if (span.start < scroll) {
        scroll = span.start;
      } else if (span.end > scroll + bodyHeight) {
        // A finding taller than the window pins to its top rather than its end.
        scroll = Math.min(span.end - bodyHeight, span.start);
      }
    }
    return Math.max(0, Math.min(scroll, Math.max(0, bodyLength - bodyHeight)));
  }

  private buildResult(): FindingsReviewResult {
    const accepted: Finding[] = [];
    const rejected: Finding[] = [];
    const deferred: Finding[] = [];
    const fixed: FixedFinding[] = [];

    for (const item of this.items) {
      switch (item.status) {
        case "apply":
          accepted.push(item.finding);
          break;
        case "reject":
          rejected.push(item.finding);
          break;
        case "defer":
          deferred.push(item.finding);
          break;
        case "fixed":
          fixed.push(
            this.fixedByIndex.get(item.originalIndex)
              ?? { finding: item.finding, files: [item.finding.file] },
          );
          break;
      }
    }

    return { accepted, rejected, deferred, fixed, handoffPath: this.lastHandoffPath };
  }

  /** The one selectable line per finding: marker, status, severity, reviewer, and location. */
  private renderFindingRow(item: ReviewItem, selected: boolean, width: number): string {
    const t = this.theme;
    const status = t.fg(STATUS_COLORS[item.status], STATUS_LABELS[item.status].padEnd(STATUS_WIDTH));
    const severe = item.finding.severity === "critical" || item.finding.severity === "high";
    const severityText = severe ? item.finding.severity.toUpperCase() : item.finding.severity;
    const severity = t.fg(severe ? "error" : "muted", severityText.padEnd(SEVERITY_WIDTH));
    const marker = selected ? t.bold(t.fg("accent", SELECTOR)) : " ";
    const sha = item.status === "fixed" ? this.fixedByIndex.get(item.originalIndex)?.commitSha : undefined;
    const reviewerName = sanitizeTerminalText(item.finding.reviewer);
    const reviewer = sha ? `${reviewerName} ${t.fg("dim", `@${sha}`)}` : reviewerName;
    const location = sanitizeTerminalText(item.finding.line > 0 ? `${item.finding.file}:${item.finding.line}` : item.finding.file);
    const row = `  ${marker} ${status} ${severity} ${reviewer} ${t.bold(t.fg("text", location))}`;
    if (!selected) return row;
    // Pad the bar to the full overlay width so the highlight reads as one row.
    const clipped = truncateToWidth(row, width, "…");
    return t.bg("selectedBg", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
  }

  /** Render every finding, recording the line span each one occupies. */
  private buildBody(width: number): { lines: string[]; spans: LineSpan[] } {
    const t = this.theme;
    const lines: string[] = [];
    const spans: LineSpan[] = [];
    let lastRec: FindingStatus | "" = "";
    let lastLabel = "";

    for (const [index, entry] of this.flatGroups.entries()) {
      const { groupRec, groupLabel, item } = entry;
      // Section and file headings open the span, so scrolling to the first
      // finding beneath them keeps its headings on screen.
      const start = lines.length;

      if (groupRec !== lastRec) {
        const heading = `── ${REC_LABELS[groupRec]} (${this.recCounts.get(groupRec) ?? 0}) `;
        const headingColor: ThemeColor = STATUS_COLORS[groupRec];
        const rule = "─".repeat(Math.max(0, width - visibleWidth(heading) - 2));
        lines.push("  " + t.bold(t.fg(headingColor, heading)) + t.fg("dim", rule));
        lastRec = groupRec;
        lastLabel = "";
      }

      const safeGroupLabel = sanitizeTerminalText(groupLabel);
      if (safeGroupLabel && safeGroupLabel !== lastLabel) {
        lines.push("  " + t.bold(t.fg("accent", safeGroupLabel)));
        lastLabel = safeGroupLabel;
      }

      const selected = index === this.selectedIndex;
      lines.push(this.renderFindingRow(item, selected, width));

      // Every finding shows its Summary; only the highlighted one opens further.
      const blocks: WrappedDetailBlock[] = [{ heading: "Summary:", content: this.wrapSummary(item, width) }];
      if (selected && this.detailsExpanded) blocks.push(...this.detailBlocks(item, width));
      for (const [blockIndex, block] of blocks.entries()) {
        if (blockIndex > 0) lines.push("");
        const flag = block.flag ? `${t.fg(block.flag, "⚑")} ` : "";
        lines.push(`    ${flag}${t.fg("text", block.heading)}`);
        for (const detail of block.content) {
          lines.push(`      ${t.fg("muted", detail)}`);
        }
      }

      spans.push({ start, end: lines.length });
      lines.push("");
    }

    return { lines, spans };
  }

  render(width: number): string[] {
    const viewport = this.viewportHeight();
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === viewport) return this.cachedLines;

    const t = this.theme;
    // Side walls cost two columns, so all content is laid out one frame in.
    const inner = Math.max(0, width - 2);
    const keybinds = `↑↓ navigate · → expand · ← collapse · PgUp/PgDn page · S sort: ${SORT_LABELS[this.sortMode]} · A apply · R reject · D defer · Space cycle · F fix now · H handoff · Enter finish · Esc cancel`;
    const header = [
      renderFramedTop(t, inner, `Findings Review (${this.items.length} total)`),
      ...wrapTextWithAnsi(keybinds, Math.max(2, inner - 1)).map((line) => " " + t.fg("dim", line)),
      ...(this.degradationNote
        ? wrapTextWithAnsi(`⚠ ${sanitizeTerminalText(this.degradationNote)}`, Math.max(2, inner - 1)).map((line) => " " + t.fg("warning", line))
        : []),
      "",
    ];

    // Scroll hint, blank, counts, optional handoff note, optional cancel
    // confirmation, bottom border.
    const footerHeight = 4 + (this.handoffNote ? 1 : 0) + (this.awaitingCancelConfirm ? 1 : 0);
    const bodyHeight = Math.max(1, viewport - header.length - footerHeight);

    let body = this.buildBody(inner);
    if (this.pendingPageDelta !== 0) {
      // Apply every queued key so rapid PageUp/PageDown presses are not lost
      // while the host is waiting to render the next frame.
      while (this.pendingPageDelta !== 0) {
        const direction: -1 | 1 = this.pendingPageDelta < 0 ? -1 : 1;
        this.pendingPageDelta -= direction;
        this.applyPage(body.spans, bodyHeight, body.lines.length, direction);
      }
      // Page movement may change the selected row, so rebuild the body to put
      // the highlight on the new selection before slicing the window.
      body = this.buildBody(inner);
    }
    this.scrollOffset = this.resolveScroll(body.spans, bodyHeight, body.lines.length);
    const windowed = body.lines.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    if (this.flatGroups.length === 0) windowed.push("  " + t.fg("dim", "No findings to review."));

    let above = 0;
    let below = 0;
    for (const s of body.spans) {
      if (s.end <= this.scrollOffset) above++;
      else if (s.start >= this.scrollOffset + bodyHeight) below++;
    }
    const hints = [above > 0 ? `↑ ${above} above` : "", below > 0 ? `↓ ${below} below` : ""].filter(Boolean);

    let applyCount = 0;
    let rejectCount = 0;
    let deferCount = 0;
    let fixedCount = 0;
    for (const i of this.items) {
      if (i.status === "apply") applyCount++;
      else if (i.status === "reject") rejectCount++;
      else if (i.status === "fixed") fixedCount++;
      else deferCount++;
    }
    const counts = `  ${t.fg("success", `${applyCount} apply`)} · `
      + `${t.fg("warning", `${rejectCount} reject`)} · `
      + `${t.fg("dim", `${deferCount} defer`)}`
      + (fixedCount > 0 ? ` · ${t.fg("success", `${fixedCount} fixed`)}` : "");
    const position = this.flatGroups.length > 0 ? `${this.selectedIndex + 1}/${this.flatGroups.length}` : "0/0";
    const gap = " ".repeat(Math.max(1, inner - visibleWidth(counts) - position.length - 2));

    const footer = [
      hints.length > 0 ? "  " + t.fg("dim", hints.join(" · ")) : "",
      "",
      counts + gap + t.fg("dim", position) + "  ",
    ];
    if (this.handoffNote) footer.push(`  ${t.fg("accent", sanitizeTerminalText(this.handoffNote))}`);
    if (this.awaitingCancelConfirm) {
      footer.push(
        "  " + t.fg("warning", "Press Esc again to cancel the audit — no fixes applied · any other key resumes"),
      );
    }
    footer.push(renderFramedBottom(t, inner));

    const lines = [
      header[0]!,
      ...[...header.slice(1), ...windowed, ...footer.slice(0, -1)].map((row) => renderFramedRow(t, inner, row)),
      footer[footer.length - 1]!,
    ];
    this.cachedWidth = width;
    this.cachedHeight = viewport;
    this.cachedLines = lines;
    return lines;
  }
}

/** Show the findings review TUI overlay. */
export async function showFindingsReview(
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui">,
  findings: Finding[],
  handoff: { slug: string; isoDate: string; scope: string; reviewers: string[] },
  degradationNote?: string,
  restore?: ReviewSessionState,
): Promise<FindingsReviewOutcome> {
  const onWriteHandoff = async (deferred: Finding[]): Promise<string> => {
    const relPath = handoffRelPath(handoff.slug);
    const headCommit = await gitHeadCommit(ctx.cwd);
    await writeReportFile(
      ctx.cwd,
      relPath,
      renderDeferredHandoff(
        {
          isoDate: handoff.isoDate,
          scope: handoff.scope,
          reviewers: handoff.reviewers,
          ...(headCommit ? { headCommit } : {}),
        },
        deferred,
      ),
    );
    return relPath;
  };

  return showOverlayPrompt<FindingsReviewOutcome>(
    ctx,
    (tui, theme, done) => new FindingsReview(findings, theme, done, tui, onWriteHandoff, degradationNote, restore),
  );
}
