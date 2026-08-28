import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { collectArtifacts, deleteArtifacts, formatBytes, isOlderThan, parseSlugDate } from "../src/artifacts.ts";
import { repoCacheDir } from "../src/orchestrator.ts";

const slug = "2026-01-02_03-04-05-006";

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "persona-artifacts-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "persona-agent-"));
  const auditDir = path.join(cwd, ".pi/persona-audit/audits");
  await mkdir(path.join(cwd, ".pi/persona-audit/handoffs"), { recursive: true });
  await mkdir(path.join(cwd, ".pi/persona-audit/snapshots", slug, "pre"), { recursive: true });
  await mkdir(auditDir, { recursive: true });
  await writeFile(path.join(auditDir, `${slug}_persona-audit.md`), "report");
  await writeFile(path.join(auditDir, `${slug}_progress_snapshot.md`), "progress");
  await writeFile(path.join(cwd, ".pi/persona-audit/handoffs", `${slug}_deferred-findings.md`), "<!-- persona-audit-resume:v1 -->");
  await writeFile(path.join(cwd, ".pi/persona-audit/snapshots", slug, "pre", "source.ts"), "snapshot");
  await writeFile(path.join(auditDir, "foreign.md"), "foreign");
  await mkdir(path.join(cwd, ".pi/persona-audit/snapshots", "baselines"));
  await mkdir(repoCacheDir(cwd, agentDir), { recursive: true });
  await writeFile(path.join(repoCacheDir(cwd, agentDir), "review.json"), "{}");
  await writeFile(path.join(agentDir, "persona-audit", "settings.json"), "{}");
  return { cwd, agentDir, auditDir };
}

test("collectArtifacts classifies recognized artifacts and ignores foreign entries", async () => {
  const { cwd, agentDir } = await fixture();
  const entries = await collectArtifacts(cwd, agentDir);
  assert.deepEqual(entries.map((entry) => entry.kind), ["report", "progress", "handoff", "snapshot-set", "cache"]);
  assert.equal(entries.find((entry) => entry.kind === "progress")?.detail, "superseded");
  assert.equal(entries.find((entry) => entry.kind === "handoff")?.detail, "resumable");
  assert.equal(entries.find((entry) => entry.kind === "snapshot-set")?.detail, "1 files");
  assert.equal(entries.find((entry) => entry.kind === "snapshot-set")?.sizeBytes, 8);
});

test("deleteArtifacts removes selected recognized entries and leaves foreign files", async () => {
  const { cwd, agentDir, auditDir } = await fixture();
  const entries = await collectArtifacts(cwd, agentDir);
  const selected = entries.filter((entry) => entry.kind === "report" || entry.kind === "snapshot-set");
  const result = await deleteArtifacts(cwd, selected);
  assert.equal(result.deleted, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(await readFile(path.join(auditDir, "foreign.md"), "utf8"), "foreign");
  await assert.rejects(readFile(selected[0]!.absPath));
});

test("deleteArtifacts refuses a symlink that replaced a scanned target", async () => {
  const { cwd, agentDir } = await fixture();
  const entry = (await collectArtifacts(cwd, agentDir)).find((item) => item.kind === "report")!;
  const inside = path.join(cwd, ".pi/persona-audit/audits", "foreign.md");
  await rm(entry.absPath);
  await symlink(inside, entry.absPath);
  const result = await deleteArtifacts(cwd, [entry]);
  assert.equal(result.deleted, 0);
  assert.match(result.failed[0]!.error, /refusing to delete symbolic link/);
});

test("slug parsing and byte formatting are stable", () => {
  assert.equal(parseSlugDate(`${slug}_persona-audit.md`)?.toISOString(), "2026-01-02T03:04:05.006Z");
  assert.equal(parseSlugDate("not-a-slug"), undefined);
  assert.equal(formatBytes(1024), "1 KB");
  const report = { id: "report", kind: "report", absPath: "/report", displayPath: "report", isDirectory: false, sizeBytes: 0, mtimeMs: 0 } as const;
  const cache = { ...report, id: "cache", kind: "cache" } as const;
  assert.equal(isOlderThan(report, 1, 86_400_001), true);
  assert.equal(isOlderThan(cache, 1, 86_400_001), false);
  assert.match(repoCacheDir("/repo", "/agent"), /persona-audit\/cache\/816fc349d3faebf8$/);
});
