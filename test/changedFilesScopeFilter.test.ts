import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getChangedFiles } from "../src/index.ts";
import { GIT_ENV, git, hasGit, writeFileAt } from "./helpers/gitTest.ts";

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
