/**
 * Fix Now overlay: live telemetry while the fix/verify agents run, then a
 * scrollable diff gate where the user accepts, retries, or discards the fix.
 * One overlay instance survives the whole episode — retries re-enter the
 * working view instead of remounting, so the frame never flickers.
 */

import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { ActivityMeter, ACTIVITY_METER_WIDTH, rateToLevel, TokRateTracker } from "../activityMeter.ts";
import type { Finding, HeadlessProgress } from "../types.ts";
import { contextCell, formatCost, formatElapsed, sanitizeTerminalText } from "./AuditProgress.ts";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, OVERLAY_MAX_HEIGHT, renderFramedBottom, renderFramedRow, renderFramedTop, wrapText } from "./menuChrome.ts";

export type FixGateDecision = "accept" | "retry" | "discard";

type FixPhase = "fixing" | "verifying" | "gate" | "accepting" | "retrying" | "discarding";

const TICK_MS = 100;
const SPIN_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** The slice of pi's `TUI` the overlay needs. Structural so tests can supply a stub. */
export interface FixProgressHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of pi's `Theme` the overlay needs. Structural so tests can supply a stub. */
export interface FixProgressTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/** What the fix flow feeds into the gate view. */
export interface FixGateInput {
  diff: string;
  /** Verifier verdict line, shown above the diff. */
  verdictNote?: string;
  /** Degradations (verifier failed, dirty files kept, …), shown as warnings. */
  warnings?: string[];
  /** False when the user opted out of auto-commit — the accept key relabels accordingly. */
  commitPlanned: boolean;
  /** Attempt number, 1-based. */
  attempt: number;
}

export class FixProgress implements Component {
  private readonly theme: FixProgressTheme;
  private readonly tui: FixProgressHost;
  private readonly finding: Finding;
  private readonly onCancelRequest: () => void;

  private phase: FixPhase = "fixing";
  private statusText = "starting…";
  private attempt = 1;
  private progress: HeadlessProgress | undefined;
  private phaseStartedAt = Date.now();
  private readonly meter = new ActivityMeter();
  private readonly tracker = new TokRateTracker();
  private meterRevision = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private spinFrame = 0;

  private gateInput: FixGateInput | undefined;
  private gateResolve: ((decision: FixGateDecision) => void) | undefined;
  private diffLines: string[] = [];
  private scrollOffset = 0;
  private awaitingCancelConfirm = false;

  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(finding: Finding, theme: FixProgressTheme, tui: FixProgressHost, onCancelRequest: () => void) {
    this.finding = finding;
    this.theme = theme;
    this.tui = tui;
    this.onCancelRequest = onCancelRequest;
    this.startTicker();
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => {
      if (this.phase === "gate") return;
      this.spinFrame = (this.spinFrame + 1) % SPIN_FRAMES.length;
      if (this.progress) {
        if (this.progress.outputRevision !== this.meterRevision) {
          this.meterRevision = this.progress.outputRevision;
          this.tracker.reset();
        }
        this.meter.push(rateToLevel(this.tracker.sample(this.progress.outputTokens, Date.now())));
      }
      this.invalidate();
      this.tui.requestRender();
    }, TICK_MS);
  }

  /** Enter (or re-enter, on retry) a working phase. */
  setPhase(phase: "fixing" | "verifying", statusText: string, attempt: number): void {
    this.phase = phase;
    this.statusText = statusText;
    this.attempt = attempt;
    this.phaseStartedAt = Date.now();
    this.gateInput = undefined;
    this.awaitingCancelConfirm = false;
    this.invalidate();
    this.tui.requestRender();
  }

  /** Fold one streamed agent-telemetry snapshot into the working view. */
  applyProgress(progress: HeadlessProgress): void {
    this.progress = progress;
    this.invalidate();
  }

  /** Show the diff gate and resolve with the user's decision. */
  gate(input: FixGateInput): Promise<FixGateDecision> {
    this.phase = "gate";
    this.gateInput = input;
    this.attempt = input.attempt;
    this.diffLines = input.diff.replace(/\r/g, "").split("\n");
    this.scrollOffset = 0;
    this.awaitingCancelConfirm = false;
    this.invalidate();
    this.tui.requestRender();
    return new Promise<FixGateDecision>((resolve) => {
      this.gateResolve = resolve;
    });
  }

  private settleGate(decision: FixGateDecision): void {
    const resolve = this.gateResolve;
    if (!resolve) return;
    this.gateResolve = undefined;
    this.phase = decision === "accept" ? "accepting" : decision === "retry" ? "retrying" : "discarding";
    this.statusText = decision === "accept"
      ? this.gateInput?.commitPlanned ? "committing changes" : "saving accepted fix"
      : decision === "retry"
        ? "reverting changes before retry"
        : "reverting changes";
    this.phaseStartedAt = Date.now();
    this.awaitingCancelConfirm = false;
    this.invalidate();
    this.tui.requestRender();
    resolve(decision);
  }

  handleInput(data: string): void {
    // A decision has already been handed back to the flow. Keep the overlay
    // visibly busy until its follow-up file operation has finished.
    if (this.phase === "accepting" || this.phase === "retrying" || this.phase === "discarding") return;
    if (matchesKey(data, Key.escape)) {
      if (!this.awaitingCancelConfirm) {
        this.awaitingCancelConfirm = true;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.awaitingCancelConfirm = false;
      if (this.phase === "gate") this.settleGate("discard");
      else this.onCancelRequest();
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.awaitingCancelConfirm) {
      this.awaitingCancelConfirm = false;
      this.invalidate();
    }

    if (this.phase !== "gate") {
      this.tui.requestRender();
      return;
    }

    if (data === "a" || data === "A") {
      this.settleGate("accept");
      return;
    }
    if (data === "r" || data === "R") {
      this.settleGate("retry");
      return;
    }
    if (data === "d" || data === "D") {
      this.settleGate("discard");
      return;
    }

    const step = matchesKey(data, Key.up) ? -1
      : matchesKey(data, Key.down) ? 1
        : matchesKey(data, Key.pageUp) ? -10
          : matchesKey(data, Key.pageDown) ? 10
            : 0;
    if (step !== 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset + step);
      this.invalidate();
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    const usable = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
    return Math.max(1, Math.floor((usable * OVERLAY_HEIGHT_PERCENT) / 100));
  }

  private findingLabel(): string {
    const f = this.finding;
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    return `${loc} · ${f.category}/${f.severity}`;
  }

  private colorDiffLine(line: string): string {
    const t = this.theme;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
      return t.fg("dim", line);
    }
    if (line.startsWith("@@")) return t.fg("accent", line);
    if (line.startsWith("+")) return t.fg("success", line);
    if (line.startsWith("-")) return t.fg("error", line);
    return t.fg("muted", line);
  }

  render(width: number): string[] {
    const viewport = this.viewportHeight();
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const inner = Math.max(0, width - 2);
    const attempt = this.attempt > 1 ? ` · attempt ${this.attempt}` : "";
    const title = `Fix Now — ${truncateToWidth(sanitizeTerminalText(this.finding.file), Math.max(4, inner - 24))}${attempt}`;

    const header = [
      renderFramedTop(t, inner, title),
      " " + t.fg("accent", truncateToWidth(sanitizeTerminalText(this.findingLabel()), Math.max(2, inner - 2))),
      ...wrapText(sanitizeTerminalText(this.finding.rationale), Math.max(2, inner - 2)).map((l) => " " + t.fg("muted", l)),
      "",
    ];

    const body = this.phase === "gate" ? this.renderGate(inner, viewport, header.length) : this.renderWorking(inner);

    const lines = [
      header[0]!,
      ...[...header.slice(1), ...body.slice(0, -1)].map((row) => renderFramedRow(t, inner, row)),
      body[body.length - 1]!,
    ];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  /** Live agent view: phase line, telemetry row, current tool activity. */
  private renderWorking(inner: number): string[] {
    const t = this.theme;
    const spin = SPIN_FRAMES[this.spinFrame % SPIN_FRAMES.length]!;
    const phaseLabel = this.phase === "fixing"
      ? "implementing fix"
      : this.phase === "verifying"
        ? "verifying fix"
        : this.phase === "accepting"
          ? "accepting fix"
          : this.phase === "retrying"
            ? "preparing retry"
            : "discarding fix";
    const settling = this.phase === "accepting" || this.phase === "retrying" || this.phase === "discarding";
    const p = settling ? undefined : this.progress;

    const stats = [
      contextCell(p?.contextTokens, undefined).trim() || "—",
      this.meter.render((level, char) => ActivityMeter.colorizeCell(level, char, t)),
      `${p?.turns ?? 0} turns`,
      `${p?.toolCalls ?? 0} tools`,
      formatCost(p?.costUsd),
      formatElapsed(Date.now() - this.phaseStartedAt),
    ].join("  ");

    const lines = [
      ` ${t.fg("accent", spin)} ${t.bold(phaseLabel)}${this.attempt > 1 ? t.fg("dim", ` (attempt ${this.attempt})`) : ""} ${t.fg("dim", "· " + this.statusText)}`,
      "",
    ];
    if (!settling) {
      lines.push(" " + stats);
      if (p?.activity) {
        lines.push(" " + t.fg("dim", truncateToWidth(`↳ ${sanitizeTerminalText(p.activity)}`, Math.max(2, inner - 2), "…")));
      }
      lines.push("");
    }
    if (settling) {
      lines.push(" " + t.fg("dim", "Please wait…"));
    } else if (this.awaitingCancelConfirm) {
      lines.push(" " + t.fg("warning", "Press Esc again to cancel this fix — clean edits will be reverted"));
    } else {
      lines.push(" " + t.fg("dim", "Esc cancel fix"));
    }
    lines.push(renderFramedBottom(t, inner));
    return lines;
  }

  /** Diff gate view: verdict, warnings, scrollable diff, decision keys. */
  private renderGate(inner: number, viewport: number, headerLines: number): string[] {
    const t = this.theme;
    const input = this.gateInput;
    const pre: string[] = [];
    if (input?.verdictNote) {
      pre.push(...wrapText(`✓ ${sanitizeTerminalText(input.verdictNote)}`, Math.max(2, inner - 2)).map((l) => " " + t.fg("success", l)));
    }
    for (const warning of input?.warnings ?? []) {
      pre.push(...wrapText(`⚠ ${sanitizeTerminalText(warning)}`, Math.max(2, inner - 2)).map((l) => " " + t.fg("warning", l)));
    }
    if (pre.length > 0) pre.push("");

    const acceptLabel = input?.commitPlanned === false ? "A accept (no commit)" : "A accept & commit";
    const keybinds = `${acceptLabel} · R retry · D discard · ↑↓/PgUp/PgDn scroll`;
    const footer: string[] = [""];
    if (this.awaitingCancelConfirm) {
      footer.push(" " + t.fg("warning", "Press Esc again to discard this fix"));
    }
    footer.push(...wrapText(keybinds, Math.max(2, inner - 2)).map((l) => " " + t.fg("dim", l)));

    const diffBudget = Math.max(1, viewport - headerLines - pre.length - footer.length - 2);
    const maxOffset = Math.max(0, this.diffLines.length - diffBudget);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const windowed = this.diffLines
      .slice(this.scrollOffset, this.scrollOffset + diffBudget)
      .map((line) => " " + this.colorDiffLine(truncateToWidth(sanitizeTerminalText(line), Math.max(2, inner - 2), "…")));
    if (this.diffLines.length === 0 || (this.diffLines.length === 1 && this.diffLines[0] === "")) {
      windowed.length = 0;
      windowed.push(" " + t.fg("dim", "No changes on disk."));
    }

    const below = this.diffLines.length - this.scrollOffset - diffBudget;
    const scrollHint = [
      this.scrollOffset > 0 ? `↑ ${this.scrollOffset} more` : "",
      below > 0 ? `↓ ${below} more` : "",
    ].filter(Boolean).join(" · ");
    if (scrollHint) windowed.push(" " + t.fg("dim", scrollHint));

    return [...pre, ...windowed, ...footer, renderFramedBottom(t, inner)];
  }
}

/** Handle the fix flow drives while the overlay stays mounted. */
export interface FixProgressController {
  setPhase(phase: "fixing" | "verifying", statusText: string, attempt: number): void;
  applyProgress(progress: HeadlessProgress): void;
  gate(input: FixGateInput): Promise<FixGateDecision>;
  /** Dismiss the overlay. Safe to call once; resolves after the host settles. */
  close(): Promise<void>;
}

/** Mount the Fix Now overlay and return the controller the flow drives. */
export function openFixProgress(
  ctx: Pick<ExtensionCommandContext, "ui">,
  finding: Finding,
  onCancelRequest: () => void,
): FixProgressController {
  let component: FixProgress | undefined;
  let doneFn: ((value: undefined) => void) | undefined;
  const shown = ctx.ui.custom<undefined>(
    (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (value: undefined) => void) => {
      doneFn = done;
      component = new FixProgress(finding, theme, tui, onCancelRequest);
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        maxHeight: OVERLAY_MAX_HEIGHT,
      },
    },
  );

  return {
    setPhase: (phase, statusText, attempt) => component?.setPhase(phase, statusText, attempt),
    applyProgress: (progress) => component?.applyProgress(progress),
    gate: (input) => {
      if (!component) return Promise.resolve("discard");
      return component.gate(input);
    },
    close: async () => {
      doneFn?.(undefined);
      await shown;
    },
  };
}
