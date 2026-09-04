import assert from "node:assert/strict";
import test from "node:test";

import {
  ADJUDICATOR_APPLY_DIRECTIVE,
  ADJUDICATOR_RECONCILE_DIRECTIVE,
  FIX_HYGIENE_CONTRACT,
  FIX_NOW_APPLY_DIRECTIVE,
  PERSONALITIES,
  REGRESSION_TEST_DIRECTIVE,
  REVIEWER_OUTPUT_CONTRACT,
  REVOICE_DIRECTIVE,
  VERIFIER_DIRECTIVE,
  VERIFY_REPAIR_DIRECTIVE,
  getPersonality,
  registerEnforcement,
} from "../src/skillContent.ts";
import { TEMPERAMENTS } from "../src/modelConfig.ts";
import { TIERS } from "../src/components/ReviewerData.ts";

test("FIX_HYGIENE_CONTRACT names all seven slop categories", () => {
  const categories = [
    "comment",
    "indirection",
    "defensive code",
    "type-system escape hatch",
    "hand-rolled duplicate",
    "leftover",
    "debug logging",
  ];

  for (const category of categories) {
    assert.ok(
      FIX_HYGIENE_CONTRACT.toLowerCase().includes(category),
      `expected FIX_HYGIENE_CONTRACT to mention "${category}"`,
    );
  }
});

test("code-producing directives interpolate the fix hygiene contract", () => {
  const heading = "## Fix Hygiene";

  for (const directive of [
    REVIEWER_OUTPUT_CONTRACT,
    ADJUDICATOR_APPLY_DIRECTIVE,
    FIX_NOW_APPLY_DIRECTIVE,
    REGRESSION_TEST_DIRECTIVE,
    VERIFY_REPAIR_DIRECTIVE,
  ]) {
    assert.ok(directive.includes(heading));
  }
});

test("apply directives require updating related tests without weakening them", () => {
  for (const directive of [ADJUDICATOR_APPLY_DIRECTIVE, FIX_NOW_APPLY_DIRECTIVE]) {
    assert.match(directive, /Grep the test files/i);
    assert.match(directive, /[Nn]ever weaken a test/);
    assert.match(directive, /fix the fix, not the test/);
    assert.match(directive, /### Tests Updated/);
    assert.match(directive, /### Tests Left Failing/);
    assert.match(directive, /no bash|cannot run tests/i);
    assert.doesNotMatch(directive, /Do not modify test fixtures/);
  }
});

test("batch directive keeps parallel ownership, Fix Now directive drops it", () => {
  assert.match(ADJUDICATOR_APPLY_DIRECTIVE, /Your Primary Files/);
  assert.match(ADJUDICATOR_APPLY_DIRECTIVE, /Reserved Files/);
  assert.match(ADJUDICATOR_APPLY_DIRECTIVE, /## Adjudicator Fix Application Report/);
  assert.match(ADJUDICATOR_APPLY_DIRECTIVE, /### Fixes Applied[\s\S]*### Tests Updated[\s\S]*### Fixes Deferred/);

  assert.match(FIX_NOW_APPLY_DIRECTIVE, /only agent editing this tree/);
  assert.match(FIX_NOW_APPLY_DIRECTIVE, /Target File/);
  assert.match(FIX_NOW_APPLY_DIRECTIVE, /## Fix Now Report/);
  assert.ok(!FIX_NOW_APPLY_DIRECTIVE.includes("Reserved Files"));
  assert.ok(!FIX_NOW_APPLY_DIRECTIVE.includes("Your Files"));
});

test("reviewer contract defines the optional change-kind enum", () => {
  assert.match(REVIEWER_OUTPUT_CONTRACT, /changeKind/);
  assert.match(REVIEWER_OUTPUT_CONTRACT, /signature, behavior, internal, cosmetic/);
  assert.match(REVIEWER_OUTPUT_CONTRACT, /Omit when unsure/);
});

test("verifier directive demands verbatim join keys even when they look stale", () => {
  assert.match(VERIFIER_DIRECTIVE, /join keys, not location claims/);
  assert.match(VERIFIER_DIRECTIVE, /never absolutized/);
  assert.match(VERIFIER_DIRECTIVE, /echo "line" verbatim/);
});

test("gate-repair directive forbids weakening gates and covers every failure type", () => {
  assert.match(VERIFY_REPAIR_DIRECTIVE, /[Nn]ever weaken a gate/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /not-fixed/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /partial/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /cannot-verify/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /regression test/i);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /verification script/i);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /## Gate Repair Report/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /### Repairs Applied/);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /### Unresolved/);
});

test("reconcile directive defines ASD-STE100 summaries", () => {
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /"summary"/);
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /ASD-STE100/);
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /1–3 short declarative sentences/);
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /at most 360 characters/);
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /Do not add claims/);
});

test("reconcile directive defers rather than rejects slop-prone fixes", () => {
  assert.match(ADJUDICATOR_RECONCILE_DIRECTIVE, /recommend "defer"/);
});

test("apply and repair directives re-read + retry a failed match and confirm the file changed", () => {
  for (const directive of [ADJUDICATOR_APPLY_DIRECTIVE, FIX_NOW_APPLY_DIRECTIVE, VERIFY_REPAIR_DIRECTIVE]) {
    assert.match(directive, /could not find the text/i);
    assert.match(directive, /re-read the file/i);
    assert.match(directive, /retry/i);
    assert.match(directive, /byte-identical/i);
  }
  assert.match(ADJUDICATOR_APPLY_DIRECTIVE, /report it deferred, never applied/i);
  assert.match(FIX_NOW_APPLY_DIRECTIVE, /report it deferred, never applied/i);
  assert.match(VERIFY_REPAIR_DIRECTIVE, /report it unresolved, not applied/i);
});

test("temperament rewrites the Linus output style and leaves the rest of the block untouched", () => {
  const bodyOf = (block: string): string => block.slice(0, block.indexOf("**Output Style**"));
  const styleOf = (block: string): string => block.slice(block.indexOf("**Output Style**"));

  const blocks = TEMPERAMENTS.map((temperament) => {
    const block = getPersonality("Linus Torvalds", temperament);
    assert.ok(block, `expected a block for temperament "${temperament}"`);
    return block;
  });

  for (const block of blocks) assert.equal(bodyOf(block), bodyOf(blocks[0]!));
  assert.equal(new Set(blocks.map(styleOf)).size, TEMPERAMENTS.length);

  // The default must stay the shipped register: omitting it cannot heat a review up.
  assert.equal(getPersonality("Linus Torvalds"), blocks[0]);
  assert.match(blocks[0]!, /\*\*Output Style\*\*: Blunt, specific, and unhedged/);
});

test("every register above the default pins severity to impact and bars abuse of the author", () => {
  for (const temperament of TEMPERAMENTS.slice(1)) {
    const block = getPersonality("Linus Torvalds", temperament)!;
    assert.match(block, /[Ss]everity tracks impact, not temperature/);
    assert.match(block, /never the author/);
  }
});

test("register enforcement rides only hot Linus registers and reads as contract", () => {
  assert.equal(registerEnforcement("Linus Torvalds", "calibrated"), undefined);
  assert.equal(registerEnforcement("Julia Evans", "lkml"), undefined);

  const hot = TEMPERAMENTS.slice(1).map((t) => registerEnforcement("Linus Torvalds", t)!);
  for (const block of hot) {
    assert.match(block, /## Register Is Part Of The Contract/);
    assert.match(block, /contract violation/);
    assert.match(block, /VIOLATION — never write/);
    assert.match(block, /COMPLIANT — always write/);
  }
  assert.notEqual(hot[0], hot[1]);
});

test("revoice directive is voice-only, freezes severity, and states its contract", () => {
  assert.match(REVOICE_DIRECTIVE, /REGISTER RE-VOICE mode/);
  assert.match(REVOICE_DIRECTIVE, /Do NOT use any tools/);
  assert.match(REVOICE_DIRECTIVE, /Voice only\. The technical content is frozen/);
  assert.match(REVOICE_DIRECTIVE, /Severity is frozen/);
  assert.match(REVOICE_DIRECTIVE, /never the author/);
  assert.match(REVOICE_DIRECTIVE, /complete issue summary/);
  assert.match(REVOICE_DIRECTIVE, /at most 2000 characters/);
  assert.match(REVOICE_DIRECTIVE, /\{"index": <index from the input>/);
  assert.match(REVOICE_DIRECTIVE, /omit keep their original text/);
});

test("temperament does not reach reviewers other than Linus", () => {
  assert.equal(getPersonality("Julia Evans", "lkml"), getPersonality("Julia Evans"));
  assert.equal(getPersonality("Nobody At All", "lkml"), undefined);
});

// The forward direction (every TIERS reviewer resolves via getPersonality,
// including the specially-composed Linus Torvalds) is covered by
// test/expertPicker.test.ts. This is the reverse guard: PERSONALITIES must
// never carry a name TIERS does not also list, which would mean a reviewer
// exists in prompts but is unreachable from the picker.
test("every PERSONALITIES entry names a reviewer TIERS also lists", () => {
  const tierNames = new Set(TIERS.flatMap((t) => t.reviewers).map((r) => r.name));
  for (const name of Object.keys(PERSONALITIES)) {
    assert.ok(tierNames.has(name), `PERSONALITIES has "${name}" but no TIERS reviewer uses that name`);
  }
});
