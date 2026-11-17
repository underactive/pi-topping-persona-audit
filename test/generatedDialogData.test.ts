import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_EXAMINATION_MODES,
  DEFAULT_DECISION_SETTINGS,
  MAX_ROSTER_COUNT,
  MAX_ROSTER_NAME_LENGTH,
  MAX_ROSTER_SIZE,
  MAX_VERIFY_ROUNDS,
  METER_COLORS,
  METER_DIRECTIONS,
  MIN_VERIFY_ROUNDS,
  ROSTER_NAME_PATTERN,
  TEMPERAMENTS,
} from "../src/modelConfig.ts";
import { dialogReviewers } from "../src/ui/dialog-models.ts";
import { rosterNameError } from "../src/ui/generated/persona-audit/admin.ts";
import {
  ALL_REVIEWERS,
  COST_CONFIRM_RUN_THRESHOLD,
  CROSS_EXAMINATION,
  DEFAULT_SETTINGS,
  DIRECTIONS,
  MAX_ROSTER_COUNT as DIALOG_MAX_ROSTER_COUNT,
  MAX_ROSTER_NAME_LENGTH as DIALOG_MAX_ROSTER_NAME_LENGTH,
  MAX_ROSTER_SIZE as DIALOG_MAX_ROSTER_SIZE,
  METER_COLORS as DIALOG_METER_COLORS,
  TEMPERAMENTS as DIALOG_TEMPERAMENTS,
} from "../src/ui/generated/persona-audit/data.ts";

// The dialogs' design metadata comes from the mockups and is generated, not copied. These pin it
// against the extension's own model, so a drift on either side fails here and not in front of a user.

test("the dialogs' choice rows list the extension's values in the extension's order", () => {
  assert.deepEqual(DIALOG_METER_COLORS, [...METER_COLORS]);
  assert.deepEqual(Object.keys(DIRECTIONS), [...METER_DIRECTIONS]);
  assert.deepEqual(Object.keys(DIALOG_TEMPERAMENTS), [...TEMPERAMENTS]);
  assert.deepEqual(Object.keys(CROSS_EXAMINATION), [...CROSS_EXAMINATION_MODES]);
  // The rounds row is a fixed list of ten values, and its index maps back by adding one.
  assert.equal(MIN_VERIFY_ROUNDS, 1);
  assert.equal(MAX_VERIFY_ROUNDS, 10);
});

test("the dialogs' defaults are the extension's defaults", () => {
  assert.equal(DEFAULT_SETTINGS.decision.useForDispatcher, DEFAULT_DECISION_SETTINGS.useForDispatcher);
  assert.equal(DEFAULT_SETTINGS.decision.useForTriage, DEFAULT_DECISION_SETTINGS.useForTriage);
  assert.equal(DEFAULT_SETTINGS.decision.enabled, DEFAULT_DECISION_SETTINGS.enabled);
});

test("the roster limits and the name rule are the extension's", () => {
  assert.equal(DIALOG_MAX_ROSTER_SIZE, MAX_ROSTER_SIZE);
  assert.equal(DIALOG_MAX_ROSTER_COUNT, MAX_ROSTER_COUNT);
  assert.equal(DIALOG_MAX_ROSTER_NAME_LENGTH, MAX_ROSTER_NAME_LENGTH);
  const names = ["Quick", "", "a b", "x".repeat(MAX_ROSTER_NAME_LENGTH), "x".repeat(MAX_ROSTER_NAME_LENGTH + 1), "naïve", "a-b", "R2D2"];
  for (const name of names) {
    const extensionAccepts = name.length >= 1 && name.length <= MAX_ROSTER_NAME_LENGTH && ROSTER_NAME_PATTERN.test(name);
    assert.equal(rosterNameError(name, []) === undefined, extensionAccepts, JSON.stringify(name));
  }
});

test("the sample reviewer catalogue is the extension's, so the mockup's copy cannot drift", () => {
  assert.deepEqual(ALL_REVIEWERS, dialogReviewers());
  assert.equal(COST_CONFIRM_RUN_THRESHOLD, 6);
});
