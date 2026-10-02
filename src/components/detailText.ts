/**
 * Coloring for finding detail text in the review overlay.
 *
 * Finding prose arrives as plain strings from the reviewers, so the overlay
 * shows long runs of one muted color with the identifiers that matter — the
 * function being called, the file being blamed — indistinguishable from the
 * English around them. This splits a paragraph into segments and paints each
 * one, so `buildBody` can wrap the styled string instead of wrapping first
 * and coloring the result.
 *
 * Painting is per segment and never nested: `Theme.fg` closes with a reset to
 * the terminal default, which would drop the rest of a line out of `muted` if
 * a styled span sat inside a muted one. Every segment therefore carries its own
 * full color, and `wrapTextWithAnsi` carries nothing between lines to restore.
 *
 * Bare camelCase words are left alone on purpose. A segmenter that colored
 * every `someIdentifier` would color ordinary English too, and the noise would
 * cost more than the signal. Backticks, `name()` calls and `path/file.ts:12`
 * are the shapes reviewers actually write, and they are unambiguous.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** The slice of the theme the overlay needs to paint detail text. Structural, so tests can stub it. */
export interface DetailTextTheme {
  fg(color: ThemeColor, text: string): string;
}

/** How a run of finding text is painted. */
export type DetailTextKind = "prose" | "code" | "call" | "path" | "fence";

/**
 * Theme token per kind. `mdCode`/`mdCodeBlock` match the tokens pi's Markdown
 * component uses for the same constructs, so an inline `foo` reads the same in
 * the review overlay as it does in the saved report.
 */
const KIND_COLORS: Record<DetailTextKind, ThemeColor> = {
  prose: "muted",
  code: "mdCode",
  call: "syntaxFunction",
  path: "syntaxString",
  fence: "mdCodeBlock",
};

export interface DetailSegment {
  kind: DetailTextKind;
  text: string;
}

/** A fenced block, closed or not — an unterminated fence runs to the end of the text. */
const FENCE_PATTERN = /```[\s\S]*?(?:```|$)/g;

/** An inline code span on one line. An unmatched backtick matches nothing and stays prose. */
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;

/**
 * `name()` calls and `path/file.ts:12` references. The path arm's lookbehind
 * keeps it off the tail of a URL (`…/example.com/x.html` must not match as
 * `com/x.html`) and off a reference that is already inside a longer path.
 */
const CODEISH_PATTERN = /(?<call>(?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\(\))|(?<path>(?<![\w./:-])(?:[A-Za-z0-9_@-]+\/)+[A-Za-z0-9_@.-]*\.[A-Za-z][A-Za-z0-9]*(?::\d+)?)/g;

/** Append a segment, merging it into the previous one when the kind is unchanged. */
function push(segments: DetailSegment[], kind: DetailTextKind, text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  segments.push({ kind, text });
}

/** The text between one pair of backticks: mostly code, with its own identifiers picked out. */
function pushCodeSpan(inner: string, segments: DetailSegment[]): void {
  let cursor = 0;
  for (const match of inner.matchAll(CODEISH_PATTERN)) {
    push(segments, "code", inner.slice(cursor, match.index));
    push(segments, match.groups?.call ? "call" : "path", match[0]);
    cursor = match.index + match[0].length;
  }
  push(segments, "code", inner.slice(cursor));
}

/** Split prose into `call` and `path` segments, leaving the rest as prose. */
function pushProse(text: string, segments: DetailSegment[]): void {
  let cursor = 0;
  for (const match of text.matchAll(CODEISH_PATTERN)) {
    push(segments, "prose", text.slice(cursor, match.index));
    push(segments, match.groups?.call ? "call" : "path", match[0]);
    cursor = match.index + match[0].length;
  }
  push(segments, "prose", text.slice(cursor));
}

/** Split one run of non-fence text into inline code spans and the prose around them. */
function pushInline(text: string, segments: DetailSegment[]): void {
  let cursor = 0;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    pushProse(text.slice(cursor, match.index), segments);
    pushCodeSpan(match[0].slice(1, -1), segments);
    cursor = match.index + match[0].length;
  }
  pushProse(text.slice(cursor), segments);
}

/**
 * Split finding text into paintable segments. Fences win over inline spans, so
 * a code block is one segment rather than a stack of backtick matches. Callers
 * sanitize the text first — this never inspects terminal escapes.
 */
export function segmentDetailText(text: string): DetailSegment[] {
  const segments: DetailSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FENCE_PATTERN)) {
    pushInline(text.slice(cursor, match.index), segments);
    push(segments, "fence", match[0]);
    cursor = match.index + match[0].length;
  }
  pushInline(text.slice(cursor), segments);
  return segments;
}

/**
 * Paint one paragraph without wrapping it, for the single-line entries that sit
 * inside a detail block rather than in its wrapped body.
 */
export function styleDetailText(text: string, theme: DetailTextTheme): string {
  return segmentDetailText(text)
    .map((segment) => theme.fg(KIND_COLORS[segment.kind], segment.text))
    .join("");
}
