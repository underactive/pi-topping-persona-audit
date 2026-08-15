import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  compareToSnapshots,
  lookupSelfReport,
  parseApplyReport,
  resolveTargetPath,
  snapshotFiles,
  snapshotRelPath,
} from "../src/snapshot.ts";
import type { Finding } from "../src/types.ts";

const SLUG = "2026-07-01_10-00-00-000";

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "persona-audit-snapshot-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return dir;
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "r",
  suggestedChange: "s",
  ...overrides,
});

// ── path containment ───────────────────────────────────────────────────────

test("resolveTargetPath rejects paths that escape the project root", async () => {
  const dir = await makeProject();
  try {
    assert.ok(resolveTargetPath(dir, "src/a.ts"));
    assert.equal(resolveTargetPath(dir, "../outside.ts"), undefined);
    assert.equal(resolveTargetPath(dir, "src/../../outside.ts"), undefined);
    assert.equal(resolveTargetPath(dir, "/etc/passwd"), undefined);
    assert.equal(resolveTargetPath(dir, ""), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── capture ────────────────────────────────────────────────────────────────

test("snapshotFiles writes a pre-fix copy under .pi and records its hash", async () => {
  const dir = await makeProject({ "src/a.ts": "original\n" });
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/a.ts"]);
    const snap = snapshots.get("src/a.ts");
    assert.ok(snap);
    assert.equal(snap.existed, true);
    assert.equal(snap.error, undefined);
    assert.equal(snap.snapshotPath, snapshotRelPath(SLUG, "src/a.ts"));
    assert.match(snap.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(await readFile(path.join(dir, snap.snapshotPath ?? ""), "utf-8"), "original\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotFiles treats a not-yet-created file as absent rather than an error", async () => {
  const dir = await makeProject();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/new.ts"]);
    const snap = snapshots.get("src/new.ts");
    assert.ok(snap);
    assert.equal(snap.existed, false);
    assert.equal(snap.error, undefined);
    assert.equal(snap.snapshotPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotFiles records an error and writes nothing for an escaping path", async () => {
  const dir = await makeProject();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["../outside.ts"]);
    const snap = snapshots.get("../outside.ts");
    assert.ok(snap);
    assert.equal(snap.existed, false);
    assert.match(snap.error ?? "", /escapes the project root/);
    assert.equal(snap.snapshotPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── comparison ─────────────────────────────────────────────────────────────

test("compareToSnapshots classifies unchanged, changed, created and deleted files", async () => {
  const dir = await makeProject({ "src/same.ts": "a\n", "src/edited.ts": "a\n", "src/gone.ts": "a\n" });
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/same.ts", "src/edited.ts", "src/gone.ts", "src/new.ts"]);
    await writeFile(path.join(dir, "src/edited.ts"), "b\n", "utf-8");
    await rm(path.join(dir, "src/gone.ts"));
    await writeFile(path.join(dir, "src/new.ts"), "fresh\n", "utf-8");

    const evidence = await compareToSnapshots(dir, snapshots);
    assert.equal(evidence.get("src/same.ts")?.state, "unchanged");
    assert.equal(evidence.get("src/edited.ts")?.state, "changed");
    assert.equal(evidence.get("src/gone.ts")?.state, "deleted");
    assert.equal(evidence.get("src/new.ts")?.state, "created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareToSnapshots reports a file that was never created as unchanged", async () => {
  const dir = await makeProject();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["src/never.ts"]);
    const evidence = await compareToSnapshots(dir, snapshots);
    assert.equal(evidence.get("src/never.ts")?.state, "unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareToSnapshots reports unreadable when the snapshot itself failed", async () => {
  const dir = await makeProject();
  try {
    const snapshots = await snapshotFiles(dir, SLUG, ["../outside.ts"]);
    const evidence = await compareToSnapshots(dir, snapshots);
    const entry = evidence.get("../outside.ts");
    assert.equal(entry?.state, "unreadable");
    assert.match(entry?.detail ?? "", /escapes the project root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── apply-report parsing ───────────────────────────────────────────────────

test("parseApplyReport accepts both the directive's bracket form and what agents emit", () => {
  const reports = parseApplyReport(
    [
      "## Adjudicator Fix Application Report",
      "",
      "### Fixes Applied",
      "- src/a.ts:12 [high] — security: escaped the argument",
      "- [src/b.ts:3] [critical] — [bug]: fixed the off-by-one",
      "- src/c.ts [low] - style: renamed",
      "- **src/d.ts:7** [low] — maintainability: markdown-bolded location",
    ].join("\n"),
  );

  assert.equal(lookupSelfReport(reports, finding({ file: "src/a.ts", line: 12 })), "applied");
  assert.equal(lookupSelfReport(reports, finding({ file: "src/b.ts", line: 3, category: "bug" })), "applied");
  assert.equal(lookupSelfReport(reports, finding({ file: "src/c.ts", line: -1, category: "style" })), "applied");
  assert.equal(
    lookupSelfReport(reports, finding({ file: "src/d.ts", line: 7, category: "maintainability" })),
    "applied",
  );
});

test("parseApplyReport separates applied from deferred and ignores bullets outside both sections", () => {
  const reports = parseApplyReport(
    [
      "### Notes",
      "- src/z.ts:1 [high] — security: this bullet is not in a tracked section",
      "",
      "### Fixes Applied",
      "- src/a.ts:12 [high] — security: escaped",
      "",
      "### Fixes Deferred",
      "- src/b.ts:3 [high] — bug: could not locate the region",
      "",
      "## Some Other Heading",
      "- src/y.ts:9 [high] — bug: also outside",
    ].join("\n"),
  );

  assert.equal(lookupSelfReport(reports, finding({ file: "src/a.ts", line: 12 })), "applied");
  assert.equal(lookupSelfReport(reports, finding({ file: "src/b.ts", line: 3, category: "bug" })), "deferred");
  assert.equal(lookupSelfReport(reports, finding({ file: "src/z.ts", line: 1 })), "unreported");
  assert.equal(lookupSelfReport(reports, finding({ file: "src/y.ts", line: 9, category: "bug" })), "unreported");
});

test("lookupSelfReport tolerates line drift but not a different category in the same file", () => {
  const reports = parseApplyReport("### Fixes Applied\n- src/a.ts:12 [high] — security: escaped");

  // Earlier edits shift line numbers, so file+category still resolves.
  assert.equal(lookupSelfReport(reports, finding({ line: 40 })), "applied");
  // A different finding that merely shares the file must not inherit the claim.
  assert.equal(lookupSelfReport(reports, finding({ line: 40, category: "bug" })), "unreported");
});
