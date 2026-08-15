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
  "getChangedFiles excludes .tfvars, serviceaccount keys, nested .env files, and additional lockfile types",
  { skip: !hasGit() },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-csf-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      // First commit: a baseline so we have a diff base
      await writeFileAt(dir, "README.md", "# test");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "initial");
      const firstCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
        env: GIT_ENV,
      }).trim();

      // Second commit: regular files plus secret/lockfile/.env patterns
      await writeFileAt(dir, "src/lib.ts", "export const z = 3;");
      await writeFileAt(dir, "terraform.tfvars", 'db_password = "secret"');
      await writeFileAt(dir, "config/terraform.tfvars.json", '{"db_password": "secret"}');
      await writeFileAt(dir, "infra/serviceaccount.json", '{"private_key": "..."}');
      await writeFileAt(dir, "src/.env.production", "DB_URL=prod");
      await writeFileAt(dir, "Cargo.lock", "[package]");
      await writeFileAt(dir, "go.sum", "hash");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "add files");

      const result = await getChangedFiles(dir, ".", firstCommit);

      assert.ok(result.includes("src/lib.ts"), "regular source file must be included");
      assert.ok(!result.includes("terraform.tfvars"), ".tfvars must be excluded (terraform variables)");
      assert.ok(
        !result.includes("config/terraform.tfvars.json"),
        ".tfvars.json must be excluded",
      );
      assert.ok(
        !result.includes("infra/serviceaccount.json"),
        "serviceaccount.json must be excluded (service account key)",
      );
      assert.ok(
        !result.includes("src/.env.production"),
        ".env.production must be excluded (pathHasEnvSegment)",
      );
      assert.ok(!result.includes("Cargo.lock"), "Cargo.lock must be excluded");
      assert.ok(!result.includes("go.sum"), "go.sum must be excluded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
