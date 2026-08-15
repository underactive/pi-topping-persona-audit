import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { ActivityMeter, StreamingWordCounter, TokRateTracker, rateToLevel } from "../src/activityMeter.ts";

// src/activityMeter.ts is vendored from pi-moa-plan (originally pi-topping), so
// these assertions are the drift alarm: if they need updating, check whether
// upstream changed too rather than retuning the thresholds locally.

test("rateToLevel maps output rates onto the eight display levels", () => {
  assert.equal(rateToLevel(0), 0);
  assert.equal(rateToLevel(1), 1);
  assert.equal(rateToLevel(5), 1);
  assert.equal(rateToLevel(5.1), 2);
  assert.equal(rateToLevel(10), 2);
  assert.equal(rateToLevel(10.1), 3);
  assert.equal(rateToLevel(15), 3);
  assert.equal(rateToLevel(15.1), 4);
  assert.equal(rateToLevel(22), 4);
  assert.equal(rateToLevel(22.1), 5);
  assert.equal(rateToLevel(30), 5);
  assert.equal(rateToLevel(30.1), 6);
  assert.equal(rateToLevel(40), 6);
  assert.equal(rateToLevel(40.1), 7);
});

test("meter renders an eight-cell braille ramp and scrolls left-to-right", () => {
  const meter = new ActivityMeter();
  assert.equal(meter.render(), "⢀⢀⢀⢀⢀⢀⢀⢀");
  for (let i = 0; i < 8; i++) meter.push(3);
  assert.equal(meter.render(), "⣤⣤⣤⣤⣤⣤⣤⣤");
  for (let i = 0; i < 8; i++) meter.push(7);
  assert.equal(meter.render(), "⣿⣿⣿⣿⣿⣿⣿⣿");

  meter.reset();
  for (let i = 0; i < 8; i++) meter.push(0);
  for (let i = 0; i < 3; i++) meter.push(4);
  assert.equal(meter.render(), "⣴⣴⣴⢀⢀⢀⢀⢀");
});

test("colorizeCell dims idle cells and wraps settled rows in ANSI faint", () => {
  const theme = { fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>` };
  assert.equal(ActivityMeter.colorizeCell(0, "⢀", theme), "<dim>⢀</dim>");
  assert.equal(ActivityMeter.colorizeCell(3, "⣤", theme), "<accent>⣤</accent>");
  assert.equal(ActivityMeter.colorizeCell(3, "⣤", theme, "border"), "<border>⣤</border>");
  assert.equal(ActivityMeter.colorizeCell(3, "⣤", theme, "accent", true), "\x1b[2m<accent>⣤</accent>\x1b[22m");
});

test("TokRateTracker smooths with EMA and defers tokens sampled at a duplicate timestamp", () => {
  const tracker = new TokRateTracker();
  assert.equal(tracker.sample(0, 0), 0);
  assert.equal(tracker.sample(3, 200), 6);
  assert.equal(tracker.sample(9, 400), 15.6);
  assert.equal(tracker.sample(20, 400), 15.6);
  // The 11 tokens banked at the duplicate timestamp land at 600 ms:
  // 0.4 × (11 / 0.2) + 0.6 × 15.6 = 31.36.
  assert.equal(tracker.sample(0, 600), 31.36);

  tracker.reset();
  assert.equal(tracker.sample(100, 2_000), 0);
});

test("StreamingWordCounter counts split words once and keeps streams independent", () => {
  const counter = new StreamingWordCounter();
  assert.equal(counter.count("hello world "), 2);
  // A word split across deltas is counted once, not twice.
  assert.equal(counter.count("frag"), 1);
  assert.equal(counter.count("ment "), 0);
  // Interleaved streams keep independent mid-word state.
  assert.equal(counter.count("think", "thinking_delta"), 1);
  assert.equal(counter.count("more text", "text_delta"), 2);
  assert.equal(counter.count("ing done", "thinking_delta"), 1);

  counter.reset();
  assert.equal(counter.count("ment "), 1, "reset must forget mid-word state");
  assert.equal(counter.count("   \n\t  "), 0);
});
