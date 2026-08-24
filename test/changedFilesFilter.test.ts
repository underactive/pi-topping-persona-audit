import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getChangedFiles } from "../src/index.ts";
import { GIT_ENV, git, hasGit, writeFileAt } from "./helpers/gitTest.ts";

test("getChangedFiles excludes lockfile, secret, and .env files from diff output", { skip: !hasGit() }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-cf-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    // First commit: one regular file so we have a base to diff against
    await writeFileAt(dir, "README.md", "# test");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
    const firstCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: GIT_ENV,
    }).trim();

    // Second commit: add files that include lockfile, secret, and .env patterns
    await writeFileAt(dir, "src/index.ts", "export const x = 1;");
    await writeFileAt(dir, "src/utils.ts", "export const y = 2;");
    await writeFileAt(dir, "package-lock.json", "{}");
    await writeFileAt(dir, "config/secrets.json", "{}");
    await writeFileAt(dir, ".env", "KEY=val");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add files");

    const result = await getChangedFiles(dir, ".", firstCommit);

    assert.ok(result.includes("src/index.ts"), "regular source file must be included");
    assert.ok(result.includes("src/utils.ts"), "regular source file must be included");
    assert.ok(!result.includes("package-lock.json"), "lockfile must be excluded");
    assert.ok(!result.includes("config/secrets.json"), "secret file must be excluded");
    assert.ok(!result.includes(".env"), ".env file must be excluded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
