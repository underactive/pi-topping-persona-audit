/**
 * Layer 1 of the verify phase: deterministic "did the fix land?" evidence.
 *
 * Snapshots every accepted finding's target file before the implement phase,
 * then re-hashes afterwards. A byte-identical file is proof the fix did not
 * land, independent of anything the implement agent claims about itself.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { errorCode, message, resolveSafeWritePath } from "./report.ts";
import { mapWithConcurrencyLimit } from "./subprocess.ts";
import { CATEGORY_PRIORITY, type FileChangeEvidence, type Finding, type FindingCategory, type SelfReport } from "./types.ts";

const SNAPSHOTS_DIR = ".pi/persona-audit/snapshots";

/** Concurrency cap for the per-file read/hash/write work in snapshotFiles and compareToSnapshots. */
const SNAPSHOT_CONCURRENCY = 8;

/** Pre-fix copy of one audited file, captured before the implement phase. */
export interface FileSnapshot {
  file: string;
  existed: boolean;
  sha256?: string;
  /** Repo-relative path of the pre-fix copy, absent when the file did not exist. */
  snapshotPath?: string;
  error?: string;
}

/** Callers must pass the return value through resolveSafeWritePath before writing. */
export function snapshotRelPath(slug: string, file: string): string {
  return `${SNAPSHOTS_DIR}/${slug}/pre/${file}`;
}

/**
 * Resolve a finding's file to an absolute path inside cwd.
 *
 * Finding paths come from an LLM, and resolveSafeWritePath only guards writes.
 * This is the read-side containment check.
 */
export function resolveTargetPath(cwd: string, file: string): string | undefined {
  if (!file || path.isAbsolute(file)) return undefined;
  const cwdPath = path.resolve(cwd);
  const abs = path.resolve(cwdPath, file);
  const rel = path.relative(cwdPath, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return abs;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Capture pre-fix content and hash for each file. Never throws. */
export async function snapshotFiles(cwd: string, slug: string, files: string[]): Promise<Map<string, FileSnapshot>> {
  const cwdReal = await realpath(path.resolve(cwd));
  const entries = await mapWithConcurrencyLimit(files, SNAPSHOT_CONCURRENCY, async (file): Promise<[string, FileSnapshot]> => {
    const abs = resolveTargetPath(cwd, file);
    if (!abs) {
      return [file, { file, existed: false, error: `path escapes the project root: ${file}` }];
    }
    let realAbs: string;
    try {
      realAbs = await realpath(abs);
    } catch (error) {
      // A finding on a not-yet-created file is legitimate, not an error.
      return [
        file,
        errorCode(error) === "ENOENT"
          ? { file, existed: false }
          : { file, existed: false, error: message(error) },
      ];
    }
    const relToCwd = path.relative(cwdReal, realAbs);
    if (relToCwd.startsWith("..") || path.isAbsolute(relToCwd)) {
      return [file, { file, existed: false, error: `path escapes the project root: ${file}` }];
    }
    let content: Buffer;
    try {
      content = await readFile(realAbs);
    } catch (error) {
      return [
        file,
        errorCode(error) === "ENOENT"
          ? { file, existed: false }
          : { file, existed: false, error: message(error) },
      ];
    }
    const relPath = snapshotRelPath(slug, file);
    try {
      const dest = await resolveSafeWritePath(cwd, relPath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, content);
      return [file, { file, existed: true, sha256: sha256(content), snapshotPath: relPath }];
    } catch (error) {
      return [file, { file, existed: true, sha256: sha256(content), error: message(error) }];
    }
  });
  return new Map(entries);
}

/** Re-read each snapshotted file and classify how it changed. Never throws. */
export async function compareToSnapshots(
  cwd: string,
  snapshots: Map<string, FileSnapshot>,
): Promise<Map<string, FileChangeEvidence>> {
  const cwdReal = await realpath(path.resolve(cwd));
  const entries = await mapWithConcurrencyLimit(
    [...snapshots],
    SNAPSHOT_CONCURRENCY,
    async ([file, snap]): Promise<[string, FileChangeEvidence]> => {
      const base = { file, snapshotPath: snap.snapshotPath, preSha256: snap.sha256 };
      if (snap.error) {
        return [file, { ...base, state: "unreadable", detail: snap.error }];
      }
      const abs = resolveTargetPath(cwd, file);
      if (!abs) {
        return [file, { ...base, state: "unreadable", detail: `path escapes the project root: ${file}` }];
      }
      let content: Buffer | undefined;
      try {
        const realAbs = await realpath(abs);
        const rel = path.relative(cwdReal, realAbs);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return [file, { ...base, state: "unreadable", detail: `path escapes the project root: ${file}` }];
        }
        content = await readFile(abs);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          return [file, { ...base, state: "unreadable", detail: message(error) }];
        }
      }
      if (content === undefined) {
        return [file, { ...base, state: snap.existed ? "deleted" : "unchanged" }];
      }
      const postSha256 = sha256(content);
      if (!snap.existed) {
        return [file, { ...base, state: "created", postSha256 }];
      }
      return [
        file,
        {
          ...base,
          state: postSha256 === snap.sha256 ? "unchanged" : "changed",
          postSha256,
        },
      ];
    },
  );
  return new Map(entries);
}

const SECTION_HEADING = /^#{2,4}\s*Fixes\s+(Applied|Deferred)\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^[-*]\s+\[?\s*([^\][\s]+?)\s*\]?\s+\[?\s*(?:critical|high|medium|low|info)\s*\]?\s*[—–-]+\s*\[?\s*([a-z]+)\s*\]?\s*:/i;

const CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function findingKey(file: string, line: number, category: string): string {
  return `${file}\0${line}\0${category.toLowerCase()}`;
}

function fallbackKey(file: string, category: string): string {
  return `${file}\0${category.toLowerCase()}`;
}

/**
 * Best-effort parse of the implement agent's own "Fixes Applied/Deferred" report.
 *
 * The directive's example uses placeholder brackets around every field but what
 * agents actually emit brackets only the severity, so both shapes are accepted.
 * This is a cross-check signal for the verifier prompt, never a verdict source.
 */
export function parseApplyReport(report: string): Map<string, SelfReport> {
  const reports = new Map<string, SelfReport>();
  let current: SelfReport | undefined;
  for (const raw of report.split("\n")) {
    const line = raw.trim();
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      current = heading[1]?.toLowerCase() === "applied" ? "applied" : "deferred";
      continue;
    }
    if (ANY_HEADING.test(line)) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const match = BULLET.exec(line);
    if (!match) continue;
    const location = match[1]?.replace(/^\*+|\*+$/g, "");
    const category = match[2]?.toLowerCase();
    if (!location || !category || !CATEGORIES.has(category)) continue;
    const withLine = /^(.*):(\d+)$/.exec(location);
    const file = withLine?.[1] ?? location;
    const lineNumber = withLine ? Number(withLine[2]) : -1;
    reports.set(findingKey(file, lineNumber, category), current);
    const fallback = fallbackKey(file, category);
    if (!reports.has(fallback)) reports.set(fallback, current);
  }
  return reports;
}

/** Look up a finding's self-report, tolerating the line drift edits cause. */
export function lookupSelfReport(reports: Map<string, SelfReport>, finding: Finding): SelfReport {
  return (
    reports.get(findingKey(finding.file, finding.line, finding.category)) ??
    reports.get(fallbackKey(finding.file, finding.category)) ??
    "unreported"
  );
}

/** Stable key used to join findings against agent-produced JSON. */
export function verificationKey(file: string, line: number, category: FindingCategory | string): string {
  return findingKey(file, line, String(category));
}
