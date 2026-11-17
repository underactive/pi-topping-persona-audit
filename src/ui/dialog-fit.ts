/**
 * How big the generated dialogs are.
 *
 * Every dialog under `./generated` lays itself out in the room pi gives its overlay, on every
 * frame: it takes its full size where the terminal has room, and shrinks with the terminal down
 * to `MIN_DIALOG_SIZE`, a default terminal window. Below that it keeps that size and pi cuts
 * its right-hand columns or its bottom rows. A terminal resized while a dialog is open re-lays
 * it out, so nothing is decided when it opens.
 */

/** Columns and rows: of a terminal, or of the room a dialog needs. */
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The overlay width every dialog asks pi for: its full width. pi narrows the overlay on a
 * narrower terminal, and the dialog lays itself out in what it gets.
 */
export const DIALOG_WIDTH = 104;

/** The least room the dialogs lay themselves out for (the mockups' `MIN_ROOM`). */
export const MIN_DIALOG_SIZE: TerminalSize = { columns: 80, rows: 24 };

/**
 * `maxHeight` for `showOpenTuiDialog`: the share of the terminal's rows a dialog may take.
 * All of them; each dialog windows its own rows to fit.
 */
export const DIALOG_MAX_HEIGHT = 1;

/**
 * List rows for the reviewer and roster pickers: as many as the room has, which is what they
 * have always taken in pi. The mockup's default is the 17 rows of its full-size drawing.
 */
export const FILL_ROOM = Number.POSITIVE_INFINITY;
