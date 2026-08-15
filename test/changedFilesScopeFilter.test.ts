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

test(
  "getChangedFiles excludes secrets and lockfiles even when they fall inside a subdirectory scope",
  { skip: !hasGit() },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-scf-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      await writeFileAt(dir, "README.md", "# baseline");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "initial");
      const firstCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
        env: GIT_ENV,
      }).trim();

      // Files inside scope "src": regular, secret, env, lockfile
      await writeFileAt(dir, "src/index.ts", "export const x = 1;");
      await writeFileAt(dir, "src/secrets.json", '{"key":"val"}');
      await writeFileAt(dir, "src/.env", "DB_URL=x");
      await writeFileAt(dir, "src/serviceaccount.yaml", "private_key: x");
      // Lockfile inside scope
      await writeFileAt(dir, "src/go.sum", "hash");
      // Files outside scope — must not appear in result
      await writeFileAt(dir, "package-lock.json", "{}");
      await writeFileAt(dir, "out/secrets.yaml", "token: x");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "add files");

      const result = await getChangedFiles(dir, "src", firstCommit);

      assert.ok(result.includes("src/index.ts"), "regular file in scope must be included");
      assert.ok(!result.includes("src/secrets.json"), "secret inside scope must be excluded");
      assert.ok(!result.includes("src/.env"), ".env inside scope must be excluded");
      assert.ok(
        !result.includes("src/serviceaccount.yaml"),
        "serviceaccount inside scope must be excluded",
      );
      assert.ok(!result.includes("src/go.sum"), "go.sum inside scope must be excluded");
      assert.ok(!result.includes("package-lock.json"), "lockfile outside scope must be absent");
      assert.ok(!result.includes("out/secrets.yaml"), "secret outside scope must be absent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
