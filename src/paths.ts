/**
 * Filesystem-safety helpers shared by every module that touches the disk.
 *
 * Containment is the guarantee callers depend on: a write stays inside the root
 * it owns — the project root for reports, snapshots and artifact deletion, the
 * scratch worktree for the regression harness — and no symlink along the path
 * may carry it outside that root.
 */

import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

export function isWithinDirectory(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk from rootLexical down to absPath, following symlinks, and throw if any
 * segment — including the final leaf — resolves outside rootReal. Shared by
 * resolveSafeWritePath and any other caller that owns a sandboxed root
 * (e.g. the regression harness's scratch git worktree).
 */
export async function assertWriteContained(rootLexical: string, rootReal: string, absPath: string): Promise<void> {
  const relativeToRoot = path.relative(rootLexical, path.dirname(absPath));
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Refusing to write outside the root: ${absPath}`);
  }

  const segments = relativeToRoot.split(path.sep).filter(Boolean);
  let syntheticCurrent = rootLexical;
  let resolvedCurrent = rootReal;
  for (const segment of segments) {
    syntheticCurrent = path.join(syntheticCurrent, segment);
    const candidateResolved = path.join(resolvedCurrent, segment);
    try {
      const stats = await lstat(syntheticCurrent);
      if (stats.isSymbolicLink()) {
        const real = await realpath(syntheticCurrent);
        if (!isWithinDirectory(rootReal, real)) {
          throw new Error(`Refusing to write through a symlink outside the root: ${syntheticCurrent}`);
        }
        resolvedCurrent = real;
        continue;
      }
      if (stats.isDirectory() || stats.isFile()) {
        resolvedCurrent = candidateResolved;
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        resolvedCurrent = candidateResolved;
        break;
      }
      throw error;
    }
  }

  if (!isWithinDirectory(rootReal, resolvedCurrent)) {
    throw new Error(`Refusing to write outside the root: ${absPath}`);
  }

  const leaf = await lstat(absPath).catch(() => undefined);
  if (leaf?.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlinked path outside the root: ${absPath}`);
  }
}

/**
 * Resolve a write target safely under the current project root.
 * Rejects paths outside cwd and `.pi` writes that ride a symlink outside cwd.
 */
export async function resolveSafeWritePath(cwd: string, relPath: string): Promise<string> {
  const cwdPath = path.resolve(cwd);
  const cwdReal = await realpath(cwdPath);
  const absPath = path.resolve(cwdPath, relPath);
  const piRoot = path.resolve(cwdPath, ".pi");
  const relativeToPi = path.relative(piRoot, absPath);
  if (relativeToPi.startsWith("..") || path.isAbsolute(relativeToPi)) {
    throw new Error(`Refusing to write outside the .pi directory: ${relPath}`);
  }

  await assertWriteContained(cwdPath, cwdReal, absPath);

  return absPath;
}
