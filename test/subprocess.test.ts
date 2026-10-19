import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
  BUNDLED_AGENTS_DIR,
  discoverAgents,
  isPermanentRunFailure,
  loadAgentsFromDir,
  mapWithConcurrencyLimit,
  resolveAgentTools,
} from "../src/subprocess.ts";
import { virtualModelMessage } from "../src/agentRunner.ts";

// ── Agent discovery ────────────────────────────────────────

test("the bundled agents/ directory ships both required agents", () => {
  // Asserted against the bundled layer directly, not through discoverAgents: a
  // developer's ~/.pi/agent/agents copy would otherwise satisfy the assertion
  // and hide a broken bundle path.
  const byName = new Map(loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled").map((a) => [a.name, a]));

  const reviewer = byName.get("persona-audit-reviewer");
  const adjudicator = byName.get("persona-audit-adjudicator");
  assert.ok(reviewer, `persona-audit-reviewer missing from ${BUNDLED_AGENTS_DIR}`);
  assert.ok(adjudicator, `persona-audit-adjudicator missing from ${BUNDLED_AGENTS_DIR}`);

  // Frontmatter is the source of truth for the subprocess tool allowlist.
  assert.deepEqual(reviewer.tools, ["read", "grep", "find", "ls"]);
  assert.ok(adjudicator.tools?.includes("edit"), "the adjudicator must be edit-capable");
  assert.match(adjudicator.systemPrompt, /never weaken/i);
  assert.doesNotMatch(adjudicator.systemPrompt, /Do not modify test fixtures/);
  assert.ok(reviewer.systemPrompt.trim().length > 0, "the markdown body is the base system prompt");
});

test("discovery finds the required agents from a cwd with no project-local .pi/agents", () => {
  // The guarantee that lets /persona-audit run against an unrelated repository.
  const names = discoverAgents(tmpdir()).map((a) => a.name);
  assert.ok(names.includes("persona-audit-reviewer"));
  assert.ok(names.includes("persona-audit-adjudicator"));
});

// ── Agent tool lists ──

const ROLE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const agentFile = "/home/me/.pi/agent/agents/persona-audit-adjudicator.md";

test("resolveAgentTools keeps a list of names and falls back to a copy of the role's tools", () => {
  assert.deepEqual(resolveAgentTools({ tools: ["read", "edit"], filePath: agentFile }, ROLE_TOOLS), ["read", "edit"]);
  assert.deepEqual(
    resolveAgentTools({ tools: ["read", "mcp__*"], filePath: agentFile }, ROLE_TOOLS),
    ["read", "mcp__*"],
    "patterns among names are left for pi to match",
  );
  const fallback = resolveAgentTools({ filePath: agentFile }, ROLE_TOOLS);
  assert.deepEqual(fallback, ROLE_TOOLS);
  fallback.pop();
  assert.equal(ROLE_TOOLS.length, 7, "callers may change the result without touching the shared defaults");
});

test("resolveAgentTools applies +name/-name entries to the role's tools, not pi's defaults", () => {
  // Passed through, pi 1.1.0+ would edit read/bash/edit/write and drop grep, find and ls.
  assert.deepEqual(resolveAgentTools({ tools: ["-write"], filePath: agentFile }, ROLE_TOOLS), [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
  ]);
  assert.deepEqual(resolveAgentTools({ tools: ["+codemode", "-ls"], filePath: agentFile }, ROLE_TOOLS), [
    "read",
    "grep",
    "find",
    "bash",
    "edit",
    "write",
    "codemode",
  ]);
  assert.deepEqual(
    resolveAgentTools({ tools: ["+read", "-missing", "+"], filePath: agentFile }, ROLE_TOOLS),
    ROLE_TOOLS,
    "adding a present tool, removing an absent one, or a bare + changes nothing",
  );
});

test("resolveAgentTools rejects the lists pi rejects, naming the agent file", () => {
  assert.throws(
    () => resolveAgentTools({ tools: ["read", "-write"], filePath: agentFile }, ROLE_TOOLS),
    new Error(`Invalid tools in ${agentFile}: tool names cannot be mixed with +name or -name entries`),
  );
  assert.throws(
    () => resolveAgentTools({ tools: ["+mcp__*"], filePath: agentFile }, ROLE_TOOLS),
    new Error(`Invalid tools in ${agentFile}: +name and -name entries take exact tool names, not patterns: +mcp__*`),
  );
});

// ── Concurrency ──────────────────────────────────────────────

test("mapWithConcurrencyLimit preserves order and caps concurrency", async () => {
  let running = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await mapWithConcurrencyLimit(items, 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});

// ── Permanent-failure classification ────────────────────────────────────

test("isPermanentRunFailure recognizes pre-network errors", () => {
  assert.equal(isPermanentRunFailure('Model not found: "gpt-99".\n\nAvailable models:\n- gpt-5'), true);
  assert.equal(isPermanentRunFailure(virtualModelMessage("routesense/auto")), true);
  assert.equal(isPermanentRunFailure("model not found: gpt-99"), false, "resolveModelRef's prefix is capitalized");
  assert.equal(isPermanentRunFailure("connection reset by peer"), false);
  assert.equal(isPermanentRunFailure(""), false);
  assert.equal(isPermanentRunFailure(undefined), false);
});
