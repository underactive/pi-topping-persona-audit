/**
 * Decides whether a generated dialog can be shown, or whether the caller keeps its pi-tui menu.
 *
 * The dialogs under `./generated` are drawn at a fixed size and do not adapt to the terminal: on
 * one that is too small the overlay loses its right-hand columns or its bottom rows, which hold
 * the buttons and the key hints. The pi-tui menus in `../components` work at any size, so they
 * stay as the fallback. The decision is made once, when a dialog opens; a terminal shrunk while a
 * generated dialog is open clips it.
 */
import { type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { hostBelow } from "@underactive/pi-topping-primitives/process";

/** Columns and rows: of a terminal, or of the room a dialog needs. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * Room reserved for each generated dialog, sub-screens included. The width is the dialog's own
 * width, which includes the panel's two right-hand padding columns that a measure of the last
 * visible character does not see. Settings is as tall as its tallest screen. Purge lists as many
 * rows as the terminal gives it, so its rows are the least that keep its buttons and key hints
 * on screen. `test/dialogFit.test.ts` measures both and fails when a number is wrong.
 */
export const SETTINGS_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 33 };
export const PURGE_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 24 };
export const RETRY_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 28 };
export const FINDINGS_REVIEW_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 24 };
export const FIX_GATE_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 34 };
export const REPORT_VIEWER_DIALOG_SIZE: TerminalSize = { columns: 104, rows: 18 };

/**
 * `maxHeight` for `showOpenTuiDialog`: the share of the terminal's rows a dialog may take.
 * All of them, so `dialogFits` can compare rows directly.
 */
export const DIALOG_MAX_HEIGHT = 1;

/** True when the terminal is known and has room for all of `dialog`. An unknown size does not fit. */
export function dialogFits(terminal: TerminalSize | undefined, dialog: TerminalSize): boolean {
  return terminal !== undefined && terminal.columns >= dialog.columns && terminal.rows >= dialog.rows;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function terminalSizeOf(tui: { terminal?: { columns?: unknown; rows?: unknown } }): TerminalSize | undefined {
  const columns = positiveInteger(tui.terminal?.columns);
  const rows = positiveInteger(tui.terminal?.rows);
  return columns === undefined || rows === undefined ? undefined : { columns, rows };
}

/**
 * The first pi on which `readTerminalSize` asks for the size. From 1.3.0, pi closes an overlay
 * dialog through that dialog's own handle, which does nothing for one that was never shown.
 * pi 1.2.0 hides the topmost overlay instead, and that could be another extension's.
 */
export const MIN_SIZE_PROBE_HOST_VERSION = "1.3.0";

/**
 * The size of the terminal pi is drawing on, or `undefined` when it cannot be read.
 *
 * pi's extension context has no size of its own. `ctx.ui.custom` hands its factory the `TUI` that
 * overlays are laid out against, so the factory reads `tui.terminal` and finishes at once: pi
 * drops a component whose dialog closed before it was shown, so nothing is drawn, focused or
 * reported as blocking. Call it in TUI mode only. On a pi older than `MIN_SIZE_PROBE_HOST_VERSION`
 * nothing is asked and the size is unknown.
 */
export async function readTerminalSize(
  ctx: { readonly ui: Pick<ExtensionContext["ui"], "custom"> },
  hostVersion: string = VERSION,
): Promise<TerminalSize | undefined> {
  if (hostBelow(hostVersion, MIN_SIZE_PROBE_HOST_VERSION)) return undefined;
  try {
    return await ctx.ui.custom<TerminalSize | undefined>(
      (tui, _theme, _keybindings, done) => {
        done(terminalSizeOf(tui));
        return { render: () => [], invalidate: () => {} };
      },
      { overlay: true },
    );
  } catch {
    return undefined;
  }
}
