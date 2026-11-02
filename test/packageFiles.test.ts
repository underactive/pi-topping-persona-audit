import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as { files?: unknown };
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf-8");

test("the published package ships the root CHANGELOG.md so pi can show update notes", () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes("CHANGELOG.md"));
});

test("CHANGELOG.md has a released version heading pi can match", () => {
  assert.match(changelog, /^## \[\d+\.\d+\.\d+\]/m);
});
