import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getChangedFiles } from "../src/index.ts";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: GIT_ENV });
}

async function writeFileAt(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

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
