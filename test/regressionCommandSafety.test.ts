import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafeTestCommand } from "../src/regression.ts";

test("isSafeTestCommand rejects remote fetch via runner URL and package-install verbs", () => {
  assert.equal(isSafeTestCommand("deno run https://deno.land/std/http/server.ts"), false);
  assert.equal(isSafeTestCommand("npm install some-package"), false);
  assert.equal(isSafeTestCommand("yarn add some-package"), false);
  assert.equal(isSafeTestCommand("pnpm i some-package"), false);
  assert.equal(isSafeTestCommand("npm --no-audit install some-package"), false);
});
