import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { aggregateVerificationStatus, discoverVerifyScripts, runVerifyScript } from "../src/verify.ts";
import type { FixVerdict, FixVerification, VerifyResult } from "../src/types.ts";

/** Create a throwaway package.json project whose scripts are plain node one-liners. */
async function makeProject(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-verify-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }), "utf-8");
  return dir;
}

const passing = (marker: string): string => `node -e "console.log('${marker}')"`;
const failing = (marker: string): string => `node -e "console.error('${marker}'); process.exit(3)"`;

// ── discovery ──────────────────────────────────────────────────────────────

test("discoverVerifyScripts returns only present scripts, in check → lint → test order", async () => {
  const dir = await makeProject({ test: passing("t"), check: passing("c"), build: passing("b") });
  try {
    assert.deepEqual(await discoverVerifyScripts(dir), ["check", "test"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverVerifyScripts returns nothing for a project without package.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-verify-"));
  try {
    assert.deepEqual(await discoverVerifyScripts(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── per-script execution ───────────────────────────────────────────────────

test("runVerifyScript reports a passing script with its captured output", async () => {
  const dir = await makeProject({ check: passing("CHECK_OK") });
  try {
    const result = await runVerifyScript(dir, "check");
    assert.equal(result.script, "check");
    assert.equal(result.command, "npm run check");
    assert.equal(result.status, "pass");
    assert.equal(result.exitCode, 0);
    assert.ok(result.relevantOutput.includes("CHECK_OK"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runVerifyScript reports a failing script instead of throwing", async () => {
  const dir = await makeProject({ check: failing("CHECK_BROKE") });
  try {
    const result = await runVerifyScript(dir, "check");
    assert.equal(result.status, "fail");
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.relevantOutput.includes("CHECK_BROKE"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── status aggregation ─────────────────────────────────────────────────────

const fix = (verdict: FixVerdict): FixVerification => ({
  file: "src/a.ts",
  line: 12,
  category: "security",
  verdict,
  evidence: "e",
  changed: "changed",
  selfReport: "applied",
});

const script = (status: VerifyResult["status"]): VerifyResult => ({
  script: "check",
  command: "npm run check",
  status,
  exitCode: status === "pass" ? 0 : 1,
  relevantOutput: "",
});

test("aggregateVerificationStatus applies its clauses in precedence order", () => {
  const status = aggregateVerificationStatus;

  // 1. a failed implement phase, or nothing accepted, means nothing to verify
  assert.equal(status({ implementFailed: true, acceptedCount: 3, fixes: [fix("fixed")], scripts: [script("pass")] }), "skipped");
  assert.equal(status({ implementFailed: false, acceptedCount: 0, fixes: [], scripts: [] }), "skipped");

  // 2. a failing script fails the run outright
  assert.equal(status({ implementFailed: false, acceptedCount: 1, fixes: [fix("fixed")], scripts: [script("fail")] }), "failed");

  // 3. a fix that never landed fails the run even with a green gate
  assert.equal(status({ implementFailed: false, acceptedCount: 1, fixes: [fix("not-fixed")], scripts: [script("pass")] }), "failed");

  // 4. partial or unverifiable verdicts degrade to partial
  assert.equal(status({ implementFailed: false, acceptedCount: 1, fixes: [fix("partial")], scripts: [script("pass")] }), "partial");
  assert.equal(
    status({ implementFailed: false, acceptedCount: 1, fixes: [fix("cannot-verify")], scripts: [script("pass")] }),
    "partial",
  );

  // 5. an accepted finding with no verdict at all degrades to partial
  assert.equal(status({ implementFailed: false, acceptedCount: 2, fixes: [fix("fixed")], scripts: [script("pass")] }), "partial");

  // 6. every fix verified but no gate to back it up is not a pass
  assert.equal(status({ implementFailed: false, acceptedCount: 1, fixes: [fix("fixed")], scripts: [] }), "partial");

  // 7. everything verified and the gate is green
  assert.equal(status({ implementFailed: false, acceptedCount: 1, fixes: [fix("fixed")], scripts: [script("pass")] }), "passed");
});
