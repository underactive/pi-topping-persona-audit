import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EDIT_TOOLS } from "../src/orchestrator.ts";
import { BUNDLED_AGENTS_DIR, loadAgentsFromDir, resolveAgentTools, withoutBash, type AgentConfig } from "../src/subprocess.ts";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// The user layer is the only one that may redefine the adjudicator, so each
// case loads a real override file the way discovery does.
async function withOverride<T>(toolsLine: string, fn: (agent: AgentConfig) => T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "persona-audit-tools-"));
  try {
    await writeFile(
      join(dir, "persona-audit-adjudicator.md"),
      `---\nname: persona-audit-adjudicator\ndescription: override\ntools: ${toolsLine}\n---\nbody\n`,
    );
    const [agent] = loadAgentsFromDir(dir, "user");
    assert.ok(agent, `the override with tools: ${toolsLine} must load`);
    return fn(agent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("edit-capable adjudicator sessions never get bash, whatever an override's tools say", async () => {
  // pi 1.1.0+ reads a list of only +name/-name entries as an edit of pi's own
  // defaults (read, bash, edit, write), and pi 1.0.4+ reads `*` as a wildcard.
  // A filter that removed only an entry spelled "bash" let both hand bash back.
  const cases: Array<[string, string[]]> = [
    ["read, grep, edit", ["read", "grep", "edit"]],
    ["-write", ["read", "grep", "find", "ls", "edit"]],
    ["+codemode", ["read", "grep", "find", "ls", "edit", "write", "codemode"]],
    ["read, edit, *", ["read", "edit", "*"]],
    ['"*"', ["*"]],
    ["read, b*", ["read", "b*"]],
  ];
  for (const [toolsLine, expected] of cases) {
    const options = await withOverride(toolsLine, (agent) => withoutBash(resolveAgentTools(agent, EDIT_TOOLS)));
    assert.deepEqual(options.tools, expected, `tools: ${toolsLine}`);
    assert.deepEqual(options.excludeTools, ["bash"], `tools: ${toolsLine} must still exclude bash, which a * entry matches`);
  }
});

test("an override mixing tool names with +name/-name entries fails before any session, naming its file", async () => {
  // Passed through, pi would throw "Invalid tools option" only when the
  // implement phase created its first session, after the review had run.
  await withOverride("read, -write", (agent) => {
    assert.throws(
      () => resolveAgentTools(agent, EDIT_TOOLS),
      (error: unknown) =>
        error instanceof Error && error.message.includes(agent.filePath) && error.message.includes("cannot be mixed"),
    );
  });
});

test("+name/-name entries edit the same list the bundled adjudicator ships", () => {
  const bundled = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled").find((a) => a.name === "persona-audit-adjudicator");
  assert.ok(bundled);
  assert.deepEqual(bundled.tools, EDIT_TOOLS, "an override's -write must mean the shipped list minus write");
});

test("no session takes the adjudicator's tools without withoutBash()", async () => {
  // A new edit-capable session handed the resolved list directly could shell out.
  for (const file of ["orchestrator.ts", "fixNow.ts"]) {
    const lines = (await readFile(join(srcDir, file), "utf-8")).split("\n").map((l) => l.trim());
    const direct = lines.filter((l) => /^tools:/.test(l) && /\b(EDIT_TOOLS|adjudicatorTools)\b/.test(l));
    assert.deepEqual(direct, [], `${file} passes the adjudicator's tools to a session without withoutBash()`);
  }
});
