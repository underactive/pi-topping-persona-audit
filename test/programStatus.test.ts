import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
// pi's own OSC 7501 reporter, the one interactive mode runs. It is not a
// package export; it is loaded by path so these tests exercise the code that
// actually writes the status. If pi moves it, this import fails, and the
// assumption src/programStatus.ts rests on (the reporter writes through the
// terminal's setProgramStatus, looked up on every report) needs checking again.
import { ProgramStatusReporter } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/program-status-reporter.js";
import { AuditProgramStatus, auditOutcomeOf } from "../src/programStatus.ts";

/** Stands in for pi-tui's terminal: the method is on the prototype, as on ProcessTerminal. */
class FakeTerminal {
  readonly written: ProgramStatus[] = [];
  setProgramStatus(status: ProgramStatus): void {
    this.written.push(status);
  }
  /** What a terminal reading OSC 7501 shows now. */
  get showing(): string {
    const last = this.written.at(-1);
    return last ? `${last.state}${last.message ? `: ${last.message}` : ""}` : "(nothing)";
  }
}

/** A pi TUI session: the terminal and pi's reporter writing to it, started the way pi starts. */
function piSession() {
  const terminal = new FakeTerminal();
  const reporter = new ProgramStatusReporter(() => terminal as never, () => "my session");
  reporter.report();
  assert.equal(terminal.showing, "idle", "pi starts idle");
  // pi's dialogs and overlays report blocked under a source while open.
  const dialog = (source: string, title: string) => {
    reporter.setBlocked(source, { kind: "question", message: title });
    return () => reporter.setBlocked(source, undefined);
  };
  return { terminal, reporter, dialog };
}

test("an audit shows as working, its dialogs as blocked, and its result as done", () => {
  const { terminal, reporter, dialog } = piSession();
  const status = new AuditProgramStatus();

  status.begin(terminal);
  assert.equal(terminal.showing, "working: Persona audit");
  assert.equal(terminal.written.at(-1)?.app, "pi");

  const closeRetry = dialog("overlay-1", "Retry failed reviewers?");
  assert.equal(terminal.showing, "blocked: Retry failed reviewers?", "a dialog that waits on the user shows as blocked");
  closeRetry();
  assert.equal(terminal.showing, "working: Persona audit", "closing it must not drop the pane to pi's idle");

  reporter.report(); // pi re-reports on session_info_changed and similar
  assert.equal(terminal.showing, "working: Persona audit");

  status.finish("completed");
  assert.equal(terminal.showing, "done: Persona audit");
  const closeViewer = dialog("overlay-2", "Audit report");
  assert.equal(terminal.showing, "blocked: Audit report");
  closeViewer();
  assert.equal(terminal.showing, "done: Persona audit", "closing the report viewer keeps the outcome");

  status.release();
  assert.equal(Object.prototype.hasOwnProperty.call(terminal, "setProgramStatus"), false, "pi's method is back");
  assert.equal(terminal.showing, "done: Persona audit");
  reporter.report();
  assert.equal(terminal.showing, "done: Persona audit", "pi sends nothing until its own state changes");

  // pi's own turns report as before.
  reporter.handleEvent({ type: "agent_start" } as never);
  assert.equal(terminal.showing, "working: my session");
  reporter.handleEvent({ type: "agent_settled", aborted: false } as never);
  assert.equal(terminal.showing, "done: my session");
});

test("without it, pi shows an audit as idle", () => {
  // The bug, for reference: nothing in an audit reaches pi's reporter.
  const { terminal, dialog } = piSession();
  dialog("overlay-1", "Retry?")();
  assert.equal(terminal.showing, "idle");
});

test("a cancelled audit ends idle and a failed one ends in error", () => {
  for (const [outcome, expected] of [
    ["cancelled", "idle"],
    ["failed", "error: Persona audit failed"],
  ] as const) {
    const { terminal } = piSession();
    const status = new AuditProgramStatus();
    status.begin(terminal);
    status.finish(outcome);
    status.release();
    assert.equal(terminal.showing, expected);
  }
});

test("shutting down mid-audit reports idle and hands pi's method back", () => {
  const { terminal, reporter } = piSession();
  const status = new AuditProgramStatus();
  status.begin(terminal);
  status.release();
  assert.equal(terminal.showing, "idle");
  assert.equal(status.active, false);
  assert.equal(Object.prototype.hasOwnProperty.call(terminal, "setProgramStatus"), false);
  reporter.handleEvent({ type: "agent_start" } as never);
  assert.equal(terminal.showing, "working: my session");
});

test("pi's own working reports pass through mid-audit", () => {
  const { terminal, reporter } = piSession();
  const status = new AuditProgramStatus();
  status.begin(terminal);
  reporter.handleEvent({ type: "compaction_start" } as never);
  assert.equal(terminal.showing, "working: Compacting context");
  reporter.handleEvent({ type: "compaction_end", aborted: false, reason: "threshold" } as never);
  assert.equal(terminal.showing, "working: Persona audit");
});

test("a second audit on the same terminal works the same way", () => {
  const { terminal, dialog } = piSession();
  const status = new AuditProgramStatus();
  status.begin(terminal);
  status.finish("completed");
  status.release();
  status.begin(terminal);
  assert.equal(terminal.showing, "working: Persona audit");
  dialog("overlay-3", "Fix now?")();
  assert.equal(terminal.showing, "working: Persona audit");
  status.release();
});

test("each status is written once", () => {
  const { terminal, reporter } = piSession();
  const status = new AuditProgramStatus();
  const before = terminal.written.length;
  status.begin(terminal);
  status.begin(terminal);
  reporter.report();
  reporter.handleEvent({ type: "session_info_changed" } as never);
  assert.equal(terminal.written.length, before + 1);
});

test("if something wraps the method after it, release leaves that wrapper working", () => {
  const { terminal, reporter } = piSession();
  const status = new AuditProgramStatus();
  status.begin(terminal);
  const ours = terminal.setProgramStatus;
  const seen: string[] = [];
  terminal.setProgramStatus = (s: ProgramStatus) => {
    seen.push(s.state);
    ours.call(terminal, s);
  };
  status.release();
  reporter.handleEvent({ type: "agent_start" } as never);
  assert.equal(terminal.showing, "working: my session", "reports still reach the terminal");
  assert.deepEqual(seen.at(-1), "working");
});

test("does nothing without a terminal, as outside pi's TUI", () => {
  const status = new AuditProgramStatus();
  status.begin(undefined);
  status.begin({} as never);
  status.finish("completed");
  status.release();
  assert.equal(status.active, false);
});

test("a finished audit is done whatever it found", () => {
  assert.equal(auditOutcomeOf("completed"), "completed");
  assert.equal(auditOutcomeOf("no-findings"), "completed");
  assert.equal(auditOutcomeOf("none-accepted"), "completed");
  assert.equal(auditOutcomeOf("cancelled"), "cancelled");
  assert.equal(auditOutcomeOf("failed"), "failed");
});
