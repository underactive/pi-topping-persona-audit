import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ThemeSource } from "@underactive/pi-topping-opentui/theme";
import type { AuditProgressTable, AuditProgressContext, ProgressHost, ProgressTheme } from "../src/components/AuditProgress.ts";
import { AuditProgressWidget, renderAuditSnapshot } from "../src/components/AuditProgress.ts";
import type { Finding } from "../src/types.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const mountedWidgets = new Set<AuditProgressWidget>();

afterEach(() => {
  for (const widget of mountedWidgets) widget.stop();
  mountedWidgets.clear();
});

const theme: ProgressTheme & ThemeSource = {
  colors: {},
  getColorMode: () => "truecolor",
  fg: (_color, text) => text,
  bold: (text) => text,
};

function openTuiContext() {
  let table: AuditProgressTable | undefined;
  const tui: ProgressHost = { requestRender: () => {}, terminal: { rows: 80 } };
  const ctx: AuditProgressContext = {
    ui: {
      setWidget(_key, content) {
        table?.dispose();
        table = content?.(tui, theme);
      },
    },
  };
  return { ctx, currentTable: () => table };
}

const finding: Finding = {
  reviewer: "Security Engineer",
  file: "src/session.ts",
  line: 42,
  category: "security",
  severity: "high",
  rationale: "SQL string is concatenated from user input",
  suggestedChange: "use a parameterized query",
};

test("OpenTUI progress adapter renders live telemetry and frozen snapshots", () => {
  const { ctx, currentTable } = openTuiContext();
  const widget = new AuditProgressWidget(ctx, "src/", "a1b2c3d", () => undefined);
  mountedWidgets.add(widget);
  widget.addRow("Review", "review:security:1", "Security Engineer", { state: "done", statusText: "812 tokens · 1 finding" });
  widget.applyProgress("review:security:1", {
    contextTokens: 24_000,
    turns: 4,
    toolCalls: 2,
    costUsd: 0.123,
    outputTokens: 1_200,
    outputRevision: 1,
    provider: "anthropic",
    model: "claude-opus-4",
  });
  widget.addRow("Implement", "fix:session", "fix now · src/session.ts:42", { state: "working", statusText: "fixing…" });
  widget.applyProgress("fix:session", {
    contextTokens: 42_000,
    turns: 3,
    toolCalls: 5,
    costUsd: 0.045,
    outputTokens: 900,
    outputRevision: 2,
    activity: 'grep  "handleRequest"',
  });
  widget.setFixNowDetail("fix:session", finding);
  widget.updateFixNowPhase("fix:session", "fixing", "applying security fix", 1);
  widget.setFixNowCancelArmed("fix:session", true);
  widget.addRow("Verify", "verify:tests", "npm run test", { state: "error", statusText: "1 test failed" });
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4", Implement: "openai/gpt-5", Verify: "anthropic/claude-haiku-5" });
  widget.setPhaseThinking({ Review: "high", Implement: "medium", Verify: "low" });
  widget.setActivePhase("Implement");
  widget.setSummary("2 reviewers · 1 finding · fix in progress");
  widget.mount();

  widget.clock.pause();
  assert.equal(widget.isWaiting(), true);
  widget.clock.resume();
  assert.equal(widget.isWaiting(), false);

  const live = currentTable();
  assert.ok(live);
  const rendered = live.render(120).map(strip).join("\n");
  assert.match(rendered, /PERSONA-AUDIT/i);
  assert.match(rendered, /claude-opus-4/);
  assert.match(rendered, /fix now · src\/session\.ts:42/);
  assert.match(rendered, /42\.0K tok/, "unknown context windows show raw usage rather than a guessed percentage");
  assert.match(rendered, /grep\s+"handleRequest"/);
  assert.match(rendered, /security\/high/);
  assert.match(rendered, /Press Esc again to cancel this fix/);
  assert.match(rendered, /1 test failed/);
  assert.match(rendered, /total cost/);

  const snapshot = widget.snapshot();
  const frozen = renderAuditSnapshot(snapshot, theme).render(120).map(strip).join("\n");
  assert.match(frozen, /@a1b2c3d/i);
  assert.doesNotMatch(frozen, /Press Esc again to cancel this fix/);
  assert.doesNotMatch(frozen, /ctrl\+shift\+c/);
  widget.stop();
});
