import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_CONTEXT_IMAGE_BYTES,
  MAX_CONTEXT_IMAGES,
  additionalContextFingerprint,
  describeAdditionalContext,
  formatAdditionalContextPrompt,
  parseAdditionalContext,
} from "../src/additionalContext.ts";

async function fixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "persona-context-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("parses blank and text-only context", async () => fixture(async (cwd) => {
  assert.deepEqual((await parseAdditionalContext("  \n", cwd)).context, { text: "", images: [] });
  const parsed = await parseAdditionalContext("Focus on auth\nand races", cwd);
  assert.equal(parsed.context.text, "Focus on auth\nand races");
  assert.deepEqual(parsed.warnings, []);
}));

test("loads relative, quoted, and mixed image paths", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "screen.png"), Buffer.from("png"));
  await writeFile(join(cwd, "two.jpg"), Buffer.from("jpg"));
  const parsed = await parseAdditionalContext("Prioritize layout\n\"screen.png\"\n'two.jpg'", cwd);
  assert.equal(parsed.context.images.length, 2);
  assert.deepEqual(parsed.context.images.map((image) => image.mimeType), ["image/png", "image/jpeg"]);
  assert.equal(parsed.context.text, "Prioritize layout\n[Attached image: screen.png]\n[Attached image: two.jpg]");
}));

test("keeps missing and unsupported paths as text with warnings", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "notes.bmp"), Buffer.from("bmp"));
  const parsed = await parseAdditionalContext("missing.webp\nnotes.bmp", cwd);
  assert.equal(parsed.context.text, "missing.webp\nnotes.bmp");
  assert.equal(parsed.context.images.length, 0);
  assert.match(parsed.warnings.join("\n"), /not found.*missing\.webp/i);
  assert.match(parsed.warnings.join("\n"), /unsupported.*notes\.bmp/i);
}));

test("rejects oversized files and files beyond the image count limit", async () => fixture(async (cwd) => {
  await writeFile(join(cwd, "large.png"), Buffer.alloc(MAX_CONTEXT_IMAGE_BYTES + 1));
  for (let index = 0; index <= MAX_CONTEXT_IMAGES; index++) {
    await writeFile(join(cwd, `${index}.png`), Buffer.from(String(index)));
  }
  const paths = Array.from({ length: MAX_CONTEXT_IMAGES + 1 }, (_, index) => `${index}.png`).join("\n");
  const parsed = await parseAdditionalContext(`large.png\n${paths}`, cwd);
  assert.equal(parsed.context.images.length, MAX_CONTEXT_IMAGES);
  assert.match(parsed.warnings.join("\n"), /exceeds 5 MiB/);
  assert.match(parsed.warnings.join("\n"), /Image limit reached/);
}));

test("formats summary and prompt without exposing empty context", () => {
  assert.equal(describeAdditionalContext({ text: "", images: [] }), "(none)");
  assert.equal(formatAdditionalContextPrompt({ text: "", images: [] }), undefined);
  const context = { text: "Check this", images: [{ type: "image" as const, mimeType: "image/png", data: "YQ==" }] };
  assert.equal(describeAdditionalContext(context), "10 chars · 1 image");
  assert.match(formatAdditionalContextPrompt(context) ?? "", /guides review priorities/);
  assert.match(formatAdditionalContextPrompt(context) ?? "", /1 attached image/);
});

test("fingerprint changes with text, order, MIME type, or bytes and is deterministic", () => {
  const base = { text: "note", images: [{ type: "image" as const, mimeType: "image/png", data: "YQ==" }] };
  assert.equal(additionalContextFingerprint(base), additionalContextFingerprint({ ...base }));
  assert.notEqual(additionalContextFingerprint(base), additionalContextFingerprint({ ...base, text: "other" }));
  assert.notEqual(additionalContextFingerprint(base), additionalContextFingerprint({ ...base, images: [{ ...base.images[0]!, data: "Yg==" }] }));
  assert.notEqual(additionalContextFingerprint(base), additionalContextFingerprint({ ...base, images: [{ ...base.images[0]!, mimeType: "image/jpeg" }] }));
  assert.notEqual(additionalContextFingerprint({ ...base, images: [...base.images, { ...base.images[0]!, data: "Yg==" }] }), additionalContextFingerprint({ ...base, images: [{ ...base.images[0]!, data: "Yg==" }, ...base.images] }));
});
