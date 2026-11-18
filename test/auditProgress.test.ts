import assert from "node:assert/strict";
import { after, test } from "node:test";
import { visibleWidth, type TuiMode } from "@earendil-works/pi-tui";
import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";
import {
  AUDIT_PROGRESS_WIDGET_KEY,
  AuditProgressTable,
  AuditProgressWidget,
  formatElapsed,
  formatTokens,
  renderAuditSnapshot,
  totalCost,
  type AuditProgressContext,
  type AuditProgressSnapshot,
  type ProgressHost,
  type ProgressTheme,
} from "../src/components/AuditProgress.ts";
import { FULLSCREEN_WIDGET_RESERVE_ROWS } from "../src/components/viewport.ts";
import type { Finding, HeadlessProgress } from "../src/types.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const CONTEXT_WINDOW = 200_000;

const progressSnapshot = (overrides: Partial<HeadlessProgress> = {}): HeadlessProgress => ({
  contextTokens: 42_000,
  turns: 7,
  toolCalls: 3,
  outputTokens: 1_200,
  outputRevision: 0,
  provider: "anthropic",
  model: "claude-opus-4",
  ...overrides,
});

// A test that fails an assertion before its widget.stop() would leak the
// table's render ticker and keep the process alive; dispose is idempotent, so
// sweeping every table once at the end costs nothing when tests clean up.
const createdTables: AuditProgressTable[] = [];
after(() => {
  for (const table of createdTables) table.dispose();
});

/** Fake extension context mirroring pi's setWidget replace/dispose semantics. */
/** The two members the OpenTUI runtime resolves its palette from; every token paints as the terminal default. */
const PLAIN_THEME: ProgressTheme = { colors: {}, getColorMode: () => "truecolor" };

function fakeCtx(terminalRows = 40, theme: ProgressTheme = PLAIN_THEME, mode?: TuiMode) {
  const state: { table: AuditProgressTable | undefined; mounts: number; disposed: number } = {
    table: undefined,
    mounts: 0,
    disposed: 0,
  };
  let renders = 0;
  const tui: ProgressHost = { requestRender: () => renders++, terminal: { rows: terminalRows }, mode };
  const placements: (WidgetPlacement | undefined)[] = [];
  const keys: string[] = [];

  const ctx: AuditProgressContext = {
    ui: {
      setWidget(key, content, options) {
        keys.push(key);
        // pi disposes the component already registered under a key before
        // installing its replacement, so one key is at most one component.
        if (state.table) {
          state.table.dispose();
          state.table = undefined;
          state.disposed++;
        }
        if (!content) return;
        state.table = content(tui, theme);
        createdTables.push(state.table);
        state.mounts++;
        placements.push(options?.placement);
      },
    },
  };

  return { ctx, state, tui, placements, keys, renderCount: () => renders };
}

function lines(table: AuditProgressTable | undefined, width = 120): string[] {
  assert.ok(table, "expected a mounted table");
  return table.render(width).map(strip);
}

/** The table's rows without the dialog rail down their left edge. */
function content(rendered: string[]): string[] {
  return rendered.map((line) => line.replace(/^▌ ?/, ""));
}

// ── mounting & lifecycle ───────────────────────────────────────────────────

test("widget mounts one aboveEditor table and disposes its ticker on stop", () => {
  const { ctx, state, placements, keys } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/");
  widget.mount();
  widget.mount(); // idempotent

  assert.equal(state.mounts, 1);
  assert.deepEqual(placements, ["aboveEditor"]);
  assert.deepEqual(keys, [AUDIT_PROGRESS_WIDGET_KEY]);

  widget.stop();
  assert.equal(state.disposed, 1, "stopping disposes the table, clearing its render ticker");
  assert.equal(state.table, undefined);
});

test("disposing the table stops its render ticker", async () => {
  const { ctx, state, renderCount } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer");
  widget.startRow("a", "reviewing…");
  widget.mount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(renderCount() > 0, "a mounted table repaints on its own ticker");

  widget.stop();
  const frozen = renderCount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(renderCount(), frozen, "no repaints after dispose");
  assert.equal(state.disposed, 1);
});

// ── row lifecycle ──────────────────────────────────────────────────────────

test("rows move queued → working → done and carry streamed telemetry", () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, undefined, undefined, () => CONTEXT_WINDOW);
  widget.addRow("Review", "review:sec:1", "Security Engineer");

  const queued = widget.progressRows()[0];
  assert.equal(queued?.state, "queued");
  assert.equal(queued?.statusText, "queued");
  assert.equal(queued?.elapsedMs, 0, "a queued row has not started its clock");

  widget.startRow("review:sec:1", "reviewing…");
  widget.applyProgress("review:sec:1", progressSnapshot({ activity: 'grep  "handleRequest"' }));
  const working = widget.progressRows()[0];
  assert.equal(working?.state, "working");
  assert.equal(working?.statusText, "reviewing…");
  assert.equal(working?.turns, 7);
  assert.equal(working?.toolCalls, 3);
  assert.equal(working?.costUsd, undefined);
  assert.equal(working?.contextTokens, 42_000);
  assert.equal(working?.contextWindow, CONTEXT_WINDOW);
  assert.equal(working?.activity, 'grep  "handleRequest"');

  widget.applyProgress("review:sec:1", progressSnapshot({ toolCalls: 4, costUsd: 0.1234 }));
  widget.settleRow("review:sec:1", "done", "812 tokens");
  const done = widget.progressRows()[0];
  assert.equal(done?.state, "done");
  assert.equal(done?.statusText, "812 tokens");
  assert.equal(done?.toolCalls, 4);
  assert.equal(done?.costUsd, 0.1234);
  assert.equal(done?.activity, undefined, "a settled row drops its in-flight tool call");
});

test("settling freezes a row's elapsed reading", async () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "r", "Security Engineer");
  widget.startRow("r");
  await new Promise((resolve) => setTimeout(resolve, 20));
  widget.settleRow("r", "done");

  const first = widget.progressRows()[0]?.elapsedMs ?? 0;
  assert.ok(first > 0, "a started row accrues elapsed time");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(widget.progressRows()[0]?.elapsedMs, first);
});

test("settleOpenRows only touches rows that never finished", () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "done", "cached reviewer", { state: "done", statusText: "cached" });
  widget.addRow("Review", "queued", "queued reviewer");
  widget.addRow("Review", "working", "running reviewer");
  widget.startRow("working");

  widget.settleOpenRows("cancelled", "aborted");
  const byKey = new Map(widget.progressRows().map((r) => [r.key, r]));
  assert.equal(byKey.get("done")?.state, "done");
  assert.equal(byKey.get("done")?.statusText, "cached");
  assert.equal(byKey.get("queued")?.state, "cancelled");
  assert.equal(byKey.get("working")?.state, "cancelled");
  assert.equal(byKey.get("working")?.statusText, "aborted");
});

// ── phase grouping ─────────────────────────────────────────────────────────

test("phase groups keep their data flags and render headings only for non-empty groups", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.addRow("Review", "b", "Slop Auditor", { state: "done" });
  widget.addRow("Triage", "c", "collection", { state: "done" });
  widget.mount();

  const rows = widget.progressRows();
  assert.deepEqual(
    rows.map((r) => [r.phase, r.firstOfPhase]),
    [
      ["Review", true],
      ["Review", false],
      ["Triage", true],
    ],
  );

  const body = content(lines(state.table)).join("\n");
  assert.equal(body.match(/^REVIEW\s*$/gm)?.length, 1, "one Review heading");
  assert.equal(body.match(/^TRIAGE\s*$/gm)?.length, 1, "one Triage heading");
  assert.doesNotMatch(body, /^(IMPLEMENT|VERIFY)\s*$/m, "empty phases have no heading");
  assert.match(body, /Slop Auditor.*\n\s*\nTRIAGE/, "a blank line separates the phase groups");
  assert.ok(!/[├│└]/.test(body), "rendered rows have no tree connectors");
  widget.stop();
});

test("agent rows start with status icons, and a working row's tool call sits under it", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Code Quality Engineer", { state: "done" });
  widget.addRow("Review", "b", "Security Engineer", { state: "done" });
  widget.addRow("Triage", "c", "collection", { state: "done" });
  widget.addRow("Triage", "d", "adjudicator · reconcile");
  widget.startRow("d", "annotating…");
  widget.applyProgress("d", progressSnapshot({ activity: "read  src/audit.ts" }));
  widget.mount();

  const body = content(lines(state.table)).join("\n");
  assert.match(body, /REVIEW\s*\n✓ Code Quality Engineer/);
  assert.match(body, /✓ Security Engineer/);
  assert.match(body, /TRIAGE\s*\n✓ collection/);
  assert.match(body, /\S adjudicator · reconcile.*\n  ↳ read  src\/audit\.ts/, "the tool call is on the row under its agent");
  widget.stop();
});

test("rows render grouped by phase order regardless of insertion order", () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Verify", "v", "npm run test");
  widget.addRow("Review", "r1", "Security Engineer");
  widget.addRow("Implement", "a", "adjudicator · implement");
  widget.addRow("Review", "r2", "Slop Auditor");

  assert.deepEqual(
    widget.progressRows().map((r) => r.key),
    ["r1", "r2", "a", "v"],
  );
});

// ── table chrome & footer ──────────────────────────────────────────────────

test("table renders the header columns, scope and live footer summary", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/");
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.setSummary("3/6 reviewer passes · 12 findings");
  widget.mount();

  const rendered = content(lines(state.table));
  assert.ok(rendered.some((line) => /^PERSONA-AUDIT · SRC\/\s*$/.test(line)), "the title names the scope");
  assert.ok(rendered.some((line) => /AGENT.*CTX.*MONITOR.*ACTIVITY.*TURNS.*TOOLS.*COST.*TIME/.test(line)));
  assert.ok(rendered.some((line) => line.includes("3/6 reviewer passes · 12 findings")), "the summary is shown");
  assert.match(rendered.at(-2) ?? "", /total cost .* · total .*ctrl\+shift\+c cancel/, "totals and the cancel key close the table");
  widget.stop();
});

test("title bar carries the diff base hash after the scope, or alone when the scope is omitted", () => {
  const scoped = fakeCtx();
  const scopedWidget = new AuditProgressWidget(scoped.ctx, "src/components", "a1b2c3d");
  scopedWidget.addRow("Review", "a", "Security Engineer", { state: "done" });
  scopedWidget.mount();
  assert.match(content(lines(scoped.state.table))[1] ?? "", /^PERSONA-AUDIT · SRC\/COMPONENTS · @A1B2C3D\s*$/);
  scopedWidget.stop();

  const unscoped = fakeCtx();
  const unscopedWidget = new AuditProgressWidget(unscoped.ctx, undefined, "a1b2c3d");
  unscopedWidget.addRow("Review", "a", "Security Engineer", { state: "done" });
  unscopedWidget.mount();
  assert.match(content(lines(unscoped.state.table))[1] ?? "", /^PERSONA-AUDIT · @A1B2C3D\s*$/);
  unscopedWidget.stop();
});

// ── responsive layout ──────────────────────────────────────────────────────

test("a narrow table sheds the stats columns before it squeezes the agent label", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done", statusText: "812 tokens" });
  widget.mount();

  const header = (width: number) => lines(state.table, width).find((line) => line.includes("AGENT")) ?? "";
  assert.match(header(120), /TURNS.*TOOLS.*COST.*TIME/, "a wide table has the stats columns");
  assert.doesNotMatch(header(80), /TURNS|TOOLS|COST|TIME/, "the ambient stats go first at 80 columns");
  assert.ok(lines(state.table, 80).some((line) => line.includes("Security Engineer")), "the label is kept whole");
  assert.ok(lines(state.table, 80).some((line) => line.includes("812 tokens")), "so is the status");
  widget.stop();
});

test("rendered lines never exceed the requested width", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/components");
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.addRow("Review", "b", "Slop Auditor");
  widget.startRow("b", "reviewing…");
  widget.applyProgress("b", progressSnapshot({ activity: "bash  npm run check -- --verbose --project tsconfig.json" }));
  widget.setSummary("1/2 reviewer passes");
  widget.mount();

  for (const width of [30, 48, 72, 100, 160]) {
    for (const line of lines(state.table, width)) {
      assert.ok(
        visibleWidth(line) <= Math.max(20, width),
        `line overflowed at width ${width}: ${visibleWidth(line)} > ${width}`,
      );
    }
  }
  widget.stop();
});

// ── height budget ──────────────────────────────────────────────────────────

test("a short terminal drops activity sub-rows and placeholders before base rows", () => {
  const tall = fakeCtx(40);
  const tallWidget = new AuditProgressWidget(tall.ctx);
  const short = fakeCtx(10);
  const shortWidget = new AuditProgressWidget(short.ctx);

  for (const widget of [tallWidget, shortWidget]) {
    for (const key of ["a", "b", "c", "d"]) {
      widget.addRow("Review", key, `reviewer ${key}`);
      widget.startRow(key, "reviewing…");
      widget.applyProgress(key, progressSnapshot({ activity: `read  src/${key}.ts` }));
    }
    widget.mount();
  }

  const tallLines = lines(tall.state.table);
  const shortLines = lines(short.state.table);
  assert.equal(tallLines.filter((l) => l.includes("↳")).length, 4, "a tall terminal shows every tool call");
  assert.equal(shortLines.filter((l) => l.includes("↳")).length, 0);
  for (const key of ["a", "b", "c", "d"]) {
    assert.ok(
      shortLines.some((l) => l.includes(`reviewer ${key}`)),
      "base rows survive the height budget",
    );
  }

  tallWidget.stop();
  shortWidget.stop();
});

test("phase headings consume height budget before activity sub-rows", () => {
  const { ctx, state } = fakeCtx(40);
  const widget = new AuditProgressWidget(ctx);
  for (const phase of ["Review", "Triage", "Implement", "Verify"] as const) {
    const count = phase === "Review" ? 5 : 1;
    for (let i = 0; i < count; i++) {
      const key = `${phase}:${i}`;
      widget.addRow(phase, key, `${phase} agent ${i}`);
      widget.startRow(key, "working…");
      widget.applyProgress(key, progressSnapshot({ activity: `read  ${phase}/${i}.ts` }));
    }
  }
  widget.mount();

  const rendered = content(lines(state.table));
  assert.equal(rendered.filter((line) => /^(REVIEW|TRIAGE|IMPLEMENT|VERIFY)\s*$/.test(line)).length, 4);
  assert.equal(rendered.filter((line) => line.includes("↳")).length, 0, "phase headings leave no activity slots at the budget limit");
  for (let i = 0; i < 5; i++) assert.ok(rendered.some((line) => line.includes(`Review agent ${i}`)), "every working row is kept");
  widget.stop();
});

/** A review phase far past any terminal's budget: settled, queued, live and failed passes. */
function overBudgetReviewWidget(ctx: AuditProgressContext): AuditProgressWidget {
  const widget = new AuditProgressWidget(ctx);
  for (let i = 0; i < 100; i++) {
    widget.addRow("Review", `done:${i}`, `done reviewer ${i}`);
    widget.startRow(`done:${i}`, "reviewing…");
    widget.settleRow(`done:${i}`, "done", "812 tokens");
  }
  for (let i = 0; i < 98; i++) widget.addRow("Review", `queued:${i}`, `queued reviewer ${i}`);
  widget.addRow("Review", "live", "live reviewer");
  widget.startRow("live", "reviewing…");
  widget.addRow("Review", "boom", "failed reviewer");
  widget.startRow("boom", "reviewing…");
  widget.settleRow("boom", "error", "crashed");
  return widget;
}

test("an over-budget review phase folds done and queued passes into summary rows", () => {
  const { ctx, state } = fakeCtx(40);
  const widget = overBudgetReviewWidget(ctx);
  widget.mount();

  const rendered = lines(state.table);
  assert.ok(rendered.some((l) => l.includes("100 passes done")), "settled passes fold into one row");
  assert.ok(rendered.some((l) => l.includes("98 queued")), "queued passes fold into one row");
  assert.ok(rendered.some((l) => l.includes("live reviewer")), "a working pass stays expanded");
  assert.ok(rendered.some((l) => l.includes("failed reviewer")), "a failed pass stays expanded");
  assert.ok(!rendered.some((l) => l.includes("done reviewer 0")), "individual settled passes fold away");
  assert.ok(!rendered.some((l) => l.includes("queued reviewer 0")), "individual queued passes fold away");
  assert.ok(rendered.length <= 20, `the table stays inside its row budget, got ${rendered.length} lines`);

  widget.stop();
});

test("a review phase inside the budget renders every row untouched", () => {
  const { ctx, state } = fakeCtx(40);
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "settled reviewer");
  widget.startRow("a", "reviewing…");
  widget.settleRow("a", "done", "812 tokens");
  widget.addRow("Review", "b", "waiting reviewer");
  widget.addRow("Review", "c", "live reviewer");
  widget.startRow("c", "reviewing…");
  widget.mount();

  const rendered = lines(state.table);
  for (const label of ["settled reviewer", "waiting reviewer", "live reviewer"]) {
    assert.ok(rendered.some((l) => l.includes(label)), `${label} renders in full`);
  }
  assert.ok(!rendered.some((l) => l.includes("passes done")), "an under-budget table grows no summary rows");

  widget.stop();
});

test("a frozen snapshot renders every row, since it has no terminal to budget against", () => {
  const { ctx } = fakeCtx(40);
  const widget = overBudgetReviewWidget(ctx);
  const snapshot = widget.snapshot();
  widget.stop();

  const theme = PLAIN_THEME;
  const frozen = renderAuditSnapshot(snapshot, theme).render(120).map(strip);

  assert.equal(snapshot.rows.length, 200, "the snapshot keeps the full row list");
  for (const label of ["done reviewer 0", "done reviewer 99", "queued reviewer 97", "live reviewer", "failed reviewer"]) {
    assert.ok(frozen.some((l) => l.includes(label)), `${label} survives into the frozen transcript`);
  }
  assert.ok(!frozen.some((l) => l.includes("passes done")), "a frozen transcript folds nothing");
});

/** Eight settled passes: inside a 40-row terminal's half-height budget, past it once pi's dock is taken off. */
function eightSettledWidget(ctx: AuditProgressContext): AuditProgressWidget {
  const widget = new AuditProgressWidget(ctx);
  for (let i = 0; i < 8; i++) {
    widget.addRow("Review", `done:${i}`, `done reviewer ${i}`);
    widget.startRow(`done:${i}`, "reviewing…");
    widget.settleRow(`done:${i}`, "done", "812 tokens");
  }
  return widget;
}

test("in fullscreen the table budgets against the rows above pi's dock", () => {
  const regular = fakeCtx(40, undefined, "regular");
  const fullscreen = fakeCtx(40, undefined, "fullscreen");
  const regularWidget = eightSettledWidget(regular.ctx);
  const fullscreenWidget = eightSettledWidget(fullscreen.ctx);
  regularWidget.mount();
  fullscreenWidget.mount();

  const regularLines = lines(regular.state.table);
  const fullscreenLines = lines(fullscreen.state.table);
  assert.ok(regularLines.some((l) => l.includes("done reviewer 7")), "eight passes fit a regular 40-row budget");
  assert.ok(fullscreenLines.some((l) => l.includes("8 passes done")), "the same passes fold once the dock's rows are reserved");
  const budget = Math.floor((40 - FULLSCREEN_WIDGET_RESERVE_ROWS) * 0.5);
  assert.ok(fullscreenLines.length <= budget, `the table stays inside the rows above the dock, got ${fullscreenLines.length} lines`);

  regularWidget.stop();
  fullscreenWidget.stop();
});

test("a regular host budgets exactly like a host that reports no mode", () => {
  const regular = fakeCtx(40, undefined, "regular");
  const unknown = fakeCtx(40);
  const regularWidget = eightSettledWidget(regular.ctx);
  const unknownWidget = eightSettledWidget(unknown.ctx);
  regularWidget.mount();
  unknownWidget.mount();

  assert.deepEqual(lines(regular.state.table), lines(unknown.state.table));

  regularWidget.stop();
  unknownWidget.stop();
});

test("the table re-budgets when pi switches renderer under a mounted widget", () => {
  const { ctx, state, tui } = fakeCtx(40, undefined, "fullscreen");
  const widget = eightSettledWidget(ctx);
  widget.mount();
  assert.ok(lines(state.table).some((l) => l.includes("8 passes done")), "fullscreen folds the passes");

  tui.mode = "regular";
  assert.ok(lines(state.table).some((l) => l.includes("done reviewer 7")), "the next render reads the new mode and unfolds them");

  widget.stop();
});

test("a short fullscreen terminal floors the budget at the table's chrome", () => {
  const twoSettled = (rows: number, mode: TuiMode): string[] => {
    const { ctx, state } = fakeCtx(rows, undefined, mode);
    const widget = new AuditProgressWidget(ctx);
    for (const key of ["a", "b"]) {
      widget.addRow("Review", key, `settled reviewer ${key}`);
      widget.startRow(key, "reviewing…");
      widget.settleRow(key, "done", "812 tokens");
    }
    widget.mount();
    const rendered = lines(state.table);
    widget.stop();
    return rendered;
  };
  // A regular 10-row terminal's half-height budget is exactly the chrome floor.
  const atFloor = twoSettled(10, "regular");

  // 12 rows leave 7 above the dock and 9 leave 4; both budgets fall under the chrome floor.
  for (const rows of [12, 9]) {
    const rendered = twoSettled(rows, "fullscreen");
    assert.deepEqual(rendered, atFloor, `a ${rows}-row fullscreen table renders like one at the chrome floor`);
    assert.ok(rendered.some((l) => l.includes("2 passes done")), "the folded summary still renders");
  }
});

// ── cell formatting ────────────────────────────────────────────────────────

test("the context column shows a percentage when the window is known and raw tokens otherwise", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, undefined, undefined, (provider) => (provider === "known" ? CONTEXT_WINDOW : undefined));
  widget.addRow("Review", "a", "windowed", { state: "done" });
  widget.applyProgress("a", progressSnapshot({ contextTokens: 42_000, provider: "known" }));
  widget.addRow("Review", "b", "unwindowed", { state: "done" });
  widget.applyProgress("b", progressSnapshot({ contextTokens: 12_345, provider: "other" }));
  widget.addRow("Review", "c", "idle", { state: "queued" });
  widget.mount();

  const rendered = lines(state.table, 120);
  assert.match(rendered.find((line) => line.includes("windowed") && !line.includes("unwindowed")) ?? "", /21\.0%\/200\.0K/);
  assert.match(rendered.find((line) => line.includes("unwindowed")) ?? "", /12\.3K tok/);
  assert.match(rendered.find((line) => line.includes("idle")) ?? "", /idle\s+—/);
  widget.stop();
});

test("formatTokens and formatElapsed use compact, non-rolling units", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(2_000_000), "2.0M");
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(3_725_000), "62:05", "minutes keep counting past an hour");
});

test("totalCost sums valid telemetry and marks missing or invalid rows incomplete", () => {
  const rows = [
    { costUsd: 0.1234 },
    { costUsd: 0.5 },
    {},
    { costUsd: Number.NaN },
    { costUsd: -1 },
  ] as Parameters<typeof totalCost>[0];
  assert.deepEqual(totalCost(rows), { costUsd: 0.6234, incomplete: true });
  assert.deepEqual(totalCost([{ costUsd: 0.25 }] as Parameters<typeof totalCost>[0]), { costUsd: 0.25, incomplete: false });
});

test("stats columns render right-aligned turns, tool calls, cost, and elapsed time", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.applyProgress("a", progressSnapshot({ turns: 7, toolCalls: 3, costUsd: 0.1234 }));
  widget.mount();

  const dataLine = lines(state.table, 120).find((line) => line.includes("Security Engineer"));
  assert.ok(dataLine, "expected a data row");
  assert.match(dataLine.trimEnd(), /\s7\s{6}3\s{3}\$0\.123\s{3}0:00$/, `stats should be right-aligned: ${JSON.stringify(dataLine)}`);
  widget.stop();
});

// ── phase/model band ────────────────────────────────────────────────────────

test("band is suppressed entirely when no phase has an assigned model", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.mount();

  const rendered = content(lines(state.table));
  assert.match(rendered[1] ?? "", /^PERSONA-AUDIT/, "the title is unaffected");
  assert.match(rendered[3] ?? "", /AGENT.*CTX.*MONITOR/, "the header row follows the title directly");
  widget.stop();
});

test("phase/model band renders all four phases and their assigned models above the header", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.setPhaseModels({
    Review: "anthropic/claude-opus-4",
    Triage: "anthropic/claude-opus-4",
    Implement: "openai/gpt-5",
    // Verify intentionally left unset.
  });
  widget.mount();

  const rendered = content(lines(state.table));
  const headerIndex = rendered.findIndex((l) => /AGENT.*CTX.*MONITOR/.test(l));
  assert.equal(headerIndex, 6, "two band rows plus their rule push the header down three rows");
  const band = rendered.slice(3, 5).join("\n");
  for (const phase of ["Review", "Triage", "Implement", "Verify"]) {
    assert.ok(band.includes(phase), `band shows phase name "${phase}"`);
  }
  assert.ok(band.includes("claude-opus-4"));
  assert.ok(band.includes("gpt-5"));
  assert.ok(band.includes("default"), 'an unset phase falls back to "default"');
  widget.stop();
});

test("the band marks the active phase, done phases and pending ones, and a frozen copy stops its spinner", () => {
  const { ctx, state } = fakeCtx(40, {
    colors: { accent: { kind: "rgb", r: 238, g: 238, b: 17 } },
    getColorMode: () => "truecolor",
  });
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.addRow("Triage", "b", "adjudicator", { state: "working" });
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4", Triage: "anthropic/claude-opus-4" });
  widget.setActivePhase("Triage");
  widget.mount();

  const band = content(lines(state.table))[3] ?? "";
  assert.match(band, /✓ Review/, "a phase before the active one is done");
  assert.match(band, /[◐◓◑◒▖▘▝▗] Triage/, "the live active phase spins");
  assert.match(band, /○ Implement.*○ Verify/, "later phases are pending");
  const rawBand = state.table!.render(120)[3] ?? "";
  assert.ok(rawBand.includes("\u001b[38;2;238;238;17m"), "the accent is carried by the active chip's inverse background");
  assert.match(rawBand, /\u001b\[[0-9;]*7m/, "active text uses inverse video for contrast");

  const frozenBand = content(renderAuditSnapshot(widget.snapshot(), PLAIN_THEME).render(120).map(strip))[3] ?? "";
  assert.match(frozenBand, /✓ Review/, "a frozen copy reads a settled phase as done");
  assert.doesNotMatch(frozenBand, /[◐◓◑◒▖▘▝▗]/, "and has no active phase to spin");
  widget.stop();
});

test("a narrow terminal drops the band even when models are assigned", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4" });
  widget.mount();

  const headerRow = (width: number) => content(lines(state.table, width)).findIndex((line) => /AGENT.*CTX.*MONITOR/.test(line));
  assert.equal(headerRow(54), 3, "body 50 → 11 columns a phase, under the 12-column floor: no band");
  assert.equal(headerRow(56), 6, "body 52 → 12 columns a phase: the band pushes the header down");
  widget.stop();
});

test("rendered lines never exceed the requested width with the band present", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/components");
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.addRow("Review", "b", "Slop Auditor");
  widget.startRow("b", "reviewing…");
  widget.applyProgress("b", progressSnapshot({ activity: "bash  npm run check -- --verbose --project tsconfig.json" }));
  widget.setPhaseModels({
    Review: "anthropic/claude-opus-4",
    Triage: "anthropic/claude-opus-4",
    Implement: "anthropic/claude-opus-4",
    Verify: "anthropic/claude-opus-4",
  });
  widget.setSummary("1/2 reviewer passes");
  widget.mount();

  for (const width of [30, 48, 60, 72, 100, 160]) {
    for (const line of lines(state.table, width)) {
      assert.ok(
        visibleWidth(line) <= Math.max(20, width),
        `line overflowed at width ${width}: ${visibleWidth(line)} > ${width}`,
      );
    }
  }
  widget.stop();
});

// ── frozen transcript snapshot ─────────────────────────────────────────────

test("snapshot survives a JSON round-trip and renderAuditSnapshot redraws the settled table", async () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/components", "a1b2c3d");
  widget.addRow("Review", "a", "Security Engineer");
  widget.startRow("a", "reviewing…");
  widget.applyProgress("a", progressSnapshot({ outputTokens: 500 }));
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4" });
  widget.setPhaseThinking({ Review: "high" });
  widget.setSummary("1/1 reviewer passes · 3 findings");
  widget.mount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  widget.settleRow("a", "done", "812 chars");

  const snapshot = widget.snapshot();
  const roundTripped: AuditProgressSnapshot = JSON.parse(JSON.stringify(snapshot));
  widget.stop();

  assert.equal(roundTripped.meterLevels.a?.length, 8, "the meter trace round-trips at full width");
  assert.deepEqual(roundTripped.phaseThinking, { Review: "high" });

  const frozenLines = renderAuditSnapshot(roundTripped, PLAIN_THEME).render(120).map(strip);
  assert.ok(frozenLines.some((l) => l.includes("Security Engineer")), "settled row survives the round trip");
  assert.ok(frozenLines.some((l) => l.includes("1/1 reviewer passes")), "footer summary survives the round trip");
  assert.ok(frozenLines.some((l) => l.includes("SRC/COMPONENTS · @A1B2C3D")), "scope and base hash survive the round trip");
  assert.ok(frozenLines.some((l) => l.includes("claude-opus-4")), "band survives the round trip");
  assert.ok(!frozenLines.some((l) => l.includes("ctrl+shift+c")), "a frozen copy offers no cancel key");
});

test("the meter resolves thinking-level colours per phase and preserves fixed colours", () => {
  // Distinct colours for the tokens in play, so each shows up as its own truecolor escape.
  const colourful: ProgressTheme = {
    colors: { thinkingHigh: rgb("#11ee11"), thinkingLow: rgb("#1111ee"), error: rgb("#ee1111"), accent: rgb("#eeee11") },
    getColorMode: () => "truecolor",
  };
  const snapshot: AuditProgressSnapshot = {
    summary: "done",
    phaseModels: {},
    phaseThinking: { Review: "high", Triage: "low" },
    rows: [{
      key: "a",
      phase: "Review",
      label: "Security Engineer",
      state: "done",
      statusText: "812 tokens",
      elapsedMs: 1_000,
      turns: 3,
      outputTokens: 500,
      outputRevision: 0,
      firstOfPhase: true,
    }, {
      key: "b",
      phase: "Triage",
      label: "collection",
      state: "done",
      statusText: "done",
      elapsedMs: 1_000,
      turns: 0,
      outputTokens: 0,
      outputRevision: 0,
      firstOfPhase: true,
    }],
    // A non-idle cell is the only one that takes the configured colour; idle cells stay dim.
    meterLevels: {
      a: [0, 0, 0, 0, 0, 0, 0, 7],
      b: [0, 0, 0, 0, 0, 0, 0, 7],
    },
  };
  const rowOf = (rendered: string[], label: string) => rendered.find((line) => strip(line).includes(label)) ?? "";

  const thinking = renderAuditSnapshot(snapshot, colourful, { color: "thinkingLevel", direction: "ltr" }).render(120);
  assert.ok(rowOf(thinking, "Security Engineer").includes(escape("#11ee11")), "a high-thinking phase's meter");
  assert.ok(rowOf(thinking, "collection").includes(escape("#1111ee")), "a low-thinking phase's meter");

  const configured = renderAuditSnapshot(snapshot, colourful, { color: "error", direction: "ltr" }).render(120);
  assert.ok(rowOf(configured, "Security Engineer").includes(escape("#ee1111")), "a fixed colour replaces the thinking colour");
  assert.ok(rowOf(configured, "collection").includes(escape("#ee1111")));
  assert.ok(!rowOf(configured, "Security Engineer").includes(escape("#11ee11")));

  const legacySnapshot: AuditProgressSnapshot = {
    summary: snapshot.summary,
    phaseModels: snapshot.phaseModels,
    rows: snapshot.rows,
    meterLevels: snapshot.meterLevels,
  };
  const fallback = renderAuditSnapshot(legacySnapshot, colourful).render(120);
  assert.ok(rowOf(fallback, "Security Engineer").includes(escape("#eeee11")), "without settings the default accent colour is used");
  const legacy = renderAuditSnapshot(legacySnapshot, PLAIN_THEME).render(120).map(strip).join("\n");
  assert.match(legacy, /Security Engineer.*3\s+0\s+—\s+0:01/, "legacy rows default missing telemetry to 0 and —");
});

test("a frozen snapshot render never starts a ticker", () => {
  const originalSetInterval = globalThis.setInterval;
  let calls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    calls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;
  try {
    const theme = PLAIN_THEME;
    const snapshot: AuditProgressSnapshot = { summary: "completed", phaseModels: {}, rows: [], meterLevels: {} };
    renderAuditSnapshot(snapshot, theme).render(120);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  assert.equal(calls, 0, "the frozen table must not start its own ticker");
});

// ── total run time ─────────────────────────────────────────────────────────

/** A pi colour value from `#rrggbb`. */
const rgb = (hex: string) => ({ kind: "rgb" as const, r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
/** The SGR parameters a truecolor foreground of `#rrggbb` is written with. */
const escape = (hex: string) => `38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;

/** A frozen table's run summary and its totals row. */
const footerOf = (snapshot: AuditProgressSnapshot, width: number): { summary: string; totals: string } => {
  const rendered = content(renderAuditSnapshot(snapshot, PLAIN_THEME).render(width).map(strip));
  return {
    summary: rendered.find((line) => line.startsWith("▌ ")) ?? "",
    totals: rendered.find((line) => line.startsWith("total cost")) ?? "",
  };
};

test("the footer keeps the run summary whole and the totals on the row under the rule", () => {
  const footer = footerOf(
    { summary: "3/3 reviewer passes · 12 findings", totalMs: 697_000, phaseModels: {}, rows: [], meterLevels: {} },
    120,
  );
  assert.match(footer.summary, /3\/3 reviewer passes · 12 findings/, "summary is kept");
  assert.equal(footer.totals.trimEnd(), "total cost $0.000 · total 11:37", "cost and the elapsed total share the totals row");
});

test("a long summary is never truncated to make room for the totals", () => {
  const summary = "12/12 reviewer passes · 40 findings · 18 accepted · fixes 18/18 landed · verify 3/3 · 1 rejected";
  const footer = footerOf({ summary, totalMs: 3_600_000, phaseModels: {}, rows: [], meterLevels: {} }, 110);
  assert.ok(footer.summary.includes("verify 3/3 · 1 rejected"), "the summary is not truncated");
  assert.equal(footer.totals.trimEnd(), "total cost $0.000 · total 60:00", "minutes never roll into hours");
});

test("the footer shows excluded user wait and preserves legacy snapshots", () => {
  const waiting = footerOf(
    { summary: "3/3 reviewer passes · 12 findings", totalMs: 697_000, waitingMs: 125_000, phaseModels: {}, rows: [], meterLevels: {} },
    120,
  );
  assert.equal(waiting.totals.trimEnd(), "total cost $0.000 · total 11:37 (+2:05 waiting)");

  const legacy = footerOf(
    { summary: "3/3 reviewer passes · 12 findings", totalMs: 697_000, phaseModels: {}, rows: [], meterLevels: {} },
    120,
  );
  assert.equal(legacy.totals.trimEnd(), "total cost $0.000 · total 11:37");
});

test("the footer shows complete and partial aggregate costs for live and frozen rows", () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "known", "known", { state: "done" });
  widget.addRow("Triage", "missing", "missing", { state: "cancelled" });
  widget.applyProgress("known", progressSnapshot({ costUsd: 0.1234 }));
  assert.deepEqual(widget.totalCost(), { costUsd: 0.1234, incomplete: true });

  const partial = footerOf({ ...widget.snapshot(), totalMs: 697_000 }, 160);
  assert.ok(partial.totals.includes("total cost $0.123* · total 11:37"));

  const complete = footerOf(
    {
      summary: "done",
      totalMs: 0,
      phaseModels: {},
      rows: [
        { ...widget.progressRows()[0]!, costUsd: 0.25 },
        { ...widget.progressRows()[1]!, costUsd: 0.5 },
      ],
      meterLevels: {},
    },
    160,
  );
  assert.ok(complete.totals.includes("total cost $0.750 · total 0:00"));
  assert.ok(!complete.totals.includes("$0.750*"));

  const allMissing = footerOf(
    { summary: "done", totalMs: 0, phaseModels: {}, rows: widget.progressRows().map(({ costUsd: _costUsd, ...row }) => row), meterLevels: {} },
    160,
  );
  assert.ok(allMissing.totals.includes("total cost $0.000* · total 0:00"));
});

test("total run time keeps running while mounted and freezes once the widget stops", async () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src");
  assert.equal(widget.totalMs(), 0, "the clock does not start before the widget mounts");

  widget.mount();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const running = widget.totalMs();
  assert.ok(running >= 25, `the clock runs while mounted: ${running}`);

  const captured = widget.snapshot().totalMs;
  widget.stop();
  const frozen = widget.totalMs();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(widget.totalMs(), frozen, "the clock is frozen after stop()");
  assert.ok((captured ?? 0) >= running, "the snapshot captures the run's duration");
});

test("row and total clocks exclude a paused user-decision span", async () => {
  const { ctx } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "r", "Security Engineer");
  widget.mount();
  widget.startRow("r");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const beforePause = widget.totalMs();
  widget.clock.pause();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(widget.totalMs() - beforePause < 10, "the live total stays frozen while waiting");
  widget.clock.resume();

  const elapsed = widget.progressRows()[0]?.elapsedMs ?? 0;
  assert.ok(elapsed < 40, `the row excludes the paused span: ${elapsed}`);
  assert.ok(Math.abs(widget.totalMs() - beforePause) < 15, "the total excludes the paused span");
  widget.stop();
});

// ── fix-now nested detail ──────────────────────────────────────────────────

const fixNowFinding: Finding = {
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "SQL string is concatenated from user input",
  suggestedChange: "use a parameterized query",
};

/** A mounted widget with one working fix-now row carrying its nested detail. */
function fixNowHarness(terminalRows = 40, finding: Finding = fixNowFinding) {
  const { ctx, state } = fakeCtx(terminalRows);
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Implement", "fix", `fix now · ${finding.file}:${finding.line}`, { state: "working" });
  widget.setFixNowDetail("fix", finding);
  widget.mount();
  return {
    widget,
    rendered: () => lines(state.table),
    /** Line indexes of the row and its nested block, in render order. */
    indexes: () => {
      const rendered = lines(state.table);
      const at = (needle: string) => rendered.findIndex((l) => l.includes(needle));
      return { row: at("fix now ·"), meta: at("security/high"), status: at("implementing fix"), hint: at("esc cancel fix") };
    },
  };
}

test("the fix-now detail nests meta, rationale, phase status, and cancel hint under its row", () => {
  const h = fixNowHarness();
  h.widget.updateFixNowPhase("fix", "fixing", "applying security fix", 1);

  const rendered = h.rendered();
  assert.ok(rendered.some((l) => l.includes("security/high")), "meta line");
  assert.ok(rendered.some((l) => l.includes("SQL string is concatenated from user input")), "rationale line");
  assert.ok(rendered.some((l) => l.includes("implementing fix · applying security fix")), "phase status line");
  assert.ok(rendered.some((l) => l.includes("esc cancel fix")), "cancel hint");

  const idx = h.indexes();
  assert.ok(idx.row >= 0 && idx.meta > idx.row && idx.status > idx.meta && idx.hint > idx.status, "nested lines sit under the row, in order");

  h.widget.stop();
});

test("phase updates rewrite the status line and carry the attempt number", () => {
  const h = fixNowHarness();
  h.widget.updateFixNowPhase("fix", "verifying", "checking the fix", 2);

  const rendered = h.rendered();
  assert.ok(rendered.some((l) => l.includes("verifying fix · checking the fix")));
  assert.ok(rendered.some((l) => l.includes("security/high · attempt 2")), "the meta line carries the attempt");

  h.widget.stop();
});

test("arming the cancel gesture swaps the hint, disarming restores it", () => {
  const h = fixNowHarness();
  h.widget.setFixNowCancelArmed("fix", true);
  assert.ok(h.rendered().some((l) => l.includes("Press Esc again to cancel this fix — clean edits will be reverted")));

  h.widget.setFixNowCancelArmed("fix", false);
  const rendered = h.rendered();
  assert.ok(rendered.some((l) => l.includes("esc cancel fix")));
  assert.ok(!rendered.some((l) => l.includes("Press Esc again")), "the armed warning is gone");

  h.widget.stop();
});

test("settling shows the decision's busy state and Please wait", () => {
  const committing = fixNowHarness();
  committing.widget.updateFixNowSettling("fix", "accept", true);
  let rendered = committing.rendered();
  assert.ok(rendered.some((l) => l.includes("accepting fix · committing changes")));
  assert.ok(rendered.some((l) => l.includes("Please wait…")));
  assert.ok(!rendered.some((l) => l.includes("esc cancel fix")), "no cancel hint once decided");
  committing.widget.stop();

  const saving = fixNowHarness();
  saving.widget.updateFixNowSettling("fix", "accept", false);
  assert.ok(saving.rendered().some((l) => l.includes("accepting fix · saving accepted fix")));
  saving.widget.stop();

  const retrying = fixNowHarness();
  retrying.widget.updateFixNowSettling("fix", "retry", true);
  rendered = retrying.rendered();
  assert.ok(rendered.some((l) => l.includes("preparing retry · reverting changes before retry")));
  assert.ok(rendered.some((l) => l.includes("Please wait…")));
  retrying.widget.stop();

  const discarding = fixNowHarness();
  discarding.widget.updateFixNowSettling("fix", "discard", true);
  assert.ok(discarding.rendered().some((l) => l.includes("discarding fix · reverting changes")));
  discarding.widget.stop();
});

test("a long rationale is capped at three wrapped lines with a trailing ellipsis", () => {
  const long = fixNowHarness(40, {
    ...fixNowFinding,
    rationale: "word ".repeat(200).trim(),
  });

  const rationaleLines = long.rendered().filter((l) => l.includes("word"));
  assert.equal(rationaleLines.length, 3, "the rationale never takes more than three lines");
  assert.ok(rationaleLines[2]?.includes("…"), "the last kept line is marked truncated");

  long.widget.stop();
});

test("the tool-activity sub-row still renders alongside the detail block", () => {
  const h = fixNowHarness(40);
  h.widget.updateFixNowPhase("fix", "fixing", "applying security fix", 1);
  h.widget.applyProgress("fix", progressSnapshot({ activity: "edit  src/a.ts" }));

  const rendered = h.rendered();
  assert.ok(rendered.some((l) => l.includes("↳") && l.includes("edit  src/a.ts")), "activity sub-row");
  assert.ok(rendered.some((l) => l.includes("implementing fix")), "detail block");

  h.widget.stop();
});

test("settling the row clears its detail, and snapshots never carry it", () => {
  const h = fixNowHarness();
  h.widget.settleRow("fix", "done", "fixed");
  assert.ok(!h.rendered().some((l) => l.includes("security/high") || l.includes("esc cancel fix")), "a settled row renders no detail");

  const withDetail = fixNowHarness();
  const snap = withDetail.widget.snapshot();
  assert.ok(snap.rows.every((row) => row.fixNowDetail === undefined), "the frozen transcript copy drops live detail");
  withDetail.widget.stop();

  h.widget.stop();
});

test("a short terminal sheds the rationale, then the meta line, before the status and hint", () => {
  const tall = fixNowHarness(40);
  const tallRendered = tall.rendered();
  assert.ok(tallRendered.some((l) => l.includes("SQL string")), "tall terminal shows the rationale");
  tall.widget.stop();

  // 30 rows → a 15-row budget leaves the block 3 rows: meta survives, rationale sheds.
  const short = fixNowHarness(30);
  const shortRendered = short.rendered();
  assert.ok(!shortRendered.some((l) => l.includes("SQL string")), "rationale sheds first");
  assert.ok(shortRendered.some((l) => l.includes("security/high")), "meta survives");
  assert.ok(shortRendered.some((l) => l.includes("implementing fix")), "phase status is kept");
  assert.ok(shortRendered.some((l) => l.includes("esc cancel fix")), "cancel hint is kept");
  assert.ok(shortRendered.some((l) => l.includes("fix now · src/a.ts:12")), "the agent row itself is untouched");
  short.widget.stop();

  // 20 rows → the block has only its two floor rows: the meta line sheds too.
  const shorter = fixNowHarness(20);
  const shorterRendered = shorter.rendered();
  assert.ok(!shorterRendered.some((l) => l.includes("security/high")), "meta sheds after the rationale");
  assert.ok(shorterRendered.some((l) => l.includes("implementing fix")), "phase status is still kept");
  assert.ok(shorterRendered.some((l) => l.includes("esc cancel fix")), "cancel hint is still kept");
  shorter.widget.stop();
});
