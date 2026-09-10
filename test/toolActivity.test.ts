import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ActivityTheme } from "../src/toolActivity.ts";
import { highlightActivity } from "../src/toolActivity.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CODES: Partial<Record<ThemeColor, number>> = {
	text: 101,
	dim: 102,
	accent: 103,
	warning: 104,
	toolTitle: 105,
	success: 106,
	error: 107,
	border: 108,
};
const THEME: ActivityTheme = {
	fg: (color, text) => `\x1b[${CODES[color] ?? 199}m${text}\x1b[0m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const TOOL_TITLE = (tool: string): RegExp =>
	new RegExp(`\\x1b\\[105m\\x1b\\[1m${escapeRegExp(tool)}\\x1b\\[22m\\x1b\\[0m`);
const ACCENT = (detail: string): RegExp => new RegExp(`\\x1b\\[103m${escapeRegExp(detail)}\\x1b\\[0m`);

test("highlightActivity styles tool names and arguments without changing activity text", () => {
	const cases = [
		{ label: "single space", activity: "read src/app.ts", tool: "read", detail: "src/app.ts" },
		{ label: "repeated spaces", activity: 'grep  "handleRequest"', tool: "grep", detail: '"handleRequest"' },
		{
			label: "path with spaces",
			activity: "read /Users/me/My Documents/notes.txt",
			tool: "read",
			detail: "/Users/me/My Documents/notes.txt",
		},
		{
			label: "regex punctuation and backslashes",
			activity: "grep  (foo|bar)\\d+\\.ts$",
			tool: "grep",
			detail: "(foo|bar)\\d+\\.ts$",
		},
		{
			label: "custom tool name",
			activity: "mf_plan_subagent  explore the auth flow",
			tool: "mf_plan_subagent",
			detail: "explore the auth flow",
		},
		{ label: "leading whitespace", activity: "  read src/app.ts", tool: "read", detail: "src/app.ts" },
	];

	for (const { label, activity, tool, detail } of cases) {
		const output = highlightActivity(THEME, activity);
		assert.equal(strip(output), activity, `${label}: stripped output preserves the original activity exactly`);
		assert.equal(visibleWidth(output), visibleWidth(activity), `${label}: visible width is unchanged`);
		assert.match(output, TOOL_TITLE(tool), `${label}: tool is bold and toolTitle-colored`);
		assert.match(output, ACCENT(detail), `${label}: argument is accent-colored`);
	}
});

test("highlightActivity preserves leading whitespace before the styled tool", () => {
	const output = highlightActivity(THEME, "  read src/app.ts");
	assert.equal(strip(output), "  read src/app.ts");
	assert.ok(output.startsWith(`  ${THEME.fg("toolTitle", THEME.bold("read"))}`));
});

test("highlightActivity styles a bare tool name without an argument", () => {
	const output = highlightActivity(THEME, "read");
	assert.equal(strip(output), "read");
	assert.equal(visibleWidth(output), visibleWidth("read"));
	assert.match(output, /^\x1b\[105m\x1b\[1mread\x1b\[22m\x1b\[0m$/);
});

test("highlightActivity leaves empty and whitespace-only input unchanged", () => {
	assert.equal(highlightActivity(THEME, ""), "");
	assert.equal(highlightActivity(THEME, "   "), "   ");
});
