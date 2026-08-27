import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";
import {
  AUDIT_PROGRESS_WIDGET_KEY,
  AuditProgressTable,
  AuditProgressWidget,
  contextCell,
  formatCost,
  formatElapsed,
  formatTokens,
  renderAuditSnapshot,
  tableColumns,
  type AuditProgressContext,
  type AuditProgressSnapshot,
  type ProgressHost,
  type ProgressTheme,
} from "../src/components/AuditProgress.ts";
import { ACTIVITY_METER_WIDTH } from "../src/activityMeter.ts";
import type { HeadlessProgress } from "../src/types.ts";

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

/** Fake extension context mirroring pi's setWidget replace/dispose semantics. */
function fakeCtx(terminalRows = 40, theme: ProgressTheme = { fg: (_color, text) => text }) {
  const state: { table: AuditProgressTable | undefined; mounts: number; disposed: number } = {
    table: undefined,
    mounts: 0,
    disposed: 0,
  };
  let renders = 0;
  const tui: ProgressHost = { requestRender: () => renders++, terminal: { rows: terminalRows } };
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
        state.mounts++;
        placements.push(options?.placement);
      },
    },
  };

  return { ctx, state, placements, keys, renderCount: () => renders };
}

function lines(table: AuditProgressTable | undefined, width = 120): string[] {
  assert.ok(table, "expected a mounted table");
  return table.render(width).map(strip);
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

test("phase groups keep their data flags and render dim headings only for non-empty groups", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.addRow("Review", "b", "Slop Auditor", { state: "done" });
  widget.addRow("Triage", "c", "collection", { state: "done" });
  widget.mount();

  const rows = widget.progressRows();
  assert.deepEqual(
    rows.map((r) => [r.phase, r.firstOfPhase, r.lastOfPhase]),
    [
      ["Review", true, false],
      ["Review", false, true],
      ["Triage", true, true],
    ],
  );

  const rendered = lines(state.table);
  const body = rendered.join("\n");
  assert.equal(body.match(/^  Review\s*$/gm)?.length, 1, "the Review heading is rendered once");
  assert.equal(body.match(/^  Triage\s*$/gm)?.length, 1, "the Triage heading is rendered once");
  assert.ok(!body.includes("PHASE"), "rendered rows use the compact agent layout");
  assert.ok(!/[├│└]/.test(body), "rendered rows have no tree connectors");
  widget.stop();
});

test("agent rows start with status icons and tool calls align under the status column", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Code Quality Engineer", { state: "done" });
  widget.addRow("Review", "b", "Security Engineer", { state: "done" });
  widget.addRow("Triage", "c", "collection", { state: "done" });
  widget.addRow("Triage", "d", "adjudicator · reconcile");
  widget.startRow("d", "annotating…");
  widget.applyProgress("d", progressSnapshot({ activity: "read  src/audit.ts" }));
  widget.mount();

  const body = lines(state.table).join("\n");
  assert.match(body, /  Review\s*\n  ✓ Code Quality Engineer/);
  assert.match(body, /  ✓ Security Engineer/);
  assert.match(body, /  Triage\s*\n  ✓ collection/);
  assert.match(body, /  ◐ adjudicator · reconcile/);
  // The tool call starts at the status-column width, matching the sibling agent table.
  assert.match(body, /    ↳ read  src\/audit\.ts/);
  assert.ok(!/^  [✓◐○✗]/.test(body), "the header is not an agent row");
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

  const rendered = lines(state.table);
  assert.match(rendered[0] ?? "", /^══ Persona-audit ═+ src\/ ══$/);
  assert.match(rendered[1] ?? "", /AGENT.*CTX.*MONITOR.*ACTIVITY.*TURNS.*TOOLS.*COST.*TIME/);
  assert.match(rendered.at(-2) ?? "", /3\/6 reviewer passes · 12 findings/);
  widget.stop();
});

test("title bar carries the diff base hash after the scope, or alone when the scope is omitted", () => {
  const scoped = fakeCtx();
  const scopedWidget = new AuditProgressWidget(scoped.ctx, "src/components", "a1b2c3d");
  scopedWidget.addRow("Review", "a", "Security Engineer", { state: "done" });
  scopedWidget.mount();
  assert.match(
    lines(scoped.state.table)[0] ?? "",
    /^══ Persona-audit ═+ src\/components · @a1b2c3d ══$/,
  );
  scopedWidget.stop();

  const unscoped = fakeCtx();
  const unscopedWidget = new AuditProgressWidget(unscoped.ctx, undefined, "a1b2c3d");
  unscopedWidget.addRow("Review", "a", "Security Engineer", { state: "done" });
  unscopedWidget.mount();
  assert.match(lines(unscoped.state.table)[0] ?? "", /^══ Persona-audit ═+ @a1b2c3d ══$/);
  unscopedWidget.stop();
});

// ── responsive layout ──────────────────────────────────────────────────────

test("tableColumns sheds the stats block before squeezing the label, then activity", () => {
  const wide = tableColumns(140, ["Security Engineer"]);
  assert.equal(wide.stats, true);
  assert.ok(wide.activity >= 10);

  const medium = tableColumns(70, ["Security Engineer"]);
  assert.equal(medium.stats, false, "ambient stats go first on a narrow terminal");
  assert.equal(tableColumns(95, ["Security Engineer"]).stats, false);
  assert.equal(tableColumns(96, ["Security Engineer"]).stats, true);

  const tiny = tableColumns(35, ["Security Engineer"]);
  assert.equal(tiny.activity, 0, "activity is dropped once the label cannot fit beside it");
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

  const rendered = lines(state.table);
  assert.equal(rendered.filter((line) => /^(  )(Review|Triage|Implement|Verify)\s*$/.test(line)).length, 4);
  assert.equal(rendered.filter((line) => line.includes("↳")).length, 3, "headings leave only three activity slots");
  assert.equal(rendered.length, 20, "phase headings fit inside the existing half-height budget");
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

  const theme: ProgressTheme = { fg: (_color, text) => text };
  const frozen = renderAuditSnapshot(snapshot, theme).render(120).map(strip);

  assert.equal(snapshot.rows.length, 200, "the snapshot keeps the full row list");
  for (const label of ["done reviewer 0", "done reviewer 99", "queued reviewer 97", "live reviewer", "failed reviewer"]) {
    assert.ok(frozen.some((l) => l.includes(label)), `${label} survives into the frozen transcript`);
  }
  assert.ok(!frozen.some((l) => l.includes("passes done")), "a frozen transcript folds nothing");
});

// ── cell formatting ────────────────────────────────────────────────────────

test("contextCell shows a percentage when the window is known and raw tokens otherwise", () => {
  assert.match(contextCell(42_000, CONTEXT_WINDOW).trim(), /^21\.0%\/200\.0K$/);
  assert.equal(contextCell(12_345, undefined).trim(), "12.3K tok");
  assert.equal(contextCell(0, undefined).trim(), "—");
  assert.equal(contextCell(undefined, undefined).trim(), "—");
  assert.match(contextCell(undefined, CONTEXT_WINDOW).trim(), /^0\.0%\/200\.0K$/);
});

test("formatTokens and formatElapsed use compact, non-rolling units", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(2_000_000), "2.0M");
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(3_725_000), "62:05", "minutes keep counting past an hour");
});

test("formatCost uses fixed precision, clamps negatives, and dashes invalid values", () => {
  assert.equal(formatCost(undefined), "—");
  assert.equal(formatCost(Number.NaN), "—");
  assert.equal(formatCost(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatCost(Number.NEGATIVE_INFINITY), "—");
  assert.equal(formatCost(0), "$0.000");
  assert.equal(formatCost(0.1234), "$0.123");
  assert.equal(formatCost(-1), "$0.000");
});

test("stats columns render right-aligned turns, tool calls, cost, and elapsed time", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.applyProgress("a", progressSnapshot({ turns: 7, toolCalls: 3, costUsd: 0.1234 }));
  widget.mount();

  const rendered = lines(state.table, 120);
  const dataLine = rendered.find((line) => line.includes("Security Engineer"));
  assert.ok(dataLine, "expected a data row");
  assert.ok(dataLine.trimEnd().endsWith("7      3    $0.123    0:00"), `stats should be right-aligned: ${JSON.stringify(dataLine)}`);
  widget.stop();
});

// ── phase/model band ────────────────────────────────────────────────────────

test("band is suppressed entirely when no phase has an assigned model", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.mount();

  const rendered = lines(state.table);
  assert.match(rendered[0] ?? "", /^══ Persona-audit/, "top border is unaffected");
  assert.match(rendered[1] ?? "", /AGENT.*CTX.*MONITOR/, "the header row follows the top border directly");
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

  const rendered = lines(state.table);
  const headerIndex = rendered.findIndex((l) => /AGENT.*CTX.*MONITOR/.test(l));
  assert.equal(headerIndex, 4, "two band rows plus their separator push the header to row 4");
  const band = rendered.slice(1, 3).join("\n");
  for (const phase of ["Review", "Triage", "Implement", "Verify"]) {
    assert.ok(band.includes(phase), `band shows phase name "${phase}"`);
  }
  assert.ok(band.includes("claude-opus-4"));
  assert.ok(band.includes("gpt-5"));
  assert.ok(band.includes("default"), 'an unset phase falls back to "default"');
  widget.stop();
});

test("the phase band draws an aligned two-row powerline chevron between each column", () => {
  // U+E0B9 "\" on the name row over U+E0BB "/" on the model row; stacked in the
  // same terminal column they read as one tall right-chevron.
  const TOP = "\u{E0B9}";
  const BOTTOM = "\u{E0BB}";
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.setPhaseModels({
    Review: "deepseek/deepseek-v4-pro",
    Triage: "openai/gpt-5.6-luna",
    Implement: "anthropic/claude-opus-4-6",
    Verify: "zhipu/glm-5p2",
  });
  widget.mount();

  const rendered = lines(state.table);
  const colsOf = (row: string, glyph: string): number[] =>
    [...row].flatMap((ch, i) => (ch === glyph ? [i] : []));
  const topCols = colsOf(rendered[1] ?? "", TOP);
  const botCols = colsOf(rendered[2] ?? "", BOTTOM);
  assert.equal(topCols.length, 3, "three separators divide the four phases on the name row");
  assert.equal(botCols.length, 3, "three separators divide the four models on the model row");
  assert.deepEqual(botCols, topCols, "each chevron's two halves share a column so they stack into one glyph");
  widget.stop();
});

test("only the active phase shimmers with a truecolor gradient in the band", () => {
  // Real (if arbitrary) SGR codes, not literal bracket text: visibleWidth/truncateToWidth
  // only treat true ANSI escapes as zero-width, so a literal-text tagging theme would
  // inflate the line past bodyWidth and get truncated before the last column.
  const taggingTheme: ProgressTheme = {
    fg: (color, text) => `\x1b[${color === "text" ? 97 : 90}m${text}\x1b[0m`,
    getFgAnsi: (color) => (color === "text" ? "\x1b[38;2;255;255;255m" : "\x1b[38;2;120;120;120m"),
  };
  const { ctx, state } = fakeCtx(40, taggingTheme);
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "working" });
  widget.setPhaseModels({
    Review: "anthropic/claude-opus-4",
    Triage: "anthropic/claude-opus-4",
    Implement: "anthropic/claude-opus-4",
    Verify: "anthropic/claude-opus-4",
  });
  widget.setActivePhase("Triage");
  widget.mount();

  assert.ok(state.table, "expected a mounted table");
  const rendered = state.table.render(120).slice(1, 3);
  const band = rendered.join("\n");
  assert.ok(strip(band).includes("Triage"), "the active phase name still reads correctly once colors are stripped");
  assert.match(
    band,
    /\x1b\[38;2;\d+;\d+;\d+mT\x1b\[22m/,
    "the active phase shimmers with a per-character truecolor gradient",
  );
  assert.doesNotMatch(band, /\x1b\[97m\s*Triage/, "the active phase no longer uses the flat highlighted tag");
  assert.match(band, /\x1b\[90m\s*Review/, "inactive phases stay dim");
  assert.match(band, /\x1b\[90m\s*Implement/);
  assert.match(band, /\x1b\[90m\s*Verify/);
  assert.doesNotMatch(band, /\x1b\[97m\s*Review/);
  // Separators touching the active phase join its shimmer; the one between two
  // inactive phases (Implement│Verify) stays dim.
  assert.match(band, /\x1b\[38;2;\d+;\d+;\d+m[\u{E0B9}\u{E0BB}]/u, "a separator beside the active phase shimmers");
  assert.match(band, /\x1b\[90m[\u{E0B9}\u{E0BB}]/u, "a separator between two inactive phases stays dim");
  widget.stop();
});

test("the active phase falls back to the flat highlighted tone when the theme has no getFgAnsi", () => {
  const taggingTheme: ProgressTheme = { fg: (color, text) => `\x1b[${color === "text" ? 97 : 90}m${text}\x1b[0m` };
  const { ctx, state } = fakeCtx(40, taggingTheme);
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "working" });
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4", Triage: "anthropic/claude-opus-4" });
  widget.setActivePhase("Triage");
  widget.mount();

  assert.ok(state.table, "expected a mounted table");
  const band = state.table.render(120).slice(1, 3).join("\n");
  assert.match(band, /\x1b\[97m\s*Triage/, "the active phase name keeps the flat highlighted tone");
  assert.match(band, /\x1b\[90m\s*Review/, "inactive phases stay dim");
  widget.stop();
});

test("a narrow terminal drops the band even when models are assigned", () => {
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx);
  widget.addRow("Review", "a", "Security Engineer", { state: "done" });
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4" });
  widget.mount();

  const narrow = lines(state.table, 50); // bodyWidth 46 → 11/col, below the 12-column floor
  assert.match(narrow[1] ?? "", /AGENT.*CTX.*MONITOR/, "band suppressed, header follows the top border directly");

  const wide = lines(state.table, 60); // bodyWidth 56 → 14/col, clears the floor
  assert.doesNotMatch(wide[1] ?? "", /AGENT.*CTX.*MONITOR/, "band shown, so the header is pushed down");
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
  const { ctx, state } = fakeCtx();
  const widget = new AuditProgressWidget(ctx, "src/components", "a1b2c3d");
  widget.addRow("Review", "a", "Security Engineer");
  widget.startRow("a", "reviewing…");
  widget.applyProgress("a", progressSnapshot({ outputTokens: 500 }));
  widget.setPhaseModels({ Review: "anthropic/claude-opus-4" });
  widget.setSummary("1/1 reviewer passes · 3 findings");
  widget.mount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  widget.settleRow("a", "done", "812 chars");

  const snapshot = widget.snapshot();
  const roundTripped: AuditProgressSnapshot = JSON.parse(JSON.stringify(snapshot));
  widget.stop();

  assert.equal(roundTripped.meterLevels.a?.length, ACTIVITY_METER_WIDTH, "the meter trace round-trips at full width");

  const theme: ProgressTheme = { fg: (_color, text) => text };
  const frozenLines = renderAuditSnapshot(roundTripped, theme).render(120).map(strip);

  assert.ok(frozenLines.some((l) => l.includes("Security Engineer")), "settled row survives the round trip");
  assert.ok(frozenLines.some((l) => l.includes("1/1 reviewer passes")), "footer summary survives the round trip");
  assert.ok(frozenLines.some((l) => l.includes("src/components · @a1b2c3d")), "scope and base hash survive the round trip");
  assert.ok(frozenLines.some((l) => l.includes("claude-opus-4")), "band survives the round trip");
});

test("the meter renders in the configured colour, defaulting to accent", () => {
  const tagged: ProgressTheme = { fg: (color, text) => `<${color}>${text}` };
  const snapshot: AuditProgressSnapshot = {
    summary: "done",
    phaseModels: {},
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
      lastOfPhase: true,
    }],
    // A non-idle cell is the only one that takes the configured colour; idle cells stay dim.
    meterLevels: { a: [0, 0, 0, 0, 0, 0, 0, 7] },
  };

  const configured = renderAuditSnapshot(snapshot, tagged, { color: "error", direction: "ltr" }).render(120).join("\n");
  assert.match(configured, /<error>⣿/);

  const fallback = renderAuditSnapshot(snapshot, tagged).render(120).join("\n");
  assert.match(fallback, /<accent>⣿/);
  const legacy = renderAuditSnapshot(snapshot, { fg: (_color, text) => text }).render(120).join("\n");
  assert.match(legacy, /Security Engineer.*0.*—.*0:01/, "legacy rows default missing telemetry to 0 and —");
});

test("a frozen snapshot render never starts a ticker", () => {
  const originalSetInterval = globalThis.setInterval;
  let calls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    calls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;
  try {
    const theme: ProgressTheme = { fg: (_color, text) => text };
    const snapshot: AuditProgressSnapshot = { summary: "completed", phaseModels: {}, rows: [], meterLevels: {} };
    renderAuditSnapshot(snapshot, theme).render(120);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  assert.equal(calls, 0, "the frozen table must not start its own ticker");
});

// ── total run time ─────────────────────────────────────────────────────────

const footerOf = (snapshot: AuditProgressSnapshot, width: number): string[] => {
  const theme: ProgressTheme = { fg: (_color, text) => text };
  const lines = renderAuditSnapshot(snapshot, theme).render(width).map(strip);
  // The footer is everything between the last rule and the closing border.
  const rule = lines.lastIndexOf("─".repeat(Math.max(20, width)));
  return lines.slice(rule + 1, -1);
};

test("the footer pins total run time to the right edge alongside the summary", () => {
  const footer = footerOf(
    { summary: "3/3 reviewer passes · 12 findings", totalMs: 697_000, phaseModels: {}, rows: [], meterLevels: {} },
    120,
  );
  assert.equal(footer.length, 1, "a short summary shares one line with the total");
  assert.ok(footer[0]?.includes("3/3 reviewer passes"), "summary is kept");
  assert.ok(footer[0]?.trimEnd().endsWith("total 11:37  ctrl+shift+c: cancel"), `total is right-aligned: ${JSON.stringify(footer[0])}`);
});

test("the footer moves total run time to its own line rather than truncating a long summary", () => {
  const summary = "12/12 reviewer passes · 40 findings · 18 accepted · fixes 18/18 landed · verify 3/3 · 1 rejected";
  const footer = footerOf({ summary, totalMs: 3_600_000, phaseModels: {}, rows: [], meterLevels: {} }, 100);
  assert.equal(footer.length, 2, "a colliding summary pushes the total onto its own line");
  assert.ok(footer[0]?.includes("verify 3/3"), "the summary is not truncated to make room");
  assert.ok(footer[1]?.trimEnd().endsWith("total 60:00  ctrl+shift+c: cancel"), "minutes keep counting rather than rolling into hours");
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
