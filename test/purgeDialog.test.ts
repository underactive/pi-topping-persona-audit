import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ArtifactEntry } from "../src/artifacts.ts";
import { displayDirectory, openPurgeDialog, previewLoader, toDialogArtifacts } from "../src/ui/purge-dialog.ts";
import { createDialogHost, KEY, press, ROOMY_TERMINAL, screen, waitFor, type DialogHost } from "./helpers/dialog-harness.ts";

const NOW = Date.now();

function entry(dir: string, name: string, kind: ArtifactEntry["kind"], sizeBytes: number, extra: Partial<ArtifactEntry> = {}): ArtifactEntry {
  const absPath = path.join(dir, name);
  return { id: `${kind}:${absPath}`, kind, absPath, displayPath: name, isDirectory: false, sizeBytes, mtimeMs: NOW - 2 * 3_600_000, ...extra };
}

const DIR = path.join(homedir(), "work", "repo", ".pi", "persona-audit", "reports");
const REPORT_A = entry(DIR, "2026-11-10_14-02-11-000_persona-audit.md", "report", 18_841);
const REPORT_B = entry(DIR, "2026-11-03_09-41-50-000_persona-audit.md", "report", 22_630, { mtimeMs: NOW - 7 * 86_400_000 });
const HANDOFF = entry(DIR, "2026-11-10_14-02-11-000_deferred-findings.md", "handoff", 4_198, { detail: "resumable" });
const CACHE = entry(path.join(homedir(), ".pi", "cache"), "repo.json", "cache", 2_700_000);
const ENTRIES = [REPORT_A, REPORT_B, HANDOFF, CACHE];

function host(extra: Parameters<typeof createDialogHost>[0] = {}): DialogHost {
  return createDialogHost({ terminal: ROOMY_TERMINAL, ...extra });
}

async function open(h: DialogHost, entries: readonly ArtifactEntry[], preTagged: Set<string> = new Set()) {
  const result = openPurgeDialog(h.ctx, entries, preTagged, ROOMY_TERMINAL);
  return { result, dialog: await h.dialog() };
}

test("entries become artifacts with the extension's own size, age and directory text", () => {
  const [report, , handoff, cache] = toDialogArtifacts(ENTRIES, new Set([REPORT_A.id, CACHE.id]));
  assert.deepEqual(report, {
    id: REPORT_A.id, kind: "report", displayPath: REPORT_A.displayPath, dir: displayDirectory(REPORT_A.absPath),
    size: "18 KB", bytes: 18_841, age: "2h", tagged: true,
  });
  assert.equal(report!.dir, "~/work/repo/.pi/persona-audit/reports");
  assert.equal(handoff!.detail, "resumable");
  assert.equal(handoff!.tagged, false);
  assert.equal(cache!.size, "2.6 MB");
});

test("tagging, then confirming, hands back exactly the tagged entries", async () => {
  const h = host();
  const { result, dialog } = await open(h, ENTRIES, new Set([REPORT_B.id]));
  const text = screen(dialog, 104);
  assert.match(text, /PERSONA-AUDIT: PURGE ARTIFACTS/);
  assert.match(text, /■ 2026-11-03_09-41-50-000_persona-audit\.md/, "a pre-tagged entry starts ticked");
  assert.match(text, /□ 2026-11-10_14-02-11-000_persona-audit\.md/);
  await press(dialog, KEY.space); // tag the first report
  await press(dialog, KEY.tab, KEY.enter);
  const confirm = screen(dialog, 104);
  assert.match(confirm, /DELETE 2 PERSONA-AUDIT ARTIFACTS\?/);
  assert.match(confirm, /2 report · total 40 KB\./, "the total is the exact byte sum, formatted as the extension does");
  await press(dialog, "y");
  assert.deepEqual(await result, [REPORT_A, REPORT_B]);
});

test("a cache entry is never tagged to begin with, even when it was pre-tagged", async () => {
  const h = host();
  const { result, dialog } = await open(h, ENTRIES, new Set(ENTRIES.map((e) => e.id)));
  await press(dialog, KEY.tab, KEY.enter, "y");
  assert.deepEqual(await result, [REPORT_A, REPORT_B, HANDOFF]);
});

test("purging with nothing tagged says so and keeps the dialog open", async () => {
  const h = host();
  const { result, dialog } = await open(h, ENTRIES);
  await press(dialog, KEY.tab, KEY.enter);
  assert.deepEqual(h.notifications, [{ message: "Nothing tagged — no files deleted.", type: "info" }]);
  assert.match(screen(dialog, 104), /PURGE ARTIFACTS/);
  await press(dialog, KEY.esc);
  assert.equal(await result, null);
});

test("declining the confirmation returns to the list, and esc there cancels", async () => {
  const h = host();
  const { result, dialog } = await open(h, ENTRIES, new Set([REPORT_A.id]));
  await press(dialog, KEY.tab, KEY.enter, KEY.esc);
  assert.match(screen(dialog, 104), /PURGE ARTIFACTS/);
  await press(dialog, KEY.esc);
  assert.equal(await result, null);
});

test("p previews the file's text, JSON pretty-printed, and esc returns to the list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "purge-dialog-"));
  try {
    const markdown = entry(dir, "report.md", "report", 30);
    const json = entry(dir, "cache.json", "cache", 20);
    await writeFile(markdown.absPath, "# Findings\n\nThe first finding.\n");
    await writeFile(json.absPath, '{"a":1,"b":[2]}');
    const h = host();
    const { result, dialog } = await open(h, [markdown, json]);
    await press(dialog, "p");
    await waitFor(() => /The first finding\./.test(screen(dialog, 104)), "the report preview");
    assert.match(screen(dialog, 104), /ARTIFACT PREVIEW — REPORT\.MD/);
    await press(dialog, KEY.esc);
    assert.match(screen(dialog, 104), /PURGE ARTIFACTS/);
    await press(dialog, KEY.down, "p");
    await waitFor(() => /"b": \[/.test(screen(dialog, 104)), "the JSON preview");
    await press(dialog, KEY.esc, KEY.esc);
    assert.equal(await result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file that cannot be read is reported in the preview and does not close the dialog", async () => {
  const gone = entry(path.join(tmpdir(), "purge-dialog-missing"), "nope.md", "report", 1);
  const h = host();
  const { result, dialog } = await open(h, [gone]);
  await press(dialog, "p");
  await waitFor(() => /Could not preview nope\.md/.test(screen(dialog, 104)), "the preview's error text");
  await press(dialog, KEY.esc, KEY.esc);
  assert.equal(await result, null);
});

test("the preview loader refuses an artifact that is not in the scan", async () => {
  const load = previewLoader([REPORT_A]);
  const [artifact] = toDialogArtifacts([REPORT_B], new Set());
  await assert.rejects(load(artifact!), /no longer listed/);
});

test("outside TUI mode nothing is shown and the answer is a cancel", async () => {
  const h = host({ mode: "rpc" });
  assert.equal(await openPurgeDialog(h.ctx, ENTRIES, new Set(), ROOMY_TERMINAL), null);
  assert.equal(h.customOptions.length, 0);
});

test("a dialog that cannot open is reported and answers undefined, so the caller can fall back", async () => {
  const h = host({ failCustom: new Error("no overlay") });
  assert.equal(await openPurgeDialog(h.ctx, ENTRIES, new Set(), ROOMY_TERMINAL), undefined);
  assert.deepEqual(h.notifications, [{ message: "Persona-audit purge dialog failed: no overlay", type: "error" }]);
});
