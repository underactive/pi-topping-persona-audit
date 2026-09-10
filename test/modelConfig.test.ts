import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultThinkingForModel,
  DEFAULT_METER_SETTINGS,
  DEFAULT_TEMPERAMENT,
  DEFAULT_VERIFY_ROUNDS,
  MAX_ROSTER_COUNT,
  MAX_ROSTER_NAME_LENGTH,
  MAX_ROSTER_SIZE,
  MAX_VERIFY_ROUNDS,
  MIN_VERIFY_ROUNDS,
  parsePersonaAuditSettings,
  resolveMeterColor,
  thinkingColorFor,
  thinkingOptionsForModel,
  type PersonaAuditConfig,
} from "../src/modelConfig.ts";

test("parsePersonaAuditSettings round-trips a well-formed settings file", () => {
  const config: PersonaAuditConfig = {
    phases: {
      review: { ref: { provider: "anthropic", id: "claude-opus-4-6" }, thinking: "high" },
      triage: { ref: { provider: "openai", id: "gpt-5" }, thinking: "medium" },
    },
    thinkingOverrides: { "anthropic/claude-opus-4-6": "high" },
    meter: { color: "thinkingLevel", direction: "ltr" },
    temperament: "lkml",
    maxVerifyRounds: 5,
    rosters: [{ name: "Core5", reviewers: ["Architecture", "Security"] }],
  };
  const parsed = parsePersonaAuditSettings(JSON.stringify(config));
  assert.deepEqual(parsed, config);
});

test("parsePersonaAuditSettings round-trips the dispatch slot and omits it when absent or malformed", () => {
  const dispatch = { ref: { provider: "anthropic", id: "claude-haiku-4-5" }, thinking: "low" as const };
  assert.deepEqual(parsePersonaAuditSettings(JSON.stringify({ dispatch })).dispatch, dispatch);
  assert.equal("dispatch" in parsePersonaAuditSettings("{}"), false, "an absent slot must not become an undefined key");
  assert.equal(
    "dispatch" in parsePersonaAuditSettings(JSON.stringify({ dispatch: { ref: { provider: "x" }, thinking: "low" } })),
    false,
    "a malformed slot is dropped",
  );
});

test("parsePersonaAuditSettings falls back to an empty config on malformed JSON", () => {
  const empty = {
    phases: {},
    thinkingOverrides: {},
    meter: DEFAULT_METER_SETTINGS,
    temperament: DEFAULT_TEMPERAMENT,
    maxVerifyRounds: DEFAULT_VERIFY_ROUNDS,
    rosters: [],
  };
  assert.deepEqual(parsePersonaAuditSettings("not json"), empty);
  assert.deepEqual(parsePersonaAuditSettings(""), empty);
});

test("parsePersonaAuditSettings defaults a missing maxVerifyRounds and clamps out-of-range values", () => {
  assert.equal(parsePersonaAuditSettings("{}").maxVerifyRounds, DEFAULT_VERIFY_ROUNDS);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ maxVerifyRounds: 6 })).maxVerifyRounds, 6);
  assert.equal(
    parsePersonaAuditSettings(JSON.stringify({ maxVerifyRounds: 0 })).maxVerifyRounds,
    MIN_VERIFY_ROUNDS,
    "below the floor clamps up to the minimum",
  );
  assert.equal(
    parsePersonaAuditSettings(JSON.stringify({ maxVerifyRounds: 999 })).maxVerifyRounds,
    MAX_VERIFY_ROUNDS,
    "above the ceiling clamps down to the maximum",
  );
  assert.equal(
    parsePersonaAuditSettings(JSON.stringify({ maxVerifyRounds: 3.7 })).maxVerifyRounds,
    4,
    "a fractional value rounds to a whole number of rounds",
  );
  assert.equal(
    parsePersonaAuditSettings(JSON.stringify({ maxVerifyRounds: "lots" })).maxVerifyRounds,
    DEFAULT_VERIFY_ROUNDS,
    "a non-number falls back to the default",
  );
});

test("parsePersonaAuditSettings defaults an unknown temperament", () => {
  assert.equal(parsePersonaAuditSettings("{}").temperament, DEFAULT_TEMPERAMENT);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ temperament: "vintage" })).temperament, DEFAULT_TEMPERAMENT);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ temperament: "caustic" })).temperament, "caustic");
});

test("parsePersonaAuditSettings defaults the meter and rejects each invalid field independently", () => {
  assert.deepEqual(parsePersonaAuditSettings("{}").meter, DEFAULT_METER_SETTINGS);
  assert.equal(parsePersonaAuditSettings("{}").meter.color, "thinkingLevel");
  assert.deepEqual(
    parsePersonaAuditSettings(JSON.stringify({ meter: { color: "chartreuse", direction: "sideways" } })).meter,
    DEFAULT_METER_SETTINGS,
  );
  assert.deepEqual(
    parsePersonaAuditSettings(JSON.stringify({ meter: { color: "chartreuse", direction: "ltr" } })).meter,
    { color: "thinkingLevel", direction: "ltr" },
  );
});

test("thinking-level meter colors resolve to native theme colors", () => {
  assert.equal(thinkingColorFor("high"), "thinkingHigh");
  assert.equal(thinkingColorFor(undefined), "accent");
  assert.equal(resolveMeterColor("thinkingLevel", "high"), "thinkingHigh");
  assert.equal(resolveMeterColor("thinkingLevel", undefined), "accent");
  assert.equal(resolveMeterColor("warning", "high"), "warning");
});

test("parsePersonaAuditSettings drops unknown thinking levels and malformed phase entries", () => {
  const raw = JSON.stringify({
    phases: {
      review: { ref: { provider: "anthropic", id: "claude-opus-4-6" }, thinking: "extreme" },
      triage: { ref: { provider: "openai" }, thinking: "medium" }, // missing id
      implement: { ref: { provider: "openai", id: "gpt-5" }, thinking: "low" },
      bogus: { ref: { provider: "x", id: "y" }, thinking: "low" },
    },
    thinkingOverrides: {
      "anthropic/claude-opus-4-6": "not-a-level",
      "openai/gpt-5": "low",
    },
  });
  const parsed = parsePersonaAuditSettings(raw);
  assert.deepEqual(parsed.phases, {
    implement: { ref: { provider: "openai", id: "gpt-5" }, thinking: "low" },
  });
  assert.deepEqual(parsed.thinkingOverrides, { "openai/gpt-5": "low" });
});

test("parsePersonaAuditSettings sanitizes rosters while preserving unknown reviewers", () => {
  const tooLong = "A".repeat(MAX_ROSTER_NAME_LENGTH + 1);
  const reviewers = Array.from({ length: MAX_ROSTER_SIZE + 2 }, (_, index) => `Reviewer${index}`);
  const excessRosters = Array.from({ length: MAX_ROSTER_COUNT + 2 }, (_, index) => ({
    name: `Roster${index}`,
    reviewers: [`Unknown${index}`],
  }));
  const parsed = parsePersonaAuditSettings(JSON.stringify({
    rosters: [
      { name: " Core5 ", reviewers: [" Architecture ", "Architecture", "Unknown reviewer", ""] },
      { name: "core5", reviewers: ["Security"] },
      { name: "bad-name", reviewers: ["Security"] },
      { name: tooLong, reviewers: ["Security"] },
      { name: "Empty", reviewers: [" ", 42] },
      { name: "Capped", reviewers },
      ...excessRosters,
    ],
  }));

  assert.deepEqual(parsed.rosters[0], {
    name: "Core5",
    reviewers: ["Architecture", "Unknown reviewer"],
  });
  assert.equal(parsed.rosters[1]?.name, "Capped");
  assert.equal(parsed.rosters[1]?.reviewers.length, MAX_ROSTER_SIZE);
  assert.equal(parsed.rosters.length, MAX_ROSTER_COUNT);
  assert.equal(parsed.rosters.some((roster) => roster.name === "core5"), false);
  assert.equal(parsed.rosters.some((roster) => roster.name === "bad-name"), false);
  assert.equal(parsed.rosters.some((roster) => roster.name === tooLong), false);
  assert.equal(parsed.rosters.some((roster) => roster.name === "Empty"), false);
});

test("parsePersonaAuditSettings defaults malformed roster collections", () => {
  assert.deepEqual(parsePersonaAuditSettings("{}").rosters, []);
  assert.deepEqual(parsePersonaAuditSettings(JSON.stringify({ rosters: {} })).rosters, []);
  assert.deepEqual(parsePersonaAuditSettings(JSON.stringify({ rosters: [null, "bad", { name: "Valid" }] })).rosters, []);
});

test("thinkingOptionsForModel filters to the registry's declared levels in canonical order", () => {
  assert.deepEqual(thinkingOptionsForModel(["high", "off", "medium"]), ["off", "medium", "high"]);
  assert.deepEqual(thinkingOptionsForModel([]), []);
});

test("defaultThinkingForModel prefers a saved override, then the current level, then medium, then the first supported", () => {
  const overrides = { "anthropic/claude-opus-4-6": "xhigh" as const };

  assert.equal(defaultThinkingForModel("anthropic/claude-opus-4-6", overrides, "low", ["low", "medium", "xhigh"]), "xhigh");
  assert.equal(defaultThinkingForModel("openai/gpt-5", overrides, "low", ["low", "medium", "high"]), "low");
  assert.equal(defaultThinkingForModel("openai/gpt-5", overrides, "off", ["low", "medium", "high"]), "medium");
  assert.equal(defaultThinkingForModel("openai/gpt-5", overrides, "off", ["low", "high"]), "low");
});
