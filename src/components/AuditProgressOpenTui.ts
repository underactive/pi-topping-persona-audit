import { createElement } from "react";
import { mountOpenTui } from "@underactive/pi-topping-opentui/host";
import { resolveTheme, type ResolvedTheme, type ThemeSource } from "@underactive/pi-topping-opentui/theme";
import { sanitizeTerminalBytes } from "@underactive/pi-topping-primitives/text";
import { type AuditProgressRow, type AuditProgressView, type ProgressTheme } from "./AuditProgress.ts";
import { METER_WIDTH, Meter } from "../ui/generated/topping/pi.ts";
import { ProgressTable } from "../ui/generated/persona-audit/progress.ts";
import { AUDIT_PHASES, type AuditPhase, AuditRun, type FixDetail, type Row } from "../ui/generated/persona-audit/run.ts";

interface OpenTuiProgressOptions {
  view: AuditProgressView;
  width: number;
  maxRows: number;
  frozen: boolean;
  spin: number;
  meterDirection: "ltr" | "rtl";
  meterLevels: Record<string, readonly number[]>;
  theme: ProgressTheme & ThemeSource;
}

export function isThemeSource(theme: ProgressTheme): theme is ProgressTheme & ThemeSource {
  const candidate = theme as ProgressTheme & Partial<ThemeSource>;
  return candidate.colors !== undefined && typeof candidate.getColorMode === "function";
}

function toRunRow(row: AuditProgressRow, meterLevels: Record<string, readonly number[]>, meterDirection: "ltr" | "rtl"): Row {
  const levels = meterLevels[row.key];
  const meter = new Meter();
  meter.levels = Array.from({ length: METER_WIDTH }, (_, index) => levels?.[index] ?? 0);
  // ActivityMeter.levels() is already ordered for its direction; avoid reversing it again.
  meter.direction = meterDirection;
  const detail: FixDetail | undefined = row.fixNowDetail
    ? {
        category: sanitizeTerminalBytes(row.fixNowDetail.category),
        severity: sanitizeTerminalBytes(row.fixNowDetail.severity),
        rationale: sanitizeTerminalBytes(row.fixNowDetail.rationale),
        phase: row.fixNowDetail.phase,
        statusText: sanitizeTerminalBytes(row.fixNowDetail.statusText),
        attempt: row.fixNowDetail.attempt,
        cancelArmed: row.fixNowDetail.awaitingCancelConfirm,
      }
    : undefined;

  return {
    key: row.key,
    phase: row.phase,
    label: sanitizeTerminalBytes(row.label),
    state: row.state,
    status: sanitizeTerminalBytes(row.statusText),
    ctx: row.contextTokens ?? 0,
    ctxWindow: row.contextWindow ?? 0,
    ...(row.activity === undefined ? {} : { activity: sanitizeTerminalBytes(row.activity) }),
    turns: row.turns,
    tools: row.toolCalls ?? 0,
    ...(row.costUsd === undefined ? {} : { cost: row.costUsd }),
    out: row.outputTokens,
    workedMs: row.elapsedMs,
    meter,
    ...(detail === undefined ? {} : { fix: detail }),
  };
}

export function renderOpenTuiProgress(options: OpenTuiProgressOptions): string[] {
  const rows = options.view.progressRows().map((row) => toRunRow(row, options.meterLevels, options.meterDirection));
  const run = new AuditRun();
  run.rows = rows;
  run.summary = sanitizeTerminalBytes(options.view.footerSummary());
  run.activePhase = options.view.activePhase();
  run.phaseThinking = { ...options.view.phaseThinking() };
  for (const phase of AUDIT_PHASES) {
    const model = options.view.phaseModels()[phase];
    if (model) run.phaseModels[phase] = sanitizeTerminalBytes(model);
  }
  run.activeMs = options.view.totalMs();
  run.waitingMs = options.view.waitingMs();
  run.waiting = options.view.isWaiting();
  run.spin = options.spin;
  const total = options.view.totalCost();
  run.totalCost = () => ({ cost: total.costUsd, incomplete: total.incomplete });

  const width = Math.max(20, Math.floor(options.width));
  const maxRows = Number.isFinite(options.maxRows)
    ? Math.max(1, Math.floor(options.maxRows))
    : Math.max(40, rows.length * 2 + 32);
  const height = Math.max(40, rows.length * 8 + 40, maxRows);
  const theme: ResolvedTheme = resolveTheme(options.theme);
  const mounted = mountOpenTui(
    createElement(ProgressTable, {
      run,
      width,
      maxRows,
      ...(options.view.scope ? { scope: sanitizeTerminalBytes(options.view.scope) } : {}),
      ...(options.view.baseHash ? { baseHash: sanitizeTerminalBytes(options.view.baseHash) } : {}),
      frozen: options.frozen,
    }),
    { width, height, theme, fitContent: true },
  );
  try {
    return mounted.lines();
  } finally {
    mounted.unmount();
  }
}
