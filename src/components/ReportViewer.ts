import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, OVERLAY_MAX_HEIGHT, renderFramedBottom, renderFramedRow, renderFramedTop } from "./menuChrome.ts";

/** The slice of the TUI host required by the viewer; structural for unit tests. */
export interface ReportViewerHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of the theme required by the viewer; structural for unit tests. */
export interface ReportViewerTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/** Header metadata shown above the saved report. */
export interface ReportViewerHeader {
  /** Optional replacement for the standard audit-report heading. */
  title?: string;
  status: string;
  findingCount: number;
  verification: string;
  reportPath: string;
}

const NARROW_WIDTH = 60;
const PAGE_OVERLAP = 2;

/**
 * Read-only, line-scrolling audit report overlay. Markdown is rendered before
 * scrolling because wrapping changes the number of terminal lines.
 */
export class ReportViewer implements Component {
  private readonly markdown: Markdown;
  private readonly header: ReportViewerHeader;
  private readonly theme: ReportViewerTheme;
  private readonly done: () => void;
  private readonly tui: ReportViewerHost;
  private scrollOffset = 0;
  private cachedWidth: number | undefined;
  private cachedBodyLines: string[] | undefined;
  private lastWidth: number | undefined;

  constructor(
    reportText: string,
    header: ReportViewerHeader,
    theme: ReportViewerTheme,
    markdownTheme: MarkdownTheme,
    done: () => void,
    tui: ReportViewerHost,
  ) {
    this.markdown = new Markdown(reportText, 0, 0, markdownTheme);
    this.header = header;
    this.theme = theme;
    this.done = done;
    this.tui = tui;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedBodyLines = undefined;
    this.markdown.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }

    let nextOffset: number | undefined;
    if (matchesKey(data, Key.up)) nextOffset = this.scrollOffset - 1;
    else if (matchesKey(data, Key.down)) nextOffset = this.scrollOffset + 1;
    else if (data === "u" || data === "U") nextOffset = this.scrollOffset - this.pageStep();
    else if (data === "d" || data === "D") nextOffset = this.scrollOffset + this.pageStep();
    else if (data === "g") nextOffset = 0;
    else if (data === "G") nextOffset = this.maxScrollOffset();

    if (nextOffset !== undefined) {
      this.scrollOffset = this.clampScrollOffset(nextOffset);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    // Side walls cost two columns, so all content is laid out one frame in.
    const inner = Math.max(0, width - 2);
    const bodyLines = this.bodyLines(inner);
    this.scrollOffset = this.clampScrollOffset(this.scrollOffset);

    const narrow = width < NARROW_WIDTH;
    const bodyHeight = this.bodyHeight(narrow);
    const total = bodyLines.length;
    const start = total === 0 ? 0 : this.scrollOffset;
    const end = Math.min(total, start + bodyHeight);
    const body = bodyLines.slice(start, end).map((line) => this.fit(line, inner));
    if (body.length === 0) body.push(this.fit(this.theme.fg("dim", "No report content."), inner));

    const heading = this.header.title ?? `Audit Report — ${this.header.status} · ${this.header.findingCount} findings · verification ${this.header.verification}`;
    const rows: string[] = [];
    if (!narrow) rows.push(this.fit(this.theme.fg("dim", this.header.reportPath), inner));
    rows.push(this.scrollHint("↑", start, inner));
    rows.push(...body);
    rows.push(this.scrollHint("↓", total - end, inner));
    rows.push(this.footer(start, end, total, narrow, inner));
    return [
      renderFramedTop(this.theme, inner, heading),
      ...rows.map((row) => renderFramedRow(this.theme, inner, row)),
      renderFramedBottom(this.theme, inner),
    ];
  }

  private bodyLines(width: number): string[] {
    if (this.cachedWidth === width && this.cachedBodyLines) return this.cachedBodyLines;
    const body = this.markdown.render(Math.max(1, width));
    this.cachedWidth = width;
    this.cachedBodyLines = body;
    return body;
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    const terminalRows = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
    return Math.max(1, Math.floor((terminalRows * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private bodyHeight(narrow = (this.lastWidth ?? 0) < NARROW_WIDTH): number {
    // Title border, optional path, above/below markers, footer, bottom border.
    const chromeRows = narrow ? 5 : 6;
    return Math.max(1, this.viewportHeight() - chromeRows);
  }

  private pageStep(): number {
    return Math.max(1, this.bodyHeight() - PAGE_OVERLAP);
  }

  private maxScrollOffset(): number {
    const total = this.cachedBodyLines?.length ?? 0;
    return Math.max(0, total - this.bodyHeight());
  }

  private clampScrollOffset(offset: number): number {
    return Math.max(0, Math.min(offset, this.maxScrollOffset()));
  }

  private scrollHint(direction: "↑" | "↓", count: number, width: number): string {
    return count > 0
      ? this.fit(this.theme.fg("dim", `${direction} ${count} ${direction === "↑" ? "lines above" : "more lines"}`), width)
      : "";
  }

  private footer(start: number, end: number, total: number, narrow: boolean, width: number): string {
    const hints = narrow ? "↑↓ scroll · u/d page · g/G · Esc" : "↑↓ scroll · u/d page · g/G top/bottom · Esc close";
    const position = `lines ${total === 0 ? 0 : start + 1}–${end}/${total}`;
    const roomForHints = Math.max(0, width - visibleWidth(position) - 1);
    const shownHints = truncateToWidth(hints, roomForHints, "…");
    return this.fit(`${shownHints}${" ".repeat(Math.max(1, width - visibleWidth(shownHints) - visibleWidth(position)))}${position}`, width);
  }

  private fit(line: string, width: number): string {
    return truncateToWidth(line, Math.max(0, width), "…");
  }
}

/** Show the scrollable report overlay after a completed audit. */
export function showReportViewer(
  ctx: Pick<ExtensionCommandContext, "ui">,
  reportText: string,
  header: ReportViewerHeader,
): Promise<void> {
  return ctx.ui.custom<void>(
    (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: () => void) =>
      new ReportViewer(reportText, header, theme, getMarkdownTheme(), done, tui),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        maxHeight: OVERLAY_MAX_HEIGHT,
      },
    },
  );
}

/** Show a read-only Markdown or JSON artifact using the standard scrolling overlay. */
export function showArtifactViewer(ctx: Pick<ExtensionCommandContext, "ui">, content: string, artifactPath: string): Promise<void> {
  return showReportViewer(ctx, content, {
    title: `Artifact preview — ${artifactPath.split(/[\\/]/).pop() ?? artifactPath}`,
    status: "read-only",
    findingCount: 0,
    verification: "n/a",
    reportPath: artifactPath,
  });
}
