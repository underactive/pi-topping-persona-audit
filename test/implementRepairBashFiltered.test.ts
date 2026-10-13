import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Returns the line that sets the tools of the session whose `agentName` line
// matches `namePattern` (a `tools:` property or a withoutBash() spread),
// scanning forward from that line.
const toolsLineForSession = (lines: string[], namePattern: RegExp): string | undefined => {
  const start = lines.findIndex((l) => namePattern.test(l));
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length && i < start + 20; i++) {
    const line = lines[i]?.trim();
    if (line && (/^tools:\s/.test(line) || /^\.\.\.withoutBash\(/.test(line))) return line;
  }
  return undefined;
};

test("implement, gate-repair and Fix Now sessions take their tools from withoutBash()", async () => {
  // The adjudicator's tools include "bash"; an edit-capable session that
  // receives it can shell out and escape the file-manifest containment, so
  // "touch only your files" degrades to prompt-only. withoutBash() drops it
  // from the allowlist and excludes it, so no `*` entry can re-admit it.
  const sessions: Array<[string, string, RegExp]> = [
    ["implement", "orchestrator.ts", /agentName:\s*`adjudicator implement/],
    ["gate-repair", "orchestrator.ts", /agentName:\s*`adjudicator repair/],
    ["Fix Now", "fixNow.ts", /agentName:\s*"fix now implement"/],
  ];

  for (const [label, file, pattern] of sessions) {
    const lines = (await readFile(join(srcDir, file), "utf-8")).split("\n");
    const toolsLine = toolsLineForSession(lines, pattern);
    assert.ok(toolsLine, `could not locate the ${label} adjudicator session's tools line in ${file}`);
    assert.match(toolsLine, /^\.\.\.withoutBash\(/, `${label} adjudicator tools must keep bash out: ${toolsLine}`);
  }
});
