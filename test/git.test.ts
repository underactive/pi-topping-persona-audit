import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { gitCommitFiles, gitDiff, gitRestoreFiles, gitStatusPorcelain } from "../src/git.ts";

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pa-git-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src/a.ts"), "const a = 1;\n");
  await writeFile(path.join(cwd, "src/b.ts"), "const b = 1;\n");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  return cwd;
}

test("gitStatusPorcelain reports clean, modified, and untracked files", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  assert.equal((await gitStatusPorcelain(cwd)).size, 0);

  await writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n");
  await writeFile(path.join(cwd, "src/new.ts"), "const n = 1;\n");

  const all = await gitStatusPorcelain(cwd);
  assert.equal(all.get("src/a.ts")?.unstaged, true);
  assert.equal(all.get("src/a.ts")?.untracked, false);
  assert.equal(all.get("src/new.ts")?.untracked, true);
  assert.equal(all.has("src/b.ts"), false);

  const scoped = await gitStatusPorcelain(cwd, ["src/a.ts"]);
  assert.equal(scoped.size, 1);
  assert.equal(scoped.has("src/a.ts"), true);
});

test("gitStatusPorcelain drops paths that escape the repo", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const scoped = await gitStatusPorcelain(cwd, ["../outside.ts", "/etc/passwd"]);
  assert.equal(scoped.size, 0);
});

test("gitDiff includes modified and untracked file content", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n");
  await writeFile(path.join(cwd, "src/new.ts"), "const n = 1;\n");

  const diff = await gitDiff(cwd, ["src/a.ts", "src/new.ts"], ["src/new.ts"]);
  assert.match(diff, /-const a = 1;/);
  assert.match(diff, /\+const a = 2;/);
  assert.match(diff, /\+const n = 1;/);
});

test("gitCommitFiles commits only the named files and returns a short sha", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n");
  await writeFile(path.join(cwd, "src/b.ts"), "const b = 2;\n");

  const sha = await gitCommitFiles(cwd, ["src/a.ts"], "fix(bug): src/a.ts — test");
  assert.match(sha, /^[0-9a-f]{4,}$/);

  const status = await gitStatusPorcelain(cwd);
  assert.equal(status.has("src/a.ts"), false);
  assert.equal(status.get("src/b.ts")?.unstaged, true);

  const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd, encoding: "utf-8" });
  assert.match(log, /fix\(bug\): src\/a\.ts/);
});

test("gitCommitFiles commits an agent-created untracked file", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(path.join(cwd, "src/new.ts"), "const n = 1;\n");
  const sha = await gitCommitFiles(cwd, ["src/new.ts"], "add new");
  assert.match(sha, /^[0-9a-f]{4,}$/);
  assert.equal((await gitStatusPorcelain(cwd)).size, 0);
});

test("gitRestoreFiles reverts tracked files and deletes untracked ones", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(path.join(cwd, "src/a.ts"), "const a = 2;\n");
  await writeFile(path.join(cwd, "src/b.ts"), "const b = 2;\n");
  await writeFile(path.join(cwd, "src/new.ts"), "const n = 1;\n");

  await gitRestoreFiles(cwd, ["src/a.ts"], ["src/new.ts"]);

  assert.equal(await readFile(path.join(cwd, "src/a.ts"), "utf-8"), "const a = 1;\n");
  assert.equal(existsSync(path.join(cwd, "src/new.ts")), false);
  // b.ts was not named — left alone.
  assert.equal(await readFile(path.join(cwd, "src/b.ts"), "utf-8"), "const b = 2;\n");
});

test("gitRestoreFiles ignores escaping paths", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await gitRestoreFiles(cwd, ["../outside.ts"], ["/etc/passwd"]);
});
