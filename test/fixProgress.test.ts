import assert from "node:assert/strict";
import { test } from "node:test";
import { FixProgress, type FixGateDecision, type FixProgressHost, type FixProgressTheme } from "../src/components/FixProgress.ts";
import type { Finding } from "../src/types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
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

function harness(rows = 40) {
  const host: FixProgressHost = { requestRender: () => {}, terminal: { rows } };
  let cancelRequests = 0;
  const component = new FixProgress(finding, theme, host, () => cancelRequests++);
  return {
    component,
    lines: () => component.render(WIDTH).map(strip),
    press: (key: string) => component.handleInput(key),
    cancelRequests: () => cancelRequests,
    [Symbol.dispose]: () => component.dispose(),
  };
}

test("the working view names the phase, the finding, and the cancel key", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("Fix Now — src/a.ts")));
  assert.ok(lines.some((l) => l.includes("src/a.ts:12 · security/high")));
  assert.ok(lines.some((l) => l.includes("implementing fix")));
  assert.ok(lines.some((l) => l.includes("Esc Esc cancel fix")));
});

test("telemetry snapshots surface in the working view", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  ui.component.applyProgress({
    contextTokens: 12_000,
    turns: 3,
    toolCalls: 7,
    costUsd: 0.042,
    activity: "edit src/a.ts",
    outputTokens: 900,
    outputRevision: 0,
  });

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("3 turns") && l.includes("7 tools") && l.includes("$0.042")));
  assert.ok(lines.some((l) => l.includes("↳ edit src/a.ts")));
});

test("the gate shows verdict, warnings, diff, and decision keys, and resolves on A", async (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  const decision = ui.component.gate({
    diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    verdictNote: "verifier: fixed — parameterized",
    warnings: ["something to know"],
    commitPlanned: true,
    attempt: 1,
  });
  ui.component.applyProgress({
    contextTokens: 12_000,
    turns: 3,
    toolCalls: 7,
    costUsd: 0.042,
    activity: "verify src/a.ts",
    outputTokens: 900,
    outputRevision: 0,
  });

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("✓ verifier: fixed")));
  assert.ok(lines.some((l) => l.includes("⚠ something to know")));
  assert.ok(lines.some((l) => l.includes("-const a = 1;")));
  assert.ok(lines.some((l) => l.includes("+const a = 2;")));
  assert.ok(lines.some((l) => l.includes("A accept & commit · R retry · D discard")));

  ui.press("a");
  assert.ok(ui.lines().some((l) => l.includes("accepting fix") && l.includes("committing changes")));
  assert.ok(ui.lines().some((l) => l.includes("Please wait…")));
  assert.ok(!ui.lines().some((l) => l.includes("A accept")), "decision footer is gone while accepting");
  assert.ok(!ui.lines().some((l) => l.includes("3 turns") || l.includes("↳ verify src/a.ts")), "stale verifier telemetry is hidden");
  ui.press("a");
  ui.press("r");
  ui.press("d");
  ui.press(ESCAPE);
  ui.press(ESCAPE);
  assert.equal(ui.cancelRequests(), 0, "input cannot cancel or change an accepted fix");
  assert.equal(await decision, "accept");
});

test("accepting without a commit also shows a busy state", async (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  const decision = ui.component.gate({ diff: "+x", commitPlanned: false, attempt: 1 });
  ui.press("a");

  assert.ok(ui.lines().some((l) => l.includes("accepting fix") && l.includes("saving accepted fix")));
  assert.equal(await decision, "accept");
});

test("R and D resolve retry and discard; the accept key relabels when commit is off", async (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  const first = ui.component.gate({ diff: "+x", commitPlanned: false, attempt: 1 });
  assert.ok(ui.lines().some((l) => l.includes("A accept (no commit)")));
  ui.press("r");
  assert.ok(ui.lines().some((l) => l.includes("preparing retry") && l.includes("reverting changes before retry")));
  assert.ok(ui.lines().some((l) => l.includes("Please wait…")));
  assert.equal(await first, "retry");

  const second = ui.component.gate({ diff: "+x", commitPlanned: false, attempt: 2 });
  ui.press("d");
  assert.ok(ui.lines().some((l) => l.includes("discarding fix") && l.includes("reverting changes")));
  assert.equal(await second, "discard");
});

test("a long diff scrolls and reports what is hidden", (t) => {
  const ui = harness(24);
  t.after(() => ui.component.dispose());

  const diff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
  void ui.component.gate({ diff, commitPlanned: true, attempt: 1 });

  assert.ok(ui.lines().some((l) => l.includes("↓") && l.includes("more")));
  ui.press(DOWN);
  ui.press(DOWN);
  assert.ok(ui.lines().some((l) => l.includes("↑ 2 more")));
});

test("Esc Esc during the gate discards; a single Esc only arms", async (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  const decision = ui.component.gate({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.press(ESCAPE);
  assert.ok(ui.lines().some((l) => l.includes("Press Esc again to discard")));
  ui.press(ESCAPE);
  assert.equal(await decision, "discard");
});

test("Esc Esc while the agent works requests a cancel exactly once", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  ui.press(ESCAPE);
  assert.equal(ui.cancelRequests(), 0, "one Esc only arms");
  assert.ok(ui.lines().some((l) => l.includes("Press Esc again to cancel this fix")));
  ui.press(ESCAPE);
  assert.equal(ui.cancelRequests(), 1);
});

test("gate keys are inert while the agent is still working", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  ui.press("a");
  ui.press("d");
  assert.ok(ui.lines().some((l) => l.includes("implementing fix")), "still in the working view");
});

test("an empty diff reads as no changes", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  void ui.component.gate({ diff: "", commitPlanned: true, attempt: 1 });
  assert.ok(ui.lines().some((l) => l.includes("No changes on disk.")));
});

test("retry re-enters the working view with the attempt number", (t) => {
  const ui = harness();
  t.after(() => ui.component.dispose());

  void ui.component.gate({ diff: "+x", commitPlanned: true, attempt: 1 });
  ui.component.setPhase("fixing", "applying security fix", 2);

  const lines = ui.lines();
  assert.ok(lines.some((l) => l.includes("implementing fix") && l.includes("attempt 2")));
  assert.ok(!lines.some((l) => l.includes("A accept")), "the gate footer is gone");
});
