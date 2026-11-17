/**
 * How many terminal rows the docked progress table may budget against.
 */
import type { TuiMode } from "@earendil-works/pi-tui";

/** Rows assumed when the terminal does not report its height. */
export const FALLBACK_TERMINAL_ROWS = 40;

/**
 * The slice of pi's `TUI` a row budget reads. `mode` is the renderer pi is
 * actually running, so pi has already resolved an unset `tuiMode` setting to
 * its own default ("regular" on 0.99.x, "fullscreen" from 1.0.0). Read it on
 * every render: `/settings` can swap renderers behind the same `TUI`. Stubs
 * and hosts without `mode` reserve nothing.
 */
export interface ViewportHost {
  terminal?: { rows?: number };
  mode?: TuiMode;
}

/**
 * Rows taken off a fullscreen terminal before an above-editor widget claims
 * its share: pi's bare dock below the widget, measured on pi 1.0.0 at 120×40.
 * That is the editor's 3-row minimum and a 2-row footer, with the working
 * indicator drawn inside the editor's border rather than on a row of its own.
 * Multi-line input and other extensions' widgets grow the dock past this, so
 * it is a floor. Re-measure when pi's dock layout changes.
 */
export const FULLSCREEN_WIDGET_RESERVE_ROWS = 5;

/**
 * Terminal rows a component may budget against: the fallback when the height
 * is unknown, less `reserve` only in fullscreen. The mode is the host's
 * resolved `mode` unless an explicit `mode` argument overrides it; with
 * neither, nothing is reserved.
 */
export function usableTerminalRows(host: ViewportHost | undefined, reserve: number, mode = host?.mode): number {
  const rows = host?.terminal?.rows ?? 0;
  const base = rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
  return mode === "fullscreen" ? Math.max(1, base - reserve) : base;
}
