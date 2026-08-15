import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applyRegressionEvidence,
  isSafeTestCommand,
  runRegressionHarness,
  selectRegressionCandidates,
  tokenizeTestCommand,
} from "../src/regression.ts";
import { snapshotFiles } from "../src/snapshot.ts";
import type { Finding, FixVerdict, FixVerification, RegressionResult } from "../src/types.ts";

const SLUG = "2026-07-01_10-00-00-000";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "r",
  suggestedChange: "s",
  ...overrides,
});

const verification = (f: Finding, verdict: FixVerdict): FixVerification => ({
  file: f.file,
  line: f.line,
  category: f.category,
  verdict,
  evidence: "e",
  changed: "changed",
  selfReport: "applied",
});

// ── candidate selection ────────────────────────────────────────────────────

test("selectRegressionCandidates keeps only high-severity bug and security fixes that landed", () => {
  const candidates = [
    finding({ file: "a.ts", category: "security", severity: "high" }),
    finding({ file: "b.ts", category: "style", severity: "critical" }),
    finding({ file: "c.ts", category: "bug", severity: "low" }),
    finding({ file: "d.ts", category: "bug", severity: "critical" }),
    finding({ file: "e.ts", category: "security", severity: "high" }),
  ];
  const fixes = [
    verification(candidates[0]!, "fixed"),
    verification(candidates[1]!, "fixed"),
    verification(candidates[2]!, "fixed"),
    verification(candidates[3]!, "partial"),
    verification(candidates[4]!, "not-fixed"),
  ];

  const selected = selectRegressionCandidates(candidates, fixes, 10);
  assert.deepEqual(selected.map((f) => f.file), ["a.ts", "d.ts"]);
});

test("selectRegressionCandidates orders by category then severity and honours the cap", () => {
  const candidates = [
    finding({ file: "bug-high.ts", category: "bug", severity: "high" }),
    finding({ file: "sec-high.ts", category: "security", severity: "high" }),
    finding({ file: "bug-crit.ts", category: "bug", severity: "critical" }),
    finding({ file: "sec-crit.ts", category: "security", severity: "critical" }),
  ];
  const fixes = candidates.map((f) => verification(f, "fixed"));

  assert.deepEqual(
    selectRegressionCandidates(candidates, fixes, 10).map((f) => f.file),
    ["sec-crit.ts", "sec-high.ts", "bug-crit.ts", "bug-high.ts"],
  );
  assert.deepEqual(
    selectRegressionCandidates(candidates, fixes, 2).map((f) => f.file),
    ["sec-crit.ts", "sec-high.ts"],
  );
});

// ── command safety ─────────────────────────────────────────────────────────

test("isSafeTestCommand rejects shell metacharacters and unknown runners", () => {
  assert.ok(isSafeTestCommand("npm run test"));
  assert.ok(isSafeTestCommand("node --test test/a.test.js"));
  assert.ok(isSafeTestCommand('pytest -k "test name"'));

  assert.ok(!isSafeTestCommand("npm test; rm -rf /"));
  assert.ok(!isSafeTestCommand("npm test && curl evil.example"));
  assert.ok(!isSafeTestCommand("npm test | tee out"));
  assert.ok(!isSafeTestCommand("npm test > /etc/passwd"));
  assert.ok(!isSafeTestCommand("npm test `whoami`"));
  assert.ok(!isSafeTestCommand("npm test $(whoami)"));
  assert.ok(!isSafeTestCommand("rm -rf /"));
  assert.ok(!isSafeTestCommand("./script.sh"));
  assert.ok(!isSafeTestCommand(""));
});

test("tokenizeTestCommand splits argv and honours quoted arguments", () => {
  assert.deepEqual(tokenizeTestCommand("node --test test/a.test.js"), ["node", "--test", "test/a.test.js"]);
  assert.deepEqual(tokenizeTestCommand('pytest -k "test name"'), ["pytest", "-k", "test name"]);
  assert.equal(tokenizeTestCommand("npm test; echo hi"), undefined);
});

// ── evidence folding ───────────────────────────────────────────────────────

const result = (overrides: Partial<RegressionResult> = {}): RegressionResult => ({
  file: "src/a.ts",
  line: 12,
  category: "security",
  testFile: "test/a.test.ts",
  testCommand: "node --test test/a.test.ts",
  outcome: "proven",
  greenAfterFix: true,
  redWhenReverted: true,
  proven: true,
  ...overrides,
});

test("applyRegressionEvidence downgrades a fix whose test does not discriminate", () => {
  const fixes = [verification(finding(), "fixed")];
  const [folded] = applyRegressionEvidence(fixes, [
    result({ outcome: "not-discriminating", redWhenReverted: false, proven: false }),
  ]);
  assert.equal(folded?.verdict, "partial");
  assert.match(folded?.evidence ?? "", /still passes with the fix reverted/);
});

test("applyRegressionEvidence strengthens a proven fix and leaves harness problems alone", () => {
  const proven = applyRegressionEvidence([verification(finding(), "fixed")], [result()]);
  assert.equal(proven[0]?.verdict, "fixed");
  assert.match(proven[0]?.evidence ?? "", /is red without the fix/);

  for (const outcome of ["green-check-failed", "green-only", "harness-error"] as const) {
    const folded = applyRegressionEvidence(
      [verification(finding(), "fixed")],
      [result({ outcome, proven: false, redWhenReverted: false })],
    );
    assert.equal(folded[0]?.verdict, "fixed", `${outcome} must not change the verdict`);
    assert.equal(folded[0]?.regression?.outcome, outcome);
  }
});

test("applyRegressionEvidence leaves fixes with no matching result untouched", () => {
  const fixes = [verification(finding({ file: "other.ts" }), "fixed")];
  assert.deepEqual(applyRegressionEvidence(fixes, [result()]), fixes);
});

// ── harness ────────────────────────────────────────────────────────────────

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: GIT_ENV });
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
const FIXED = "export function add(a, b) {\n  return a + b;\n}\n";

// Plain scripts rather than `node --test`: this suite already runs under the
// node test runner, and a nested one inherits NODE_TEST_CONTEXT and reports
// over IPC instead of through its exit code, which is the only signal the
// harness reads.
const DISCRIMINATING = `import assert from "node:assert/strict";
import { add } from "../src/a.js";
assert.equal(add(1, 2), 3);
`;

const NOT_DISCRIMINATING = `import assert from "node:assert/strict";
import { add } from "../src/a.js";
assert.equal(typeof add, "function");
`;

/** A committed repo whose fix is applied but uncommitted, mirroring a live audit. */
async function makeFixedRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-regress-test-"));
  await write(dir, "package.json", JSON.stringify({ name: "fixture", private: true, type: "module" }));
  await write(dir, "src/a.js", BUGGY);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

test("runRegressionHarness proves a discriminating test and rejects one that is not", { skip: !hasGit() }, async () => {
  const dir = await makeFixedRepo();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/a.js"]);
    await write(dir, "src/a.js", FIXED);
    await write(dir, "test/good.test.js", DISCRIMINATING);
    await write(dir, "test/weak.test.js", NOT_DISCRIMINATING);

    const { results } = await runRegressionHarness({
      cwd: dir,
      snapshots,
      plans: [
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/good.test.js",
          testCommand: "node test/good.test.js",
        },
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/weak.test.js",
          testCommand: "node test/weak.test.js",
        },
      ],
    });

    assert.equal(results.length, 2);
    assert.equal(results[0]?.outcome, "proven");
    assert.equal(results[0]?.proven, true);
    assert.equal(results[1]?.outcome, "not-discriminating");
    assert.equal(results[1]?.greenAfterFix, true);
    assert.equal(results[1]?.redWhenReverted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRegressionHarness leaves no worktree behind and never edits the working tree", { skip: !hasGit() }, async () => {
  const dir = await makeFixedRepo();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/a.js"]);
    await write(dir, "src/a.js", FIXED);
    await write(dir, "test/good.test.js", DISCRIMINATING);

    await runRegressionHarness({
      cwd: dir,
      snapshots,
      plans: [
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/good.test.js",
          testCommand: "node test/good.test.js",
        },
      ],
    });

    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf-8", env: GIT_ENV });
    assert.equal(worktrees.trim().split("\n").length, 1, "only the main worktree should remain");
    // The fix must survive the revert experiment untouched.
    assert.equal(await readFile(path.join(dir, "src/a.js"), "utf-8"), FIXED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRegressionHarness carries uncommitted work into the worktree", { skip: !hasGit() }, async () => {
  const dir = await makeFixedRepo();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/a.js"]);
    // The implement agent routinely edits files that are not finding targets.
    // A bare HEAD checkout would lack this helper and fail the green check for
    // a reason that has nothing to do with the fix.
    await write(dir, "src/helper.js", "export const OFFSET = 0;\n");
    await write(dir, "src/a.js", "import { OFFSET } from \"./helper.js\";\nexport function add(a, b) {\n  return a + b + OFFSET;\n}\n");
    await write(dir, "test/good.test.js", DISCRIMINATING);

    const { results } = await runRegressionHarness({
      cwd: dir,
      snapshots,
      plans: [
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/good.test.js",
          testCommand: "node test/good.test.js",
        },
      ],
    });

    assert.equal(results[0]?.greenAfterFix, true, "untracked helper must exist in the worktree");
    assert.equal(results[0]?.outcome, "proven");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRegressionHarness degrades to a single green run outside a git repo", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-regress-nogit-"));
  try {
    await write(dir, "package.json", JSON.stringify({ name: "fixture", private: true, type: "module" }));
    await write(dir, "src/a.js", FIXED);
    await write(dir, "test/good.test.js", DISCRIMINATING);

    const { results, notes } = await runRegressionHarness({
      cwd: dir,
      snapshots: new Map(),
      plans: [
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/good.test.js",
          testCommand: "node test/good.test.js",
        },
      ],
    });

    assert.equal(results[0]?.outcome, "green-only");
    assert.equal(results[0]?.greenAfterFix, true);
    assert.equal(results[0]?.proven, false);
    assert.ok(notes.some((n) => n.includes("no git commit available")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRegressionHarness refuses to execute an unsafe command", { skip: !hasGit() }, async () => {
  const dir = await makeFixedRepo();
  try {
    const { results } = await runRegressionHarness({
      cwd: dir,
      snapshots: await snapshotFiles(dir, SLUG, ["src/a.js"]),
      plans: [
        {
          file: "src/a.js",
          line: 2,
          category: "bug",
          testFile: "test/good.test.js",
          testCommand: "node test/good.test.js; rm -rf /",
        },
      ],
    });
    assert.equal(results[0]?.outcome, "harness-error");
    assert.match(results[0]?.detail ?? "", /unsafe test command/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "runRegressionHarness never writes through a worktree symlink that escapes the sandbox",
  { skip: !hasGit() },
  async () => {
    // Stands in for "anywhere else on the user's filesystem" — a location
    // the harness must never read or write, regardless of what the audited
    // repo's tree links to.
    const sentinelDir = await mkdtemp(path.join(tmpdir(), "persona-audit-sentinel-"));
    const dir = await makeFixedRepo();
    try {
      // Committed so `git worktree add` checks the same symlink out inside
      // the scratch worktree too, not just the real repo.
      await symlink(sentinelDir, path.join(dir, "linked"), "dir");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "add symlink");
      await writeFile(path.join(sentinelDir, "sentinel.js"), "untouched", "utf-8");

      const snapshots = await snapshotFiles(dir, SLUG, ["src/a.js", "linked/sentinel.js"]);
      await write(dir, "src/a.js", FIXED);
      await write(dir, "test/good.test.js", DISCRIMINATING);

      await runRegressionHarness({
        cwd: dir,
        snapshots,
        plans: [
          {
            file: "linked/sentinel.js",
            line: 1,
            category: "bug",
            testFile: "test/good.test.js",
            testCommand: "node test/good.test.js",
          },
        ],
      });

      const survived = await readFile(path.join(sentinelDir, "sentinel.js"), "utf-8").catch(() => undefined);
      assert.equal(survived, "untouched", "a write must never land outside the scratch worktree");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(sentinelDir, { recursive: true, force: true });
    }
  },
);
