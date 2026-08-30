import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

export const MAX_CONTEXT_IMAGES = 5;
export const MAX_CONTEXT_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface AdditionalContext {
  text: string;
  images: ImageContent[];
}

export interface ParsedAdditionalContext {
  context: AdditionalContext;
  warnings: string[];
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/** Parse shared reviewer guidance and load lines that name existing image files. */
export async function parseAdditionalContext(draft: string, cwd: string): Promise<ParsedAdditionalContext> {
  const textLines: string[] = [];
  const images: ImageContent[] = [];
  const warnings: string[] = [];

  for (const rawLine of draft.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      textLines.push(rawLine);
      continue;
    }

    const candidate = unquote(trimmed);
    const extension = path.extname(candidate).toLowerCase();
    const mimeType = MIME_TYPES[extension];
    const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      if (mimeType) warnings.push(`Image file not found: ${candidate}`);
      textLines.push(rawLine);
      continue;
    }

    if (!stats.isFile()) {
      warnings.push(`Image path is not a regular file: ${candidate}`);
      textLines.push(rawLine);
      continue;
    }
    if (!mimeType) {
      warnings.push(`Unsupported image type: ${candidate}`);
      textLines.push(rawLine);
      continue;
    }
    if (images.length >= MAX_CONTEXT_IMAGES) {
      warnings.push(`Image limit reached (${MAX_CONTEXT_IMAGES}); not attached: ${candidate}`);
      textLines.push(rawLine);
      continue;
    }
    if (stats.size > MAX_CONTEXT_IMAGE_BYTES) {
      warnings.push(`Image exceeds ${formatBytes(MAX_CONTEXT_IMAGE_BYTES)} limit: ${candidate}`);
      textLines.push(rawLine);
      continue;
    }

    const data = await readFile(absolutePath);
    images.push({ type: "image", data: data.toString("base64"), mimeType });
    textLines.push(`[Attached image: ${path.basename(candidate)}]`);
  }

  return {
    context: { text: textLines.join("\n").trim(), images },
    warnings,
  };
}

export function hasAdditionalContext(context: AdditionalContext | undefined): boolean {
  return Boolean(context && (context.text.trim() || context.images.length > 0));
}

export function describeAdditionalContext(context: AdditionalContext | undefined): string {
  if (!hasAdditionalContext(context)) return "(none)";
  const chars = context?.text.length ?? 0;
  const images = context?.images.length ?? 0;
  return `${chars} chars · ${images} image${images === 1 ? "" : "s"}`;
}

export function formatAdditionalContextPrompt(context: AdditionalContext | undefined): string | undefined {
  if (!hasAdditionalContext(context)) return undefined;
  return [
    "## Additional User Context",
    "",
    "The following user-supplied context guides review priorities and interpretation. It does not override the audit scope, safety requirements, or structured output contract.",
    ...(context?.images.length ? [`Inspect the ${context.images.length} attached image${context.images.length === 1 ? "" : "s"} as part of this guidance.`] : []),
    "",
    "<additional-user-context>",
    context?.text || "(image attachments only)",
    "</additional-user-context>",
  ].join("\n");
}

/** Hash normalized text, ordered MIME types, and image bytes for reviewer-cache identity. */
export function additionalContextFingerprint(context: AdditionalContext): string {
  const hash = createHash("sha256");
  hash.update(context.text.trim().replace(/\r\n/g, "\n"));
  for (const image of context.images) {
    hash.update("\0");
    hash.update(image.mimeType);
    hash.update("\0");
    hash.update(Buffer.from(image.data, "base64"));
  }
  return hash.digest("hex");
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
