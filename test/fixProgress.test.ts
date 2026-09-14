import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { TerminalInputHandler, Theme } from "@earendil-works/pi-coding-agent";
import {
  FixGate,
  openFixProgress,
  type FixGateDecision,
  type FixGateInput,
  type FixProgressHost,
  type FixProgressTheme,
  type FixProgressUi,
} from "../src/components/FixProgress.ts";
import type { AuditProgressWidget } from "../src/components/AuditProgress.ts";
import { PROMPT_OVERLAY_OPTIONS } from "../src/components/menuChrome.ts";
import type { Finding } from "../src/types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const ESCAPE = "\x1b";
/** Kitty keyboard protocol release event for the Escape key (CSI 27;1:3u). */
const ESCAPE_RELEASE = "\x1b[27;1:3u";
const DOWN = "\x1b[B";
const CTRL_C = "";
const WIDTH = 90;

const theme: FixProgressTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

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

// ── FixGate (one decision overlay per gate) ────────────────────────────────

function gateHarness(input: FixGateInput, rows = 40) {
  const host: FixProgressHost = { requestRender: () => {}, terminal: { rows } };
  const decisions: FixGateDecision[] = [];
  const component = new FixGate(finding, input, theme, host, (decision) => decisions.push(decision));
  return {
    component,
    lines: () => component.render(WIDTH).map(strip),
    press: (key: string) => component.handleInput(key),
    decisions: () => decisions,
  };
}

test("the gate preserves tab indentation in diff lines", () => {
  const ui = gateHarness({
    diff: [
      "@@ -358,3 +358,5 @@ export class MoaProgressWidget implements MoaProgressView {",
      " else s.endedAt = undefined;",
      "+else {",
      "+\t\ts.startedAt ??= Date.now();",
      "+\t\ts.endedAt = undefined;",
      "+}",
    ].join("\n"),
    commitPlanned: true,
    attempt: 1,
  });

  const lines = ui.lines();
  assert.ok(
    lines.some((l) => l.includes("+\t\ts.startedAt ??= Date.now();")),
    "tab-indented added lines must keep their leading tabs",
  );
  assert.ok(
    lines.some((l) => l.includes("+\t\ts.endedAt = undefined;")),
    "every added line in the hunk keeps indentation",
  );
});

test("the gate shows the finding header, verdict, warnings, diff, and decision keys", () => {
  const ui = gateHarness({
    diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    verdictNote: "verifier: fixed — parameterized",
    warnings: ["something to know"],
    commitPlanned: true,
    attempt: 1,
  });

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("Fix Now — src/a.ts")));
  assert.ok(lines.some((l) => l.includes("src/a.ts:12 · security/high")));
  assert.ok(lines.some((l) => l.includes("✓ verifier: fixed")));
  assert.ok(lines.some((l) => l.includes("⚠ something to know")));
  assert.ok(lines.some((l) => l.includes("-const a = 1;")));
  assert.ok(lines.some((l) => l.includes("+const a = 2;")));
  assert.ok(lines.some((l) => l.includes("A accept & commit · R retry · D discard")));
});

test("A resolves accept, and decides exactly once", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });

  ui.press("a");
  assert.deepEqual(ui.decisions(), ["accept"]);

  ui.press("r");
  ui.press("d");
  ui.press(ESCAPE);
  ui.press(ESCAPE);
  assert.deepEqual(ui.decisions(), ["accept"], "input after the decision is inert");
});

test("R and D resolve retry and discard; the accept key relabels when commit is off", () => {
  const retrying = gateHarness({ diff: "+x", commitPlanned: false, attempt: 2 });
  assert.ok(retrying.lines().some((l) => l.includes("A accept (no commit)")));
  assert.ok(retrying.lines().some((l) => l.includes("attempt 2")), "the header carries the attempt number");
  retrying.press("r");
  assert.deepEqual(retrying.decisions(), ["retry"]);

  const discarding = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  discarding.press("d");
  assert.deepEqual(discarding.decisions(), ["discard"]);
});

test("a long diff scrolls and reports what is hidden", () => {
  const diff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
  const ui = gateHarness({ diff, commitPlanned: true, attempt: 1 }, 24);

  assert.ok(ui.lines().some((l) => l.includes("↓") && l.includes("more")));
  ui.press(DOWN);
  ui.press(DOWN);
  assert.ok(ui.lines().some((l) => l.includes("↑ 2 more")));
});

test("Esc Esc discards; a single Esc only arms", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });

  ui.press(ESCAPE);
  assert.ok(ui.lines().some((l) => l.includes("Press Esc again to discard")));
  assert.deepEqual(ui.decisions(), []);
  ui.press(ESCAPE);
  assert.deepEqual(ui.decisions(), ["discard"]);
});

test("an empty diff reads as no changes", () => {
  const ui = gateHarness({ diff: "", commitPlanned: true, attempt: 1 });
  assert.ok(ui.lines().some((l) => l.includes("No changes on disk.")));
});

test("C enters chat mode and shows chat input and key hints", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  assert.equal(ui.component.isInChatMode(), false);
  assert.ok(ui.lines().some((l) => l.includes("C chat / modify")));

  ui.press("c");
  assert.equal(ui.component.isInChatMode(), true);
  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("Enter send · Esc cancel chat")));
});

test("typing in chat mode routes to input and does not trigger A/R/D shortcuts", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.press("c");

  // Type characters including 'a', 'r', 'd'
  ui.press("a");
  ui.press("r");
  ui.press("d");
  assert.deepEqual(ui.decisions(), [], "typing letters must not trigger accept/retry/discard");

  // Enter sends the chat decision
  ui.press("\r");
  assert.deepEqual(ui.decisions(), [{ type: "chat", message: "ard" }]);
});

test("pressing Enter with empty text in chat mode does not decide", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.press("c");
  ui.press("\r");
  ui.press("   ");
  ui.press("\r");
  assert.deepEqual(ui.decisions(), []);
});

test("Escape in chat mode leaves chat mode without arming discard", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.press("c");
  assert.equal(ui.component.isInChatMode(), true);

  ui.press(ESCAPE);
  assert.equal(ui.component.isInChatMode(), false);
  assert.deepEqual(ui.decisions(), []);

  // Now press Escape again in nav mode — this only arms discard
  ui.press(ESCAPE);
  assert.ok(ui.lines().some((l) => l.includes("Press Esc again to discard")));
  assert.deepEqual(ui.decisions(), []);
});

test("renders conversation history cleanly with role styling", () => {
  const ui = gateHarness({
    diff: "+x",
    commitPlanned: true,
    attempt: 1,
    chatHistory: [
      { role: "user", text: "What is the impact on callers?" },
      { role: "assistant", text: "Only test/a.test.ts calls this function." },
    ],
  });

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("You: What is the impact on callers?")));
  assert.ok(lines.some((l) => l.includes("Agent: Only test/a.test.ts calls this function.")));
});

test("bounds long chat history on a short terminal", () => {
  const chatHistory = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `Message number ${i} with detail`,
  }));
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1, chatHistory }, 20);

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("earlier chat lines")));
});

test("propagates focus state to the embedded input widget", () => {
  const ui = gateHarness({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.component.focused = true;
  assert.equal(ui.component.focused, true);
  ui.press("c");
  assert.equal(ui.component.focused, true);
  ui.press(ESCAPE);
  assert.equal(ui.component.focused, true);
});

// ── openFixProgress (raw listener + gate-only overlays + table sink) ───────

interface CustomCall {
  options: unknown;
  component: Component;
  /** Whether the sink already showed a settling state when done fired. */
  settlingAtDone: boolean;
  reject: (error: Error) => void;
}

function controllerHarness(rows = 40, withSink = true) {
  const host: FixProgressHost = { requestRender: () => {}, terminal: { rows } };
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

  const ui: FixProgressUi = {
    onTerminalInput(handler: TerminalInputHandler): () => void {
      inputHandler = handler;
      return () => {
        inputHandler = undefined;
      };
    },
    custom<T>(
      factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component,
      options?: { overlay?: boolean },
    ): Promise<T> {
      const call: CustomCall = {
        options,
        component: undefined as unknown as Component,
        settlingAtDone: false,
        reject: () => {},
      };
      const promise = new Promise<T>((resolve, reject) => {
        call.reject = reject;
        call.component = factory(
          host as unknown as TUI,
          theme as unknown as Theme,
          {} as unknown as KeybindingsManager,
          (value: T) => {
            // done must fire before the sink transitions to its settling state.
            call.settlingAtDone = log.some((entry) => entry.startsWith("settling:"));
            resolve(value);
          },
        );
      });
      customCalls.push(call);
      return promise;
    },
  };

  const controller = openFixProgress(
    { ui },
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
  assert.deepEqual(h.lastCustomCall().options, PROMPT_OVERLAY_OPTIONS);

  // While the gate is open the raw listener leaves every key — Escape
  // included — untouched so the focused overlay receives it.
  assert.equal(h.send("a"), undefined);
  assert.equal(h.send(ESCAPE), undefined);
  assert.equal(h.cancelRequests(), 0, "gate input cannot arm the working cancel");

  const gate = h.lastCustomCall().component as FixGate;
  gate.handleInput("a");
  assert.equal(h.lastCustomCall().settlingAtDone, false, "done fires before the sink settles");
  assert.equal(await decision, "accept");
  assert.ok(h.log.includes("settling:accept:true"), "the row detail shows the settling state after the gate");

  await h.controller.close();
});

test("Escape stays inert once a decision is settling", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  (h.lastCustomCall().component as FixGate).handleInput("a");
  assert.equal(await decision, "accept");

  assert.deepEqual(h.send(ESCAPE), { consume: true }, "consumed so it cannot reach the editor mid-commit");
  assert.deepEqual(h.send(ESCAPE), { consume: true });
  assert.equal(h.cancelRequests(), 0, "input cannot cancel an accepted fix");

  await h.controller.close();
});

test("each retry opens exactly one fresh gate overlay", async () => {
  const h = controllerHarness();

  const first = h.controller.gate(gateInput);
  (h.customCalls[0]!.component as FixGate).handleInput("r");
  assert.equal(await first, "retry");
  h.controller.setPhase("fixing", "applying security fix", 2);

  const second = h.controller.gate({ ...gateInput, attempt: 2 });
  assert.equal(h.customCalls.length, 2);
  assert.notEqual(h.customCalls[1]!.component, h.customCalls[0]!.component, "a disposed gate is never reused");
  assert.ok((h.customCalls[1]!.component as FixGate).render(WIDTH).map(strip).some((l) => l.includes("attempt 2")));

  (h.customCalls[1]!.component as FixGate).handleInput("d");
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

test("a rejected gate overlay restores working-input routing", async () => {
  const h = controllerHarness();

  const decision = h.controller.gate(gateInput);
  h.lastCustomCall().reject(new Error("overlay host closed"));
  await assert.rejects(decision, /overlay host closed/);

  assert.deepEqual(h.send(ESCAPE), { consume: true }, "Escape is the working cancel again");
  assert.equal(h.cancelRequests(), 0, "and it only arms");

  await h.controller.close();
});
