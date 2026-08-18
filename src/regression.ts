/**
 * Layer 3 of the verify phase: deterministic red/green regression evidence.
 *
 * A test that passes after a fix proves nothing on its own — it may not touch
 * the defect at all. The harness therefore runs each authored test twice: once
 * against the current tree, and once with only the target file reverted to its
 * pre-fix content. Only a green-then-red pair proves the test discriminates.
 *
 * Both runs happen inside a detached git worktree in a temp directory. The
 * harness only writes inside that worktree. However, the authored test runs unsandboxed:
 * node_modules is a live symlink into the real tree, and the test runs with the
 * user's own privileges, so it can still touch anything the user's tree can. The green run doubles as a
 * baseline sanity check: if it fails, the worktree does not faithfully
 * reproduce the real tree and the result is reported inconclusive rather than
 * guessed at.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { assertWriteContained, message } from "./report.ts";
import { mapWithConcurrencyLimit, tail } from "./subprocess.ts";
import { resolveTargetPath, verificationKey, type FileSnapshot } from "./snapshot.ts";
import {
  CATEGORY_PRIORITY,
  SEVERITY_ORDER,
  type FindingCategory,
  type Finding,
  type FixVerification,
  type RegressionResult,
} from "./types.ts";

const execFileAsync = promisify(execFile);

/** Highest-signal findings only — each candidate costs two full test runs. */
export const REGRESSION_LIMIT = 3;

const TEST_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 2_000;

const CANDIDATE_CATEGORIES = new Set<FindingCategory>(["security", "bug"]);
const CANDIDATE_SEVERITIES = new Set<string>(["critical", "high"]);

/** Runners the harness will execute. Anything else is rejected unparsed. */
const ALLOWED_RUNNERS = new Set([
  "npm", "pnpm", "yarn", "bun", "deno", "node",
  "go", "cargo", "dotnet", "mvn", "gradle",
  "pytest", "python", "python3", "rspec",
  "jest", "vitest", "mocha",
]);

/** Package-execution subcommands (npx-equivalents) that fetch and run arbitrary code; rejected even under an allowed runner. */
const DISALLOWED_SUBCOMMANDS = new Set(["exec", "dlx", "x"]);

/** Package-install verbs — any of them resolves and runs remote packages. */
const PACKAGE_INSTALL_VERBS = new Set(["install", "add", "i", "ci"]);

/** Package managers whose bare invocation defaults to install behavior. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const SHELL_METACHARACTERS = /[;&|`$()<>\n\r\\]/;

/** One authored regression test awaiting red/green adjudication. */
export interface RegressionPlan {
  file: string;
  line: number;
  category: FindingCategory;
  testFile: string;
  testCommand: string;
}

export interface RegressionHarnessOptions {
  cwd: string;
  plans: RegressionPlan[];
  snapshots: Map<string, FileSnapshot>;
  signal?: AbortSignal;
  onStart?(plan: RegressionPlan): void;
  onDone?(result: RegressionResult): void;
}

/**
 * Pick the findings worth two test runs each, using the same category-then-
 * severity precedence the adjudicator applies to conflicts.
 */
export function selectRegressionCandidates(
  accepted: Finding[],
  fixes: FixVerification[],
  limit: number,
): Finding[] {
  const verdicts = new Map(fixes.map((f) => [verificationKey(f.file, f.line, f.category), f.verdict]));
  return accepted
    .filter((f) => {
      if (!CANDIDATE_CATEGORIES.has(f.category) || !CANDIDATE_SEVERITIES.has(f.severity)) return false;
      const verdict = verdicts.get(verificationKey(f.file, f.line, f.category));
      return verdict === "fixed" || verdict === "partial";
    })
    .sort(
      (a, b) =>
        CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category) ||
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    )
    .slice(0, limit);
}

/**
 * Split a command into argv, honouring quoted arguments.
 * Returns undefined when the command is not safe to execute.
 */
export function tokenizeTestCommand(command: string): [string, ...string[]] | undefined {
  if (!isSafeTestCommand(command)) return undefined;
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) tokens.push(token);
  }
  const [first, ...rest] = tokens;
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * The command is LLM-supplied and executed by the harness, so it is restricted
 * to a single plain invocation of a known test runner. Combined with execFile
 * (no shell), the tokens are argv and can never be reinterpreted as a script.
 */
export function isSafeTestCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) return false;
  if (/:\/\//.test(trimmed)) return false;
  const quoteCount = (trimmed.match(/"/g) ?? []).length + (trimmed.match(/'/g) ?? []).length;
  if (quoteCount % 2 !== 0) return false;
  const [, first = "", second] = /^(\S+)(?:\s+(\S+))?/.exec(trimmed) ?? [];
  if (!ALLOWED_RUNNERS.has(first)) return false;
  if (PACKAGE_MANAGERS.has(first) && second === undefined) return false;
  if (second !== undefined && DISALLOWED_SUBCOMMANDS.has(second)) return false;
  for (const token of trimmed.match(/"([^"]*)"|'([^']*)'|(\S+)/g) ?? []) {
    if (PACKAGE_INSTALL_VERBS.has(token.replace(/^["']|["']$/g, ""))) return false;
  }
  return true;
}

async function runCommand(
  tokens: [string, ...string[]],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(tokens[0], tokens.slice(1), {
      cwd,
      encoding: "utf-8",
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      signal,
    });
    return { ok: true, output: tail(`${stdout}\n${stderr}`, OUTPUT_TAIL_CHARS) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`, OUTPUT_TAIL_CHARS) || (err.message ?? "unknown error") };
  }
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** Paths git reports as modified or untracked, excluding deletions and our own artifacts. */
async function dirtyPaths(cwd: string): Promise<string[]> {
  // --untracked-files=all so untracked files are listed individually; the
  // default collapses them to a bare directory entry that cannot be copied.
  const { ok, stdout } = await git(["status", "--porcelain", "-z", "--untracked-files=all"], cwd);
  if (!ok) return [];
  const entries = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const target = entry.slice(3);
    // Renames and copies carry their source path in the following NUL chunk;
    // push it too so copyInto clears the stale HEAD copy the rename left behind.
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = entries[++i];
      if (source && !source.startsWith(".pi/") && !source.startsWith("node_modules/")) paths.push(source);
    }
    if (status.includes("D")) continue;
    // .pi holds our own artifacts; node_modules is symlinked, not copied.
    if (target.startsWith(".pi/") || target.startsWith("node_modules/")) continue;
    paths.push(target);
  }
  return paths;
}

async function copyInto(cwd: string, worktree: string, worktreeReal: string, relPath: string): Promise<void> {
  const source = resolveTargetPath(cwd, relPath);
  const dest = resolveTargetPath(worktree, relPath);
  if (!source || !dest) return;
  try {
    await assertWriteContained(worktree, worktreeReal, dest);
  } catch {
    return;
  }
  let content: Buffer;
  try {
    content = await readFile(source);
  } catch {
    await unlink(dest).catch(() => {});
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
}

async function revertInto(
  cwd: string,
  worktree: string,
  worktreeReal: string,
  relPath: string,
  snapshot: FileSnapshot | undefined,
): Promise<void> {
  const dest = resolveTargetPath(worktree, relPath);
  if (!dest) return;
  try {
    await assertWriteContained(worktree, worktreeReal, dest);
  } catch {
    return;
  }
  if (!snapshot?.existed || !snapshot.snapshotPath) {
    await unlink(dest).catch(() => {});
    return;
  }
  const source = resolveTargetPath(cwd, snapshot.snapshotPath);
  if (!source) return;
  const content = await readFile(source);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, content);
}

function harnessError(plan: RegressionPlan, detail: string): RegressionResult {
  return {
    file: plan.file,
    line: plan.line,
    category: plan.category,
    testFile: plan.testFile,
    testCommand: plan.testCommand,
    outcome: "harness-error",
    greenAfterFix: false,
    redWhenReverted: false,
    proven: false,
    detail,
  };
}

/**
 * Prove each authored test red-without-the-fix and green-with-it.
 * Never writes to the user's working tree and never throws.
 */
export async function runRegressionHarness(
  opts: RegressionHarnessOptions,
): Promise<{ results: RegressionResult[]; notes: string[] }> {
  const { cwd, plans, snapshots, signal } = opts;
  const results: RegressionResult[] = [];
  const notes: string[] = [];
  if (plans.length === 0) return { results, notes };

  const head = await git(["rev-parse", "--verify", "HEAD"], cwd);
  if (!head.ok) {
    notes.push(
      "no git commit available — regression tests were run once against the current tree only, so they are not proven to catch the original defect",
    );
    for (const plan of plans) {
      opts.onStart?.(plan);
      const tokens = tokenizeTestCommand(plan.testCommand);
      let result: RegressionResult;
      if (tokens) {
        const green = await runCommand(tokens, cwd, signal);
        result = {
          file: plan.file,
          line: plan.line,
          category: plan.category,
          testFile: plan.testFile,
          testCommand: plan.testCommand,
          outcome: "green-only",
          greenAfterFix: green.ok,
          redWhenReverted: false,
          proven: false,
          detail: green.ok ? undefined : green.output,
        };
      } else {
        result = harnessError(plan, `unsafe test command rejected: ${plan.testCommand}`);
      }
      results.push(result);
      opts.onDone?.(result);
    }
    return { results, notes };
  }

  let base: string | undefined;
  let worktree: string | undefined;
  try {
    base = await mkdtemp(path.join(tmpdir(), "persona-audit-regress-"));
    worktree = path.join(base, "wt");
    const added = await git(["worktree", "add", "--detach", worktree, "HEAD"], cwd);
    if (!added.ok) {
      notes.push("could not create a scratch git worktree — regression tests were skipped");
      return { results, notes };
    }
    const worktreeReal = await realpath(worktree);

    const nodeModules = path.join(cwd, "node_modules");
    if (await stat(nodeModules).then(() => true, () => false)) {
      await symlink(nodeModules, path.join(worktree, "node_modules"), "dir").catch(() => {
        notes.push("could not link node_modules into the scratch worktree — tests needing dependencies may fail there");
      });
    }

    // The worktree must reproduce the real tree, not bare HEAD: the implement
    // agent edits files that are not finding targets, and the user may have had
    // uncommitted work before the audit started.
    const overlay = new Set<string>([
      ...snapshots.keys(),
      ...(await dirtyPaths(cwd)),
      ...plans.map((p) => p.testFile).filter((testFile) => resolveTargetPath(cwd, testFile) !== undefined),
    ]);
    const worktreeDir = worktree;
    await mapWithConcurrencyLimit([...overlay], 8, (relPath) => copyInto(cwd, worktreeDir, worktreeReal, relPath));

    for (const plan of plans) {
      if (signal?.aborted) {
        notes.push("run aborted — remaining regression tests were skipped");
        break;
      }
      opts.onStart?.(plan);
      const tokens = tokenizeTestCommand(plan.testCommand);
      if (!tokens) {
        const result = harnessError(plan, `unsafe test command rejected: ${plan.testCommand}`);
        results.push(result);
        opts.onDone?.(result);
        continue;
      }

      const shared = {
        file: plan.file,
        line: plan.line,
        category: plan.category,
        testFile: plan.testFile,
        testCommand: plan.testCommand,
      };

      const green = await runCommand(tokens, worktree, signal);
      if (!green.ok) {
        const result: RegressionResult = {
          ...shared,
          outcome: "green-check-failed",
          greenAfterFix: false,
          redWhenReverted: false,
          proven: false,
          detail: green.output,
        };
        results.push(result);
        opts.onDone?.(result);
        continue;
      }

      let result: RegressionResult;
      try {
        await revertInto(cwd, worktree, worktreeReal, plan.file, snapshots.get(plan.file));
        const red = await runCommand(tokens, worktree, signal);
        result = {
          ...shared,
          outcome: red.ok ? "not-discriminating" : "proven",
          greenAfterFix: true,
          redWhenReverted: !red.ok,
          proven: !red.ok,
          detail: red.ok ? undefined : tail(red.output, OUTPUT_TAIL_CHARS),
        };
      } catch (error) {
        result = harnessError(plan, message(error));
      } finally {
        await copyInto(cwd, worktree, worktreeReal, plan.file);
      }
      results.push(result);
      opts.onDone?.(result);
    }
  } catch (error) {
    notes.push(`regression harness error: ${message(error)}`);
  } finally {
    if (worktree) await git(["worktree", "remove", "--force", worktree], cwd);
    if (base) await rm(base, { recursive: true, force: true }).catch(() => {});
    await git(["worktree", "prune"], cwd);
  }

  return { results, notes };
}

/**
 * Fold harness outcomes into the verdicts from the agent pass.
 * Regression evidence can only sharpen a verdict, never rescue one: a harness
 * problem leaves the independently-reached verdict untouched.
 */
export function applyRegressionEvidence(
  fixes: FixVerification[],
  results: RegressionResult[],
): FixVerification[] {
  const byKey = new Map(results.map((r) => [verificationKey(r.file, r.line, r.category), r]));
  return fixes.map((fix) => {
    const regression = byKey.get(verificationKey(fix.file, fix.line, fix.category));
    if (!regression) return fix;
    if (regression.outcome === "proven") {
      return {
        ...fix,
        regression,
        evidence: `${fix.evidence} · regression test ${regression.testFile} is red without the fix`,
      };
    }
    if (regression.outcome === "not-discriminating" && fix.verdict === "fixed") {
      return {
        ...fix,
        regression,
        verdict: "partial",
        evidence: `${fix.evidence} · regression test still passes with the fix reverted`,
      };
    }
    return { ...fix, regression };
  });
}
