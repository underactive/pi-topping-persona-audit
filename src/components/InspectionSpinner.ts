/**
 * Live feedback shown while the reviewer dispatcher fingerprints the repo and
 * asks the model to recommend reviewers.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatElapsed } from "./AuditProgress.ts";

export const INSPECTION_SPINNER_WIDGET_KEY = "persona-audit-inspection-spinner";
export const INSPECTION_SPINNER_INTERVAL_MS = 100;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The slice of pi's TUI and Theme needed by the spinner. */
export interface InspectionSpinnerHost {
  requestRender(force?: boolean): void;
}

export interface InspectionSpinnerTheme {
  fg(color: ThemeColor, text: string): string;
}

/** One-line, left-aligned progress feedback for the pre-audit dispatcher. */
export class InspectionSpinner implements Component {
  private readonly tui: InspectionSpinnerHost;
  private readonly theme: InspectionSpinnerTheme;
  private readonly message: string;
  private readonly createdAt = Date.now();
  private readonly timer: ReturnType<typeof setInterval>;
  private frame = 0;

  constructor(tui: InspectionSpinnerHost, theme: InspectionSpinnerTheme, dispatcherLabel: string) {
    this.tui = tui;
    this.theme = theme;
    this.message = `Inspecting repo with ${dispatcherLabel}…`;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, INSPECTION_SPINNER_INTERVAL_MS);
  }

  render(width: number): string[] {
    const elapsed = formatElapsed(Date.now() - this.createdAt);
    const frame = SPINNER_FRAMES[this.frame] ?? SPINNER_FRAMES[0];
    const line = `${this.theme.fg("accent", frame)} ${this.theme.fg("text", `${this.message} · ${elapsed} · ctrl+shift+c cancels`)}`;
    return [truncateToWidth(line, Math.max(0, width), "…")];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }
}
