import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
  BUNDLED_AGENTS_DIR,
  discoverAgents,
  formatToolActivity,
  isPermanentRunFailure,
  loadAgentsFromDir,
  mapWithConcurrencyLimit,
  OutputActivityTracker,
} from "../src/subprocess.ts";
import type { AssistantMessageEvent, Message } from "@earendil-works/pi-ai";

// ── Fixtures: minimal fake assistant messages/events (the tracker only reads .role and .usage) ──

const fakeAssistantMessage = (usage?: Record<string, unknown>): Message =>
  ({ role: "assistant", content: [], usage } as unknown as Message);

const textDelta = (delta: string): AssistantMessageEvent => ({ type: "text_delta", delta }) as AssistantMessageEvent;

// ── OutputActivityTracker ───────────────────────────────────────────────────

test("OutputActivityTracker estimates generated output from deltas and revises it on exact usage", () => {
  const tracker = new OutputActivityTracker();
  tracker.messageStart(fakeAssistantMessage());
  tracker.messageUpdate(textDelta("hello world "), fakeAssistantMessage());
  tracker.messageUpdate(textDelta("frag"), fakeAssistantMessage());
  tracker.messageUpdate(textDelta("ment "), fakeAssistantMessage());
  assert.equal(tracker.snapshot().tokens, 3, "a word split across deltas counts once");
  assert.equal(tracker.snapshot().revision, 0);

  tracker.messageEnd(fakeAssistantMessage({ output: 12 }));
  assert.equal(tracker.snapshot().tokens, 12);
  assert.equal(tracker.snapshot().revision, 1, "exact usage superseding an estimate bumps the revision");
});

test("OutputActivityTracker prefers exact partial usage over the word estimate", () => {
  const tracker = new OutputActivityTracker();
  tracker.messageStart(fakeAssistantMessage());
  tracker.messageUpdate(textDelta("one two three four five "), fakeAssistantMessage());
  tracker.messageUpdate(undefined, fakeAssistantMessage({ output: 30 }));
  assert.equal(tracker.snapshot().tokens, 30);
});

test("OutputActivityTracker resets its live estimate on a new turn without touching confirmed totals", () => {
  const tracker = new OutputActivityTracker();
  tracker.messageStart(fakeAssistantMessage());
  tracker.messageUpdate(textDelta("first turn words here"), fakeAssistantMessage());
  tracker.messageEnd(fakeAssistantMessage({ output: 4 }));
  assert.equal(tracker.snapshot().tokens, 4);

  tracker.messageStart(fakeAssistantMessage());
  assert.equal(tracker.snapshot().tokens, 4, "starting a new turn must not discard the prior confirmed total");
  tracker.messageUpdate(textDelta("second"), fakeAssistantMessage());
  assert.equal(tracker.snapshot().tokens, 5, "confirmed total plus the new turn's live estimate");
});

// ── Tool activity formatting ─────────────────────────────────────────────────

test("formatToolActivity collapses whitespace, prefers known args, and caps length", () => {
  assert.equal(formatToolActivity("bash", { command: "npm run  check\n --verbose" }), "bash npm run check --verbose");
  assert.equal(formatToolActivity("ls", undefined), "ls");
  assert.equal(formatToolActivity("read", { limit: 20, file: "src/a.ts" }), "read src/a.ts");
  assert.equal(formatToolActivity("custom", { note: "fallback value" }), "custom fallback value");
  assert.equal(formatToolActivity("bash", { command: "x".repeat(200) }).length, 80);
});

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
  assert.ok(reviewer.systemPrompt.trim().length > 0, "the markdown body is the base system prompt");
});

test("discovery finds the required agents from a cwd with no project-local .pi/agents", () => {
  // The guarantee that lets /persona-audit run against an unrelated repository.
  const names = discoverAgents(tmpdir()).map((a) => a.name);
  assert.ok(names.includes("persona-audit-reviewer"));
  assert.ok(names.includes("persona-audit-adjudicator"));
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

test("isPermanentRunFailure recognizes resolveModelRef's pre-network error", () => {
  assert.equal(isPermanentRunFailure('Model not found: "gpt-99".\n\nAvailable models:\n- gpt-5'), true);
  assert.equal(isPermanentRunFailure("model not found: gpt-99"), false, "resolveModelRef's prefix is capitalized");
  assert.equal(isPermanentRunFailure("connection reset by peer"), false);
  assert.equal(isPermanentRunFailure(""), false);
  assert.equal(isPermanentRunFailure(undefined), false);
});
