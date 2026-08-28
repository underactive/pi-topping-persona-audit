import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HANDOFF_RESUME_MARKER,
  HANDOFF_SCHEMA_VERSION,
  filterExistingFindings,
  parseHandoffPayload,
  renderHandoffResumeBlock,
  type HandoffPayload,
} from "../src/handoff.ts";
import { renderDeferredHandoff } from "../src/report.ts";
import type { Finding } from "../src/types.ts";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  reviewer: "Security Engineer",
  file: "src/a.ts",
  line: 12,
  category: "security",
  severity: "high",
  rationale: "unsanitized input reaches exec",
  suggestedChange: "escape the argument before interpolation",
  ...overrides,
});

const payload = (findings: Finding[], overrides: Partial<HandoffPayload> = {}): HandoffPayload => ({
  schemaVersion: HANDOFF_SCHEMA_VERSION,
  writtenAt: "2026-07-01T10:00:00Z",
  scope: ".",
  reviewers: ["Security Engineer", "Kent Beck"],
  headCommit: "a".repeat(40),
  findings,
  ...overrides,
});

// ── Round trip ─────────────────────────────────────────────────────────────

test("resume block round-trips losslessly through the rendered handoff", () => {
  const findings = [
    finding({ changeKind: "signature", recommendation: "defer", recommendationReason: "needs design review" }),
    finding({ file: "src/b.ts", line: -1, category: "bug", severity: "medium" }),
  ];
  const handoff = renderDeferredHandoff(
    {
      isoDate: "2026-07-01T10:00:00Z",
      scope: ".",
      reviewers: ["Security Engineer", "Kent Beck"],
      headCommit: "a".repeat(40),
    },
    findings,
  );

  const parsed = parseHandoffPayload(handoff);
  assert.equal(parsed.schemaVersion, HANDOFF_SCHEMA_VERSION);
  assert.equal(parsed.writtenAt, "2026-07-01T10:00:00Z");
  assert.equal(parsed.scope, ".");
  assert.deepEqual(parsed.reviewers, ["Security Engineer", "Kent Beck"]);
  assert.equal(parsed.headCommit, "a".repeat(40));
  assert.deepEqual(parsed.findings, findings);
});

test("derived blastRadius is omitted while reviewer changeKind survives", () => {
  const block = renderHandoffResumeBlock(payload([
    finding({
      changeKind: "behavior",
      blastRadius: { score: 75, level: "critical", reasons: ["imported by 20 modules"] },
    }),
  ]));
  const parsed = parseHandoffPayload(block);

  assert.equal(parsed.findings[0]?.changeKind, "behavior");
  assert.equal(parsed.findings[0]?.blastRadius, undefined);
  assert.doesNotMatch(block, /blastRadius/);
});

test("backtick runs inside suggestedChange survive the fence", () => {
  const findings = [
    finding({ suggestedChange: "use ``` fenced blocks ```` and `inline` code" }),
  ];
  const block = renderHandoffResumeBlock(payload(findings));
  const parsed = parseHandoffPayload(block);
  assert.deepEqual(parsed.findings, findings);
});

test("headCommit is omitted from the payload when absent", () => {
  const block = renderHandoffResumeBlock(payload([finding()], { headCommit: undefined }));
  const parsed = parseHandoffPayload(block);
  assert.equal(parsed.headCommit, undefined);
});

// ── Parse errors ───────────────────────────────────────────────────────────

test("a handoff without the resume marker fails with a clear error", () => {
  assert.throws(
    () => parseHandoffPayload("# Handoff: Deferred audit findings\n\nOld-format prose only.\n"),
    /no resume-data block.*older version/,
  );
});

test("a marker without a JSON fence fails", () => {
  assert.throws(
    () => parseHandoffPayload(`${HANDOFF_RESUME_MARKER}\n\nno fence here\n`),
    /no JSON fence/,
  );
});

test("malformed JSON inside the fence fails", () => {
  assert.throws(
    () => parseHandoffPayload(`${HANDOFF_RESUME_MARKER}\n\`\`\`json\n{not json\n\`\`\`\n`),
    /malformed JSON/,
  );
});

test("an unsupported schema version fails with a version error", () => {
  const json = JSON.stringify({ ...payload([finding()]), schemaVersion: 2 });
  assert.throws(
    () => parseHandoffPayload(`${HANDOFF_RESUME_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`),
    /unsupported schema version 2/,
  );
});

test("an empty findings array fails", () => {
  const json = JSON.stringify(payload([]));
  assert.throws(
    () => parseHandoffPayload(`${HANDOFF_RESUME_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`),
    /non-empty array/,
  );
});

test("a finding with an unknown category or severity fails validation", () => {
  const bad = (f: Record<string, unknown>): string =>
    `${HANDOFF_RESUME_MARKER}\n\`\`\`json\n${JSON.stringify(payload([f as unknown as Finding]))}\n\`\`\`\n`;
  assert.throws(() => parseHandoffPayload(bad({ ...finding(), category: "vibes" })), /unknown category/);
  assert.throws(() => parseHandoffPayload(bad({ ...finding(), severity: "meh" })), /unknown severity/);
  assert.throws(() => parseHandoffPayload(bad({ ...finding(), file: "" })), /missing a file/);
  assert.throws(() => parseHandoffPayload(bad({ ...finding(), line: "12" })), /non-numeric line/);
});

test("invalid recommendation and change-kind values are dropped rather than failing", () => {
  const raw = { ...finding(), changeKind: "wide-ranging", recommendation: "maybe", recommendationReason: 42 };
  const json = JSON.stringify(payload([raw as unknown as Finding]));
  const parsed = parseHandoffPayload(`${HANDOFF_RESUME_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`);
  assert.equal(parsed.findings[0]!.changeKind, undefined);
  assert.equal(parsed.findings[0]!.recommendation, undefined);
  assert.equal(parsed.findings[0]!.recommendationReason, undefined);
});

// ── Staleness filter ───────────────────────────────────────────────────────

test("filterExistingFindings splits kept and dropped by file existence", () => {
  const a = finding({ file: "src/a.ts" });
  const b = finding({ file: "src/gone.ts" });
  const c = finding({ file: "src/a.ts", line: 40 });
  const { kept, dropped } = filterExistingFindings([a, b, c], (file) => file === "src/a.ts");
  assert.deepEqual(kept, [a, c]);
  assert.deepEqual(dropped, [b]);
});
