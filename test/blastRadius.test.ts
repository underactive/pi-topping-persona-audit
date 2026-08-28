import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { computeBlastRadius, hasCorrespondingTest, sensitivityTags } from "../src/blastRadius.ts";

const score = (overrides: Partial<Parameters<typeof computeBlastRadius>[0]> = {}) =>
  computeBlastRadius({ fanIn: 0, tags: [], hasTest: true, changeKind: undefined, ...overrides });

test("fan-in is the dominant signal and produces deterministic reasons", () => {
  const first = score({ fanIn: 12, changeKind: "signature" });
  const second = score({ fanIn: 12, changeKind: "signature" });

  assert.deepEqual(first, second);
  assert.equal(first.score, 60);
  assert.equal(first.level, "high");
  assert.deepEqual(first.reasons, ["imported by 12 modules", "changes a signature"]);
});

test("sensitivity, missing tests, and change kind modify the score", () => {
  const result = score({
    tags: ["auth/session", "payment/billing", "database schema", "public API/SDK"],
    hasTest: false,
    changeKind: "behavior",
  });

  assert.equal(result.score, 50, "sensitivity is capped at 30 points");
  assert.equal(result.level, "high");
  assert.equal(result.reasons[0], "no tests");
  assert.ok(result.reasons.includes("auth/session code"));
});

test("score thresholds bucket low, medium, high, and critical", () => {
  assert.equal(score().level, "low");
  assert.equal(score({ fanIn: 3, changeKind: "behavior" }).level, "medium");
  assert.equal(score({ fanIn: 11 }).level, "high");
  assert.equal(score({ fanIn: 11, tags: ["auth/session"], hasTest: false }).level, "critical");
});

test("a high-fan-in signature change outranks a cosmetic change regardless of edit size", () => {
  const coreSignature = score({ fanIn: 20, changeKind: "signature" });
  const cosmetic = score({ fanIn: 0, changeKind: "cosmetic" });

  assert.ok(coreSignature.score > cosmetic.score);
  assert.equal(cosmetic.score, 0);
  assert.ok(!coreSignature.reasons.some((reason) => /length|line|character/i.test(reason)));
});

test("sensitivityTags recognizes high-risk path surfaces", () => {
  assert.deepEqual(sensitivityTags("src/auth/session.ts"), ["auth/session"]);
  assert.deepEqual(sensitivityTags("db/migrations/schema.ts"), ["database schema"]);
  assert.deepEqual(sensitivityTags(".github/workflows/release.yml"), ["shared config/infra"]);
  assert.deepEqual(sensitivityTags("packages/sdk/index.ts"), ["public API/SDK"]);
  assert.deepEqual(sensitivityTags("src/crypto/serialize.ts"), ["serialization/crypto"]);
});

test("hasCorrespondingTest checks sibling and conventional test locations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-audit-blast-"));
  try {
    await mkdir(path.join(cwd, "src", "auth"), { recursive: true });
    await writeFile(path.join(cwd, "src", "auth", "session.ts"), "export const session = true;\n");
    assert.equal(await hasCorrespondingTest(cwd, "src/auth/session.ts"), false);

    await mkdir(path.join(cwd, "src", "auth", "__tests__"), { recursive: true });
    await writeFile(path.join(cwd, "src", "auth", "__tests__", "session.test.ts"), "test('session', () => {});\n");
    assert.equal(await hasCorrespondingTest(cwd, "src/auth/session.ts"), true);
    assert.equal(await hasCorrespondingTest(cwd, "../outside.ts"), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
