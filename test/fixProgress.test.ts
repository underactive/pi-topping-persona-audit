import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import {
  openFixProgress,
  type FixGateInput,
  type FixProgressUi,
} from "../src/components/FixProgress.ts";
import type { AuditProgressWidget } from "../src/components/AuditProgress.ts";
import type { Finding } from "../src/types.ts";
import { DIALOG_WIDTH } from "../src/ui/dialog-fit.ts";
import { press, screen, type ShownComponent } from "./helpers/dialog-harness.ts";

const ESCAPE = "\x1b";
/** Kitty keyboard protocol release event for the Escape key (CSI 27;1:3u). */
const ESCAPE_RELEASE = "\x1b[27;1:3u";
const CTRL_C = "\x03";

/** The two members the OpenTUI runtime resolves its palette from; every token paints as the terminal default. */
const theme = { colors: {}, getColorMode: () => "truecolor" };

const finding: Finding = {
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "SQL string is concatenated from user input",
  suggestedChange: "use a parameterized query",
};

const progress = {
  contextTokens: 12_000,
  turns: 3,
  toolCalls: 7,
  costUsd: 0.042,
  activity: "edit src/a.ts",
  outputTokens: 900,
  outputRevision: 0,
};

// The gate's look and keys are the generated FixGate dialog's, pinned by the
// persona-audit-fix-gate parity cases at full size and at 80×24. These tests
// cover the controller around it.

// ── openFixProgress (raw listener + gate-only overlays + table sink) ───────

interface CustomCall {
  options: unknown;
  /** The generated gate dialog pi would show. */
  component: ShownComponent;
  /** Whether the sink already showed a settling state when done fired. */
  settlingAtDone: boolean;
  reject: (error: Error) => void;
}

function controllerHarness(rows = 40, withSink = true) {
  const host = { requestRender: () => {}, terminal: { rows, columns: 120 } };
  const customCalls: CustomCall[] = [];
  let inputHandler: TerminalInputHandler | undefined;
  let cancelRequests = 0;
  /** Ordered sink event log — the audit-table writes the controller makes. */
  const log: string[] = [];
  /** Band highlight tracked separately from `log` — phase assertions below pin exact log slices. */
  let bandPhase: string | undefined = "Triage";

  const sink = {
    setFixNowDetail: (key: string, f: Finding) => log.push(`detail:${key}:${f.file}`),
    updateFixNowPhase: (key: string, phase: string, statusText: string, attempt: number) =>
      log.push(`phase:${phase}:${statusText}:${attempt}`),
    updateFixNowSettling: (key: string, decision: string, commitPlanned: boolean) =>
      log.push(`settling:${decision}:${commitPlanned}`),
    setFixNowCancelArmed: (key: string, armed: boolean) => log.push(`armed:${armed}`),
    applyProgress: () => log.push("telemetry"),
    clearFixNowDetail: (key: string) => log.push(`clear:${key}`),
    setActivePhase: (phase: string | undefined) => {
      bandPhase = phase;
    },
    activePhase: () => bandPhase,
  } as unknown as AuditProgressWidget;

  const notifications: string[] = [];
  const ui = {
    onTerminalInput(handler: TerminalInputHandler): () => void {
      inputHandler = handler;
      return () => {
        inputHandler = undefined;
      };
    },
    notify(message: string) {
      notifications.push(message);
    },
    custom<T>(
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
      options?: unknown,
    ): Promise<T> {
      const call: CustomCall = {
        options,
        component: undefined as unknown as ShownComponent,
        settlingAtDone: false,
        reject: () => {},
      };
      const promise = new Promise<T>((resolve, reject) => {
        call.reject = reject;
        call.component = factory(host, theme, {}, (value: T) => {
          // done must fire before the sink transitions to its settling state.
          call.settlingAtDone = log.some((entry) => entry.startsWith("settling:"));
          call.component.dispose?.();
          resolve(value);
        }) as ShownComponent;
      });
      customCalls.push(call);
      return promise;
    },
  } as unknown as FixProgressUi;

  const controller = openFixProgress(
    { mode: "tui", ui },
    finding,
    () => { cancelRequests += 1; },
    withSink ? { key: "row-key", progress: sink } : undefined,
  );
  return {
    controller,
    log,
    bandPhase: () => bandPhase,
    customCalls: customCalls as readonly CustomCall[],
    lastCustomCall: () => customCalls[customCalls.length - 1]!,
    listenerActive: () => inputHandler !== undefined,
    send: (data: string) => inputHandler?.(data),
    cancelRequests: () => cancelRequests,
    notifications,
  };
}

const gateInput: FixGateInput = { diff: "+const a = 2;", verdictNote: "verifier: fixed", commitPlanned: true, attempt: 1 };

test("opening seeds the row detail; automated work flows to the sink and never opens a prompt overlay", async () => {
  const h = controllerHarness();

  assert.deepEqual(h.log[0], "detail:row-key:src/a.ts", "the fix-now row gets its nested detail on open");
  assert.ok(h.listenerActive(), "the raw working listener is registered");
  assert.equal(h.customCalls.length, 0);

  h.controller.setPhase("fixing", "applying security fix", 1);
  h.controller.applyProgress(progress);
  h.controller.setPhase("verifying", "checking the fix", 1);
  h.controller.applyProgress(progress);
  assert.deepEqual(h.log.slice(1), [
    "phase:fixing:applying security fix:1",
    "telemetry",
    "phase:verifying:checking the fix:1",
    "telemetry",
  ], "telemetry reaches the audit row through the controller only");
  assert.equal(h.customCalls.length, 0, "automated work is not a prompt");

  await h.controller.close();
  assert.ok(h.log.includes("clear:row-key"), "close removes the row detail");
});

test("the band highlight follows fix-now phases and restores on close", async () => {
  const h = controllerHarness();

  assert.equal(h.bandPhase(), "Triage", "the review overlay parks the band on Triage");
  h.controller.setPhase("fixing", "applying security fix", 1);
  assert.equal(h.bandPhase(), "Implement", "edit-capable fix work highlights Implement");
  h.controller.setPhase("verifying", "checking the fix", 1);
  assert.equal(h.bandPhase(), "Verify", "the single-finding verifier highlights Verify");
  h.controller.setPhase("fixing", "refining fix / answering question", 1);
  assert.equal(h.bandPhase(), "Implement", "a chat refinement is edit work again");

  await h.controller.close();
  assert.equal(h.bandPhase(), "Triage", "close restores the pre-episode phase");
});

test("a missing sink turns detail updates into no-ops", async () => {
  const h = controllerHarness(40, false);

  h.controller.setPhase("fixing", "applying security fix", 1);
  h.controller.applyProgress(progress);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.send(ESCAPE), { consume: true }, "the listener still runs without a sink");
  assert.equal(h.cancelRequests(), 0, "one Esc only arms");
  h.send(ESCAPE);
  assert.equal(h.cancelRequests(), 1);

  await h.controller.close();
});

test("the working listener consumes only Escape and swallows release events", async () => {
  const h = controllerHarness();

  assert.equal(h.send("a"), undefined, "printable input passes through");
  assert.equal(h.send(CTRL_C), undefined, "Ctrl+C stays with the host");
  assert.equal(h.cancelRequests(), 0);

  // One physical Escape keypress arrives as press + release: the press arms,
  // the swallowed release must not count as the second press.
  assert.deepEqual(h.send(ESCAPE), { consume: true });
  assert.deepEqual(h.log.filter((e) => e.startsWith("armed:")), ["armed:true"]);
  assert.equal(h.cancelRequests(), 0);
  assert.deepEqual(h.send(ESCAPE_RELEASE), { consume: true });
  assert.equal(h.cancelRequests(), 0, "the Escape release is not a second press");
  assert.deepEqual(h.log.filter((e) => e.startsWith("armed:")), ["armed:true"], "still armed");

  assert.deepEqual(h.send(ESCAPE), { consume: true });
  assert.equal(h.cancelRequests(), 1, "two presses cancel exactly once");
  assert.ok(h.log.includes("armed:false"), "the hint disarms after the cancel fires");

  await h.controller.close();
});

test("non-Escape input disarms a pending cancel and still reaches the editor", async () => {
  const h = controllerHarness();

  h.send(ESCAPE);
  assert.deepEqual(h.log.filter((e) => e.startsWith("armed:")), ["armed:true"]);
  assert.equal(h.send("x"), undefined, "not consumed — the editor still gets it");
  assert.deepEqual(h.log.filter((e) => e.startsWith("armed:")), ["armed:true", "armed:false"], "disarmed");
  h.send(ESCAPE);
  assert.equal(h.cancelRequests(), 0, "disarm reset the gesture — this press only re-arms");

  await h.controller.close();
});

test("the gate opens a focused overlay; done fires before the settling update", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  assert.equal(h.customCalls.length, 1);
  const options = h.lastCustomCall().options as { overlay?: boolean; overlayOptions?: { width?: number } };
  assert.equal(options.overlay, true, "the gate is an overlay, which pi focuses");
  assert.equal(options.overlayOptions?.width, DIALOG_WIDTH);

  // While the gate is open the raw listener leaves every key — Escape
  // included — untouched so the focused overlay receives it.
  assert.equal(h.send("a"), undefined);
  assert.equal(h.send(ESCAPE), undefined);
  assert.equal(h.cancelRequests(), 0, "gate input cannot arm the working cancel");

  await press(h.lastCustomCall().component, "a");
  assert.equal(h.lastCustomCall().settlingAtDone, false, "done fires before the sink settles");
  assert.equal(await decision, "accept");
  assert.ok(h.log.includes("settling:accept:true"), "the row detail shows the settling state after the gate");

  await h.controller.close();
});

test("Escape stays inert once a decision is settling", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  await press(h.lastCustomCall().component, "a");
  assert.equal(await decision, "accept");

  assert.deepEqual(h.send(ESCAPE), { consume: true }, "consumed so it cannot reach the editor mid-commit");
  assert.deepEqual(h.send(ESCAPE), { consume: true });
  assert.equal(h.cancelRequests(), 0, "input cannot cancel an accepted fix");

  await h.controller.close();
});

test("each retry opens exactly one fresh gate overlay", async () => {
  const h = controllerHarness();

  const first = h.controller.gate(gateInput);
  await press(h.customCalls[0]!.component, "r");
  assert.equal(await first, "retry");
  h.controller.setPhase("fixing", "applying security fix", 2);

  const second = h.controller.gate({ ...gateInput, attempt: 2 });
  assert.equal(h.customCalls.length, 2);
  assert.notEqual(h.customCalls[1]!.component, h.customCalls[0]!.component, "a disposed gate is never reused");
  assert.match(screen(h.customCalls[1]!.component, DIALOG_WIDTH), /attempt 2/i);

  await press(h.customCalls[1]!.component, "d");
  assert.equal(await second, "discard");
  assert.ok(h.log.includes("settling:discard:true"));

  await h.controller.close();
});

test("close removes the listener and the row detail, and is idempotent", async () => {
  const h = controllerHarness();

  await h.controller.close();
  assert.ok(!h.listenerActive(), "the raw listener is unsubscribed");
  assert.deepEqual(h.log, ["detail:row-key:src/a.ts", "clear:row-key"]);

  const eventsBefore = h.log.length;
  await h.controller.close();
  assert.equal(h.log.length, eventsBefore, "a repeated close is a no-op");
});

test("close during an open gate settles it as discard and cleans everything up", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  assert.equal(h.customCalls.length, 1);
  await h.controller.close();

  assert.equal(await decision, "discard", "the gate resolves instead of leaking");
  assert.ok(!h.listenerActive());
  assert.ok(h.log.includes("clear:row-key"));

  await h.controller.close();
  assert.equal(h.log.filter((e) => e.startsWith("clear:")).length, 1, "still idempotent");
});

test("a rejected gate overlay is reported, settles as discard, and restores working-input routing", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  h.lastCustomCall().reject(new Error("overlay host closed"));
  assert.equal(await decision, "discard", "an unreviewed fix is never kept");
  assert.match(h.notifications.join("\n"), /Fix Now gate dialog failed: overlay host closed/);

  assert.deepEqual(h.send(ESCAPE), { consume: true }, "Escape is the working cancel again");
  assert.equal(h.cancelRequests(), 0, "and it only arms");

  await h.controller.close();
});
