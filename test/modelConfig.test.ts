import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DECISION_SETTINGS,
  DEFAULT_METER_SETTINGS,
  DEFAULT_CROSS_EXAMINATION_MODE,
  DEFAULT_TEMPERAMENT,
  DEFAULT_VERIFY_ROUNDS,
  MAX_ROSTER_COUNT,
  MAX_ROSTER_NAME_LENGTH,
  MAX_ROSTER_SIZE,
  MAX_VERIFY_ROUNDS,
  MIN_VERIFY_ROUNDS,
  parsePersonaAuditSettings,
  resolveMeterColor,
  seedPhaseSelections,
  type ModelRef,
  type PersonaAuditConfig,
  type PhaseModelSelection,
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
    crossExamination: "all",
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
    crossExamination: DEFAULT_CROSS_EXAMINATION_MODE,
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

test("parsePersonaAuditSettings validates crossExamination modes", () => {
  assert.equal(parsePersonaAuditSettings("{}").crossExamination, DEFAULT_CROSS_EXAMINATION_MODE);
  for (const crossExamination of ["off", "red-team", "all"] as const) {
    assert.equal(parsePersonaAuditSettings(JSON.stringify({ crossExamination })).crossExamination, crossExamination);
  }
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ crossExamination: "unknown" })).crossExamination, DEFAULT_CROSS_EXAMINATION_MODE);
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

  for (const ref of [{ provider: "", id: "model" }, { provider: "provider", id: "" }]) {
    const invalid = parsePersonaAuditSettings(JSON.stringify({
      phases: { review: { ref, thinking: "low" } },
      dispatch: { ref, thinking: "low" },
    }));
    assert.deepEqual(invalid.phases, {});
    assert.equal("dispatch" in invalid, false);
  }
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

test("parsePersonaAuditSettings leaves the decision block absent unless it is a record", () => {
  assert.equal(parsePersonaAuditSettings("{}").decision, undefined);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ decision: "on" })).decision, undefined);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ decision: [1, 2] })).decision, undefined);
  assert.equal(parsePersonaAuditSettings(JSON.stringify({ decision: null })).decision, undefined);
});

test("a present decision block defaults to disabled with auto selection", () => {
  const decision = parsePersonaAuditSettings(JSON.stringify({ decision: {} })).decision;
  assert.deepEqual(decision, {
    ...DEFAULT_DECISION_SETTINGS,
    enabled: false,
  });
  assert.equal(decision?.provider, "auto");
  assert.equal(decision?.model, "auto");
  assert.equal(decision?.timeoutMs, 3000);
  assert.equal(decision?.circuitBreakerEnabled, true);
  assert.equal(decision?.circuitBreakerCooldownSeconds, 30);
  assert.equal(decision?.useForDispatcher, true);
  assert.equal(decision?.useForTriage, false);
});

test("a decision block keeps a usable pin and rejects a malformed one", () => {
  const stored = (decision: unknown): ReturnType<typeof parsePersonaAuditSettings>["decision"] =>
    parsePersonaAuditSettings(JSON.stringify({ decision })).decision;
  assert.equal(stored({ enabled: true, provider: "openrouter", model: "typesafe/jev-1.13" })?.provider, "openrouter");
  assert.equal(stored({ enabled: true, provider: "openrouter", model: "typesafe/jev-1.13" })?.model, "typesafe/jev-1.13");
  // A provider id never carries a slash, and an empty model id resolves to nothing.
  assert.equal(stored({ provider: "openrouter/jean", model: "jev" })?.provider, "auto");
  assert.equal(stored({ provider: "", model: "jev" })?.provider, "auto");
  assert.equal(stored({ provider: "openrouter", model: "" })?.model, "auto");
  assert.equal(stored({ provider: 42, model: 7 })?.provider, "auto");
  // Bounds clamp rather than trust the file.
  assert.equal(stored({ timeoutMs: -5 })?.timeoutMs, 1);
  assert.equal(stored({ timeoutMs: 2500.6 })?.timeoutMs, 2501);
  assert.equal(stored({ timeoutMs: "soon" })?.timeoutMs, 3000);
  assert.equal(stored({ circuitBreakerCooldownSeconds: -1 })?.circuitBreakerCooldownSeconds, 0);
  assert.equal(stored({ circuitBreakerCooldownSeconds: 12.4 })?.circuitBreakerCooldownSeconds, 12);
  // Booleans are read strictly: only a literal true enables anything.
  assert.equal(stored({ enabled: "yes" })?.enabled, false);
  assert.equal(stored({ enabled: true, useForTriage: 1 })?.useForTriage, false);
  assert.equal(stored({ enabled: true, useForTriage: true })?.useForTriage, true);
  assert.equal(stored({ enabled: true, useForDispatcher: false })?.useForDispatcher, false);
  assert.equal(stored({ enabled: true, circuitBreakerEnabled: false })?.circuitBreakerEnabled, false);
});

test("seedPhaseSelections replaces a retired saved model and recomputes thinking", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const seeded = seedPhaseSelections(
    { review: { ref: { provider: "gone", id: "retired" }, thinking: "max" } },
    undefined,
    [fallbackRef],
    fallbackRef,
    () => "low",
  );

  assert.deepEqual(seeded.selections.review, { ref: fallbackRef, thinking: "low" });
  assert.deepEqual(seeded.dropped, ["gone/retired"]);
});

test("seedPhaseSelections preserves live saved choices and gives initial choices precedence", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const live = { ref: { provider: "saved", id: "live" }, thinking: "high" } as const;
  const unsaved = { ref: { provider: "unsaved", id: "picked" }, thinking: "xhigh" } as const;
  const initial: PhaseModelSelection = {
    review: unsaved,
    triage: unsaved,
    implement: unsaved,
    verify: unsaved,
  };

  const savedOnly = seedPhaseSelections(
    { review: live },
    undefined,
    [fallbackRef, live.ref],
    fallbackRef,
    () => "low",
  );
  assert.deepEqual(savedOnly.selections.review, live);

  const initialWins = seedPhaseSelections(
    { review: live },
    initial,
    [fallbackRef, live.ref],
    fallbackRef,
    () => "low",
  );
  assert.deepEqual(initialWins.selections.review, unsaved);
  assert.deepEqual(initialWins.dropped, [], "initial choices are not revalidated against the catalogue");
});

test("seedPhaseSelections reports each retired saved model once", () => {
  const fallbackRef: ModelRef = { provider: "session", id: "current" };
  const retired = { ref: { provider: "gone", id: "retired" }, thinking: "medium" } as const;
  const seeded = seedPhaseSelections(
    { review: retired, triage: retired },
    undefined,
    [fallbackRef],
    fallbackRef,
    () => "off",
  );

  assert.deepEqual(seeded.dropped, ["gone/retired"]);
});
