import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FixGateDecision, FixGateInput, FixProgressController } from "../src/components/FixProgress.ts";
import { fixCommitMessage, parseCommitSummary, parseFixVerdict, runFixNow, type FixNowDeps } from "../src/fixNow.ts";
import type { Finding, HeadlessOptions, HeadlessResult, ReviewSessionState } from "../src/types.ts";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 1,
  category: "bug",
  severity: "high",
  rationale: "off-by-one in loop bound",
  suggestedChange: "use < instead of <=",
  ...overrides,
});

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pa-fixnow-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src/a.ts"), "const a = 1;\n");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  return cwd;
}

const okResult = (finalText = "done"): HeadlessResult => ({
  finalText,
  allText: finalText,
  aborted: false,
  stopReason: "stop",
  usage: { turns: 1, contextTokens: 100, outputTokens: 50 },
});

/** Scripted controller: records gate inputs, pops decisions in order. */
function stubController(decisions: FixGateDecision[]) {
  const gates: FixGateInput[] = [];
  const controller: FixProgressController = {
    setPhase: () => {},
    applyProgress: () => {},
    gate: (input) => {
      gates.push(input);
      return Promise.resolve(decisions.shift() ?? "discard");
    },
    close: async () => {},
  };
  return { controller, gates };
}

function makeState(count = 1): ReviewSessionState {
  return { statuses: Array.from({ length: count }, () => "apply"), selectedIndex: 0, fixed: new Map() };
}

interface HarnessOptions {
  cwd: string;
  decisions: FixGateDecision[];
  /** Called on each fix-agent run (attempt n), mutates the repo like the agent would. */
  onFix: (attempt: number, task: string) => Promise<void>;
  verifierText?: string;
  summaryText?: string;
  dirtyChoice?: "proceed" | "no-commit" | "abort";
}

function makeDeps(opts: HarnessOptions) {
  const notifications: string[] = [];
  const fixTasks: string[] = [];
  let fixRuns = 0;
  let verifyRuns = 0;
  const { controller, gates } = stubController(opts.decisions);
  const deps: FixNowDeps = {
    ctx: {
      cwd: opts.cwd,
      ui: {
        notify: (message: string) => notifications.push(message),
        select: async () => undefined,
      },
      modelRegistry: {} as ModelRegistry,
    } as unknown as FixNowDeps["ctx"],
    adjudicatorSystemPrompt: "adjudicator",
    verifierSystemPrompt: "verifier",
    adjudicatorTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    readOnlyTools: ["read", "grep", "find", "ls"],
    implementModel: {},
    verifyModel: {},
    runSession: async (options: HeadlessOptions): Promise<HeadlessResult> => {
      if (options.agentName === "fix now implement") {
        fixRuns++;
        fixTasks.push(options.task);
        assert.ok(!options.tools.includes("bash"), "the fix agent never gets bash");
        await opts.onFix(fixRuns, options.task);
        return okResult("applied");
      }
      if (options.agentName === "fix now commit subject") {
        assert.deepEqual(options.tools, [], "the summarizer gets no tools");
        return okResult(opts.summaryText ?? "Fix loop bound off-by-one");
      }
      verifyRuns++;
      assert.deepEqual(options.tools, ["read", "grep", "find", "ls"], "the verifier is read-only");
      return okResult(opts.verifierText ?? "VERDICT: fixed\nEVIDENCE: loop bound corrected");
    },
    promptDirtyChoice: async () => opts.dirtyChoice ?? "proceed",
    openProgress: () => controller,
  };
  return { deps, notifications, gates, fixTaskAt: (i: number) => fixTasks[i], counts: () => ({ fixRuns, verifyRuns }) };
}

test("accept commits exactly the touched file and marks the finding fixed", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = makeDeps({
    cwd,
    decisions: ["accept"],
    onFix: () => writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n"),
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(state.statuses[0], "fixed");
  const fixed = state.fixed.get(0);
  assert.ok(fixed);
  assert.match(fixed.commitSha ?? "", /^[0-9a-f]{4,}$/);
  assert.deepEqual(fixed.files, ["src/a.ts"]);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" });
  assert.equal(status, "", "the tree is clean after the commit");
  const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd, encoding: "utf-8" });
  assert.match(log, /^fix\(bug\): Fix loop bound off-by-one$/m);
  assert.ok(h.gates[0]?.verdictNote?.includes("fixed"), "the verifier verdict reaches the gate");
});

test("discard reverts the agent's edits and leaves the state untouched", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = makeDeps({
    cwd,
    decisions: ["discard"],
    onFix: async () => {
      await writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n");
      await writeFile(path.join(cwd, "src/new.ts"), "const n = 1;\n");
    },
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(state.statuses[0], "apply");
  assert.equal(state.fixed.size, 0);
  assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 1;\n");
  assert.equal(existsSync(path.join(cwd, "src/new.ts")), false, "the agent-created file is deleted");
  assert.ok(h.notifications.some((n) => n.includes("discarded")));
});

test("retry reverts to a clean slate and threads verifier feedback into the next attempt", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = makeDeps({
    cwd,
    decisions: ["retry", "accept"],
    verifierText: "VERDICT: partial\nEVIDENCE: bound fixed but off-by-one remains in init",
    onFix: async (attempt) => {
      // The retry must start from the pre-fix tree, not attempt 1's edits.
      assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 1;\n");
      await writeFile(path.join(cwd, "src/a.ts"), `const a = ${attempt + 1};\n`);
    },
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(h.counts().fixRuns, 2);
  assert.ok(!h.fixTaskAt(0)?.includes("Verifier Feedback"));
  assert.match(h.fixTaskAt(1) ?? "", /Verifier Feedback[\s\S]*VERDICT: partial/);
  assert.equal(h.gates[1]?.attempt, 2);
  assert.equal(state.statuses[0], "fixed");
  assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 3;\n");
});

test("a dirty target with no-commit accepts without committing and without a sha", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "src/a.ts"), "const a = 99;\n"); // user's own edit
  const h = makeDeps({
    cwd,
    decisions: ["accept"],
    dirtyChoice: "no-commit",
    onFix: () => writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n"),
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(state.statuses[0], "fixed");
  assert.equal(state.fixed.get(0)?.commitSha, undefined);
  const log = execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf-8" }).trim().split("\n");
  assert.deepEqual(log, ["init"], "no commit was created");
  assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 2;\n", "the fix stays on disk");
  assert.ok(h.gates[0]?.warnings?.some((w) => w.includes("auto-commit is off")));
});

test("aborting at the dirty-file prompt runs no agents and changes nothing", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "src/a.ts"), "const a = 99;\n");
  const h = makeDeps({
    cwd,
    decisions: [],
    dirtyChoice: "abort",
    onFix: () => assert.fail("the fix agent must not run"),
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(h.counts().fixRuns, 0);
  assert.equal(state.statuses[0], "apply");
  assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 99;\n");
});

test("discard never reverts a file that was dirty before the fix", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "src/a.ts"), "const a = 99;\n"); // user's own edit
  const h = makeDeps({
    cwd,
    decisions: ["discard"],
    dirtyChoice: "proceed",
    onFix: () => writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n"),
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.equal(
    await readFile(path.join(cwd, "src/a.ts"), "utf-8"),
    "const a = 2;\n",
    "the pre-dirty file is left as the agent wrote it, never restored to HEAD",
  );
  assert.ok(h.notifications.some((n) => n.includes("untouched")), "the kept dirty file is called out");
});

test("a fix that changes nothing on disk gates with a warning and skips the verifier", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = makeDeps({ cwd, decisions: ["discard"], onFix: async () => {} });

  await runFixNow(h.deps, finding(), 0, makeState());

  assert.equal(h.counts().verifyRuns, 0);
  assert.ok(h.gates[0]?.warnings?.some((w) => w.includes("no changes on disk")));
});

test("an unparsable verifier reply degrades to a warning instead of blocking the gate", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = makeDeps({
    cwd,
    decisions: ["accept"],
    verifierText: "I think it looks fine.",
    onFix: () => writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n"),
  });
  const state = makeState();

  await runFixNow(h.deps, finding(), 0, state);

  assert.ok(h.gates[0]?.warnings?.some((w) => w.includes("unparsable")));
  assert.equal(state.statuses[0], "fixed");
});

// ── Unit helpers ───────────────────────────────────────────────────────────

test("parseFixVerdict reads the trailing verdict lines and rejects garbage", () => {
  assert.deepEqual(
    parseFixVerdict("blah\nVERDICT: fixed\nEVIDENCE: bound corrected"),
    { verdict: "fixed", evidence: "bound corrected" },
  );
  assert.deepEqual(
    parseFixVerdict("VERDICT: not-fixed\nEVIDENCE: still uses <="),
    { verdict: "not-fixed", evidence: "still uses <=" },
  );
  assert.equal(parseFixVerdict("VERDICT: maybe"), undefined);
  assert.equal(parseFixVerdict("nothing here"), undefined);
});

test("fixCommitMessage carries category, rationale, and provenance without the location", () => {
  const message = fixCommitMessage(finding());
  const [subject] = message.split("\n");
  assert.equal(subject, "fix(bug): off-by-one in loop bound");
  assert.match(message, /Security Engineer \(high\)/);
  assert.match(message, /use < instead of <=/);
  assert.match(message, /Fix Now/);
});

test("fixCommitMessage prefers the summary and clips overlong subjects", () => {
  const summarized = fixCommitMessage(finding(), "Fix the loop bound");
  assert.equal(summarized.split("\n")[0], "fix(bug): Fix the loop bound");

  const long = fixCommitMessage(finding({ category: "security", rationale: "Admin check falls back to user_metadata.role, which users can self-edit, enabling privilege escalation" }));
  const [subject] = long.split("\n");
  assert.ok(subject!.length <= 72, `subject stays within budget (got ${subject!.length})`);
  assert.match(subject!, /…$/);
});

test("parseCommitSummary sanitizes the summarizer's reply", () => {
  assert.equal(parseCommitSummary("Stop trusting user metadata for admin checks\n"), "Stop trusting user metadata for admin checks");
  assert.equal(parseCommitSummary('"Fix the loop bound."'), "Fix the loop bound");
  assert.equal(parseCommitSummary("fix(security): Escape the argument"), "Escape the argument");
  assert.equal(parseCommitSummary("```\nUse < instead of <=\n```"), "Use < instead of <=");
  assert.equal(parseCommitSummary("   \n\n"), undefined);
});
