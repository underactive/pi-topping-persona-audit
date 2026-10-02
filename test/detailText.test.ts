import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type DetailTextTheme, segmentDetailText, styleDetailText } from "../src/components/detailText.ts";

const segments = (text: string): [string, string][] => segmentDetailText(text).map((segment) => [segment.kind, segment.text]);

/** Paints each segment with a tag naming the token, so an assertion can name the color without wrapping. */
const tagged: DetailTextTheme = {
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
};

test("prose with nothing to highlight is one segment", () => {
  assert.deepEqual(segments("The caller already validates it."), [["prose", "The caller already validates it."]]);
});

test("an inline code span becomes a code segment with the backticks dropped", () => {
  assert.deepEqual(segments("See `wrapText` for the wrap"), [
    ["prose", "See "],
    ["code", "wrapText"],
    ["prose", " for the wrap"],
  ]);
  assert.deepEqual(segments("`only`"), [["code", "only"]], "a span with no prose around it");
});

test("an unmatched backtick stays prose", () => {
  assert.deepEqual(segments("An unmatched ` backtick stays prose."), [["prose", "An unmatched ` backtick stays prose."]]);
});

test("a pair of backticks around a space is a code span, as in markdown", () => {
  assert.deepEqual(segments("two ` backticks ` here"), [
    ["prose", "two "],
    ["code", " backticks "],
    ["prose", " here"],
  ]);
});

test("a code span keeps its own identifiers in the syntax colors", () => {
  assert.deepEqual(segments("`wrapText()` in `src/a.ts`"), [
    ["call", "wrapText()"],
    ["prose", " in "],
    ["path", "src/a.ts"],
  ]);
});

test("calls and paths are picked out of prose, and the rest stays prose", () => {
  assert.deepEqual(segments("Call resolveScroll() at src/a.ts:1 today."), [
    ["prose", "Call "],
    ["call", "resolveScroll()"],
    ["prose", " at "],
    ["path", "src/a.ts:1"],
    ["prose", " today."],
  ]);
  assert.deepEqual(segments("this.buildBody()"), [["call", "this.buildBody()"]], "a method call on a receiver");
  assert.deepEqual(segments("@scope/pkg.json"), [["path", "@scope/pkg.json"]], "a scoped package path");
});

test("prose that only looks like code is left alone", () => {
  assert.deepEqual(segments("and/or is not a path"), [["prose", "and/or is not a path"]]);
  assert.deepEqual(segments("Change 01 describing the edit in enough words"), [
    ["prose", "Change 01 describing the edit in enough words"],
  ]);
  assert.deepEqual(segments("The 5/8 split stays prose"), [["prose", "The 5/8 split stays prose"]]);
});

test("a URL is not matched as a path from its tail", () => {
  assert.deepEqual(segments("See https://example.com/a.html for the shape"), [
    ["prose", "See https://example.com/a.html for the shape"],
  ]);
});

test("a fenced block is one segment, whatever is inside it", () => {
  assert.deepEqual(segments("```ts\nif (!item) return wrapText();\n```"), [
    ["fence", "```ts\nif (!item) return wrapText();\n```"],
  ]);
  assert.deepEqual(segments("A `span` then a fence:\n```\nplain\n```"), [
    ["prose", "A "],
    ["code", "span"],
    ["prose", " then a fence:\n"],
    ["fence", "```\nplain\n```"],
  ]);
});

test("an unterminated fence runs to the end of the text", () => {
  assert.deepEqual(segments("Guard it: ```ts return null;"), [
    ["prose", "Guard it: "],
    ["fence", "```ts return null;"],
  ]);
});

test("adjacent segments of one kind are merged", () => {
  assert.deepEqual(segmentDetailText("resolveScroll()buildBody()"), [
    { kind: "call", text: "resolveScroll()buildBody()" },
  ]);
  assert.equal(segmentDetailText("").length, 0, "empty text has no segments");
});

test("every segment carries its own color, so no span is nested inside another", () => {
  const painted = styleDetailText("See `wrapText` and resolveScroll() at src/a.ts:1", tagged);

  // Exact equality is the point: every run opens and closes its own tag, so the
  // text after a highlighted span is still fully colored.
  assert.equal(painted, [
    "<muted>See </muted>",
    "<mdCode>wrapText</mdCode>",
    "<muted> and </muted>",
    "<syntaxFunction>resolveScroll()</syntaxFunction>",
    "<muted> at </muted>",
    "<syntaxString>src/a.ts:1</syntaxString>",
  ].join(""));
});
