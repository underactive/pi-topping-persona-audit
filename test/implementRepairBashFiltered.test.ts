import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const orchestratorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "orchestrator.ts",
);

// Returns the `tools:` expression passed to the runAgentSession call whose
// `agentName` line matches `namePattern`, scanning forward from that line.
const toolsForSession = (lines: string[], namePattern: RegExp): string | undefined => {
  const start = lines.findIndex((l) => namePattern.test(l));
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length && i < start + 20; i++) {
    const m = lines[i]?.match(/^\s*tools:\s*(.+?),?\s*$/);
    if (m) return m[1];
  }
  return undefined;
};

test("implement and gate-repair adjudicator sessions filter bash out of their tools", async () => {
  const src = await readFile(orchestratorPath, "utf-8");
  const lines = src.split("\n");

  // EDIT_TOOLS contains "bash"; an edit-capable adjudicator session that
  // receives it unfiltered can shell out and escape the file-manifest
  // containment, so "touch only your files" degrades to prompt-only. Both the
  // fix-implement and gate-repair sessions must strip "bash" before it
  // reaches runAgentSession.
  const sessions: Array<[string, RegExp]> = [
    ["implement", /agentName:\s*`adjudicator implement/],
    ["gate-repair", /agentName:\s*`adjudicator repair/],
  ];

  for (const [label, pattern] of sessions) {
    const tools = toolsForSession(lines, pattern);
    assert.ok(tools, `could not locate the ${label} adjudicator session's tools line`);
    assert.match(
      tools,
      /\.filter\(.*!==\s*["']bash["']/,
      `${label} adjudicator tools must filter out bash: ${tools}`,
    );
  }
});
