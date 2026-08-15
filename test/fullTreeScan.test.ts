import assert from "node:assert/strict";
import { test } from "node:test";
import { capFileList } from "../src/index.ts";

// ── capFileList ──────────────────────────────────────────────────────────

test("capFileList returns a sorted, deduplicated list untruncated when under the cap", () => {
  const result = capFileList(["src/b.ts", "src/a.ts", "src/a.ts"], 10);
  assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);
  assert.equal(result.truncated, false);
  assert.equal(result.totalFound, 2);
});

test("capFileList truncates deterministically and reports the true total when over the cap", () => {
  const files = ["c.ts", "a.ts", "b.ts", "d.ts", "e.ts"];
  const result = capFileList(files, 3);
  assert.deepEqual(result.files, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(result.truncated, true);
  assert.equal(result.totalFound, 5);
});

test("capFileList treats an empty input as untruncated with zero total", () => {
  const result = capFileList([], 100);
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false);
  assert.equal(result.totalFound, 0);
});

test("capFileList treats an exact-cap-sized input as untruncated", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const result = capFileList(files, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.files.length, 3);
});
