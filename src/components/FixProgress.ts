/**
 * Fix Now surfaces, split by lifecycle responsibility. Working and settling
 * status lives in the audit table as nested detail under the `fix now · …`
 * row (via the sink below) — it is not a prompt, so Pi must not bracket it as
 * a user wait. Each accept/retry/discard decision opens one fresh centered
 * overlay (FixGate) through ctx.ui.custom with overlay: true — the only
 * lifecycle prompt here. The gate calls done the moment the user decides,
 * ending the prompt span before retry/discard cleanup, commit summarization,
 * or commit work begins.
 */

import type { Component, KeybindingsManager, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { TerminalInputHandler, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AuditProgressWidget } from "./AuditProgress.ts";
import type { Finding, HeadlessProgress } from "../types.ts";
import { sanitizeTerminalText } from "./AuditProgress.ts";
import { FALLBACK_TERMINAL_ROWS, OVERLAY_HEIGHT_PERCENT, PROMPT_OVERLAY_OPTIONS, renderFramedBottom, renderFramedRow, renderFramedTop, wrapText } from "./menuChrome.ts";

export type FixGateDecision = "accept" | "retry" | "discard";

/** The slice of pi's `TUI` the surfaces need. Structural so tests can supply a stub. */
export interface FixProgressHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of pi's `Theme` the surfaces need. Structural so tests can supply a stub. */
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

// ── Shared gate helpers ────────────────────────────────────────────────────
// The gate overlay's frame, header, and diff coloring, factored so the gate
// body and its tests share one implementation.

/** "file:line · category/severity" label shown under the frame title. */
function findingLabel(finding: Finding): string {
  const loc = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return `${loc} · ${finding.category}/${finding.severity}`;
}

/** Diff-line coloring: headers dim, hunks accent, additions green, removals red. */
function colorDiffLine(theme: FixProgressTheme, line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) {
    return theme.fg("dim", line);
  }
  if (line.startsWith("@@")) return theme.fg("accent", line);
  if (line.startsWith("+")) return theme.fg("success", line);
  if (line.startsWith("-")) return theme.fg("error", line);
  return theme.fg("muted", line);
}

/** Content viewport: 75% of the terminal, mirroring the overlay's maxHeight. */
function viewportHeight(tui: FixProgressHost): number {
  const rows = tui.terminal?.rows ?? 0;
  const usable = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
  return Math.max(1, Math.floor((usable * OVERLAY_HEIGHT_PERCENT) / 100));
}

/** Frame title, finding label, and rationale — identical on both surfaces. */
function renderFixHeader(theme: FixProgressTheme, finding: Finding, inner: number, attempt: number): string[] {
  const attemptLabel = attempt > 1 ? ` · attempt ${attempt}` : "";
  const title = `Fix Now — ${truncateToWidth(sanitizeTerminalText(finding.file), Math.max(4, inner - 24))}${attemptLabel}`;
  return [
    renderFramedTop(theme, inner, title),
    " " + theme.fg("accent", truncateToWidth(sanitizeTerminalText(findingLabel(finding)), Math.max(2, inner - 2))),
    ...wrapText(sanitizeTerminalText(finding.rationale), Math.max(2, inner - 2)).map((l) => " " + theme.fg("muted", l)),
    "",
  ];
}

/** Wrap header + body in the frame's side borders; the body's last row is the bottom border. */
function assembleFixFrame(theme: FixProgressTheme, inner: number, header: string[], body: string[]): string[] {
  return [
    header[0]!,
    ...[...header.slice(1), ...body.slice(0, -1)].map((row) => renderFramedRow(theme, inner, row)),
    body[body.length - 1]!,
  ];
}

// ── FixGate: one decision overlay per gate ─────────────────────────────────

/**
 * The accept/retry/discard decision view: verdict, warnings, a scrollable
 * diff, and the decision keys. A fresh instance is constructed for every
 * gate — ctx.ui.custom disposes the component when the overlay closes, so a
 * retry must never reuse one. A/R/D and the second Escape call done
 * immediately, ending the prompt lifecycle span before the flow's follow-up
 * work begins.
 */
export class FixGate implements Component {
  private readonly theme: FixProgressTheme;
  private readonly tui: FixProgressHost;
  private readonly finding: Finding;
  private readonly input: FixGateInput;
  private readonly done: (decision: FixGateDecision) => void;

  private readonly diffLines: string[];
  private scrollOffset = 0;
  private awaitingDiscardConfirm = false;
  private settled = false;

  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    finding: Finding,
    input: FixGateInput,
    theme: FixProgressTheme,
    tui: FixProgressHost,
    done: (decision: FixGateDecision) => void,
  ) {
    this.finding = finding;
    this.input = input;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.diffLines = input.diff.replace(/\r/g, "").split("\n");
  }

  private decide(decision: FixGateDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.done(decision);
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesKey(data, Key.escape)) {
      if (!this.awaitingDiscardConfirm) {
        this.awaitingDiscardConfirm = true;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      this.decide("discard");
      return;
    }
    // Any other input disarms a pending discard confirmation.
    if (this.awaitingDiscardConfirm) {
      this.awaitingDiscardConfirm = false;
      this.invalidate();
    }

    if (data === "a" || data === "A") {
      this.decide("accept");
      return;
    }
    if (data === "r" || data === "R") {
      this.decide("retry");
      return;
    }
    if (data === "d" || data === "D") {
      this.decide("discard");
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

  render(width: number): string[] {
    const viewport = viewportHeight(this.tui);
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const inner = Math.max(0, width - 2);
    const header = renderFixHeader(this.theme, this.finding, inner, this.input.attempt);
    const body = this.renderGateBody(inner, viewport, header.length);
    const lines = assembleFixFrame(this.theme, inner, header, body);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  /** Gate body: verdict, warnings, scrollable diff, decision keys. */
  private renderGateBody(inner: number, viewport: number, headerLines: number): string[] {
    const t = this.theme;
    const input = this.input;
    const pre: string[] = [];
    if (input.verdictNote) {
      pre.push(...wrapText(`✓ ${sanitizeTerminalText(input.verdictNote)}`, Math.max(2, inner - 2)).map((l) => " " + t.fg("success", l)));
    }
    for (const warning of input.warnings ?? []) {
      pre.push(...wrapText(`⚠ ${sanitizeTerminalText(warning)}`, Math.max(2, inner - 2)).map((l) => " " + t.fg("warning", l)));
    }
    if (pre.length > 0) pre.push("");

    const acceptLabel = input.commitPlanned === false ? "A accept (no commit)" : "A accept & commit";
    const keybinds = `${acceptLabel} · R retry · D discard · ↑↓/PgUp/PgDn scroll`;
    const footer: string[] = [""];
    if (this.awaitingDiscardConfirm) {
      footer.push(" " + t.fg("warning", "Press Esc again to discard this fix"));
    }
    footer.push(...wrapText(keybinds, Math.max(2, inner - 2)).map((l) => " " + t.fg("dim", l)));

    const diffBudget = Math.max(1, viewport - headerLines - pre.length - footer.length - 2);
    const maxOffset = Math.max(0, this.diffLines.length - diffBudget);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const windowed = this.diffLines
      .slice(this.scrollOffset, this.scrollOffset + diffBudget)
      .map((line) => " " + colorDiffLine(t, truncateToWidth(sanitizeTerminalText(line), Math.max(2, inner - 2), "…")));
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

// ── Controller ─────────────────────────────────────────────────────────────

/** Handle the fix flow drives for the life of one fix episode. */
export interface FixProgressController {
  setPhase(phase: "fixing" | "verifying", statusText: string, attempt: number): void;
  applyProgress(progress: HeadlessProgress): void;
  gate(input: FixGateInput): Promise<FixGateDecision>;
  /** Settle any open gate as discard, remove the listener and row detail. Idempotent. */
  close(): Promise<void>;
}

/**
 * The slice of pi's extension `ui` openFixProgress needs: one raw input
 * listener for the double-Escape cancel gesture and focused custom overlays
 * for the decision gates. Structural so tests can supply a stub.
 */
export interface FixProgressUi {
  onTerminalInput(handler: TerminalInputHandler): () => void;
  custom<T>(
    factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
    options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
  ): Promise<T>;
}

/** Where working/settling status goes: nested detail on the audit table's fix-now row. */
export interface FixProgressSink {
  key: string;
  progress: AuditProgressWidget;
}

/**
 * Open a Fix Now episode and return the controller the flow drives. There is
 * no separate widget: the audit table row named by `sink` carries the
 * telemetry (via applyProgress) and the nested working/settling detail, so
 * custom() — and therefore a prompt lifecycle span — happens only inside
 * gate(). Pi owns focus, disposal, keyboard dispatch, and Kitty key-release
 * filtering for the gate overlay; the raw working listener below is
 * unfocused, so it keeps its own release guard.
 */
export function openFixProgress(
  ctx: { ui: FixProgressUi },
  finding: Finding,
  onCancelRequest: () => void,
  sink?: FixProgressSink,
): FixProgressController {
  let closed = false;
  /** True while a gate overlay owns keyboard focus. */
  let gateActive = false;
  /** True once a decision is handed back — the follow-up file work is inert to input. */
  let settling = false;
  let cancelArmed = false;
  /** The open gate's done callback — lets close() settle it as discard. */
  let settleGate: ((decision: FixGateDecision) => void) | undefined;

  sink?.progress.setFixNowDetail(sink.key, finding);

  const setArmed = (armed: boolean): void => {
    if (cancelArmed === armed) return;
    cancelArmed = armed;
    sink?.progress.setFixNowCancelArmed(sink.key, armed);
  };

  // Raw, unfocused listener for the working surface. It consumes only Escape
  // (the double-press cancel gesture) and swallows Kitty release events so one
  // physical keypress cannot arm-and-cancel in a single motion. Everything
  // else passes through to the editor/host untouched — and disarms a pending
  // cancel confirmation on its way. While a gate overlay is open, input is
  // left alone: the focused overlay owns it.
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (closed || gateActive) return undefined;
    if (isKeyRelease(data)) return { consume: true };
    if (!matchesKey(data, Key.escape)) {
      if (cancelArmed) setArmed(false);
      return undefined;
    }
    // A decision is already with the flow; keep Escape inert while its
    // follow-up file operation finishes.
    if (settling) return { consume: true };
    if (!cancelArmed) {
      setArmed(true);
      return { consume: true };
    }
    setArmed(false);
    onCancelRequest();
    return { consume: true };
  });

  return {
    setPhase: (phase, statusText, attempt) => {
      if (closed) return;
      settling = false;
      setArmed(false);
      sink?.progress.updateFixNowPhase(sink.key, phase, statusText, attempt);
    },
    applyProgress: (progress) => {
      if (closed) return;
      sink?.progress.applyProgress(sink.key, progress);
    },
    gate: (input) => {
      if (closed) return Promise.resolve("discard" as const);
      gateActive = true;
      const shown = ctx.ui.custom<FixGateDecision>(
        (tui, theme, _kb, done) => {
          settleGate = done;
          return new FixGate(finding, input, theme, tui, done);
        },
        PROMPT_OVERLAY_OPTIONS,
      );
      return shown
        .then((decision) => {
          if (!closed) {
            settling = true;
            setArmed(false);
            sink?.progress.updateFixNowSettling(sink.key, decision, input.commitPlanned);
          }
          return decision;
        })
        .finally(() => {
          gateActive = false;
          settleGate = undefined;
        });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // Settle any still-open gate as discard so its overlay resolves instead
      // of leaking; the flow treats it as an ordinary discard decision.
      settleGate?.("discard");
      settleGate = undefined;
      unsubscribe();
      sink?.progress.clearFixNowDetail(sink.key);
    },
  };
}
