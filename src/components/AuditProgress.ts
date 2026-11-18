/**
 * Audit progress surface: a sticky per-row table above the editor showing
 * context usage, output activity, in-flight tool calls, turn count, and
 * elapsed time, grouped by phase.
 */

import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeSource } from "@underactive/pi-topping-opentui/theme";
import {
  ActivityMeter,
  type ActivityMeterLevel,
  formatElapsedClock as formatElapsed,
  rateToLevel,
  RunClock,
  TokRateTracker,
} from "@underactive/pi-topping-primitives/activity";
import { QUADRANT_SPINNER_FRAMES as TABLE_FRAMES } from "@underactive/pi-topping-primitives/glyphs";
import { normalizeFindingText } from "../dedup.ts";
import { DEFAULT_METER_SETTINGS, type MeterSettings, type ThinkingLevel } from "../modelConfig.ts";
import type { Finding, HeadlessProgress } from "../types.ts";
import { renderOpenTuiProgress } from "./AuditProgressOpenTui.ts";
import { FULLSCREEN_WIDGET_RESERVE_ROWS, usableTerminalRows, type ViewportHost } from "./viewport.ts";
import type { ProgramStatusTerminal } from "../programStatus.ts";

export const AUDIT_PROGRESS_WIDGET_KEY = "persona-audit-progress";
const SPINNER_INTERVAL_MS = 100;

/** Visible phase groups, in render order. The 8-step workflow collapses into these four. */
export const AUDIT_PHASES = ["Review", "Triage", "Implement", "Verify"] as const;
export type AuditPhase = (typeof AUDIT_PHASES)[number];

export type RowState = "queued" | "working" | "done" | "error" | "cancelled";

/**
 * Nested Fix Now status rendered as sub-rows under the `fix now · …` row while
 * it is active: what is being fixed, which phase the flow is in, and the
 * cancel gesture. Telemetry stays on the row itself; this block carries only
 * what the row cannot. JSON-safe so it can ride `AuditProgressRow`.
 */
export interface FixNowDetail {
  category: string;
  severity: string;
  rationale: string;
  phase: "fixing" | "verifying" | "accepting" | "retrying" | "discarding";
  statusText: string;
  attempt: number;
  commitPlanned: boolean;
  awaitingCancelConfirm: boolean;
}

/**
 * Share of the terminal the table may claim. Lower than an overlay's would be:
 * this sits above the editor for the whole run and cannot be dismissed, so it
 * has to leave the transcript readable. In fullscreen it is a share of the rows
 * above pi's dock, since the table shares the dock with the editor and footer.
 */
const TABLE_HEIGHT_RATIO = 0.5;
/** The fewest rows the table is ever budgeted, however short the terminal. */
const TABLE_CHROME_ROWS = 5;

/** Format a token count as `X.XM` / `X.XK`, or raw when small. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/** Aggregate model-cost telemetry across every progress row. */
export interface TotalCost {
  costUsd: number;
  incomplete: boolean;
}

/** Sum valid non-negative row costs, marking totals partial when telemetry is unavailable or invalid. */
export function totalCost(rows: AuditProgressRow[]): TotalCost {
  let costUsd = 0;
  let incomplete = false;
  for (const row of rows) {
    if (row.costUsd === undefined || !Number.isFinite(row.costUsd) || row.costUsd < 0) {
      incomplete = true;
    } else {
      costUsd += row.costUsd;
    }
  }
  return { costUsd, incomplete };
}

/**
 * The elapsed clock (`M:SS`, minutes keep counting past 60), under the name this module's
 * importers and tests already use.
 */
export { formatElapsed };

/** Working rows animate and sample their output rate into the activity meter. */
function isActive(state: RowState): boolean {
  return state === "working";
}

function defaultStatusText(state: RowState): string {
  switch (state) {
    case "queued":
      return "queued";
    case "working":
      return "working…";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** One tracked workload in the audit table. */
export interface AuditProgressRow {
  key: string;
  phase: AuditPhase;
  label: string;
  state: RowState;
  statusText: string;
  contextTokens?: number;
  contextWindow?: number;
  activity?: string;
  elapsedMs: number;
  turns: number;
  /** Absent on entries persisted before tool-call telemetry was added. */
  toolCalls?: number;
  costUsd?: number;
  outputTokens: number;
  outputRevision: number;
  /** First row of its phase group; used by the render-only phase heading. */
  firstOfPhase: boolean;
  /** Nested Fix Now detail, present only on an active `fix now · …` row. */
  fixNowDetail?: FixNowDetail;
}

/** What the table component reads from. */
export interface AuditProgressView {
  progressRows(): AuditProgressRow[];
  /** Compact live run summary, shown in the footer. */
  footerSummary(): string;
  /** Work duration of the whole run, excluding spans blocked on a user decision. */
  totalMs(): number;
  /** Time the run sat blocked on a user decision. */
  waitingMs(): number;
  /** Whether a blocking user prompt is currently open. */
  isWaiting(): boolean;
  /** Aggregate model cost across every row, including whether the total is partial. */
  totalCost(): TotalCost;
  /** Audit scope, shown right-aligned in the title bar. */
  readonly scope: string | undefined;
  /** Short hash of the diff's base commit, shown right-aligned in the title bar after the scope. Undefined outside --diff mode. */
  readonly baseHash: string | undefined;
  /** Model assigned to each phase, for the band above the table header. */
  phaseModels(): Partial<Record<AuditPhase, string>>;
  /** Thinking level assigned to each phase, for per-phase meter coloring. */
  phaseThinking(): Partial<Record<AuditPhase, ThinkingLevel>>;
  /** The phase currently highlighted in the band; undefined highlights none (e.g. a frozen, finished run). */
  activePhase(): AuditPhase | undefined;
  /** Whether any row is still working — lets the ticker skip progressRows() while idle. */
  hasActiveRows(): boolean;
}

/** Custom entry type for the frozen transcript copy left behind on completion (see `pi.appendEntry`). */
export const AUDIT_PROGRESS_ENTRY_TYPE = "persona-audit-table";

/** JSON-serializable capture of a finished run, rendered read-only in the transcript without re-entering LLM context. */
export interface AuditProgressSnapshot {
  scope?: string;
  /** Absent on entries persisted before the title bar carried the diff base. */
  baseHash?: string;
  summary: string;
  /** Absent on entries persisted before the total-time footer existed. */
  totalMs?: number;
  /** Absent on entries persisted before the footer showed excluded user waits. */
  waitingMs?: number;
  phaseModels: Partial<Record<AuditPhase, string>>;
  /** Absent on entries persisted before per-phase meter coloring was added. */
  phaseThinking?: Partial<Record<AuditPhase, ThinkingLevel>>;
  rows: AuditProgressRow[];
  meterLevels: Record<string, ActivityMeterLevel[]>;
}

/** Resolve a model's context window from the identifiers an agent session reported. */
export type ContextWindowResolver = (provider: string | undefined, model: string | undefined) => number | undefined;

/** The slice of pi's `TUI` the table needs. Structural so tests can supply a stub. */
export interface ProgressHost extends ViewportHost {
  /** pi-tui's terminal. `setProgramStatus` is how the audit reports itself as working (see src/programStatus.ts). */
  terminal?: { rows?: number } & Partial<ProgramStatusTerminal>;
  requestRender(force?: boolean): void;
}

/** The slice of pi's `Theme` the table needs: what the OpenTUI runtime resolves its palette from. Structural so tests can supply a stub. */
export type ProgressTheme = ThemeSource;

/** The slice of pi's extension context the widget needs. Structural so tests can stub it. */
export interface AuditProgressContext {
  ui: {
    setWidget(
      key: string,
      content: ((tui: ProgressHost, theme: ProgressTheme) => AuditProgressTable) | undefined,
      options?: { placement?: WidgetPlacement },
    ): void;
  };
}

interface RowRecord {
  key: string;
  phase: AuditPhase;
  label: string;
  state: RowState;
  statusText?: string;
  contextTokens?: number;
  provider?: string;
  model?: string;
  activity?: string;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
  outputTokens?: number;
  outputRevision?: number;
  startedAt?: number;
  endedAt?: number;
  fixNowDetail?: FixNowDetail;
}

class AuditProgressClock extends RunClock {
  private waiting = false;

  override pause(): void {
    super.pause();
    this.waiting = true;
  }

  override resume(): void {
    super.resume();
    this.waiting = false;
  }

  isWaiting(): boolean {
    return this.waiting;
  }
}

export class AuditProgressWidget implements AuditProgressView {
  readonly scope: string | undefined;
  readonly baseHash: string | undefined;
  readonly clock = new AuditProgressClock();

  private readonly ctx: AuditProgressContext;
  private readonly resolveContextWindow: ContextWindowResolver;
  private readonly meter: MeterSettings;
  /** Memoizes resolveContextWindow by `${provider}\0${model}` — the registry is fixed for the session, so a full model-registry scan needn't repeat for every row on every 100ms tick. */
  private readonly contextWindowCache = new Map<string, number | undefined>();
  private readonly rows = new Map<string, RowRecord>();
  private summary = "";
  private mounted = false;
  private models: Partial<Record<AuditPhase, string>> = {};
  private thinking: Partial<Record<AuditPhase, ThinkingLevel>> = {};
  private active: AuditPhase | undefined;
  private activeRowCount = 0;
  private table: AuditProgressTable | undefined;
  private host: ProgressHost | undefined;

  constructor(
    ctx: AuditProgressContext,
    scope?: string,
    baseHash?: string,
    resolveContextWindow: ContextWindowResolver = () => undefined,
    meter: MeterSettings = DEFAULT_METER_SETTINGS,
  ) {
    this.ctx = ctx;
    this.scope = scope;
    this.baseHash = baseHash;
    this.resolveContextWindow = resolveContextWindow;
    this.meter = meter;
  }

  /** Mount the table above the editor. Safe to call multiple times. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.clock.start();
    this.ctx.ui.setWidget(
      AUDIT_PROGRESS_WIDGET_KEY,
      (tui, theme) => {
        this.host = tui;
        this.table = new AuditProgressTable(tui, theme, this, undefined, this.meter);
        return this.table;
      },
      { placement: "aboveEditor" },
    );
  }

  /**
   * The terminal of the TUI that drew the table, once pi has built it (pi does
   * so inside `mount()`). Undefined outside pi's TUI, where no table is built.
   */
  get terminal(): ProgramStatusTerminal | undefined {
    const terminal = this.host?.terminal;
    return typeof terminal?.setProgramStatus === "function" ? (terminal as ProgramStatusTerminal) : undefined;
  }

  /** Tear down the progress surface, disposing the table's ticker. Safe to call multiple times. */
  stop(): void {
    this.mounted = false;
    this.clock.stop();
    this.table = undefined;
    this.ctx.ui.setWidget(AUDIT_PROGRESS_WIDGET_KEY, undefined);
  }

  /** Register a row. Re-adding a key updates its label and phase rather than duplicating it. */
  addRow(
    phase: AuditPhase,
    key: string,
    label: string,
    init: { state?: RowState; statusText?: string } = {},
  ): void {
    const existing = this.rows.get(key);
    const state = init.state ?? "queued";
    if (existing) {
      const wasWorking = existing.state === "working";
      existing.phase = phase;
      existing.label = label;
      existing.state = state;
      existing.statusText = init.statusText ? normalizeFindingText(init.statusText) : undefined;
      if (wasWorking && state !== "working") this.activeRowCount--;
      if (!wasWorking && state === "working") this.activeRowCount++;
      return;
    }
    this.rows.set(key, {
      key,
      phase,
      label,
      state,
      statusText: init.statusText ? normalizeFindingText(init.statusText) : undefined,
      startedAt: state === "working" ? Date.now() : undefined,
      endedAt: state === "done" || state === "error" || state === "cancelled" ? Date.now() : undefined,
    });
    if (state === "working") this.activeRowCount++;
  }

  /** Move a row into `working`, starting its elapsed clock. */
  startRow(key: string, statusText?: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    const wasWorking = row.state === "working";
    const wasSettled = row.state === "done" || row.state === "error" || row.state === "cancelled";
    row.state = "working";
    row.statusText = statusText;
    if (wasSettled) {
      row.startedAt = Date.now();
      row.contextTokens = undefined;
      row.provider = undefined;
      row.model = undefined;
      row.activity = undefined;
      row.turns = undefined;
      row.toolCalls = undefined;
      row.costUsd = undefined;
      row.outputTokens = undefined;
      row.outputRevision = undefined;
    } else {
      row.startedAt ??= Date.now();
    }
    row.endedAt = undefined;
    if (!wasWorking) this.activeRowCount++;
  }

  /** Fold one streamed telemetry snapshot into a row. */
  applyProgress(key: string, progress: HeadlessProgress): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.contextTokens = progress.contextTokens;
    row.turns = progress.turns;
    row.toolCalls = progress.toolCalls;
    row.costUsd = progress.costUsd;
    row.outputTokens = progress.outputTokens;
    row.outputRevision = progress.outputRevision;
    if (progress.activity) row.activity = normalizeFindingText(progress.activity);
    if (progress.provider) row.provider = progress.provider;
    if (progress.model) row.model = progress.model;
  }

  /** Settle a row, freezing its elapsed reading. */
  settleRow(key: string, state: Exclude<RowState, "queued" | "working">, statusText?: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    const wasWorking = row.state === "working";
    row.state = state;
    row.statusText = statusText ? normalizeFindingText(statusText) : undefined;
    row.activity = undefined;
    row.fixNowDetail = undefined;
    row.endedAt ??= Date.now();
    if (wasWorking) this.activeRowCount--;
  }

  /**
   * Settle every row that never finished. Already-completed rows keep their
   * result, so a cancelled run still shows which passes actually landed.
   */
  settleOpenRows(state: Exclude<RowState, "queued" | "working">, statusText?: string): void {
    for (const row of this.rows.values()) {
      if (row.state === "queued" || row.state === "working") this.settleRow(row.key, state, statusText);
    }
  }

  /** Attach the nested Fix Now detail block to a `fix now · …` row. */
  setFixNowDetail(key: string, finding: Finding): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.fixNowDetail = {
      category: finding.category,
      severity: finding.severity,
      rationale: finding.rationale,
      phase: "fixing",
      statusText: "starting…",
      attempt: 1,
      commitPlanned: true,
      awaitingCancelConfirm: false,
    };
  }

  /** Move the nested detail into a working phase (also re-entry after a retry). */
  updateFixNowPhase(key: string, phase: "fixing" | "verifying", statusText: string, attempt: number): void {
    const detail = this.rows.get(key)?.fixNowDetail;
    if (!detail) return;
    detail.phase = phase;
    detail.statusText = statusText;
    detail.attempt = attempt;
    detail.awaitingCancelConfirm = false;
  }

  /** Move the nested detail into its post-decision settling state. */
  updateFixNowSettling(key: string, decision: "accept" | "retry" | "discard", commitPlanned: boolean): void {
    const detail = this.rows.get(key)?.fixNowDetail;
    if (!detail) return;
    detail.phase = decision === "accept" ? "accepting" : decision === "retry" ? "retrying" : "discarding";
    detail.commitPlanned = commitPlanned;
    detail.statusText = decision === "accept"
      ? commitPlanned ? "committing changes" : "saving accepted fix"
      : decision === "retry"
        ? "reverting changes before retry"
        : "reverting changes";
    detail.awaitingCancelConfirm = false;
  }

  /** Arm or disarm the double-Escape cancel hint in the nested detail. */
  setFixNowCancelArmed(key: string, armed: boolean): void {
    const detail = this.rows.get(key)?.fixNowDetail;
    if (!detail) return;
    detail.awaitingCancelConfirm = armed;
  }

  /** Remove the nested detail (the fix episode ended; the row settles right after). */
  clearFixNowDetail(key: string): void {
    const row = this.rows.get(key);
    if (row) row.fixNowDetail = undefined;
  }

  /** Replace the compact run summary rendered in the footer. */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  footerSummary(): string {
    return this.summary;
  }

  totalMs(): number {
    return this.clock.activeMs();
  }

  waitingMs(): number {
    return this.clock.waitingMs();
  }

  isWaiting(): boolean {
    return this.clock.isWaiting();
  }

  totalCost(): TotalCost {
    return totalCost(this.progressRows());
  }

  /** Assign the model shown in the phase/model band for each phase. */
  setPhaseModels(models: Partial<Record<AuditPhase, string>>): void {
    this.models = models;
  }

  phaseModels(): Partial<Record<AuditPhase, string>> {
    return this.models;
  }

  /** Assign the thinking level used to color each phase's activity meter. */
  setPhaseThinking(thinking: Partial<Record<AuditPhase, ThinkingLevel>>): void {
    this.thinking = thinking;
  }

  phaseThinking(): Partial<Record<AuditPhase, ThinkingLevel>> {
    return this.thinking;
  }

  /** Mark which phase is highlighted in the band. Undefined highlights none. */
  setActivePhase(phase: AuditPhase | undefined): void {
    this.active = phase;
  }

  activePhase(): AuditPhase | undefined {
    return this.active;
  }

  hasActiveRows(): boolean {
    return this.activeRowCount > 0;
  }

  /** Capture a JSON-serializable copy of the current view for transcript persistence. Must be called before `stop()`, which drops the table and its meter traces. */
  snapshot(): AuditProgressSnapshot {
    return {
      scope: this.scope,
      baseHash: this.baseHash,
      summary: this.summary,
      totalMs: this.totalMs(),
      waitingMs: this.waitingMs(),
      phaseModels: this.models,
      phaseThinking: this.thinking,
      // Live fix-now detail (cancel hints, settling states) is transient UI
      // state, not run history — never freeze it into the transcript.
      rows: this.progressRows().map((row) => ({ ...row, fixNowDetail: undefined })),
      meterLevels: this.table?.meterLevels() ?? {},
    };
  }

  private resolvedContextWindow(provider: string | undefined, model: string | undefined): number | undefined {
    const key = `${provider}\0${model}`;
    if (this.contextWindowCache.has(key)) return this.contextWindowCache.get(key);
    const resolved = this.resolveContextWindow(provider, model);
    this.contextWindowCache.set(key, resolved);
    return resolved;
  }

  progressRows(): AuditProgressRow[] {
    const now = Date.now();
    const ordered = [...this.rows.values()].sort(
      (a, b) => AUDIT_PHASES.indexOf(a.phase) - AUDIT_PHASES.indexOf(b.phase),
    );
    return ordered.map((row, index) => ({
      key: row.key,
      phase: row.phase,
      label: row.label,
      state: row.state,
      statusText: row.statusText ?? defaultStatusText(row.state),
      contextTokens: row.contextTokens,
      contextWindow: this.resolvedContextWindow(row.provider, row.model),
      activity: row.activity,
      elapsedMs: row.startedAt === undefined ? 0 : this.clock.workedBetween(row.startedAt, row.endedAt ?? now),
      turns: row.turns ?? 0,
      toolCalls: row.toolCalls ?? 0,
      costUsd: row.costUsd,
      outputTokens: row.outputTokens ?? 0,
      outputRevision: row.outputRevision ?? 0,
      firstOfPhase: ordered[index - 1]?.phase !== row.phase,
      fixNowDetail: row.fixNowDetail ? { ...row.fixNowDetail } : undefined,
    }));
  }
}

interface RowMeter {
  meter: ActivityMeter;
  tracker: TokRateTracker;
  revision: number;
}

/**
 * The docked table, drawn by the generated `ProgressTable` (`./AuditProgressOpenTui.ts`). This
 * component owns what the drawing cannot: the ticker that animates working rows and samples
 * their output rate into the activity meters, the settled traces a frozen copy is seeded with,
 * and the row budget that keeps the table from crowding out the editor.
 */
export class AuditProgressTable implements Component {
  private readonly tui: ProgressHost;
  private readonly theme: ProgressTheme;
  private readonly view: AuditProgressView;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly meters = new Map<string, RowMeter>();
  private readonly meterSettings: MeterSettings;
  private readonly frozen: boolean;
  private spinFrame = 0;

  /** `frozenMeters`, when given, seeds settled traces and skips the ticker entirely — used for the read-only transcript copy. */
  constructor(
    tui: ProgressHost,
    theme: ProgressTheme,
    view: AuditProgressView,
    frozenMeters?: Record<string, ActivityMeterLevel[]>,
    meterSettings: MeterSettings = DEFAULT_METER_SETTINGS,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.view = view;
    this.meterSettings = meterSettings;
    this.frozen = frozenMeters !== undefined;
    if (frozenMeters !== undefined) {
      for (const row of view.progressRows()) {
        const levels = frozenMeters[row.key];
        if (!levels) continue;
        const meter = new ActivityMeter({ direction: meterSettings.direction });
        meter.setLevels(levels);
        this.meters.set(row.key, { meter, tracker: new TokRateTracker(), revision: row.outputRevision });
      }
      this.timer = undefined;
    } else {
      // One timer drives spinner animation, meter sampling and repaint, so the
      // meter's 100ms cadence matches the reference widget's.
      this.timer = setInterval(() => {
        if (!this.view.hasActiveRows()) return;
        this.spinFrame = (this.spinFrame + 1) % TABLE_FRAMES.length;
        const rows = this.view.progressRows();
        this.sampleMeters(rows, Date.now());
        this.tui.requestRender();
      }, SPINNER_INTERVAL_MS);
    }
  }

  /** Snapshot every row's current activity trace, for a frozen transcript copy. */
  meterLevels(): Record<string, ActivityMeterLevel[]> {
    const result: Record<string, ActivityMeterLevel[]> = {};
    for (const [key, entry] of this.meters) {
      result[key] = entry.meter.levels();
    }
    return result;
  }

  private sampleMeters(rows: AuditProgressRow[], now: number): void {
    for (const row of rows) {
      let entry = this.meters.get(row.key);
      if (!entry) {
        entry = { meter: new ActivityMeter({ direction: this.meterSettings.direction }), tracker: new TokRateTracker(), revision: row.outputRevision };
        this.meters.set(row.key, entry);
      }
      if (entry.revision !== row.outputRevision) {
        entry.revision = row.outputRevision;
        entry.tracker.reset();
      }
      // Settled rows keep their final trace instead of decaying to idle.
      if (!isActive(row.state)) continue;
      entry.meter.push(rateToLevel(entry.tracker.sample(row.outputTokens, now)));
    }
  }

  /**
   * How many lines the table may use, so it never crowds out the editor below
   * it. In fullscreen the ratio applies to the rows above pi's dock, since the
   * table sits inside that dock with the editor and footer. An unknown height
   * means no budget, which the frozen snapshot relies on.
   */
  private rowBudget(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    if (rows <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(TABLE_CHROME_ROWS, Math.floor(usableTerminalRows(this.tui, FULLSCREEN_WIDGET_RESERVE_ROWS) * TABLE_HEIGHT_RATIO));
  }

  render(width: number): string[] {
    return renderOpenTuiProgress({
      view: this.view,
      width,
      maxRows: this.rowBudget(),
      frozen: this.frozen,
      spin: this.spinFrame,
      meterColor: this.meterSettings.color,
      meterDirection: this.meterSettings.direction,
      meterLevels: this.meterLevels(),
      theme: this.theme,
    });
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Redraw a settled run from a persisted `AuditProgressSnapshot` — the frozen,
 * read-only transcript copy left behind on completion (see
 * `AUDIT_PROGRESS_ENTRY_TYPE`). Reuses the live render path so the two views
 * cannot drift, over a stub host with no terminal so the copy is never
 * row-clipped, and with no active phase so nothing in a finished run stays
 * highlighted.
 */
export function renderAuditSnapshot(
  snapshot: AuditProgressSnapshot,
  theme: ProgressTheme,
  meter: MeterSettings = DEFAULT_METER_SETTINGS,
): Component {
  const host: ProgressHost = { requestRender: () => {} };
  const view: AuditProgressView = {
    progressRows: () => snapshot.rows,
    footerSummary: () => snapshot.summary,
    totalMs: () => snapshot.totalMs ?? 0,
    waitingMs: () => snapshot.waitingMs ?? 0,
    isWaiting: () => false,
    totalCost: () => totalCost(snapshot.rows),
    scope: snapshot.scope,
    baseHash: snapshot.baseHash,
    phaseModels: () => snapshot.phaseModels,
    phaseThinking: () => snapshot.phaseThinking ?? {},
    activePhase: () => undefined,
    hasActiveRows: () => false,
  };
  return new AuditProgressTable(host, theme, view, snapshot.meterLevels, meter);
}
