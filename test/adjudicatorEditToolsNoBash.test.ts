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

test("edit-capable adjudicator sessions filter bash out of their tool set", async () => {
  const src = await readFile(orchestratorPath, "utf-8");

  // EDIT_TOOLS is the only built-in toolset that contains "bash"; reconcile
  // uses READ_ONLY_TOOLS and revoice uses `[]`, so any `tools:` line drawing
  // on EDIT_TOOLS is an edit-capable adjudicator session (implement or
  // gate-repair). Such a session must not be able to shell out, so "bash"
  // has to be filtered before it reaches runAgentSession.
  const editCapableToolLines = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^tools:\s/.test(l) && l.includes("EDIT_TOOLS"));

  assert.ok(
    editCapableToolLines.length >= 2,
    `expected implement and gate-repair to configure tools from EDIT_TOOLS, found ${editCapableToolLines.length}`,
  );

  for (const line of editCapableToolLines) {
    assert.match(
      line,
      /\.filter\(.*!==\s*["']bash["']/,
      `edit-capable adjudicator tools must filter out bash: ${line}`,
    );
  }
});
