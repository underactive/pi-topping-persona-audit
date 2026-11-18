/**
 * Program status (OSC 7501) for the length of an audit.
 *
 * pi tells the terminal whether it is working, blocked, done or idle with the
 * Program Status Protocol, and terminals and dashboards that read it (herdr's
 * macOS app, through `hc`) show that state. pi's reporter only follows the root
 * session's own agent runs and compaction. A persona audit runs inside a slash
 * command and does its work in separate agent sessions, so for the whole audit
 * pi keeps reporting the state it had before: idle.
 *
 * pi has no extension API for this state, so while an audit runs this module
 * stands in front of the terminal's `setProgramStatus`, the one method pi's
 * reporter writes through:
 *
 * - While the audit runs, pi's resting states (idle, done, error) are shown as
 *   `working`. When a dialog closes, pi reports its resting state again, which
 *   would otherwise turn the pane idle in the middle of the run.
 * - pi's `blocked` reports pass through unchanged, so a dialog that waits on
 *   the user (a retry checkpoint, Findings Review, the Fix Now gate) shows as
 *   blocked, as pi's own dialogs do. So do pi's own `working` reports.
 * - Once the audit has finished, its outcome (done, error, or idle when
 *   cancelled) stands in for pi's resting state the same way, so closing the
 *   report viewer leaves the outcome showing rather than idle.
 * - `release()` puts pi's method back and leaves the last status showing. pi's
 *   reporter sends nothing until its own state changes, which is how a pi run's
 *   `done` stays up too.
 *
 * Only reachable in pi's TUI, where the progress widget is handed pi's TUI and
 * its terminal; elsewhere there is no terminal and this does nothing.
 */
import type { ProgramStatus } from "@earendil-works/pi-tui";
import type { AuditStatus } from "./types.ts";

/** The slice of pi-tui's `Terminal` this module uses. */
export interface ProgramStatusTerminal {
  setProgramStatus(status: ProgramStatus): void;
}

export type AuditOutcome = "completed" | "failed" | "cancelled";

/** pi's program name (`APP_NAME`), used until pi reports one of its own. */
const DEFAULT_APP = "pi";
const MESSAGE = "Persona audit";

const OUTCOME_STATUS: Record<AuditOutcome, ProgramStatus> = {
  completed: { state: "done", message: MESSAGE },
  failed: { state: "error", message: `${MESSAGE} failed` },
  cancelled: { state: "idle" },
};

/** How a finished audit is reported: a run that finished is done, whatever it found. */
export function auditOutcomeOf(status: AuditStatus): AuditOutcome {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

type Mode = { kind: "running" } | { kind: "finished"; status: ProgramStatus };

export class AuditProgramStatus {
  private terminal: ProgramStatusTerminal | undefined;
  /** Writes straight to the terminal, past this module. */
  private forward: ((status: ProgramStatus) => void) | undefined;
  /** Puts pi's method back, if nothing has replaced ours since. */
  private restore: (() => void) | undefined;
  private mode: Mode | undefined;
  /** The last status pi asked for while this module stood in front of it. */
  private piStatus: ProgramStatus | undefined;
  private lastWritten: string | undefined;

  /** True while this module stands in front of a terminal. */
  get active(): boolean {
    return this.terminal !== undefined;
  }

  /** Show the audit as working on `terminal`. Without a terminal (outside the TUI) this does nothing. */
  begin(terminal: ProgramStatusTerminal | undefined): void {
    if (!terminal || typeof terminal.setProgramStatus !== "function") return;
    if (this.terminal !== terminal) {
      this.release();
      this.install(terminal);
    }
    this.mode = { kind: "running" };
    this.show();
  }

  /** The audit is over: show its outcome in place of pi's resting state until `release()`. */
  finish(outcome: AuditOutcome): void {
    if (!this.terminal) return;
    this.mode = { kind: "finished", status: OUTCOME_STATUS[outcome] };
    this.show();
  }

  /**
   * Stop standing in front of pi's reports. An audit still running when this
   * is called (the session is shutting down) is reported as cancelled.
   */
  release(): void {
    if (!this.terminal) return;
    if (this.mode?.kind !== "finished") this.mode = { kind: "finished", status: OUTCOME_STATUS.cancelled };
    this.show();
    this.restore?.();
    this.terminal = undefined;
    this.forward = undefined;
    this.restore = undefined;
    this.mode = undefined;
    this.piStatus = undefined;
    this.lastWritten = undefined;
  }

  private install(terminal: ProgramStatusTerminal): void {
    const hadOwn = Object.prototype.hasOwnProperty.call(terminal, "setProgramStatus");
    const previous = terminal.setProgramStatus;
    const forward = (status: ProgramStatus) => previous.call(terminal, status);
    const override = (status: ProgramStatus) => {
      // Released, but something wrapped this override since: pass straight on.
      if (this.terminal !== terminal) return forward(status);
      this.piStatus = status;
      this.show();
    };
    terminal.setProgramStatus = override;
    this.restore = () => {
      if (terminal.setProgramStatus !== override) return;
      if (hadOwn) terminal.setProgramStatus = previous;
      else delete (terminal as { setProgramStatus?: unknown }).setProgramStatus;
    };
    this.forward = forward;
    this.terminal = terminal;
    this.piStatus = undefined;
    this.lastWritten = undefined;
  }

  /** What the terminal should show now. */
  private current(): ProgramStatus | undefined {
    const pi = this.piStatus;
    if (!this.mode) return pi;
    if (pi && (pi.state === "blocked" || pi.state === "working" || pi.state === "clear")) return pi;
    const app = pi?.app ?? DEFAULT_APP;
    if (this.mode.kind === "running") return { state: "working", app, message: MESSAGE };
    return { ...this.mode.status, app };
  }

  private show(): void {
    const status = this.current();
    if (!status || !this.forward) return;
    const key = JSON.stringify(status);
    if (key === this.lastWritten) return;
    this.lastWritten = key;
    this.forward(status);
  }
}
