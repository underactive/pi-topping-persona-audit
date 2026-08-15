/**
 * Audit progress surface.
 *
 * The whole run reports into ONE sticky widget above the editor: a compact
 * table carrying, per tracked workload, live context usage, a generated-output
 * activity meter, the tool call in flight, turn count and elapsed time. Rows
 * are grouped into the four phases the user sees — Review, Triage, Implement,
 * Verify — with the phase name rendered once per group on the row that also
 * carries the phase's tree connector (├ / └), status icons leading each
 * label, and branch continuations (│) on the rows beneath.
 *
 * Ported from pi-moa-plan's `src/moaProgressWidget.ts`; the meter cadence,
 * column-shedding order and half-screen row budget are load-bearing for visual
 * parity, so port changes upstream rather than tuning them here.
 *
 * Widgets never take keyboard focus; this one handles no input at all.
 * The picker widgets read the terminal directly, and FindingsReview/ReportViewer
 * are focus-taking overlays.
 */

import type { ThemeColor, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  ACTIVITY_METER_WIDTH,
  ActivityMeter,
  rateToLevel,
  TokRateTracker,
  type ActivityMeterLevel,
} from "../activityMeter.ts";
import { normalizeFindingText } from "../dedup.ts";
import { DEFAULT_METER_SETTINGS, type MeterSettings } from "../modelConfig.ts";
import { shimmerString, type ShimmerTheme } from "../shimmer.ts";
import type { HeadlessProgress } from "../types.ts";

export const AUDIT_PROGRESS_WIDGET_KEY = "persona-audit-progress";
const SPINNER_INTERVAL_MS = 100;

/** Visible phase groups, in render order. The 8-step workflow collapses into these four. */
export const AUDIT_PHASES = ["Review", "Triage", "Implement", "Verify"] as const;
export type AuditPhase = (typeof AUDIT_PHASES)[number];

export type RowState = "queued" | "working" | "done" | "error" | "cancelled";

const TABLE_TITLE = "Persona-audit";
/** Shortest rule run allowed between the title and the scope before the scope is dropped. */
const MIN_TITLE_SCOPE_GAP = 2;
/** Shortest gap allowed between the footer summary and the total before the total moves to its own line. */
const MIN_FOOTER_TOTAL_GAP = 2;
/**
 * Share of the terminal the table may claim. Lower than an overlay's would be:
 * this sits above the editor for the whole run and cannot be dismissed, so it
 * has to leave the transcript readable.
 */
const TABLE_HEIGHT_RATIO = 0.5;
const TABLE_FRAMES = ["◐", "◓", "◑", "◒"] as const;
/** Border, header, separator, footer and bottom border — the rows a table always costs. */
const TABLE_CHROME_ROWS = 5;
/** Two band text lines plus their separator rule — the extra rows the phase/model band costs when shown. */
const PHASE_BAND_ROWS = 3;
/** Narrowest a band column may get before its centered label becomes unreadable; below this the band is dropped. */
const PHASE_BAND_MIN_COL = 12;
/**
 * The two halves of the tall right-chevron drawn between phase columns: a "\"
 * powerline diagonal (U+E0B9) on the name row stacked over a "/" (U+E0BB) on
 * the model row. Needs a Powerline/Nerd Font to render; plainer fonts show tofu.
 */
const PHASE_SEP_TOP = "\u{E0B9}";
const PHASE_SEP_BOTTOM = "\u{E0BB}";

const COLUMN_GAP = 2;
const STATUS_COL_WIDTH = 2;
const CTX_COL_WIDTH = 14;
const ELAPSED_COL_WIDTH = 6;
const TURNS_COL_WIDTH = 5;
/** Width of the "├ " / "│ " / "└ " tree connector that leads each phase group. */
const BRANCH_COL_WIDTH = 2;
const LABEL_COL_MIN = 8;
/** Label width below which reviewer names stop being distinguishable from their siblings. */
const LABEL_COL_READABLE = 24;
const ACTIVITY_COL_MIN = 10;

/** Widest phase name plus a trailing space, so the branch column starts clear of it. */
function phaseColumnWidth(): number {
  return AUDIT_PHASES.reduce((max, phase) => Math.max(max, phase.length), 0) + 1;
}

/** Format a token count as `X.XM` / `X.XK`, or raw when small. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/**
 * Context usage as a right-aligned `${pct}/${window}`. When the context window
 * cannot be resolved, shows the raw token count instead of a percentage that
 * would be guesswork.
 */
export function contextCell(contextTokens: number | undefined, contextWindow: number | undefined): string {
  const used = contextTokens && contextTokens > 0 ? contextTokens : 0;
  if (!contextWindow || contextWindow <= 0) {
    return (used > 0 ? `${formatTokens(used)} tok` : "—").padStart(CTX_COL_WIDTH);
  }
  const ratio = Math.max(0, Math.min(1, used / contextWindow));
  return `${(ratio * 100).toFixed(1)}%/${formatTokens(contextWindow)}`.padStart(CTX_COL_WIDTH);
}

/** Elapsed time as `M:SS`. Minutes keep counting past 60 rather than rolling into an hours field. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** Working rows animate, render bright, and may carry a tool-activity sub-row. */
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
  outputTokens: number;
  outputRevision: number;
  /** First row of its phase group — the only one that prints the phase name and its tree connector. */
  firstOfPhase: boolean;
  /** Last row of its phase group. */
  lastOfPhase: boolean;
}

/** What the table component reads from. */
export interface AuditProgressView {
  progressRows(): AuditProgressRow[];
  /** Compact live run summary, shown in the footer. */
  footerSummary(): string;
  /** Wall-clock duration of the whole run, shown at the footer's right edge. */
  totalMs(): number;
  /** Audit scope, shown right-aligned in the title bar. */
  readonly scope: string | undefined;
  /** Model assigned to each phase, for the band above the table header. */
  phaseModels(): Partial<Record<AuditPhase, string>>;
  /** The phase currently highlighted in the band; undefined highlights none (e.g. a frozen, finished run). */
  activePhase(): AuditPhase | undefined;
}

/** Custom entry type for the frozen transcript copy left behind on completion (see `pi.appendEntry`). */
export const AUDIT_PROGRESS_ENTRY_TYPE = "persona-audit-table";

/** JSON-serializable capture of a finished run, rendered read-only in the transcript without re-entering LLM context. */
export interface AuditProgressSnapshot {
  scope?: string;
  summary: string;
  /** Absent on entries persisted before the total-time footer existed. */
  totalMs?: number;
  phaseModels: Partial<Record<AuditPhase, string>>;
  rows: AuditProgressRow[];
  meterLevels: Record<string, ActivityMeterLevel[]>;
}

/** Resolve a model's context window from the identifiers an agent session reported. */
export type ContextWindowResolver = (provider: string | undefined, model: string | undefined) => number | undefined;

/** The slice of pi's `TUI` the table needs. Structural so tests can supply a stub. */
export interface ProgressHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number };
}

/** The slice of pi's `Theme` the table needs. Structural so tests can supply a stub. */
export interface ProgressTheme {
  fg(color: ThemeColor, text: string): string;
  /** 24-bit ANSI escape for a color, used to shimmer the active phase in the band. Optional so structural test stubs need not implement it; the active phase falls back to its flat highlighted tone when absent. */
  getFgAnsi?(color: ThemeColor): string;
}

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
  outputTokens?: number;
  outputRevision?: number;
  startedAt?: number;
  endedAt?: number;
}

export class AuditProgressWidget implements AuditProgressView {
  readonly scope: string | undefined;

  private readonly ctx: AuditProgressContext;
  private readonly resolveContextWindow: ContextWindowResolver;
  private readonly meter: MeterSettings;
  /** Memoizes resolveContextWindow by `${provider}\0${model}` — the registry is fixed for the session, so a full model-registry scan needn't repeat for every row on every 100ms tick. */
  private readonly contextWindowCache = new Map<string, number | undefined>();
  private readonly rows = new Map<string, RowRecord>();
  private summary = "";
  private mounted = false;
  private models: Partial<Record<AuditPhase, string>> = {};
  private active: AuditPhase | undefined;
  private table: AuditProgressTable | undefined;
  private runStartedAt: number | undefined;
  private runEndedAt: number | undefined;

  constructor(
    ctx: AuditProgressContext,
    scope?: string,
    resolveContextWindow: ContextWindowResolver = () => undefined,
    meter: MeterSettings = DEFAULT_METER_SETTINGS,
  ) {
    this.ctx = ctx;
    this.scope = scope;
    this.resolveContextWindow = resolveContextWindow;
    this.meter = meter;
  }

  /** Mount the table above the editor. Safe to call multiple times. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.runStartedAt ??= Date.now();
    this.ctx.ui.setWidget(
      AUDIT_PROGRESS_WIDGET_KEY,
      (tui, theme) => {
        this.table = new AuditProgressTable(tui, theme, this, undefined, this.meter);
        return this.table;
      },
      { placement: "aboveEditor" },
    );
  }

  /** Tear down the progress surface, disposing the table's ticker. Safe to call multiple times. */
  stop(): void {
    this.mounted = false;
    this.runEndedAt ??= Date.now();
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
      existing.phase = phase;
      existing.label = label;
      existing.state = state;
      existing.statusText = init.statusText ? normalizeFindingText(init.statusText) : undefined;
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
  }

  /** Move a row into `working`, starting its elapsed clock. */
  startRow(key: string, statusText?: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.state = "working";
    row.statusText = statusText;
    row.startedAt ??= Date.now();
    row.endedAt = undefined;
  }

  /** Fold one streamed telemetry snapshot into a row. */
  applyProgress(key: string, progress: HeadlessProgress): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.contextTokens = progress.contextTokens;
    row.turns = progress.turns;
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
    row.state = state;
    row.statusText = statusText ? normalizeFindingText(statusText) : undefined;
    row.activity = undefined;
    row.endedAt ??= Date.now();
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

  /** Replace the compact run summary rendered in the footer. */
  setSummary(summary: string): void {
    this.summary = summary;
  }

  footerSummary(): string {
    return this.summary;
  }

  totalMs(): number {
    if (this.runStartedAt === undefined) return 0;
    return (this.runEndedAt ?? Date.now()) - this.runStartedAt;
  }

  /** Assign the model shown in the phase/model band for each phase. */
  setPhaseModels(models: Partial<Record<AuditPhase, string>>): void {
    this.models = models;
  }

  phaseModels(): Partial<Record<AuditPhase, string>> {
    return this.models;
  }

  /** Mark which phase is highlighted in the band. Undefined highlights none. */
  setActivePhase(phase: AuditPhase | undefined): void {
    this.active = phase;
  }

  activePhase(): AuditPhase | undefined {
    return this.active;
  }

  /** Capture a JSON-serializable copy of the current view for transcript persistence. Must be called before `stop()`, which drops the table and its meter traces. */
  snapshot(): AuditProgressSnapshot {
    return {
      scope: this.scope,
      summary: this.summary,
      totalMs: this.totalMs(),
      phaseModels: this.models,
      rows: this.progressRows(),
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
      elapsedMs: row.startedAt === undefined ? 0 : (row.endedAt ?? now) - row.startedAt,
      turns: row.turns ?? 0,
      outputTokens: row.outputTokens ?? 0,
      outputRevision: row.outputRevision ?? 0,
      firstOfPhase: ordered[index - 1]?.phase !== row.phase,
      lastOfPhase: ordered[index + 1]?.phase !== row.phase,
    }));
  }
}

/**
 * Folds the Review phase down when the table outgrows its row budget. Review is
 * the only phase that scales with the reviewer × pass matrix, so a large run
 * buries the live work under hundreds of settled and queued rows. Done and
 * queued passes collapse into one summary row each; working, failed and
 * cancelled passes are always kept, so nothing in flight or broken is hidden.
 *
 * Render-only — `progressRows()` and `snapshot()` keep the full list, which is
 * what leaves frozen transcripts complete.
 */
export function collapseReviewRows(rows: AuditProgressRow[], maxBaseRows: number): AuditProgressRow[] {
  if (rows.length <= maxBaseRows) return rows;

  const start = rows.findIndex((row) => row.phase === "Review");
  if (start < 0) return rows;
  // progressRows() sorts by phase, so the Review rows are one contiguous block.
  const review = rows.filter((row) => row.phase === "Review");

  let done = 0;
  let queued = 0;
  const unfoldable: AuditProgressRow[] = [];
  for (const row of review) {
    if (row.state === "done") done++;
    else if (row.state === "queued") queued++;
    else unfoldable.push(row);
  }
  if (done + queued === 0) return rows;

  const folded = [
    ...(done > 0 ? [reviewSummaryRow("done", `${done} ${done === 1 ? "pass" : "passes"} done`)] : []),
    ...unfoldable,
    ...(queued > 0 ? [reviewSummaryRow("queued", `${queued} queued`)] : []),
  ];
  const collapsed = [...rows.slice(0, start), ...folded, ...rows.slice(start + review.length)];
  return collapsed.map((row, index) => ({
    ...row,
    firstOfPhase: collapsed[index - 1]?.phase !== row.phase,
    lastOfPhase: collapsed[index + 1]?.phase !== row.phase,
  }));
}

/** An aggregate stand-in for folded passes. Its key has no meter, so it draws the idle trace. */
function reviewSummaryRow(state: "done" | "queued", label: string): AuditProgressRow {
  return {
    key: `review:summary:${state}`,
    phase: "Review",
    label,
    state,
    statusText: defaultStatusText(state),
    elapsedMs: 0,
    turns: 0,
    outputTokens: 0,
    outputRevision: 0,
    firstOfPhase: false,
    lastOfPhase: false,
  };
}

/** Column widths for the table, shedding columns as the terminal narrows. */
export function tableColumns(
  bodyWidth: number,
  labels: string[],
): { label: number; activity: number; stats: boolean } {
  const fixed =
    STATUS_COL_WIDTH +
    phaseColumnWidth() +
    BRANCH_COL_WIDTH +
    COLUMN_GAP +
    CTX_COL_WIDTH +
    COLUMN_GAP +
    ACTIVITY_METER_WIDTH +
    COLUMN_GAP;
  const statsWidth = ELAPSED_COL_WIDTH + COLUMN_GAP + TURNS_COL_WIDTH + COLUMN_GAP;
  // Elapsed and turns go first on a narrow terminal: they are ambient readings,
  // and are not worth truncating the row label down to an unreadable stub.
  const stats = bodyWidth - fixed - statsWidth >= LABEL_COL_READABLE + ACTIVITY_COL_MIN;
  const available = bodyWidth - fixed - (stats ? statsWidth : 0);
  if (available < LABEL_COL_MIN) return { label: Math.max(1, available), activity: 0, stats };

  const widest = labels.reduce((max, label) => Math.max(max, visibleWidth(label)), 0);
  const label = Math.min(Math.max(LABEL_COL_MIN, widest), Math.max(LABEL_COL_MIN, available - ACTIVITY_COL_MIN));
  return { label, activity: available - label, stats };
}

/** Pad or truncate a possibly-ANSI-colored cell to exactly `width` columns. */
function cell(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
  if (width <= 0) return "";
  const shown = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
  const padding = Math.max(0, width - visibleWidth(shown));
  if (align === "right") return " ".repeat(padding) + shown;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + shown + " ".repeat(padding - left);
  }
  return shown + " ".repeat(padding);
}

/** Shorten a `provider/id` model label (or a bare frontmatter id) to its id, for the space-constrained band. */
function shortModelId(label: string | undefined): string {
  if (!label) return "default";
  const idx = label.lastIndexOf("/");
  return idx === -1 ? label : label.slice(idx + 1);
}

interface RowMeter {
  meter: ActivityMeter;
  tracker: TokRateTracker;
  revision: number;
}

export class AuditProgressTable implements Component {
  private readonly tui: ProgressHost;
  private readonly theme: ProgressTheme;
  private readonly view: AuditProgressView;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private readonly meters = new Map<string, RowMeter>();
  private readonly meterSettings: MeterSettings;
  private readonly createdAt = Date.now();
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
    if (frozenMeters) {
      for (const row of view.progressRows()) {
        const levels = frozenMeters[row.key];
        if (!levels) continue;
        const meter = new ActivityMeter(meterSettings.direction);
        meter.setLevels(levels);
        this.meters.set(row.key, { meter, tracker: new TokRateTracker(), revision: row.outputRevision });
      }
      this.timer = undefined;
    } else {
      // One timer drives spinner animation, meter sampling and repaint, so the
      // meter's 100ms cadence matches the reference widget's.
      this.timer = setInterval(() => {
        this.spinFrame = (this.spinFrame + 1) % TABLE_FRAMES.length;
        const rows = this.view.progressRows();
        if (rows.length > 0 && !rows.some((row) => isActive(row.state))) return;
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
        entry = { meter: new ActivityMeter(this.meterSettings.direction), tracker: new TokRateTracker(), revision: row.outputRevision };
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

  private renderMeter(key: string, active: boolean): string {
    const meter = this.meters.get(key)?.meter;
    if (!meter) return this.theme.fg("dim", "⢀".repeat(ACTIVITY_METER_WIDTH));
    return meter.render((level, char) => ActivityMeter.colorizeCell(level, char, this.theme, this.meterSettings.color, !active));
  }

  /** How many lines the table may use, so it never crowds out the editor below it. */
  private rowBudget(): number {
    const rows = this.tui.terminal?.rows ?? 0;
    if (rows <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(TABLE_CHROME_ROWS, Math.floor(rows * TABLE_HEIGHT_RATIO));
  }

  /**
   * Two centered rows — phase names, then their assigned model ids — shown
   * above the table header, with a two-row powerline chevron standing between
   * adjacent columns to trace the phase flow. Self-suppresses when no phase has
   * a model, or the terminal is too narrow to keep each column readable. The
   * active phase (and the chevrons touching it) shimmers in place of its flat
   * highlighted tone when the theme can supply truecolor ANSI, matching
   * pi-topping's "working" loader sweep.
   */
  private phaseModelBand(bodyWidth: number, now: number): string[] {
    const models = this.view.phaseModels();
    if (!AUDIT_PHASES.some((phase) => models[phase])) return [];
    const sepCount = AUDIT_PHASES.length - 1;
    const colWidth = Math.floor((bodyWidth - sepCount) / AUDIT_PHASES.length);
    if (colWidth < PHASE_BAND_MIN_COL) return [];

    const th = this.theme;
    const active = this.view.activePhase();
    const paint = (lit: boolean, text: string) => {
      if (!lit) return th.fg("dim", text);
      return th.getFgAnsi
        ? shimmerString(text, now - this.createdAt, th as ShimmerTheme, "ltr", "normal", true)
        : th.fg("text", text);
    };
    // Each boundary carries a two-row powerline chevron: the "\" half on the name
    // row stacks over the "/" half on the model row. Both rows share one column
    // layout, so the halves land in the same terminal column and read as a
    // single tall chevron. A separator lights with either phase it divides, so
    // the active highlight flows along the pipeline.
    const bandRow = (sep: string, textFor: (phase: AuditPhase) => string): string => {
      const parts: string[] = [];
      AUDIT_PHASES.forEach((phase, i) => {
        parts.push(paint(phase === active, cell(textFor(phase), colWidth, "center")));
        const next = AUDIT_PHASES[i + 1];
        if (next !== undefined) parts.push(paint(phase === active || next === active, sep));
      });
      return parts.join("");
    };
    const nameRow = bandRow(PHASE_SEP_TOP, (phase) => phase);
    const modelRow = bandRow(PHASE_SEP_BOTTOM, (phase) => shortModelId(models[phase]));
    return [nameRow, modelRow];
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 4);
    const border = (s: string) => th.fg("border", s);
    const row = (s: string) => `  ${truncateToWidth(s, bodyWidth, "…", true)}  `;
    const band = this.phaseModelBand(bodyWidth, Date.now());
    const footer = this.footerLines(bodyWidth);
    const maxBaseRows = Math.max(
      1,
      this.rowBudget() - TABLE_CHROME_ROWS - (footer.length - 1) - (band.length > 0 ? PHASE_BAND_ROWS : 0),
    );
    const rows = collapseReviewRows(this.view.progressRows(), maxBaseRows);
    const cols = tableColumns(
      bodyWidth,
      rows.map((r) => r.label),
    );
    const phaseWidth = phaseColumnWidth();
    const spin = TABLE_FRAMES[this.spinFrame % TABLE_FRAMES.length] ?? "◐";

    const gap = " ".repeat(COLUMN_GAP);
    // Turns and elapsed are pinned to the right edge so the activity column, whose
    // values are by far the longest, keeps every column the others don't need.
    interface LineParams { branch: string; phase: string; icon: string; label: string; ctx: string; meter: string; activity: string; turns: string; elapsed: string }
    const line = (p: LineParams) => {
      const parts = [
        `${cell(p.branch, BRANCH_COL_WIDTH)}${cell(p.phase, phaseWidth)}${cell(p.icon, STATUS_COL_WIDTH)}${cell(p.label, cols.label)}`,
        cell(p.ctx, CTX_COL_WIDTH, "right"),
        p.meter,
      ];
      if (cols.activity > 0) parts.push(cell(p.activity, cols.activity));
      if (cols.stats) parts.push(cell(p.turns, TURNS_COL_WIDTH, "right"), cell(p.elapsed, ELAPSED_COL_WIDTH, "right"));
      return row(parts.join(gap));
    };

    const dim = (s: string) => th.fg("dim", s);
    const lines: string[] = [this.topBorder(innerWidth, border)];
    for (const bandLine of band) lines.push(row(bandLine));
    if (band.length > 0) lines.push(border("─".repeat(innerWidth)));
    lines.push(
      line({
        branch: "",
        phase: dim("PHASE"),
        icon: "",
        label: "",
        ctx: dim("CTX"),
        meter: dim(cell("MONITOR", ACTIVITY_METER_WIDTH)),
        activity: dim("ACTIVITY"),
        turns: dim("TURNS"),
        elapsed: dim("TIME"),
      }),
    );

    const free = Math.max(
      0,
      this.rowBudget() -
        TABLE_CHROME_ROWS -
        (footer.length - 1) -
        rows.length -
        (band.length > 0 ? PHASE_BAND_ROWS : 0),
    );
    const activeRows = rows.filter((r) => isActive(r.state));
    let subRowBudget = Math.min(free, activeRows.filter((r) => r.activity).length);
    // Reserve one line under every active row before it reports activity. When
    // a tool call arrives, it replaces that line instead of growing the table.
    // On a short terminal, activity still outranks these cosmetic placeholders.
    const reservedActivitySlots = free >= activeRows.length;

    // The phase tree: each phase's first row carries its connector (├ for
    // every phase but the last, └ for the last); rows beneath continue the
    // branch with │ until the final phase, whose own rows hang plain.
    const lastPhase = rows[rows.length - 1]?.phase;

    for (const r of rows) {
      const active = isActive(r.state);
      const icon =
        r.state === "done"
          ? th.fg("success", "✓")
          : r.state === "error" || r.state === "cancelled"
            ? th.fg("error", "✗")
            : r.state === "queued"
              ? th.fg("dim", "○")
              : th.fg("accent", spin);
      const label = active ? th.fg("text", r.label) : th.fg("dim", r.label);
      const status = r.state === "error" ? th.fg("error", r.statusText) : th.fg("dim", r.statusText);
      const endsPhaseTree = r.phase === lastPhase;
      const branch = r.firstOfPhase
        ? th.fg("border", endsPhaseTree ? "└" : "├")
        : th.fg("border", endsPhaseTree ? " " : "│");
      lines.push(
        line({
          branch,
          phase: r.firstOfPhase ? th.fg("text", r.phase) : "",
          icon,
          label,
          ctx: contextCell(r.contextTokens, r.contextWindow),
          meter: this.renderMeter(r.key, active),
          activity: status,
          turns: String(r.turns),
          elapsed: formatElapsed(r.elapsedMs),
        }),
      );

      if (active && r.activity && subRowBudget > 0) {
        subRowBudget--;
        lines.push(row(this.activitySubRow(r.activity, bodyWidth)));
      } else if (active && reservedActivitySlots) {
        lines.push(row(""));
      }
    }

    lines.push(border("─".repeat(innerWidth)));
    for (const footerLine of footer) lines.push(row(footerLine));
    lines.push(border("═".repeat(innerWidth)));
    return lines;
  }

  /**
   * Run summary on the left, whole-run wall clock on the right. The total is
   * the run's own elapsed time, not the sum of the row clocks, which overlap
   * whenever passes run concurrently.
   */
  private footerLines(bodyWidth: number): string[] {
    const dim = (s: string) => this.theme.fg("dim", s);
    const summary = this.view.footerSummary();
    const total = `total ${formatElapsed(this.view.totalMs())}`;
    const cancelHint = "ctrl+shift+c: cancel";
    const rhs = `${dim(total)}  ${dim(cancelHint)}`;
    const gap = bodyWidth - visibleWidth(summary) - visibleWidth(rhs);
    if (gap >= MIN_FOOTER_TOTAL_GAP) return [dim(summary) + " ".repeat(gap) + rhs];
    return [dim(summary), cell(rhs, bodyWidth, "right")];
  }

  /**
   * Merged-cell tool activity line, indented two columns past the status icon
   * so it aligns with the row labels above.
   */
  private activitySubRow(activity: string, bodyWidth: number): string {
    const indent = STATUS_COL_WIDTH + phaseColumnWidth() + BRANCH_COL_WIDTH;
    const room = Math.max(0, bodyWidth - indent);
    return `${" ".repeat(indent)}${this.theme.fg("dim", cell(`↳ ${activity}`, room))}`;
  }

  private topBorder(innerWidth: number, border: (s: string) => string): string {
    const title = ` ${TABLE_TITLE} `;
    const head = `${border("══")}${this.theme.fg("accent", title)}`;
    const scope = this.view.scope ? ` ${this.view.scope} ` : "";
    const scopeFill = innerWidth - 4 - visibleWidth(title) - visibleWidth(scope);
    // A narrow terminal drops the scope rather than truncating it: a cut-off
    // path reads as a different scope, and the full path is in the report.
    if (scope && scopeFill >= MIN_TITLE_SCOPE_GAP) {
      return `${head}${border("═".repeat(scopeFill))}${this.theme.fg("dim", scope)}${border("══")}`;
    }
    const fill = innerWidth - 2 - visibleWidth(title);
    if (fill < 0) return border("═".repeat(innerWidth));
    return `${head}${border("═".repeat(fill))}`;
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
    scope: snapshot.scope,
    phaseModels: () => snapshot.phaseModels,
    activePhase: () => undefined,
  };
  return new AuditProgressTable(host, theme, view, snapshot.meterLevels, meter);
}
