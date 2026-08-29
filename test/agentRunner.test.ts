import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildRuntimeWithExtensionProviders,
  calculateTurnCost,
  createInteractiveAgentSession,
  createIsolatedResourceLoader,
  getAllAssistantText,
  getFinalAssistantText,
  resolveModelRef,
  type SessionMessage,
} from "../src/agentRunner.ts";

// Exercises the real ModelRegistry.registerProvider() path — the same
// mechanism a bridge/extension provider uses at runtime — rather than a
// duck-typed fake, since that data-mutation path is what the migration relies on.
// Model ids/names use a "zzz-rt-test-" prefix so fuzzy matching can never
// collide with a real built-in catalogue entry that also loaded into this registry.
async function testRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider("zzz-rt-test-provider", {
    apiKey: "fake-key",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "zzz-rt-test-alpha-4-5",
        name: "ZZZ RT Test Alpha 4.5",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
          tiers: [{ inputTokensAbove: 1000, input: 100, output: 200, cacheRead: 30, cacheWrite: 40 }],
        },
        contextWindow: 200_000,
        maxTokens: 8000,
      },
      {
        id: "zzz-rt-test-beta",
        name: "ZZZ RT Test Beta",
        api: "openai-responses",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 8000,
      },
    ],
  });
  return registry;
}

test("resolveModelRef returns undefined for undefined input", async () => {
  assert.equal(resolveModelRef(undefined, await testRegistry()), undefined);
});

test("resolveModelRef resolves an exact provider/id match", async () => {
  const found = resolveModelRef("zzz-rt-test-provider/zzz-rt-test-alpha-4-5", await testRegistry());
  assert.equal(found?.provider, "zzz-rt-test-provider");
  assert.equal(found?.id, "zzz-rt-test-alpha-4-5");
});

test("resolveModelRef fuzzy-matches dot/dash punctuation differences", async () => {
  const found = resolveModelRef("zzz-rt-test-alpha-4.5", await testRegistry());
  assert.equal(found?.provider, "zzz-rt-test-provider");
  assert.equal(found?.id, "zzz-rt-test-alpha-4-5");
});

test("resolveModelRef fuzzy-matches a bare frontmatter-style string against display name", async () => {
  const found = resolveModelRef("ZZZ RT Test Beta", await testRegistry());
  assert.equal(found?.provider, "zzz-rt-test-provider");
  assert.equal(found?.id, "zzz-rt-test-beta");
});

test("resolveModelRef matches a date-stamped query against an undated registry id", async () => {
  const found = resolveModelRef("zzz-rt-test-alpha-4-5-20251001", await testRegistry());
  assert.equal(found?.provider, "zzz-rt-test-provider");
  assert.equal(found?.id, "zzz-rt-test-alpha-4-5");
});

test("resolveModelRef retries bare when the named provider doesn't have the model", async () => {
  const found = resolveModelRef("wrong-provider/zzz-rt-test-alpha-4-5", await testRegistry());
  assert.equal(found?.provider, "zzz-rt-test-provider");
  assert.equal(found?.id, "zzz-rt-test-alpha-4-5");
});

test("resolveModelRef throws with the available-model list when nothing matches", async () => {
  const registry = await testRegistry();
  assert.throws(
    () => resolveModelRef("zzz-rt-test-nonexistent-model-xyz", registry),
    /Model not found: "zzz-rt-test-nonexistent-model-xyz"[\s\S]*zzz-rt-test-provider\/zzz-rt-test-alpha-4-5[\s\S]*zzz-rt-test-provider\/zzz-rt-test-beta/,
  );
});

test("calculateTurnCost uses registry rates, including long-cache writes", async () => {
  const registry = await testRegistry();
  const model = registry.find("zzz-rt-test-provider", "zzz-rt-test-alpha-4-5");
  assert.ok(model);
  assert.equal(
    calculateTurnCost(model, {
      input: 100,
      output: 200,
      cacheRead: 300,
      cacheWrite: 400,
      cacheWrite1h: 100,
      totalTokens: 1000,
    }),
    0.0091,
  );
  assert.equal(
    calculateTurnCost(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0 }),
    undefined,
  );

  const zeroCostModel = registry.find("zzz-rt-test-provider", "zzz-rt-test-beta");
  assert.ok(zeroCostModel);
  assert.equal(
    calculateTurnCost(zeroCostModel, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cacheWrite1h: 1, totalTokens: 5 }),
    0,
  );
});

test("calculateTurnCost applies each tier to its own assistant turn", async () => {
  const registry = await testRegistry();
  const model = registry.find("zzz-rt-test-provider", "zzz-rt-test-alpha-4-5");
  assert.ok(model);
  const turn = { input: 600, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 700 };

  const firstTurnCost = calculateTurnCost(model, turn);
  const secondTurnCost = calculateTurnCost(model, turn);
  assert.equal(firstTurnCost, 0.008);
  assert.equal(secondTurnCost, 0.008);
  assert.equal((firstTurnCost ?? 0) + (secondTurnCost ?? 0), 0.016);

  // The same two turns as one request would cross the request-wide threshold
  // and incorrectly use the higher rates for all tokens.
  const aggregateCost = calculateTurnCost(model, { input: 1200, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1400 });
  assert.equal(aggregateCost, 0.16);
  assert.notEqual((firstTurnCost ?? 0) + (secondTurnCost ?? 0), aggregateCost);
});

// ── The actual regression: a fresh runtime must inherit registered-provider auth ──

test("buildRuntimeWithExtensionProviders replays a registered provider so hasConfiguredAuth is true on the fresh runtime", async () => {
  const registry = await testRegistry();
  const agentDir = getAgentDir();
  const runtime = await buildRuntimeWithExtensionProviders(registry, agentDir);
  assert.equal(runtime.hasConfiguredAuth("zzz-rt-test-provider"), true);
});

// ── Session transcript text extraction ────────────────────────────────────

const assistantMsg = (text: string): SessionMessage =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as SessionMessage;
const toolResultMsg = (): SessionMessage =>
  ({ role: "toolResult", content: [{ type: "text", text: "ok" }] }) as unknown as SessionMessage;

test("getFinalAssistantText returns only the last assistant text block", () => {
  const messages = [assistantMsg("first"), toolResultMsg(), assistantMsg("second")];
  assert.equal(getFinalAssistantText(messages), "second");
});

test("getFinalAssistantText returns an empty string when there is no assistant message", () => {
  assert.equal(getFinalAssistantText([toolResultMsg()]), "");
});

test("getAllAssistantText concatenates all assistant text blocks in order, skipping tool results", () => {
  const messages = [assistantMsg("first"), toolResultMsg(), assistantMsg("second")];
  const all = getAllAssistantText(messages);
  assert.ok(all.includes("first"));
  assert.ok(all.includes("second"));
  assert.ok(all.indexOf("first") < all.indexOf("second"));
  assert.ok(!all.includes("ok"), "tool result text must not leak into assistant text");
});

test("getAllAssistantText skips blank assistant text blocks", () => {
  const messages = [assistantMsg("   "), assistantMsg("real content")];
  assert.equal(getAllAssistantText(messages), "real content");
});

// ── Self-recursion guard ───────────────────────────────────────────────────────────────

test("createIsolatedResourceLoader discovers no extensions, even where the unrestricted loader would", async () => {
  // A self-contained project-local extension (.pi/extensions/*.ts is a real
  // discovery convention) rather than relying on whatever happens to be
  // globally installed on the machine running this test.
  const cwd = await mkdtemp(join(tmpdir(), "persona-audit-ext-probe-"));
  try {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "fake-ext.ts"),
      'export default function (pi: { registerCommand: (name: string, def: unknown) => void }): void {\n  pi.registerCommand("fake-cmd", { description: "fake", handler: async () => {} });\n}\n',
      "utf-8",
    );
    const agentDir = getAgentDir();

    // Control: proves the fixture is discoverable at all, so a passing
    // isolated-loader assertion below means noExtensions actually suppressed
    // discovery — not that there was nothing to discover in the first place.
    const unrestricted = new DefaultResourceLoader({ cwd, agentDir });
    await unrestricted.reload();
    assert.ok(
      unrestricted.getExtensions().extensions.some((e) => e.path.endsWith("fake-ext.ts")),
      "expected the fixture extension to be discoverable for the control to be meaningful",
    );

    const isolated = createIsolatedResourceLoader(cwd, agentDir, "");
    await isolated.reload();
    assert.equal(isolated.getExtensions().extensions.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ── InteractiveAgentSession ──

test("createInteractiveAgentSession returns a session that can be aborted and disposed idempotently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "persona-audit-session-"));
  try {
    const registry = await testRegistry();
    const abort = new AbortController();
    const session = await createInteractiveAgentSession({
      cwd,
      modelRegistry: registry,
      model: "zzz-rt-test-provider/zzz-rt-test-alpha-4-5",
      systemPrompt: "sys",
      tools: [],
      agentName: "test agent",
      signal: abort.signal,
    });

    abort.abort();
    const result = await session.prompt("hello");
    assert.equal(result.aborted, true);

    session.dispose();
    session.dispose(); // Idempotent

    const postDispose = await session.prompt("hello again");
    assert.equal(postDispose.stopReason, "error");
    assert.equal(postDispose.errorMessage, "session is disposed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
