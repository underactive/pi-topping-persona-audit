import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { TIERS } from "../src/components/ReviewerData.ts";
import {
  DISPATCHER_AGENT_NAME,
  DISPATCHER_MAX,
  DISPATCHER_MIN,
  buildDispatcherSystemPrompt,
  buildDispatcherTask,
  fingerprintRepo,
  formatRecommendation,
  parseDispatcherOutput,
  recommendReviewers,
  renderFingerprint,
  type DispatcherDeps,
  type DispatcherOutcome,
  type DispatcherRecommendation,
  type RepoFingerprint,
} from "../src/dispatcher.ts";
import { AGENT_IDLE_TIMEOUT_MS, READ_ONLY_TOOLS } from "../src/orchestrator.ts";
import type { HeadlessOptions, HeadlessResult } from "../src/types.ts";

const CATALOGUE_NAMES = TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => reviewer.name));

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  dependencies: { express: "^4", passport: "^0.7", pg: "^8" },
  devDependencies: { vitest: "^2" },
});

const MANIFEST = [
  "src/index.ts",
  "src/server.ts",
  "src/auth/login.ts",
  "src/tenant/resolve.ts",
  "native/bridge.rs",
  "scripts/migrate.py",
  "README.md",
  "package.json",
  ".github/workflows/ci.yml",
];

/** readFile stub backed by an absolute-path map; missing paths reject like fs would. */
function fakeReadFile(files: Record<string, string>): NonNullable<DispatcherDeps["readFile"]> {
  return async (absPath) => {
    const content = files[absPath];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${absPath}`), { code: "ENOENT" });
    return content;
  };
}

/** Temp repo with the on-disk manifests the stat checks look for. */
async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pa-dispatcher-"));
  await writeFile(path.join(cwd, "package.json"), PACKAGE_JSON);
  await writeFile(path.join(cwd, "Dockerfile"), "FROM node:22\n");
  await mkdir(path.join(cwd, ".github/workflows"), { recursive: true });
  await writeFile(path.join(cwd, ".github/workflows/ci.yml"), "on: push\n");
  return cwd;
}

const okResult = (text: string): HeadlessResult => ({
  finalText: text,
  allText: text,
  aborted: false,
  stopReason: "stop",
  usage: { turns: 1, contextTokens: 100, outputTokens: 50 },
});

function expectOk(outcome: DispatcherOutcome): DispatcherRecommendation {
  if (!outcome.ok) assert.fail(`expected an ok outcome, got ${JSON.stringify(outcome)}`);
  return outcome.recommendation;
}

function pick(names: string[]): string {
  return JSON.stringify(names.map((reviewer) => ({ reviewer, reason: `${reviewer} fits.` })));
}

// ── fingerprintRepo ────────────────────────────────────────────────────────

test("fingerprintRepo maps extensions, root manifests, frameworks, and signals", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const readFile = fakeReadFile({ [path.join(cwd, "package.json")]: PACKAGE_JSON });

  const fp = await fingerprintRepo(cwd, MANIFEST, readFile);

  assert.deepEqual(fp.languages, [
    { language: "TypeScript", files: 4 },
    { language: "Config", files: 2 },
    { language: "Python", files: 1 },
    { language: "Rust", files: 1 },
  ]);
  assert.deepEqual(fp.manifests, [".github/workflows", "Dockerfile", "package.json"]);
  assert.deepEqual(fp.frameworks, ["express", "pg", "vitest"]);
  assert.deepEqual(fp.signals, ["auth", "ci", "containers", "database", "multi-tenant", "native", "tests"]);
  assert.deepEqual(fp.authEvidence, ["passport", "src/auth/login.ts", "src/tenant/resolve.ts"]);
  assert.deepEqual(fp.sampleFiles, [...MANIFEST].sort());
  assert.equal(fp.totalFiles, MANIFEST.length);
});

test("fingerprintRepo is deterministic when the manifest order changes", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const readFile = fakeReadFile({ [path.join(cwd, "package.json")]: PACKAGE_JSON });
  const reversed = [...MANIFEST].reverse();
  const rotated = [...reversed.slice(3), ...reversed.slice(0, 3)];

  const [a, b] = await Promise.all([fingerprintRepo(cwd, MANIFEST, readFile), fingerprintRepo(cwd, rotated, readFile)]);

  assert.deepEqual(a, b);
});

test("fingerprintRepo tolerates an unreadable package.json and still flags path-based signals", async (t) => {
  const cwd = await makeRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const fp = await fingerprintRepo(cwd, MANIFEST, fakeReadFile({}));

  assert.deepEqual(fp.frameworks, []);
  assert.deepEqual(fp.signals, ["auth", "ci", "containers", "multi-tenant", "native"]);
  assert.deepEqual(fp.authEvidence, ["src/auth/login.ts", "src/tenant/resolve.ts"]);
  assert.ok(fp.manifests.includes("package.json"), "existence comes from stat, not from readability");
});

test("fingerprintRepo parses Cargo.toml, go.mod, pyproject.toml, and requirements.txt", async () => {
  const cwd = path.join(tmpdir(), "pa-dispatcher-does-not-exist");
  const readFile = fakeReadFile({
    [path.join(cwd, "Cargo.toml")]: [
      "[package]",
      'name = "app"',
      "",
      "[dependencies]",
      'tokio = { version = "1", features = ["full"] }',
      'ring = "0.17"',
      "",
      "[dependencies.axum]",
      'version = "0.7"',
      "",
      "[dev-dependencies]",
      'criterion = "0.5"',
    ].join("\n"),
    [path.join(cwd, "go.mod")]: [
      "module example.com/app",
      "",
      "go 1.22",
      "",
      "require (",
      "\tgithub.com/gin-gonic/gin v1.9.1",
      "\tgorm.io/gorm v1.25.0 // indirect",
      ")",
      "",
      "require github.com/labstack/echo/v4 v4.11.0",
    ].join("\n"),
    [path.join(cwd, "requirements.txt")]: ["Django==4.2", "PyJWT>=2.8", "# a comment", "-r base.txt"].join("\n"),
    [path.join(cwd, "pyproject.toml")]: ["[project]", 'name = "app"', "dependencies = [", '  "fastapi>=0.100",', '  "sqlalchemy",', "]"].join("\n"),
  });

  const fp = await fingerprintRepo(cwd, ["src/main.rs", "cmd/app/main.go", "app/api.py"], readFile);

  assert.deepEqual(fp.manifests, [], "a missing cwd yields no manifests and no error");
  assert.deepEqual(fp.frameworks, ["axum", "django", "echo", "fastapi", "gin", "gorm", "ring", "sqlalchemy", "tokio"]);
  assert.deepEqual(fp.signals, ["auth", "crypto", "database", "native"]);
  assert.deepEqual(fp.authEvidence, ["pyjwt"]);
  assert.deepEqual(fp.languages, [
    { language: "Go", files: 1 },
    { language: "Python", files: 1 },
    { language: "Rust", files: 1 },
  ]);
});

test("fingerprintRepo caps auth evidence at ten sorted entries and sample files at two hundred", async () => {
  const cwd = path.join(tmpdir(), "pa-dispatcher-does-not-exist");
  const manifest = Array.from({ length: 250 }, (_, i) => `src/auth/handler${String(i).padStart(3, "0")}.ts`);

  const fp = await fingerprintRepo(cwd, manifest, fakeReadFile({}));

  assert.equal(fp.authEvidence.length, 10);
  assert.deepEqual(fp.authEvidence, [...manifest].sort().slice(0, 10));
  assert.equal(fp.sampleFiles.length, 200);
  assert.equal(fp.totalFiles, 250);
});

// ── Prompt rendering ───────────────────────────────────────────────────────

const EMPTY_FINGERPRINT: RepoFingerprint = {
  languages: [],
  manifests: [],
  frameworks: [],
  signals: [],
  authEvidence: [],
  sampleFiles: [],
  totalFiles: 0,
};

test("renderFingerprint prints every section, with a none marker for empty ones", () => {
  const text = renderFingerprint({
    ...EMPTY_FINGERPRINT,
    languages: [{ language: "TypeScript", files: 42 }, { language: "SQL", files: 1 }],
    signals: ["auth"],
  });

  for (const header of ["### Languages", "### Manifests", "### Frameworks", "### Signals", "### Auth evidence", "### Sample files"]) {
    assert.ok(text.includes(header), `missing ${header}`);
  }
  assert.match(text, /^- TypeScript: 42 files$/m);
  assert.match(text, /^- SQL: 1 file$/m);
  assert.match(text, /### Manifests\n- none/);
  assert.match(text, /### Signals\n- auth/);
});

test("buildDispatcherTask lists every catalogue name and tier label", () => {
  const task = buildDispatcherTask(EMPTY_FINGERPRINT, { mode: "full", scope: "whole tree", fileCount: 9 });

  assert.equal(CATALOGUE_NAMES.length, 53);
  for (const name of CATALOGUE_NAMES) assert.ok(task.includes(`- ${name}:`), `missing reviewer ${name}`);
  for (const tier of TIERS) assert.ok(task.includes(`### ${tier.label}`), `missing tier ${tier.label}`);
  assert.match(task, /^Audit mode: full$/m);
  assert.match(task, /^Scope: whole tree$/m);
  assert.match(task, /^Files in scope: 9$/m);
  assert.ok(task.includes("## Reviewer catalogue"));
  assert.ok(task.includes("(focus: Architecture & Design · Maintainability"));
  assert.match(task, /JSON array/);
});

test("buildDispatcherSystemPrompt states the role, the bounds, and the output contract", () => {
  const prompt = buildDispatcherSystemPrompt();

  assert.ok(prompt.startsWith("You are the dispatcher for a multi-persona code audit."));
  assert.ok(prompt.includes(`between ${DISPATCHER_MIN} and ${DISPATCHER_MAX}`));
  assert.ok(prompt.includes("at least one Holistic reviewer"));
  assert.ok(prompt.includes("ONLY a JSON array"));
});

// ── parseDispatcherOutput ──────────────────────────────────────────────────

test("parseDispatcherOutput accepts a clean array and keeps reasons", () => {
  const parsed = parseDispatcherOutput(pick(["Principal Engineer", "Security Engineer", "Kent Beck"]));

  assert.deepEqual(parsed, {
    entries: [
      { reviewer: "Principal Engineer", reason: "Principal Engineer fits." },
      { reviewer: "Security Engineer", reason: "Security Engineer fits." },
      { reviewer: "Kent Beck", reason: "Kent Beck fits." },
    ],
  });
});

test("parseDispatcherOutput salvages a fenced array", () => {
  const text = `Here is my pick:\n\`\`\`json\n${pick(["Principal Engineer", "Security Engineer", "Kent Beck"])}\n\`\`\``;

  const parsed = parseDispatcherOutput(text);

  assert.ok("entries" in parsed);
  assert.deepEqual(parsed.entries.map((entry) => entry.reviewer), ["Principal Engineer", "Security Engineer", "Kent Beck"]);
});

test("parseDispatcherOutput normalises case and whitespace, drops unknown names and duplicates", () => {
  const text = JSON.stringify([
    { reviewer: "principal   engineer", reason: "a" },
    { reviewer: "  SECURITY ENGINEER ", reason: "b" },
    { reviewer: "Nobody Special", reason: "c" },
    { reviewer: "Principal Engineer", reason: "dupe" },
    { reviewer: "Kent Beck" },
    { reviewer: 42 },
    "Rob Pike",
  ]);

  const parsed = parseDispatcherOutput(text);

  assert.deepEqual(parsed, {
    entries: [
      { reviewer: "Principal Engineer", reason: "a" },
      { reviewer: "Security Engineer", reason: "b" },
      { reviewer: "Kent Beck", reason: "" },
    ],
  });
});

test("parseDispatcherOutput caps at the maximum and rejects below the minimum", () => {
  const twelve = parseDispatcherOutput(pick(CATALOGUE_NAMES.slice(0, 12)));
  assert.ok("entries" in twelve);
  assert.equal(twelve.entries.length, DISPATCHER_MAX);
  assert.deepEqual(twelve.entries.map((entry) => entry.reviewer), CATALOGUE_NAMES.slice(0, 10));

  assert.deepEqual(parseDispatcherOutput(pick(["Principal Engineer", "Kent Beck"])), {
    error: "dispatcher returned 2 valid reviewers; need at least 3",
  });
  assert.deepEqual(parseDispatcherOutput("I could not decide."), { error: "no JSON array found in dispatcher output" });
});

test("formatRecommendation joins names and reasons on one line", () => {
  const text = formatRecommendation({
    entries: [
      { reviewer: "Principal Engineer", reason: "Owns the architecture view." },
      { reviewer: "Security Engineer", reason: "Auth paths present." },
      { reviewer: "Kent Beck", reason: "" },
    ],
    reviewers: ["Principal Engineer", "Security Engineer", "Kent Beck"],
    fingerprint: EMPTY_FINGERPRINT,
  });

  assert.equal(text, "Recommended 3 reviewers: Principal Engineer — Owns the architecture view.; Security Engineer — Auth paths present.; Kent Beck");
});

// ── recommendReviewers ─────────────────────────────────────────────────────

function harness(result: HeadlessResult) {
  const calls: HeadlessOptions[] = [];
  const controller = new AbortController();
  const deps: DispatcherDeps = {
    cwd: path.join(tmpdir(), "pa-dispatcher-does-not-exist"),
    modelRegistry: {} as ModelRegistry,
    model: "anthropic/claude-haiku-4-5",
    thinking: "low",
    signal: controller.signal,
    readFile: fakeReadFile({}),
    runSession: async (options) => {
      calls.push(options);
      return result;
    },
  };
  return { deps, calls, controller };
}

const INPUT = { fileManifest: MANIFEST, mode: "diff" as const, scope: "main..HEAD" };

test("recommendReviewers runs a read-only dispatcher session and returns the validated pick", async () => {
  const h = harness(okResult(JSON.stringify([
    { reviewer: "Principal Engineer", reason: "Owns the architecture view." },
    { reviewer: "security engineer", reason: "Auth paths present." },
    { reviewer: "Kent Beck", reason: "Small diff." },
  ])));

  const outcome = await recommendReviewers(h.deps, INPUT);

  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.ok(call);
  assert.equal(call.agentName, DISPATCHER_AGENT_NAME);
  assert.deepEqual(call.tools, READ_ONLY_TOOLS);
  assert.equal(call.model, "anthropic/claude-haiku-4-5");
  assert.equal(call.thinking, "low");
  assert.equal(call.signal, h.controller.signal);
  assert.equal(call.idleTimeoutMs, AGENT_IDLE_TIMEOUT_MS);
  assert.equal(call.cwd, h.deps.cwd);
  assert.equal(call.modelRegistry, h.deps.modelRegistry);
  assert.equal(call.systemPrompt, buildDispatcherSystemPrompt());
  assert.ok(call.task.includes("Reviewer catalogue"));
  assert.match(call.task, /^Audit mode: diff$/m);
  assert.match(call.task, /^Scope: main\.\.HEAD$/m);
  assert.match(call.task, /^Files in scope: 9$/m);
  assert.ok(call.task.includes("- src/auth/login.ts"), "the fingerprint's auth evidence reaches the task");

  const rec = expectOk(outcome);
  assert.deepEqual(rec.reviewers, ["Principal Engineer", "Security Engineer", "Kent Beck"]);
  assert.equal(rec.entries[1]?.reason, "Auth paths present.");
  assert.equal(rec.fingerprint.totalFiles, MANIFEST.length);
  assert.ok(rec.fingerprint.signals.includes("auth"));
});

test("recommendReviewers falls back to the full transcript when the final message is prose", async () => {
  const array = pick(["Principal Engineer", "Security Engineer", "Kent Beck"]);
  const h = harness({ ...okResult("Done."), allText: `Looking at the auth paths.\n${array}\nDone.` });

  const rec = expectOk(await recommendReviewers(h.deps, INPUT));

  assert.deepEqual(rec.reviewers, ["Principal Engineer", "Security Engineer", "Kent Beck"]);
});

test("recommendReviewers reports an aborted session", async () => {
  const h = harness({ ...okResult(""), aborted: true, stopReason: undefined });

  assert.deepEqual(await recommendReviewers(h.deps, INPUT), { ok: false, aborted: true, error: "aborted" });
});

test("recommendReviewers treats a tripped signal as an abort even when the session returned output", async () => {
  const h = harness(okResult(pick(["Principal Engineer", "Security Engineer", "Kent Beck"])));
  h.controller.abort();

  assert.deepEqual(await recommendReviewers(h.deps, INPUT), { ok: false, aborted: true, error: "aborted" });
});

test("recommendReviewers surfaces a session error", async () => {
  const h = harness({ ...okResult(""), stopReason: "error", errorMessage: "Rate limit exceeded" });

  assert.deepEqual(await recommendReviewers(h.deps, INPUT), { ok: false, aborted: false, error: "Rate limit exceeded" });
});

test("recommendReviewers fails on empty or unparsable output", async () => {
  assert.deepEqual(await recommendReviewers(harness(okResult("   \n")).deps, INPUT), { ok: false, aborted: false, error: "no output" });

  const unparsable = await recommendReviewers(harness(okResult("I could not decide.")).deps, INPUT);
  assert.deepEqual(unparsable, { ok: false, aborted: false, error: "no JSON array found in dispatcher output" });

  const tooFew = await recommendReviewers(harness(okResult(pick(["Principal Engineer", "Nobody"]))).deps, INPUT);
  assert.deepEqual(tooFew, { ok: false, aborted: false, error: "dispatcher returned 1 valid reviewers; need at least 3" });
});
