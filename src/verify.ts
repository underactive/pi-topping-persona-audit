/**
 * Post-fix verification gate — runs discovered package.json scripts after fixes land.
 *
 * Discovers existing verification scripts in package.json (check → lint →
 * test, in that order) and runs one at a time via `npm run <script>` from the
 * project root. Never invents a runner or adds runner-specific flags.
 * `runVerifyScript` reports a failure instead of throwing, so the caller's loop
 * can run every discovered script and capture the complete gate status.
 *
 * This gate runs last in the verify phase, after per-finding verification and
 * regression authoring, so that newly authored tests are covered by it.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tail } from "./subprocess.ts";
import type { FixVerification, VerificationStatus, VerifyResult } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Preferred script discovery order. */
const SCRIPT_ORDER = ["check", "lint", "test"] as const;

const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CHARS = 4_000;

/** Discover which of check/lint/test exist in package.json#scripts. */
export async function discoverVerifyScripts(cwd: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(`${cwd}/package.json`, "utf-8");
  } catch {
    return [];
  }

  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return [];
  }

  return SCRIPT_ORDER.filter((name) => typeof scripts[name] === "string");
}

/** Run one discovered verification script via `npm run <script>`. Never throws. */
export async function runVerifyScript(cwd: string, script: string, signal?: AbortSignal): Promise<VerifyResult> {
  const command = `npm run ${script}`;
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", script], {
      cwd,
      encoding: "utf-8",
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    });
    return {
      script,
      command,
      status: "pass",
      exitCode: 0,
      relevantOutput: tail(`${stdout}\n${stderr}`, OUTPUT_TAIL_CHARS),
    };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      script,
      command,
      status: "fail",
      exitCode: typeof err.code === "number" ? err.code : 1,
      relevantOutput: tail(`${err.stdout ?? ""}\n${err.stderr ?? ""}`, OUTPUT_TAIL_CHARS) || (err.message ?? "unknown error"),
    };
  }
}

/**
 * Fold per-finding verdicts and the script gate into one report-level status.
 *
 * A run with every fix verified but no discovered scripts settles at "partial":
 * claiming "passed" with no gate would over-promise.
 */
export function aggregateVerificationStatus(input: {
  implementFailed: boolean;
  acceptedCount: number;
  fixes: FixVerification[];
  scripts: VerifyResult[];
}): VerificationStatus {
  if (input.implementFailed || input.acceptedCount === 0) return "skipped";
  if (input.scripts.some((r) => r.status === "fail")) return "failed";
  if (input.fixes.some((f) => f.verdict === "not-fixed")) return "failed";
  if (input.fixes.some((f) => f.verdict === "partial" || f.verdict === "cannot-verify")) return "partial";
  if (input.fixes.length < input.acceptedCount) return "partial";
  if (input.scripts.length === 0) return "partial";
  return "passed";
}
