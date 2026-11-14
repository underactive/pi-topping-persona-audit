/**
 * Measures a generated dialog: mounted with room to spare and left to take the rows its content
 * needs, then driven through a key script, taking the size of every screen it shows.
 *
 * Not a test file. The `test/*.test.ts` glob does not run it.
 */
import { mountOpenTui } from "@underactive/pi-topping-opentui/host";
import { MOCKUP_PALETTE } from "@underactive/pi-topping-opentui/theme";
import type { ReactNode } from "react";
import type { TerminalSize } from "../../src/ui/dialog-fit.ts";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface Screen {
  size: TerminalSize;
  text: string;
}

/** The size of one frame: the widest line and the number of lines. */
function sizeOf(chars: string): TerminalSize {
  const rows = chars.split("\n");
  return { columns: Math.max(...rows.map((row) => [...row.trimEnd()].length)), rows: rows.length };
}

/**
 * One entry per step: the dialog as it stands after the keys of that step, `""` meaning no key.
 * A key handler only sets state and React commits a moment later, so each step waits it out.
 */
export async function measureSteps(element: ReactNode, steps: readonly (readonly string[])[], frame: TerminalSize = { columns: 160, rows: 80 }): Promise<Screen[]> {
  const mounted = mountOpenTui(element, { width: frame.columns, height: frame.rows, theme: MOCKUP_PALETTE, fitContent: true });
  try {
    const screens: Screen[] = [];
    for (const keys of steps) {
      for (const key of keys) {
        if (key) mounted.input(key);
        for (let i = 0; i < 4; i++) await turn();
      }
      const text = mounted.charFrame();
      screens.push({ size: sizeOf(text), text });
    }
    return screens;
  } finally {
    mounted.unmount();
  }
}

/** The largest width and height over `screens`. */
export function largest(screens: readonly Screen[]): TerminalSize {
  return {
    columns: Math.max(...screens.map((screen) => screen.size.columns)),
    rows: Math.max(...screens.map((screen) => screen.size.rows)),
  };
}
