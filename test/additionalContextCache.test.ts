import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReviewerCacheKey } from "../src/index.ts";

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "persona-cache-context-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const args = (cwd: string): [string, string[], string[], number, "full", "calibrated"] =>
  [cwd, ["src/a.ts"], ["Security Engineer"], 1, "full", "calibrated"];

test("empty additional context preserves the context-free reviewer cache key", async () => withProject(async (cwd) => {
  const original = await buildReviewerCacheKey(...args(cwd));
  const empty = await buildReviewerCacheKey(...args(cwd), undefined, { text: "", images: [] });
  assert.equal(empty, original);
}));

test("text and image changes invalidate reviewer cache keys", async () => withProject(async (cwd) => {
  const first = await buildReviewerCacheKey(...args(cwd), undefined, { text: "first", images: [] });
  const second = await buildReviewerCacheKey(...args(cwd), undefined, { text: "second", images: [] });
  const imageA = await buildReviewerCacheKey(...args(cwd), undefined, {
    text: "first",
    images: [{ type: "image", mimeType: "image/png", data: "YQ==" }],
  });
  const imageB = await buildReviewerCacheKey(...args(cwd), undefined, {
    text: "first",
    images: [{ type: "image", mimeType: "image/png", data: "Yg==" }],
  });
  assert.notEqual(first, second);
  assert.notEqual(first, imageA);
  assert.notEqual(imageA, imageB);
}));
