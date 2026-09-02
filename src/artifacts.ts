import { lstat, readdir, readFile, realpath, rmdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { HANDOFF_RESUME_MARKER } from "./handoff.ts";
import { repoCacheDir } from "./orchestrator.ts";
import { AUDITS_DIR, HANDOFFS_DIR, errorCode, isWithinDirectory } from "./report.ts";
import { SNAPSHOTS_DIR } from "./snapshot.ts";
import { mapWithConcurrencyLimit } from "./subprocess.ts";

export type ArtifactKind = "report" | "progress" | "handoff" | "snapshot-set" | "cache";

export interface ArtifactEntry {
  id: string;
  kind: ArtifactKind;
  absPath: string;
  displayPath: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
  slugDate?: Date;
  detail?: string;
}

const SLUG = "\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}-\\d{3}";
const REPORT_RE = new RegExp(`^(${SLUG})_persona-audit\\.md$`);
const PROGRESS_RE = new RegExp(`^(${SLUG})_progress_snapshot\\.md$`);
const HANDOFF_RE = new RegExp(`^(${SLUG})_deferred-findings\\.md$`);
const SNAPSHOT_RE = new RegExp(`^${SLUG}$`);
const CACHE_RE = /^[^/]+\.json$/;
const SCAN_CONCURRENCY = 8;

export function parseSlugDate(name: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(name);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, millis] = match;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis)));
  return Number.isNaN(value.getTime()) ? undefined : value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
}

export function formatAge(mtimeMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function isOlderThan(entry: ArtifactEntry, days: number, now: number = Date.now()): boolean {
  return entry.kind !== "cache" && (entry.slugDate?.getTime() ?? entry.mtimeMs) < now - days * 86_400_000;
}

async function safeReadDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function directorySize(dir: string): Promise<{ sizeBytes: number; files: number }> {
  const entries = await safeReadDir(dir);
  const results = await mapWithConcurrencyLimit(entries, SCAN_CONCURRENCY, async (entry) => {
    const abs = path.join(dir, entry.name);
    const stats = await lstat(abs).catch(() => undefined);
    if (!stats || stats.isSymbolicLink()) return { sizeBytes: 0, files: 0 };
    if (stats.isDirectory()) return directorySize(abs);
    return stats.isFile() ? { sizeBytes: stats.size, files: 1 } : { sizeBytes: 0, files: 0 };
  });
  return results.reduce((total, item) => ({ sizeBytes: total.sizeBytes + item.sizeBytes, files: total.files + item.files }), { sizeBytes: 0, files: 0 });
}

async function collectFiles(dir: string, kind: ArtifactKind, matcher: RegExp): Promise<ArtifactEntry[]> {
  const entries = await safeReadDir(dir);
  const matches = await mapWithConcurrencyLimit<typeof entries[number], ArtifactEntry | undefined>(entries, SCAN_CONCURRENCY, async (entry) => {
    if (!matcher.test(entry.name)) return undefined;
    const absPath = path.join(dir, entry.name);
    const stats = await lstat(absPath).catch(() => undefined);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) return undefined;
    let detail: string | undefined;
    if (kind === "handoff") {
      const text = await readFile(absPath, "utf-8").catch(() => "");
      if (text.includes(HANDOFF_RESUME_MARKER)) detail = "resumable";
    }
    if (kind === "progress") {
      const finalName = entry.name.replace("_progress_snapshot.md", "_persona-audit.md");
      const finalStats = await lstat(path.join(dir, finalName)).catch(() => undefined);
      if (finalStats?.isFile() && !finalStats.isSymbolicLink()) detail = "superseded";
    }
    return { id: `${kind}:${absPath}`, kind, absPath, displayPath: entry.name, isDirectory: false, sizeBytes: stats.size, mtimeMs: stats.mtimeMs, slugDate: parseSlugDate(entry.name), detail } satisfies ArtifactEntry;
  });
  return matches.filter((entry): entry is ArtifactEntry => entry !== undefined);
}

async function collectAuditFiles(dir: string): Promise<{ reports: ArtifactEntry[]; progress: ArtifactEntry[] }> {
  const entries = await safeReadDir(dir);
  const matches = await mapWithConcurrencyLimit<typeof entries[number], { report?: ArtifactEntry; progress?: ArtifactEntry } | undefined>(
    entries,
    SCAN_CONCURRENCY,
    async (entry) => {
      const reportMatch = REPORT_RE.test(entry.name);
      const progressMatch = PROGRESS_RE.test(entry.name);
      if (!reportMatch && !progressMatch) return undefined;
      const absPath = path.join(dir, entry.name);
      const stats = await lstat(absPath).catch(() => undefined);
      if (!stats || stats.isSymbolicLink() || !stats.isFile()) return undefined;
      const result: { report?: ArtifactEntry; progress?: ArtifactEntry } = {};
      if (reportMatch) {
        result.report = { id: `report:${absPath}`, kind: "report", absPath, displayPath: entry.name, isDirectory: false, sizeBytes: stats.size, mtimeMs: stats.mtimeMs, slugDate: parseSlugDate(entry.name) } satisfies ArtifactEntry;
      }
      if (progressMatch) {
        let detail: string | undefined;
        const finalName = entry.name.replace("_progress_snapshot.md", "_persona-audit.md");
        const finalStats = await lstat(path.join(dir, finalName)).catch(() => undefined);
        if (finalStats?.isFile() && !finalStats.isSymbolicLink()) detail = "superseded";
        result.progress = { id: `progress:${absPath}`, kind: "progress", absPath, displayPath: entry.name, isDirectory: false, sizeBytes: stats.size, mtimeMs: stats.mtimeMs, slugDate: parseSlugDate(entry.name), detail } satisfies ArtifactEntry;
      }
      return result;
    },
  );
  const reports: ArtifactEntry[] = [];
  const progress: ArtifactEntry[] = [];
  for (const match of matches) {
    if (!match) continue;
    if (match.report) reports.push(match.report);
    if (match.progress) progress.push(match.progress);
  }
  return { reports, progress };
}

export async function collectArtifacts(cwd: string, agentDir?: string): Promise<ArtifactEntry[]> {
  const root = path.resolve(cwd);
  const audits = path.join(root, AUDITS_DIR);
  const handoffs = path.join(root, HANDOFFS_DIR);
  const snapshots = path.join(root, SNAPSHOTS_DIR);
  const cache = repoCacheDir(cwd, agentDir);
  const [{ reports, progress }, handoffEntries, snapshotEntries, cacheEntries] = await Promise.all([
    collectAuditFiles(audits),
    collectFiles(handoffs, "handoff", HANDOFF_RE),
    (async () => {
      const dirs = await safeReadDir(snapshots);
      const found = await mapWithConcurrencyLimit<typeof dirs[number], ArtifactEntry | undefined>(dirs, SCAN_CONCURRENCY, async (entry) => {
        if (!SNAPSHOT_RE.test(entry.name)) return undefined;
        const absPath = path.join(snapshots, entry.name);
        const stats = await lstat(absPath).catch(() => undefined);
        if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
        const size = await directorySize(absPath);
        return { id: `snapshot-set:${absPath}`, kind: "snapshot-set", absPath, displayPath: `${entry.name}/`, isDirectory: true, sizeBytes: size.sizeBytes, mtimeMs: stats.mtimeMs, slugDate: parseSlugDate(entry.name), detail: `${size.files} files` } satisfies ArtifactEntry;
      });
      return found.filter((entry): entry is ArtifactEntry => entry !== undefined);
    })(),
    collectFiles(cache, "cache", CACHE_RE),
  ]);
  const groups = [reports, progress, handoffEntries, snapshotEntries, cacheEntries];
  return groups.flatMap((group) => group.sort((a, b) => (a.slugDate?.getTime() ?? a.mtimeMs) - (b.slugDate?.getTime() ?? b.mtimeMs)));
}

function rootForEntry(cwd: string, entry: ArtifactEntry): string {
  if (entry.kind === "cache") return repoCacheDir(cwd);
  return path.resolve(cwd, ".pi/persona-audit");
}

function hasExpectedName(entry: ArtifactEntry): boolean {
  const name = path.basename(entry.absPath);
  if (entry.kind === "report") return REPORT_RE.test(name) && !entry.isDirectory;
  if (entry.kind === "progress") return PROGRESS_RE.test(name) && !entry.isDirectory;
  if (entry.kind === "handoff") return HANDOFF_RE.test(name) && !entry.isDirectory;
  if (entry.kind === "snapshot-set") return SNAPSHOT_RE.test(name) && entry.isDirectory;
  return CACHE_RE.test(name) && !entry.isDirectory;
}

async function prune(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") throw error;
  }
}

export async function deleteArtifacts(cwd: string, entries: ArtifactEntry[]): Promise<{ deleted: number; freedBytes: number; failed: { entry: ArtifactEntry; error: string }[] }> {
  let deleted = 0;
  let freedBytes = 0;
  const failed: { entry: ArtifactEntry; error: string }[] = [];
  for (const entry of entries) {
    try {
      if (!hasExpectedName(entry)) throw new Error("unrecognized artifact name");
      const root = rootForEntry(cwd, entry);
      const rootReal = await realpath(root);
      const targetReal = await realpath(entry.absPath);
      if (!isWithinDirectory(rootReal, targetReal)) throw new Error("artifact resolves outside its storage root");
      const stats = await lstat(entry.absPath);
      if (stats.isSymbolicLink()) throw new Error("refusing to delete symbolic link");
      if (entry.isDirectory !== stats.isDirectory()) throw new Error("artifact type changed since scan");
      await rm(entry.absPath, { recursive: entry.isDirectory, force: true });
      deleted++;
      freedBytes += entry.sizeBytes;
    } catch (error) {
      failed.push({ entry, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const store = path.resolve(cwd, ".pi/persona-audit");
  await prune(path.join(store, "audits"));
  await prune(path.join(store, "handoffs"));
  await prune(path.join(store, "snapshots"));
  await prune(store);
  await prune(repoCacheDir(cwd));
  return { deleted, freedBytes, failed };
}
