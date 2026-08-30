import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePersonaAuditArgs, tokenizeCommandArgs } from "../src/args.ts";

test("tokenizeCommandArgs preserves unquoted splitting and supports quoted values", () => {
  assert.deepEqual(
    tokenizeCommandArgs(`--full "src/my components" --exclude 'my tests'`),
    ["--full", "src/my components", "--exclude", "my tests"],
  );
});

test("tokenizeCommandArgs rejects unmatched quotes", () => {
  assert.throws(() => tokenizeCommandArgs(`--full "src`), /Unmatched " quote/);
});

test("parsePersonaAuditArgs preserves diff, base, scope, and full parsing", () => {
  const diff = parsePersonaAuditArgs("--diff --base HEAD~5 src/components");
  assert.equal(diff.ok, true);
  if (!diff.ok) return;
  assert.deepEqual(
    { useDiff: diff.value.useDiff, useFull: diff.value.useFull, baseCommit: diff.value.baseCommit, scope: diff.value.scope, scopeGiven: diff.value.scopeGiven },
    { useDiff: true, useFull: false, baseCommit: "HEAD~5", scope: "src/components", scopeGiven: true },
  );

  const full = parsePersonaAuditArgs("--full");
  assert.equal(full.ok, true);
  if (full.ok) assert.equal(full.value.scope, ".");
});

test("parsePersonaAuditArgs preserves existing missing-value errors", () => {
  assert.deepEqual(parsePersonaAuditArgs("--diff --base --full"), { ok: false, error: "Error: --base requires a commit." });
  assert.deepEqual(parsePersonaAuditArgs("--handoff"), {
    ok: false,
    error: "Error: --handoff requires a path to a deferred-findings handoff file.",
  });
});

test("parsePersonaAuditArgs collects and deduplicates name and path exclusions", () => {
  const result = parsePersonaAuditArgs("--exclude tests --full src --exclude src/generated --exclude tests");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.value.exclusions.names], ["tests"]);
  assert.deepEqual([...result.value.exclusions.paths], ["src/generated"]);
});

test("parsePersonaAuditArgs normalizes separators and redundant path segments", () => {
  const result = parsePersonaAuditArgs("--full --exclude .\\src\\generated\\..\\fixtures\\");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([...result.value.exclusions.paths], ["src/fixtures"]);
});

test("parsePersonaAuditArgs supports quoted scope and exclusion values", () => {
  const result = parsePersonaAuditArgs(`--full "src/my components" --exclude "src/my components/my tests"`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.scope, "src/my components");
  assert.deepEqual([...result.value.exclusions.paths], ["src/my components/my tests"]);
});

test("parsePersonaAuditArgs validates exclusion values", () => {
  for (const input of ["--full --exclude", "--full --exclude --diff", `--full --exclude ""`]) {
    const result = parsePersonaAuditArgs(input);
    assert.equal(result.ok, false, input);
  }
  for (const [input, pattern] of [
    ["--full --exclude .", /cannot be empty/],
    ["--full --exclude ../outside", /escapes the project root/],
    ["--full --exclude /tmp/outside", /must be relative/],
    [String.raw`--full --exclude C:\outside`, /must be relative/],
  ] as const) {
    const result = parsePersonaAuditArgs(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, pattern);
  }
});

test("parsePersonaAuditArgs restricts exclusions to full mode", () => {
  for (const input of ["--diff --exclude tests", "--handoff findings.md --exclude tests", "--exclude tests"]) {
    assert.deepEqual(parsePersonaAuditArgs(input), { ok: false, error: "Error: --exclude is only supported with --full mode." });
  }
});

test("parsePersonaAuditArgs returns unmatched quote errors", () => {
  const result = parsePersonaAuditArgs(`--full "src`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Unmatched/);
});
