/** Git subprocess helpers for the interactive Fix Now flow. All args go through execFile — no shell. */

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { resolveTargetPath } from "./snapshot.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** HEAD commit hash, or undefined outside a git repo — handoffs must stay writable in non-git runs. */
export async function gitHeadCommit(cwd: string): Promise<string | undefined> {
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return head || undefined;
  } catch {
    return undefined;
  }
}

/** Working-tree state of one file, from `git status --porcelain`. */
export interface FileGitStatus {
  file: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** Reject paths that are absolute or escape cwd — finding/agent-reported paths are untrusted. */
function containedPaths(cwd: string, files: string[]): string[] {
  return files.filter((file) => resolveTargetPath(cwd, file) !== undefined);
}

/**
 * Per-file working-tree status. Keys are repo-relative paths as git reports
 * them. `paths` limits the scan; omit it for the whole tree.
 */
export async function gitStatusPorcelain(cwd: string, paths?: string[]): Promise<Map<string, FileGitStatus>> {
  const scoped = paths === undefined ? [] : containedPaths(cwd, paths);
  if (paths !== undefined && scoped.length === 0) return new Map();
  const stdout = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...scoped]);
  const result = new Map<string, FileGitStatus>();
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0]!;
    const y = line[1]!;
    // Rename entries read "R  old -> new"; the new path is the one on disk.
    const rawPath = line.slice(3);
    const arrow = rawPath.indexOf(" -> ");
    const file = unquoteGitPath(arrow === -1 ? rawPath : rawPath.slice(arrow + 4));
    const untracked = x === "?" && y === "?";
    result.set(file, {
      file,
      staged: !untracked && x !== " ",
      unstaged: untracked || y !== " ",
      untracked,
    });
  }
  return result;
}

/** Strip the quoting git applies to paths with special characters. */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(["\\tnr])/g, (_, ch: string) => ({ '"': '"', "\\": "\\", t: "\t", n: "\n", r: "\r" })[ch]!);
}

/**
 * Unified diff of the given files against HEAD. Untracked files are
 * intent-to-add'ed first so their content appears in the diff.
 */
export async function gitDiff(cwd: string, files: string[], untracked: string[] = []): Promise<string> {
  const scoped = containedPaths(cwd, files);
  if (scoped.length === 0) return "";
  const newFiles = containedPaths(cwd, untracked);
  if (newFiles.length > 0) await git(cwd, ["add", "--intent-to-add", "--", ...newFiles]);
  return git(cwd, ["diff", "HEAD", "--", ...scoped]);
}

/** Stage exactly `files` and commit them. Returns the short SHA of the new commit. */
export async function gitCommitFiles(cwd: string, files: string[], message: string): Promise<string> {
  const scoped = containedPaths(cwd, files);
  if (scoped.length === 0) throw new Error("no files to commit");
  await git(cwd, ["add", "--", ...scoped]);
  await git(cwd, ["commit", "--only", "-m", message, "--", ...scoped]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

/**
 * Revert the given files to HEAD. Tracked files are restored; files unknown to
 * HEAD (agent-created) are deleted individually — never `git clean`.
 */
export async function gitRestoreFiles(cwd: string, tracked: string[], untracked: string[] = []): Promise<void> {
  const trackedScoped = containedPaths(cwd, tracked);
  if (trackedScoped.length > 0) {
    await git(cwd, ["restore", "--worktree", "--staged", "--", ...trackedScoped]);
  }
  for (const file of containedPaths(cwd, untracked)) {
    const abs = resolveTargetPath(cwd, file);
    if (abs !== undefined) await rm(abs, { force: true });
  }
}
