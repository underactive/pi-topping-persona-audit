import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSavedChoice } from "../src/modelCatalogue.ts";
import type { ModelRef, PhaseModelChoice } from "../src/modelConfig.ts";

const live: PhaseModelChoice = {
  ref: { provider: "provider-a", id: "model-1" },
  thinking: "medium",
};
const available: ModelRef[] = [
  { provider: "provider-a", id: "model-1" },
  { provider: "provider-b", id: "model-2" },
];

test("validateSavedChoice preserves a listed exact provider/id choice", () => {
  assert.deepEqual(validateSavedChoice(live, available), { choice: live });
});

test("validateSavedChoice drops a retired ref without an undefined choice key", () => {
  const retired: PhaseModelChoice = {
    ref: { provider: "gone", id: "retired" },
    thinking: "high",
  };
  const result = validateSavedChoice(retired, available);

  assert.deepEqual(result, { dropped: "gone/retired" });
  assert.equal("choice" in result, false);
});

test("validateSavedChoice returns an empty object for no saved choice", () => {
  assert.deepEqual(validateSavedChoice(undefined, available), {});
});

test("validateSavedChoice preserves a choice when the catalogue is empty", () => {
  assert.deepEqual(validateSavedChoice(live, []), { choice: live });
});

test("validateSavedChoice rejects a retired provider instead of allowing bare-id fallback", () => {
  const retired: PhaseModelChoice = {
    ref: { provider: "openai-codex", id: "gpt-5.4" },
    thinking: "max",
  };
  const sameIdElsewhere: ModelRef[] = [{ provider: "other-provider", id: "gpt-5.4" }];

  assert.deepEqual(validateSavedChoice(retired, sameIdElsewhere), { dropped: "openai-codex/gpt-5.4" });
});
