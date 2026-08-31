import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackSteSummary, MAX_FINDING_SUMMARY_LENGTH } from "../src/findingSummary.ts";

test("fallbackSteSummary removes redundant finding prefixes and uses plain words", () => {
  const summary = fallbackSteSummary("bug:903 — Prior to parsing, utilize the Open Question result in order to show the user text.");

  assert.equal(summary, "Before parsing, use the Open Question result to show the user text.");
});

test("fallbackSteSummary shortens long text at a sentence boundary", () => {
  const first = "The parser captures output after the question. ";
  const summary = fallbackSteSummary(first + "Additional detail ".repeat(40));

  assert.equal(summary, "The parser captures output after the question.");
  assert.ok(summary.length <= MAX_FINDING_SUMMARY_LENGTH);
});

test("fallbackSteSummary caps an unbroken long input", () => {
  const summary = fallbackSteSummary("word".repeat(200));

  assert.equal(summary.length, MAX_FINDING_SUMMARY_LENGTH);
  assert.ok(summary.endsWith("…"));
});

test("fallbackSteSummary safely handles blank and prefix-only input", () => {
  assert.equal(fallbackSteSummary("\n\t"), "");
  assert.equal(fallbackSteSummary("bug:903 — "), "bug:903 —");
});
