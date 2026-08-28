import type { Component, TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { handoffRelPath, renderDeferredHandoff, writeReportFile } from "../report.ts";
import type { Finding, FindingRecommendation, FindingsReviewOutcome, FindingsReviewResult, FindingStatus, FixedFinding, ReviewSessionState } from "../types.ts";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, OVERLAY_MAX_HEIGHT, renderFramedBottom, renderFramedRow, renderFramedTop, SELECTOR } from "./menuChrome.ts";

interface ReviewItem {
  finding: Finding;
  /** Position in the original findings array — flatGroups reorders, and Fix Now must name the source finding. */
  originalIndex: number;
  status: FindingStatus;
  /** Wrapped rationale/suggestedChange/reason lines, cached per width — arrow-key navigation invalidates the render cache on every keystroke, so this avoids re-wrapping every finding just to redraw the visible window. */
  wrapCache?: { width: number; rationale: string[]; suggestedChange: string[]; reason?: string[] };
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

/**
 * Findings review overlay — displays findings grouped by adjudicator recommendation.
 * Within each recommendation group, findings are sub-grouped by file.
 * The user cycles through apply → reject → defer states per finding.
 * `O` key promotes deferred → apply directly. Enter returns the structured
 * result; Esc arms a cancel that a second Esc confirms, returning null (the
 * orchestrator writes a partial report and applies no fixes).
 *
 * Findings vary in height with word wrapping, so the body is measured as it is
 * built and scrolled in line space; see {@link resolveScroll}.
 */
export class FindingsReview implements Component {
  private items: ReviewItem[];
  private selectedIndex = 0;
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
    this.theme = theme;
    this.done = done;
    this.tui = tui;
    this.onWriteHandoff = onWriteHandoff;
    this.populateGroups();
    if (restore) {
      this.selectedIndex = Math.max(0, Math.min(restore.selectedIndex, this.flatGroups.length - 1));
      this.lastHandoffPath = restore.handoffPath;
    }
  }

  /** Snapshot the mutable review state so a Fix Now round-trip can reopen the overlay unchanged. */
  private captureState(): ReviewSessionState {
    return {
      statuses: this.items.map((item) => item.status),
      selectedIndex: this.selectedIndex,
      fixed: new Map(this.fixedByIndex),
      handoffPath: this.lastHandoffPath,
    };
  }

  /** Adjudication degradation to surface in the header (recommendations are defaults, not judgments). */
  private readonly degradationNote?: string;

  // ── Group findings by recommendation, then by file ─────────────────────

  private readonly flatGroups: { groupRec: FindingRecommendation; groupFile: string; item: ReviewItem }[] = [];
  private readonly recCounts = new Map<FindingRecommendation, number>();

  private populateGroups(): void {
    const recMap = new Map<FindingStatus, Map<string, ReviewItem[]>>();
    for (const item of this.items) {
      const rec = item.finding.recommendation ?? "apply";
      let fileMap = recMap.get(rec);
      if (!fileMap) {
        fileMap = new Map();
        recMap.set(rec, fileMap);
      }
      const existing = fileMap.get(item.finding.file);
      if (existing) {
        existing.push(item);
      } else {
        fileMap.set(item.finding.file, [item]);
      }
    }

    this.flatGroups.length = 0;
    for (const rec of RENDER_ORDER) {
      const fileMap = recMap.get(rec);
      if (!fileMap) continue;
      for (const [file, items] of fileMap.entries()) {
        for (const item of items) {
          this.flatGroups.push({ groupRec: rec, groupFile: file, item });
        }
      }
    }

    this.recCounts.clear();
    for (const entry of this.flatGroups) {
      this.recCounts.set(entry.groupRec, (this.recCounts.get(entry.groupRec) ?? 0) + 1);
    }
  }

  // ── Component interface ─────────────────────────────────────────────────

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
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

    // Override key: promote deferred → apply
    if (data === "o" || data === "O") {
      const current = this.flatGroups[this.selectedIndex];
      if (current && current.item.status === "defer") {
        current.item.status = "apply";
        this.invalidate();
      }
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
        this.selectedIndex--;
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      const total = this.flatGroups.length;
      if (this.selectedIndex < total - 1) {
        this.selectedIndex++;
        this.invalidate();
      }
      return;
    }
  }

  /**
   * Lines the host will show before it clips, mirroring the overlay's maxHeight.
   * `render` is handed only a width, so the budget is rederived here.
   */
  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    const usable = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
    return Math.max(1, Math.floor((usable * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  /**
   * Word-wrap text to fit within maxCols, breaking at word boundaries.
   * `firstCols` gives the opening line a narrower budget, for callers that
   * print a head ("bug:12 — ") before it and indent the rest.
   */
  private wordWrap(text: string, maxCols: number, firstCols = maxCols): string[] {
    if (text.length <= firstCols) return [text];
    const words = text.split(/(\s+)/);
    const result: string[] = [];
    const budget = (): number => (result.length === 0 ? firstCols : maxCols);
    let current = "";
    for (const word of words) {
      const test = current + word;
      if (test.length <= budget()) {
        current = test;
      } else {
        // Flush current line if non-empty
        if (current.length > 0) {
          result.push(current);
        }
        // Start new line, stripping leading whitespace
        current = word.replace(/^\s+/, "");
        // Force-break if a single word exceeds the current budget
        while (current.length > budget()) {
          result.push(current.slice(0, budget() - 1) + "…");
          current = current.slice(budget() - 1);
        }
      }
    }
    if (current.length > 0) result.push(current);
    return result.length > 0 ? result : [text];
  }

  private wrapItem(item: ReviewItem, width: number, headCols: number): { rationale: string[]; suggestedChange: string[]; reason?: string[] } {
    if (item.wrapCache && item.wrapCache.width === width) return item.wrapCache;
    // Continuation lines are indented 6; the first also pays for the head.
    const rationale = this.wordWrap(item.finding.rationale, Math.max(2, width - 6), Math.max(2, width - 4 - headCols));
    const suggestedChange = this.wordWrap(`→ ${item.finding.suggestedChange}`, Math.max(2, width - 6), Math.max(2, width - 4));
    let reason: string[] | undefined;
    if (item.finding.recommendationReason && item.finding.recommendation !== "apply") {
      const reasonLabel = item.finding.recommendation === "reject" ? "Why reject" : "Why defer";
      reason = this.wordWrap(`⚑ ${reasonLabel}: ${item.finding.recommendationReason}`, Math.max(2, width - 6), Math.max(2, width - 4));
    }
    const cache = { width, rationale, suggestedChange, reason };
    item.wrapCache = cache;
    return cache;
  }

  /**
   * Scroll the body so the selected finding is fully visible, in line space.
   * A finding's height depends on how its rationale and suggested change wrap,
   * so scrolling by finding count cannot keep the selection inside the window.
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

  /** The one selectable line per finding: marker, status, severity, reviewer. */
  private renderFindingRow(item: ReviewItem, selected: boolean, width: number): string {
    const t = this.theme;
    const status = t.fg(STATUS_COLORS[item.status], STATUS_LABELS[item.status].padEnd(STATUS_WIDTH));
    const severe = item.finding.severity === "critical" || item.finding.severity === "high";
    const severityText = severe ? item.finding.severity.toUpperCase() : item.finding.severity;
    const severity = t.fg(severe ? "error" : "muted", severityText.padEnd(SEVERITY_WIDTH));
    const marker = selected ? t.bold(t.fg("accent", SELECTOR)) : " ";
    const sha = item.status === "fixed" ? this.fixedByIndex.get(item.originalIndex)?.commitSha : undefined;
    const reviewer = sha ? `${item.finding.reviewer} ${t.fg("dim", `@${sha}`)}` : item.finding.reviewer;
    const row = `  ${marker} ${status} ${severity} ${reviewer}`;
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
    let lastFile = "";

    for (const [index, entry] of this.flatGroups.entries()) {
      const { groupRec, groupFile, item } = entry;
      // Section and file headings open the span, so scrolling to the first
      // finding beneath them keeps its headings on screen.
      const start = lines.length;

      if (groupRec !== lastRec) {
        const heading = `── ${REC_LABELS[groupRec]} (${this.recCounts.get(groupRec) ?? 0}) `;
        const headingColor: ThemeColor = groupRec === "apply" ? "success" : groupRec === "reject" ? "warning" : "dim";
        const rule = "─".repeat(Math.max(0, width - visibleWidth(heading) - 2));
        lines.push("  " + t.bold(t.fg(headingColor, heading)) + t.fg("dim", rule));
        lastRec = groupRec;
        lastFile = "";
      }

      if (groupFile !== lastFile) {
        lines.push("  " + t.bold(t.fg("accent", groupFile)));
        lastFile = groupFile;
      }

      lines.push(this.renderFindingRow(item, index === this.selectedIndex, width));

      const lineInfo = item.finding.line > 0
        ? `${item.finding.category}:${item.finding.line}`
        : item.finding.category;
      const wrapped = this.wrapItem(item, width, visibleWidth(lineInfo) + 3);
      const firstRationale = wrapped.rationale[0];
      if (firstRationale !== undefined) {
        lines.push(`    ${t.fg("dim", lineInfo + " — ")}` + t.fg("muted", firstRationale));
        for (let ri = 1; ri < wrapped.rationale.length; ri++) {
          const rl = wrapped.rationale[ri];
          if (rl !== undefined) lines.push(`      ${t.fg("muted", rl)}`);
        }
      }

      for (const [ci, cl] of wrapped.suggestedChange.entries()) {
        lines.push(`${ci === 0 ? "    " : "      "}${t.fg("accent", cl)}`);
      }

      if (wrapped.reason) {
        for (const [ri, rl] of wrapped.reason.entries()) {
          lines.push(`${ri === 0 ? "    " : "      "}${t.fg("warning", rl)}`);
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
    const keybinds = "↑↓ navigate · Space cycle (A→R→D→A) · F fix now · O defer-override · H handoff-deferred · Enter finish · Esc Esc cancel";
    const header = [
      renderFramedTop(t, inner, `Findings Review (${this.items.length} total)`),
      ...this.wordWrap(keybinds, Math.max(2, inner - 1)).map((line) => " " + t.fg("dim", line)),
      ...(this.degradationNote
        ? this.wordWrap(`⚠ ${this.degradationNote}`, Math.max(2, inner - 1)).map((line) => " " + t.fg("warning", line))
        : []),
      "",
    ];

    // Scroll hint, blank, counts, optional handoff note, optional cancel
    // confirmation, bottom border.
    const footerHeight = 4 + (this.handoffNote ? 1 : 0) + (this.awaitingCancelConfirm ? 1 : 0);
    const bodyHeight = Math.max(1, viewport - header.length - footerHeight);

    const body = this.buildBody(inner);
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
    if (this.handoffNote) footer.push(`  ${t.fg("accent", this.handoffNote)}`);
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
    await writeReportFile(
      ctx.cwd,
      relPath,
      renderDeferredHandoff(
        { isoDate: handoff.isoDate, scope: handoff.scope, reviewers: handoff.reviewers },
        deferred,
      ),
    );
    return relPath;
  };

  return ctx.ui.custom<FindingsReviewOutcome>(
    (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (outcome: FindingsReviewOutcome) => void) =>
      new FindingsReview(findings, theme, done, tui, onWriteHandoff, degradationNote, restore),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        maxHeight: OVERLAY_MAX_HEIGHT,
      },
    },
  );
}