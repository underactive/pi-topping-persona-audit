/** Deterministic audit state machine — runs reviewer/adjudicator/verifier agent sessions and writes the report. */

/**
 * Cancellation note: `ctx.signal` (the extension command context's signal)
 * is undefined while a command handler runs, so the audit carries its own
 * `input.signal` — an AbortController owned by the command handler in
 * index.ts and wired to a shortcut/command trigger — through every
 * long-running agent session and script call below. User cancellation is also
 * guaranteed at the TUI checkpoints (ExpertPicker / ReviewerRetry / FindingsReview);
 * note ReviewerRetry's own Esc skips failed passes rather than cancelling —
 * only its "Cancel audit" button cancels, and VerifierRetry cannot cancel at all
 * since fixes are already on disk by the time it appears. Completed reviewer batches are
 * durable via the partial report and the incremental cache.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { collectReviewerFindings } from "./findingsTransport.ts";
import { computeBlastRadius, hasCorrespondingTest, sensitivityTags } from "./blastRadius.ts";
import { isRecord, normalizeFindingText } from "./dedup.ts";
import { type AuditProgressWidget, formatTokens } from "./components/AuditProgress.ts";
import type { ReviewerFailurePrompt } from "./components/ReviewerRetry.ts";
import type { VerifierFailurePrompt, VerifierRetryDecision } from "./components/VerifierRetry.ts";
import {
  ADJUDICATOR_APPLY_DIRECTIVE,
  ADJUDICATOR_RECONCILE_DIRECTIVE,
  LINUS_TORVALDS,
  REGRESSION_TEST_DIRECTIVE,
  REVIEWER_OUTPUT_CONTRACT,
  REVOICE_DIRECTIVE,
  UNTRUSTED_DATA_RULE,
  VERIFIER_DIRECTIVE,
  VERIFY_REPAIR_DIRECTIVE,
  VERIFY_REPAIR_ESCALATION_ADDENDUM,
  getPersonality,
  registerEnforcement,
} from "./skillContent.ts";
import { runAgentSession } from "./agentRunner.ts";
import { describeAdditionalContext, formatAdditionalContextPrompt, type AdditionalContext } from "./additionalContext.ts";
import {
  type AgentConfig,
  discoverAgents,
  isFailedRun,
  isPermanentRunFailure,
  mapWithConcurrencyLimit,
} from "./subprocess.ts";
import {
  type CollectionDiagnostics,
  type ReportContext,
  makeSlug,
  partialReportRelPath,
  renderCollectionFailureReport,
  renderCompactReport,
  renderFullReport,
  renderPartialReport,
  reportRelPath,
  resolveSafeWritePath,
  writeReportFile,
} from "./report.ts";
import { aggregateVerificationStatus, discoverVerifyScripts, runVerifyScript } from "./verify.ts";
import {
  compareToSnapshots,
  lookupSelfReport,
  parseApplyReport,
  resolveTargetPath,
  snapshotFiles,
  verificationKey,
  type FileSnapshot,
} from "./snapshot.ts";
import {
  REGRESSION_LIMIT,
  applyRegressionEvidence,
  isSafeTestCommand,
  runRegressionHarness,
  selectRegressionCandidates,
  type RegressionPlan,
} from "./regression.ts";
import { DEFAULT_TEMPERAMENT, DEFAULT_VERIFY_ROUNDS, modelRefLabel, phaseModelChoiceLabel, type PhaseModelChoice, type PhaseSlot, type Temperament, type ThinkingLevel } from "./modelConfig.ts";
import { CATEGORY_PRIORITY, SEVERITY_ORDER } from "./types.ts";
import type {
  ApplyBatch,
  AuditMode,
  AuditStatus,
  AuditSummary,
  CollectReviewerFindingsResult,
  ContestedVerdict,
  FileChangeEvidence,
  Finding,
  FindingCategory,
  FindingRecommendation,
  FindingStatus,
  FindingsReviewResult,
  FixVerdict,
  FixVerification,
  HeadlessOptions,
  ReviewerOutput,
  ReviewerRunRecord,
  ReviewerSelection,
  ReviewSessionState,
  SelfReport,
  VerificationOutcome,
  VerificationRound,
} from "./types.ts";

const REVIEWER_CONCURRENCY = 5;
// Lower than the reviewer limit: these agents write to the tree, and each extra
// batch re-pays the system prompt and hygiene contract in tokens.
const APPLY_CONCURRENCY = 3;
const MAX_APPLY_EDITS = 40;
const REVIEWER_AGENT = "persona-audit-reviewer";
const ADJUDICATOR_AGENT = "persona-audit-adjudicator";
const VERIFIER_AGENT = "persona-audit-verifier";

const COLLECT_ROW = "triage:collect";
const REVOICE_ROW = "triage:revoice";
const RECONCILE_ROW = "triage:reconcile";

const reviewRowKey = (reviewer: string, pass: number): string => `review:${reviewer}:${pass}`;
const applyRowKey = (index: number): string => `implement:apply:${index}`;
const fixRowKey = (f: { file: string; line: number; category: string }): string =>
  `verify:fix:${f.file}:${f.line}:${f.category}`;
const regressRowKey = (f: { file: string; line: number; category: string }): string =>
  `verify:regress:${f.file}:${f.line}:${f.category}`;

const findingLabel = (f: { file: string; line: number }): string =>
  f.line > 0 ? `${f.file}:${f.line}` : f.file;

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EDIT_TOOLS = [...READ_ONLY_TOOLS, "bash", "edit", "write"];
const AGENT_IDLE_TIMEOUT_MS = 600_000;

/** Cap on retries prompted by unusable (low-match) verifier output, per round. */
const MAX_UNUSABLE_VERIFIER_RETRIES = 2;

const skippedVerification = (): VerificationOutcome => ({
  status: "skipped",
  fixes: [],
  regressions: [],
  scripts: [],
  notes: [],
  rounds: [],
  contested: [],
});

export interface AuditInput {
  scope: string;
  /** "diff" (git-based, requires a git repo) or "full" (whole-tree scan, no git required). */
  mode: AuditMode;
  baseCommit?: string;
  changedFiles: string[];
  importers: string[];
  blastFanIn?: ReadonlyMap<string, number>;
  fileManifest: string[];
  fileCount: number;
  /** True when a --full scan exceeded the file cap and was deterministically truncated. */
  truncated?: boolean;
  /** Total files found by a --full scan before truncation (only set when truncated). */
  totalFilesFound?: number;
  selection: ReviewerSelection;
  cacheKey?: string;
  /** Optional progress widget — row updates are no-ops when omitted. */
  progress?: AuditProgressWidget;
  /** Per-phase model + thinking overrides from the post-ExpertPicker picker, if confirmed. */
  phaseModels?: Partial<Record<PhaseSlot, PhaseModelChoice>>;
  /** Shared user guidance attached only to reviewer passes. */
  additionalContext?: AdditionalContext;
  /** Reviewer register from `/persona-audit-settings`; omitted means the default level. */
  temperament?: Temperament;
  /**
   * Total fix→verify rounds allowed (round 1 + up to N-1 gate repairs), from
   * `/persona-audit-settings`. Omitted (as in tests) uses DEFAULT_VERIFY_ROUNDS.
   */
  maxVerifyRounds?: number;
  /** Owned by the command handler (index.ts), not ctx.signal — see cancellation note above. */
  signal?: AbortSignal;
  /**
   * Resume from a deferred-findings handoff: skip reviewer passes, collection,
   * re-voice, and adjudication, and seed triage with these findings (already
   * validated, staleness-filtered, and status-normalized by the caller).
   */
  resume?: { handoffPath: string; findings: Finding[]; notes: string[] };
  /**
   * Checkpoint invoked once per round after a reviewer batch settles with
   * failures. Omitted (as in tests) means every failed pass is skipped, which
   * is how the audit behaved before the checkpoint existed.
   */
  onReviewFailures?: ReviewerFailurePrompt;
  onVerifierFailure?: VerifierFailurePrompt;
}

/** Resolve a phase's effective model/thinking: the picker's choice, or the agent's frontmatter model with no thinking override. */
function resolvePhaseModel(
  phaseModels: Partial<Record<PhaseSlot, PhaseModelChoice>> | undefined,
  slot: PhaseSlot,
  fallbackModel: string | undefined,
): { model: string | undefined; thinking: ThinkingLevel | undefined; label: string } {
  const choice = phaseModels?.[slot];
  if (!choice) return { model: fallbackModel, thinking: undefined, label: fallbackModel ?? "(session default)" };
  const label = modelRefLabel(choice.ref);
  return { model: label, thinking: choice.thinking, label: phaseModelChoiceLabel(choice) };
}

// ── Adjudicator annotation parsing (graceful fallback) ────────────────────

/**
 * Robustly extract a JSON array from LLM output: direct parse, fenced blocks,
 * bracket slice, then JSON-lines objects as a last resort.
 */
export function extractJsonArray(text: string): unknown[] | null {
  return extractJsonArrayCandidates(text)[0] ?? null;
}

/**
 * Every successful parse from the same text, in salvage-precedence order:
 * whole text, fenced blocks, bracket slice, then JSON-lines objects. A prose
 * final message can salvage a single stray object while the complete array
 * lives in another candidate, so callers that can score candidates should
 * inspect all of them rather than trusting the first.
 */
function extractJsonArrayCandidates(text: string): unknown[][] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push((match[1] ?? "").trim());
  }
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  const results: unknown[][] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) results.push(parsed);
    } catch {
      /* try next candidate */
    }
  }

  const objects: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith("{") && l.endsWith("}")) {
      try {
        objects.push(JSON.parse(l));
      } catch {
        /* skip malformed line */
      }
    }
  }
  if (objects.length > 0) results.push(objects);
  return results;
}

/**
 * Merge adjudicator recommendation annotations onto the deduped findings.
 * If the adjudicator output is unparsable, every finding defaults to "defer".
 * Otherwise, findings the adjudicator failed to annotate keep the original
 * finding (triage defaults them to "apply"). Degradation is reported.
 */
export function annotateFindings(
  base: Finding[],
  texts: string[],
): { findings: Finding[]; note?: string; matched: number } {
  const items = firstJsonArray(texts);

  if (!items || items.length === 0) {
    return {
      findings: base.map((f) => ({ ...f, recommendation: "defer" })),
      note: "adjudicator output was unparsable — all findings default to defer",
      matched: 0,
    };
  }

  const annotations = new Map<string, { rec: FindingRecommendation; reason?: string }>();
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const rec = normalizeFindingText(raw.recommendation).toLowerCase();
    if (rec !== "apply" && rec !== "reject" && rec !== "defer") continue;
    const file = normalizeFindingText(raw.file);
    const category = normalizeFindingText(raw.category).toLowerCase();
    if (!file || !category) continue;
    const lineNum = Number(raw.line);
    const key = `${file}\u0000${Number.isFinite(lineNum) ? lineNum : -1}\u0000${category}`;
    const reason = normalizeFindingText(raw.recommendationReason, 120) || undefined;
    annotations.set(key, { rec, reason });
  }

  let matched = 0;
  const findings = base.map((finding) => {
    const key = `${finding.file}\u0000${finding.line}\u0000${finding.category}`;
    const annotation = annotations.get(key);
    if (!annotation) return finding;
    matched++;
    const annotated: Finding = { ...finding, recommendation: annotation.rec };
    if (annotation.reason && annotation.rec !== "apply") {
      annotated.recommendationReason = annotation.reason;
    }
    return annotated;
  });

  const note =
    matched < base.length
      ? `adjudicator annotated ${matched}/${base.length} findings — the rest default to apply in triage`
      : undefined;
  return { findings, note, matched };
}

function firstJsonArray(texts: string[]): unknown[] | null {
  for (const text of texts) {
    if (!text.trim()) continue;
    const items = extractJsonArray(text);
    if (items && items.length > 0) return items;
  }
  return null;
}

/**
 * Pick the parse candidate that scores highest across all texts. Ties go to
 * the earliest candidate (final message first), preserving firstJsonArray's
 * behavior when scoring cannot separate them.
 */
function bestJsonArray(texts: string[], score: (items: unknown[]) => number): unknown[] | null {
  let best: unknown[] | null = null;
  let bestScore = -1;
  for (const text of texts) {
    if (!text.trim()) continue;
    for (const items of extractJsonArrayCandidates(text)) {
      if (items.length === 0) continue;
      const s = score(items);
      if (s > bestScore) {
        best = items;
        bestScore = s;
      }
    }
  }
  return best;
}

// ── Register re-voice (voice-only rewrite of hot-register findings) ──────

/**
 * Findings eligible for the register re-voice pass: only at a hot temperament,
 * and only findings carrying the configurable-register reviewer (including
 * dedup-merged findings, whose reviewer field is a comma-joined set).
 */
export function selectRevoiceTargets(
  findings: Finding[],
  temperament: Temperament | undefined,
): { index: number; finding: Finding }[] {
  if (!temperament || temperament === DEFAULT_TEMPERAMENT) return [];
  return findings
    .map((finding, index) => ({ index, finding }))
    .filter(({ finding }) => finding.reviewer.split(",").map((r) => r.trim()).includes(LINUS_TORVALDS));
}

/**
 * Merge re-voiced text onto the deduped findings, voice fields only.
 *
 * Everything except `rationale`/`suggestedChange` is structurally frozen: the
 * re-voice model's output is never allowed to touch file, line, category,
 * severity, or reviewer. Findings the model skipped — or answered with empty
 * or out-of-target indices — keep the reviewer's original text, and the
 * degradation is reported rather than failing the audit.
 */
export function applyRevoicedFindings(
  base: Finding[],
  targetIndices: number[],
  texts: string[],
): { findings: Finding[]; matched: number; note?: string } {
  const targets = new Set(targetIndices);
  const items = firstJsonArray(texts);
  if (!items || items.length === 0) {
    return {
      findings: base,
      matched: 0,
      note: "register re-voice output was unparsable — findings keep the reviewer's original text",
    };
  }

  const rewrites = new Map<number, { rationale: string; suggestedChange: string }>();
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const index = Number(raw.index);
    if (!Number.isInteger(index) || !targets.has(index)) continue;
    const rationale = normalizeFindingText(raw.rationale);
    const suggestedChange = normalizeFindingText(raw.suggestedChange, 2000);
    if (!rationale && !suggestedChange) continue;
    rewrites.set(index, { rationale, suggestedChange });
  }

  const findings = base.map((finding, index) => {
    const rewrite = rewrites.get(index);
    if (!rewrite) return finding;
    return {
      ...finding,
      rationale: rewrite.rationale || finding.rationale,
      suggestedChange: rewrite.suggestedChange || finding.suggestedChange,
    };
  });

  const matched = rewrites.size;
  const note =
    matched < targetIndices.length
      ? `register re-voice covered ${matched}/${targetIndices.length} findings — the rest keep the reviewer's original text`
      : undefined;
  return { findings, matched, note };
}

const VERDICTS = new Set<string>(["fixed", "partial", "not-fixed", "cannot-verify"]);

/**
 * Merge the verifier's per-finding verdicts onto the deterministic Layer-1 evidence.
 *
 * Layer 1 outranks the agent: a byte-identical file is proof the fix never
 * landed, so no claim from the verifier can promote it. Findings the agent
 * skipped, or that it could not read, settle at "cannot-verify" rather than
 * silently disappearing.
 */
export function parseFixVerdicts(
  accepted: Finding[],
  evidence: Map<string, FileChangeEvidence>,
  selfReports: Map<string, SelfReport>,
  texts: string[],
  cwd?: string,
): { verifications: FixVerification[]; note?: string; matched: number; judgeable: number } {
  // Verifiers are told to echo file/line/category verbatim, but models still
  // absolutize paths and "correct" line numbers to what the live (post-edit)
  // file shows. Claims are normalized and joined with a fallback so that
  // drift does not read as "no verdict".
  const cwdPrefix = cwd ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : undefined;
  const normalizeFile = (file: string): string => {
    let f = file;
    if (cwdPrefix && f.startsWith(cwdPrefix)) f = f.slice(cwdPrefix.length);
    while (f.startsWith("./")) f = f.slice(2);
    return f;
  };

  const pairKey = (file: string, category: string): string => `${file}\u0000${category.toLowerCase()}`;
  const pairCounts = new Map<string, number>();
  for (const f of accepted) {
    const k = pairKey(f.file, f.category);
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  }

  type Claim = { verdict: FixVerdict; evidence: string };
  const parseClaims = (items: unknown[]): { exact: Map<string, Claim>; byPair: Map<string, Claim> } => {
    const exact = new Map<string, Claim>();
    const byPair = new Map<string, Claim>();
    for (const raw of items) {
      if (!isRecord(raw)) continue;
      const verdict = normalizeFindingText(raw.verdict).toLowerCase();
      if (!VERDICTS.has(verdict)) continue;
      const file = normalizeFile(normalizeFindingText(raw.file));
      const category = normalizeFindingText(raw.category).toLowerCase();
      if (!file || !category) continue;
      const lineNum = Number(raw.line);
      const claim: Claim = {
        verdict: verdict as FixVerdict,
        evidence: normalizeFindingText(raw.evidence, 160),
      };
      exact.set(verificationKey(file, Number.isFinite(lineNum) ? lineNum : -1, category), claim);
      const pk = pairKey(file, category);
      if (!byPair.has(pk)) byPair.set(pk, claim);
    }
    return { exact, byPair };
  };

  const scoreItems = (items: unknown[]): number => {
    const { exact, byPair } = parseClaims(items);
    let score = 0;
    for (const f of accepted) {
      if (exact.has(verificationKey(f.file, f.line, f.category))) {
        score++;
      } else if (pairCounts.get(pairKey(f.file, f.category)) === 1 && byPair.has(pairKey(f.file, f.category))) {
        score++;
      }
    }
    return score;
  };

  const items = bestJsonArray(texts, scoreItems);
  const { exact: claims, byPair: fallbackClaims } = parseClaims(items ?? []);

  let matched = 0;
  const verifications = accepted.map((finding) => {
    const state = evidence.get(finding.file);
    const selfReport = lookupSelfReport(selfReports, finding);
    const base = {
      file: finding.file,
      line: finding.line,
      category: finding.category,
      changed: state?.state ?? "unreadable",
      selfReport,
    };
    if (!state || state.state === "unreadable") {
      return {
        ...base,
        verdict: "cannot-verify" as FixVerdict,
        evidence: state?.detail ?? "target file could not be read for comparison",
      };
    }
    if (state.state === "unchanged") {
      return {
        ...base,
        verdict: "not-fixed" as FixVerdict,
        evidence: "target file is byte-identical to the pre-fix snapshot",
      };
    }
    let claim = claims.get(verificationKey(finding.file, finding.line, finding.category));
    if (!claim) {
      // Line-blind fallback: only when this file+category pair maps to exactly
      // one accepted finding, so a drifted line number cannot cross-match two
      // findings in the same file. Consumed on use so it cannot double-serve.
      const pk = pairKey(finding.file, finding.category);
      if (pairCounts.get(pk) === 1) {
        claim = fallbackClaims.get(pk);
        if (claim) fallbackClaims.delete(pk);
      }
    }
    if (!claim) {
      return {
        ...base,
        verdict: "cannot-verify" as FixVerdict,
        evidence: "verifier produced no verdict for this finding",
      };
    }
    matched++;
    return { ...base, verdict: claim.verdict, evidence: claim.evidence || "no evidence given" };
  });

  const judgeable = verifications.filter((v) => v.changed !== "unchanged" && v.changed !== "unreadable").length;
  let note: string | undefined;
  if (!items && judgeable > 0) {
    note = "verifier output was unparsable — changed files could not be judged";
  } else if (matched < judgeable) {
    note = `verifier judged ${matched}/${judgeable} changed findings — the rest are cannot-verify`;
  }
  return { verifications, note, matched, judgeable };
}

/**
 * A completed verifier run whose claims join to fewer than half the judgeable
 * findings is treated like a failed run: the output exists but cannot be
 * trusted to represent a per-finding judgment.
 */
export function verifierOutputUnusable(matched: number, judgeable: number): boolean {
  return judgeable > 0 && matched < Math.ceil(judgeable / 2);
}

/**
 * Parse authored regression plans, dropping anything the harness must not run.
 *
 * A test written into a finding's own target file would be clobbered when the
 * harness reverts that file, so those plans are discarded rather than producing
 * a misleading result.
 */
export function parseRegressionPlans(
  candidates: Finding[],
  texts: string[],
  cwd?: string,
): { plans: RegressionPlan[]; note?: string } {
  const items = firstJsonArray(texts);
  if (!items) {
    return { plans: [], note: "regression test authoring produced no parsable plan" };
  }

  const byKey = new Map(candidates.map((f) => [verificationKey(f.file, f.line, f.category), f]));
  const targets = new Set(candidates.map((f) => path.posix.normalize(f.file)));
  const plans: RegressionPlan[] = [];
  const rejected: string[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const file = normalizeFindingText(raw.file);
    const category = normalizeFindingText(raw.category).toLowerCase();
    const lineNum = Number(raw.line);
    const candidate = byKey.get(verificationKey(file, Number.isFinite(lineNum) ? lineNum : -1, category));
    if (!candidate) continue;
    const testFile = normalizeFindingText(raw.testFile);
    const testCommand = normalizeFindingText(raw.testCommand, 300);
    if (!testFile || !testCommand) continue;
    if (cwd !== undefined && resolveTargetPath(cwd, testFile) === undefined) {
      rejected.push(`${candidate.file}:${candidate.line} (test file escapes the project root)`);
      continue;
    }
    if (targets.has(path.posix.normalize(testFile))) {
      rejected.push(`${candidate.file}:${candidate.line} (would be reverted with its own target file)`);
      continue;
    }
    if (!isSafeTestCommand(testCommand)) {
      rejected.push(`${candidate.file}:${candidate.line} (unsafe command)`);
      continue;
    }
    plans.push({
      file: candidate.file,
      line: candidate.line,
      category: candidate.category,
      testFile,
      testCommand,
    });
  }

  const note = rejected.length > 0 ? `rejected ${rejected.length} regression test plan(s): ${rejected.join("; ")}` : undefined;
  return { plans, note };
}

// ── Incremental cache ──────────────────────────────────────────────────────

interface ReviewerCache {
  cacheKey: string;
  outputs: ReviewerOutput[];
}

/** User-owned cache location, keyed by repo path + cacheKey — a repo-controlled `.pi/persona-audit/cache` file could otherwise smuggle in forged "clean" reviewer output. */
export function repoCacheDir(cwd: string, agentDir: string = getAgentDir()): string {
  const repoHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(agentDir, "persona-audit", "cache", repoHash);
}

function cacheFilePath(cwd: string, cacheKey: string): string {
  return path.join(repoCacheDir(cwd), `${cacheKey}.json`);
}

async function loadCache(cwd: string, cacheKey: string): Promise<ReviewerOutput[]> {
  try {
    const raw = await readFile(cacheFilePath(cwd, cacheKey), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReviewerCache>;
    if (parsed.cacheKey !== cacheKey || !Array.isArray(parsed.outputs)) return [];
    return parsed.outputs.filter(
      (output): output is ReviewerOutput =>
        isRecord(output) &&
        typeof output.reviewer === "string" &&
        Number.isFinite(Number(output.pass)) &&
        typeof output.output === "string",
    );
  } catch {
    return [];
  }
}

async function saveCache(cwd: string, cacheKey: string, outputs: ReviewerOutput[]): Promise<void> {
  try {
    const absPath = cacheFilePath(cwd, cacheKey);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, JSON.stringify({ cacheKey, outputs } satisfies ReviewerCache), "utf-8");
  } catch {
    /* cache write failures are non-fatal */
  }
}

// ── Prompt composition ─────────────────────────────────────────────────────

function buildReviewerSystemPrompt(agent: AgentConfig, reviewer: string, temperament?: Temperament): string {
  const personality = getPersonality(reviewer, temperament);
  if (!personality) {
    throw new Error(`Unknown reviewer personality: "${reviewer}"`);
  }
  return [
    "Obey the following persona and output contract exactly.",
    "",
    agent.systemPrompt.trim(),
    "",
    "## Your Reviewer Personality",
    "",
    personality,
  ].join("\n");
}

function scopeDescriptionLines(input: AuditInput, baseLabel: string): string[] {
  if (input.mode === "full") {
    const truncNote = input.truncated ? `, capped from ${input.totalFilesFound} found` : "";
    return [`- Scope: ${input.scope} (full-tree scan, no git) · Files: ${input.fileCount}${truncNote}`];
  }
  return [
    `- Scope: ${input.scope} (diff-based, base: ${baseLabel})`,
    `- Changed files: ${input.changedFiles.length} · Direct importers: ${input.importers.length}`,
  ];
}

export function buildReviewerTask(input: AuditInput, cwd: string, baseLabel: string, reviewer: string): string {
  const personality = getPersonality(reviewer, input.temperament);
  if (!personality) {
    throw new Error(`Unknown reviewer personality: "${reviewer}"`);
  }
  // At hot registers the persona's Output Style loses to a bridge backend's
  // ingrained professional voice when it rides mid-task, so the register is
  // restated as a binding contract clause after the output contract.
  const enforcement = registerEnforcement(reviewer, input.temperament);
  return [
    enforcement
      ? "You are performing one full review pass of the audit scope below, according to your reviewer personality. The personality's Output Style is a hard output requirement — the closing section enforces it; neutral prose is a contract violation."
      : "You are performing one full review pass of the audit scope below, according to your reviewer personality.",
    "",
    // Persona rides in the task as well as the system prompt: bridge providers
    // (e.g. claude-bridge) replace the session system prompt with their own
    // preset, silently dropping anything injected there.
    "## Your Reviewer Personality",
    "",
    personality,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Audit Scope",
    "",
    `- Working directory: ${cwd}`,
    ...scopeDescriptionLines(input, baseLabel),
    "",
    "Audit the following files (JSON array of relative paths):",
    "",
    JSON.stringify(input.fileManifest),
    ...(formatAdditionalContextPrompt(input.additionalContext)
      ? ["", formatAdditionalContextPrompt(input.additionalContext)!]
      : []),
    "",
    REVIEWER_OUTPUT_CONTRACT,
    ...(enforcement ? ["", enforcement] : []),
  ].join("\n");
}

function buildRevoiceTask(
  targets: { index: number; finding: Finding }[],
  temperament: Temperament,
): string {
  const personality = getPersonality(LINUS_TORVALDS, temperament);
  if (!personality) {
    throw new Error(`Unknown reviewer personality: "${LINUS_TORVALDS}"`);
  }
  return [
    REVOICE_DIRECTIVE,
    "",
    // Persona rides in the task as well as the system prompt for the same
    // reason as the reviewer pass: bridge providers replace the session
    // system prompt with their own preset.
    "## Reviewer Personality",
    "",
    personality,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Findings (JSON — file/line/category/severity are read-only context)",
    "",
    JSON.stringify(
      targets.map(({ index, finding }) => ({
        index,
        file: finding.file,
        line: finding.line,
        category: finding.category,
        severity: finding.severity,
        rationale: finding.rationale,
        suggestedChange: finding.suggestedChange,
      })),
    ),
  ].join("\n");
}

function buildReconcileTask(
  input: AuditInput,
  baseLabel: string,
  dedupedFindings: Finding[],
): string {
  return [
    ADJUDICATOR_RECONCILE_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Audit Scope",
    "",
    ...scopeDescriptionLines(input, baseLabel),
    `- Passes per reviewer: ${input.selection.passes}`,
    "",
    "## File Manifest",
    "",
    JSON.stringify(input.fileManifest),
    "",
    "## Deduplicated Findings (JSON)",
    "",
    JSON.stringify(dedupedFindings),
  ].join("\n");
}

function buildApplyTask(batch: ApplyBatch): string {
  return [
    ADJUDICATOR_APPLY_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Your Files",
    "",
    JSON.stringify(batch.files),
    "",
    "## Accepted Findings (JSON)",
    "",
    JSON.stringify(batch.findings),
  ].join("\n");
}

/**
 * Split triage's accepted findings by whether this run actually audited the file.
 *
 * The implement phase writes files, so a finding naming a path outside the
 * manifest must not reach it. The dropped set comes back rather than being
 * discarded in place: it has to reach the report, and the caller has to re-test
 * emptiness afterwards so a set that empties here lands on the none-accepted
 * path instead of an implement phase with nothing to do.
 */
export function scopeAcceptedFindings(
  accepted: Finding[],
  fileManifest: string[],
): { inScope: Finding[]; outOfScope: Finding[] } {
  const scope = new Set(fileManifest);
  const inScope: Finding[] = [];
  const outOfScope: Finding[] = [];
  for (const finding of accepted) {
    (scope.has(finding.file) ? inScope : outOfScope).push(finding);
  }
  return { inScope, outOfScope };
}

/**
 * Split accepted findings into the workloads for parallel implement agents.
 *
 * The cap the adjudicator used to self-enforce is applied here instead: once
 * findings are split across agents no single agent can see the global count, so
 * the ranking (category → severity, the reconciliation order)
 * has to happen before distribution. Whatever falls past the cap comes back as
 * `overflow` so the report can account for it rather than dropping it silently.
 */
export function partitionApplyBatches(
  accepted: Finding[],
): { batches: ApplyBatch[]; overflow: Finding[] } {
  const ranked = [...accepted].sort(
    (a, b) =>
      CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const byFile = new Map<string, Finding[]>();
  for (const finding of ranked.slice(0, MAX_APPLY_EDITS)) {
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else byFile.set(finding.file, [finding]);
  }

  // Heaviest file first, then into the lightest batch: keeps agents balanced
  // when one file carries most of the findings.
  const groups = [...byFile.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const batches: ApplyBatch[] = Array.from(
    { length: Math.min(Math.max(1, APPLY_CONCURRENCY), groups.length) },
    (_, index) => ({ index, files: [], findings: [] }),
  );
  for (const [file, findings] of groups) {
    const target = batches.reduce((lightest, batch) =>
      batch.findings.length < lightest.findings.length ? batch : lightest,
    );
    target.files.push(file);
    target.findings.push(...findings);
  }
  for (const batch of batches) {
    batch.files.sort();
    batch.findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  return { batches, overflow: ranked.slice(MAX_APPLY_EDITS) };
}

const applyBatchLabel = (batch: ApplyBatch): string =>
  batch.files.length === 1
    ? `apply · ${batch.files[0]}`
    : `apply · ${batch.files[0]} +${batch.files.length - 1}`;

const deferralBullet = (finding: Finding, reason: string): string =>
  `- ${findingLabel(finding)} [${finding.severity}] — ${finding.category}: ${reason}`;

/**
 * Fold the parallel agents' reports into the single document the verifier and
 * the self-report parser already expect. Findings no agent got to — a failed
 * batch, or the overflow past the cap — are written in as explicit deferrals so
 * they are not read as "unreported".
 */
function mergeApplyReports(
  runs: { batch: ApplyBatch; text: string; failureReason?: string }[],
  overflow: Finding[],
): string {
  const sections = runs.map(({ batch, text, failureReason }) => {
    const heading = `## Implement batch ${batch.index + 1} — ${batch.files.join(", ")}`;
    if (failureReason === undefined) return `${heading}\n\n${text}`;
    return [
      heading,
      "",
      `Batch failed: ${failureReason}`,
      "",
      "### Fixes Deferred",
      ...batch.findings.map((f) => deferralBullet(f, `implement agent failed — ${failureReason}`)),
    ].join("\n");
  });

  if (overflow.length > 0) {
    sections.push(
      [
        `## Over the ${MAX_APPLY_EDITS}-fix cap`,
        "",
        "### Fixes Deferred",
        ...overflow.map((f) => deferralBullet(f, `exceeded the ${MAX_APPLY_EDITS}-fix per-run cap`)),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * Hand the verifier snapshot paths rather than diffs: the prompt then scales
 * with the number of findings instead of the size of the change, and the agent
 * picks its own diff granularity.
 */
function buildVerifierTask(
  cwd: string,
  accepted: Finding[],
  evidence: Map<string, FileChangeEvidence>,
  selfReports: Map<string, SelfReport>,
  applyReport: string,
  fileManifest: string[],
): string {
  const findings = accepted.map((finding) => {
    const state = evidence.get(finding.file);
    return {
      ...finding,
      fileChanged: state?.state ?? "unreadable",
      snapshotPath: state?.snapshotPath ?? null,
      livePath: finding.file,
      selfReport: lookupSelfReport(selfReports, finding),
    };
  });
  return [
    VERIFIER_DIRECTIVE,
    "",
    "## Context",
    "",
    `- Working directory: ${cwd}`,
    "",
    "## Findings To Verify (JSON)",
    "",
    JSON.stringify(findings),
    "",
    "## Implement Agent Report (untrusted — the agent's own claims about its work)",
    "",
    applyReport.trim() || "_No apply report produced._",
    "",
    "## File Manifest",
    "",
    JSON.stringify(fileManifest),
  ].join("\n");
}

function buildRegressionTask(cwd: string, candidates: Finding[], fixes: FixVerification[]): string {
  const byKey = new Map(fixes.map((f) => [verificationKey(f.file, f.line, f.category), f]));
  const findings = candidates.map((finding) => {
    const fix = byKey.get(verificationKey(finding.file, finding.line, finding.category));
    return { ...finding, verdict: fix?.verdict ?? "cannot-verify", verdictEvidence: fix?.evidence ?? "" };
  });
  return [
    REGRESSION_TEST_DIRECTIVE,
    "",
    "## Context",
    "",
    `- Working directory: ${cwd}`,
    "",
    "## Findings (JSON)",
    "",
    JSON.stringify(findings),
  ].join("\n");
}

/**
 * Whether a fix verdict is something a repair round can act on: a fix that did
 * not land or only partly landed, or a cannot-verify the verifier could still
 * read (an unreadable file is not something a repair can fix). Shared by
 * buildRepairTask and actionableFingerprint so the set handed to the repair
 * agent and the set the stagnation check fingerprints can never drift.
 */
const isRepairableVerdict = (v: FixVerification): boolean =>
  v.verdict === "not-fixed" ||
  v.verdict === "partial" ||
  (v.verdict === "cannot-verify" && v.changed !== "unreadable");

/**
 * Collect a verification round's actionable failures — not-fixed/partial
 * verdicts, judgeable cannot-verify, non-discriminating regressions, and
 * failed scripts — into one repair task. Findings already fixed ride along as
 * read-only context so the repair agent does not re-touch them.
 *
 * Returns an empty task when nothing is actionable (a stop condition for the
 * repair loop, not an error): a script can fail for reasons no fix touches,
 * and cannot-verify on an unreadable file is not something a repair can fix.
 *
 * `opts.priorRounds` makes the retry informed rather than blind: each failing
 * finding carries its verdict history and each prior repair's report rides
 * along, so the agent can see what was already tried and why it failed.
 * `opts.escalated` appends the root-cause addendum for a repair that follows a
 * recurred failure set.
 */
export function buildRepairTask(
  cwd: string,
  round: VerificationRound,
  accepted: Finding[],
  fileManifest: string[],
  opts?: {
    priorRounds?: VerificationRound[];
    escalated?: boolean;
    snapshots?: Map<string, FileSnapshot>;
  },
): { task: string; targetCount: number } {
  const byKey = new Map(accepted.map((f) => [verificationKey(f.file, f.line, f.category), f]));
  const actionable = round.fixVerdicts.filter(isRepairableVerdict);
  const passing = round.fixVerdicts.filter((v) => v.verdict === "fixed");
  const badRegressions = round.regressions.filter((r) => !r.proven);
  const failedScripts = round.scripts.filter((s) => s.status === "fail");

  if (actionable.length === 0 && badRegressions.length === 0 && failedScripts.length === 0) {
    return { task: "", targetCount: 0 };
  }

  const priorRounds = opts?.priorRounds ?? [];
  const failingFindings = actionable.map((v) => {
    const key = verificationKey(v.file, v.line, v.category);
    const finding = byKey.get(key);
    const history = priorRounds.flatMap((prior) =>
      prior.fixVerdicts
        .filter((pv) => verificationKey(pv.file, pv.line, pv.category) === key)
        .map((pv) => ({ round: prior.round, verdict: pv.verdict, evidence: pv.evidence })),
    );
    const recurring = priorRounds.some((prior) =>
      prior.fixVerdicts.some(
        (pv) => isRepairableVerdict(pv) && verificationKey(pv.file, pv.line, pv.category) === key,
      ),
    );
    return {
      file: v.file,
      line: v.line,
      category: v.category,
      severity: finding?.severity ?? "medium",
      rationale: finding?.rationale ?? "",
      suggestedChange: finding?.suggestedChange ?? "",
      verdict: v.verdict,
      evidence: v.evidence,
      snapshotPath: opts?.snapshots?.get(v.file)?.snapshotPath ?? null,
      livePath: v.file,
      ...(history.length > 0 ? { history } : {}),
      ...(recurring ? { recurring: true } : {}),
    };
  });
  const passingFindings = passing.map((v) => ({ file: v.file, line: v.line, category: v.category }));
  const regressionFailures = badRegressions.map((r) => ({
    file: r.file,
    line: r.line,
    category: r.category,
    testFile: r.testFile,
    testCommand: r.testCommand,
    outcome: r.outcome,
    detail: r.detail,
  }));
  const scriptFailures = failedScripts.map((s) => ({
    script: s.script,
    command: s.command,
    exitCode: s.exitCode,
    output: s.relevantOutput,
  }));

  const priorRepairs = priorRounds
    .filter((prior) => prior.repairOutcome !== undefined)
    .map((prior) => ({
      afterRound: prior.round,
      escalated: prior.repairEscalated === true,
      report: clampRepairReport(prior.repairOutcome ?? ""),
    }));

  const task = [
    opts?.escalated ? `${VERIFY_REPAIR_DIRECTIVE}\n\n${VERIFY_REPAIR_ESCALATION_ADDENDUM}` : VERIFY_REPAIR_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Context",
    "",
    `- Working directory: ${cwd}`,
    "",
    "## Failures To Repair (JSON)",
    "",
    JSON.stringify(failingFindings),
    "",
    ...(priorRepairs.length > 0
      ? ["## Previous Repair Attempts (JSON)", "", JSON.stringify(priorRepairs), ""]
      : []),
    "## Already-Fixed Findings — read-only context, do not touch (JSON)",
    "",
    JSON.stringify(passingFindings),
    "",
    "## Non-Discriminating Regression Tests (JSON)",
    "",
    JSON.stringify(regressionFailures),
    "",
    "## Failed Verification Scripts (JSON)",
    "",
    JSON.stringify(scriptFailures),
    "",
    "## File Manifest",
    "",
    JSON.stringify(fileManifest),
  ].join("\n");

  return { task, targetCount: actionable.length + regressionFailures.length + scriptFailures.length };
}

/** Prior repair reports are agent output and can be huge; the history only needs the gist. */
const MAX_REPAIR_REPORT_CHARS = 4_000;
function clampRepairReport(report: string): string {
  if (report.length <= MAX_REPAIR_REPORT_CHARS) return report;
  return `${report.slice(0, MAX_REPAIR_REPORT_CHARS)}… [truncated]`;
}

/**
 * Parse the optional "### Contested Verdicts" section of a repair report: the
 * repair agent's evidence-backed claim that a verifier verdict is wrong.
 * Surface-only — entries are validated against the accepted findings and
 * rendered for human adjudication, never used to change verification status.
 */
export function parseContestedVerdicts(
  accepted: Finding[],
  texts: string[],
  round: number,
): ContestedVerdict[] {
  const byKey = new Map(accepted.map((f) => [verificationKey(f.file, f.line, f.category), f]));
  for (const text of texts) {
    const match = /^#{2,4}\s*Contested Verdicts.*$/im.exec(text);
    if (!match) continue;
    const entries = extractJsonArray(text.slice(match.index + match[0].length));
    if (!entries) continue;
    const contested: ContestedVerdict[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const { file, line, category } = entry;
      if (typeof file !== "string" || typeof line !== "number" || typeof category !== "string") continue;
      const finding = byKey.get(verificationKey(file, line, category));
      const reason = normalizeFindingText(entry.reason, 500);
      if (!finding || !reason) continue;
      contested.push({ file: finding.file, line: finding.line, category: finding.category, reason, round });
    }
    return contested;
  }
  return [];
}

/**
 * Track how often a failure set has been seen across verification rounds and
 * decide the repair loop's next move: a first sighting is normal progress, a
 * second escalates the next repair to root-cause mode, and a third means even
 * the escalated repair changed nothing — stop rather than burn budget.
 */
export function recordFingerprint(
  counts: Map<string, number>,
  fingerprint: string,
): "new" | "recurred" | "exhausted" {
  const count = (counts.get(fingerprint) ?? 0) + 1;
  counts.set(fingerprint, count);
  return count === 1 ? "new" : count === 2 ? "recurred" : "exhausted";
}

/**
 * A canonical fingerprint of a round's actionable failure set — the same three
 * groups buildRepairTask hands the repair agent. Order-independent (sorted), so
 * a reordered-but-identical failure set matches. Each fix carries its verdict
 * and each regression its outcome, so a failure that improves (not-fixed →
 * partial) fingerprints differently and reads as progress, not stagnation.
 *
 * The empty string means nothing is actionable — which is exactly when
 * buildRepairTask returns targetCount 0, so an empty fingerprint is already
 * handled by that break and never reaches the stagnation check.
 */
export function actionableFingerprint(round: VerificationRound): string {
  const tokens = [
    ...round.fixVerdicts
      .filter(isRepairableVerdict)
      .map((v) => `fix:${verificationKey(v.file, v.line, v.category)}:${v.verdict}`),
    ...round.regressions
      .filter((r) => !r.proven)
      .map((r) => `regress:${verificationKey(r.file, r.line, r.category)}:${r.outcome}`),
    ...round.scripts.filter((s) => s.status === "fail").map((s) => `script:${s.script}`),
  ];
  return tokens.sort().join("|");
}

// ── Audit driver ───────────────────────────────────────────────────────────

export async function runAudit(ctx: ExtensionCommandContext, input: AuditInput): Promise<AuditSummary> {
  const runStartedAt = Date.now();
  const { slug, iso } = makeSlug();
  const baseLabel = input.baseCommit || "merge-base with main";
  const selection: ReviewerSelection = input.selection;

  const reportCtx: ReportContext = {
    slug,
    isoDate: iso,
    scope: input.scope,
    mode: input.mode,
    baseLabel,
    changedCount: input.changedFiles.length,
    importerCount: input.importers.length,
    fileCount: input.fileCount,
    truncated: input.truncated,
    totalFilesFound: input.totalFilesFound,
    reviewers: selection.reviewers,
    passes: selection.passes,
    cacheHits: 0,
    freshRuns: 0,
    ...(input.additionalContext ? { additionalContext: describeAdditionalContext(input.additionalContext) } : {}),
  };
  if (input.resume) {
    reportCtx.handoffSource = input.resume.handoffPath;
    if (input.resume.notes.length > 0) reportCtx.resumeNotes = input.resume.notes;
  }

  const runRecords: ReviewerRunRecord[] = [];
  const diagnostics: CollectionDiagnostics = { failedRuns: [] };
  let collection: CollectReviewerFindingsResult | undefined;
  let partialWritten = false;

  const progress = input.progress;

  /** Stamp the run's wall-clock duration into the context. Call at every report render site. */
  const report = (): ReportContext => {
    reportCtx.totalMs = Date.now() - runStartedAt;
    return reportCtx;
  };

  /** One-time notification for important phase transitions. */
  const notifyPhase = (message: string): void => {
    ctx.ui.notify(`persona-audit: ${message}`, "info");
  };

  const runSummary: {
    reviewDone: number;
    reviewTotal: number;
    findings?: number;
    accepted?: number;
    fixesLanded?: number;
    fixesTotal?: number;
    verifyDone: number;
    verifyTotal: number;
    note?: string;
  } = { reviewDone: 0, reviewTotal: 0, verifyDone: 0, verifyTotal: 0 };

  /** Recompute the one-line run summary rendered in the widget footer. */
  const refreshSummary = (): void => {
    if (!progress) return;
    const parts = [`${runSummary.reviewDone}/${runSummary.reviewTotal} reviewer passes`];
    if (runSummary.findings !== undefined) parts.push(`${runSummary.findings} findings`);
    if (runSummary.accepted !== undefined) parts.push(`${runSummary.accepted} accepted`);
    if (runSummary.fixesTotal !== undefined) {
      parts.push(`fixes ${runSummary.fixesLanded ?? 0}/${runSummary.fixesTotal} landed`);
    }
    if (runSummary.verifyTotal > 0) parts.push(`verify ${runSummary.verifyDone}/${runSummary.verifyTotal}`);
    if (runSummary.note) parts.push(runSummary.note);
    progress.setSummary(parts.join(" · "));
  };

  const writePartial = async (
    status: "partial" | "cancelled" | "failed" | "superseded",
    note?: string,
  ): Promise<string> => {
    const relPath = partialReportRelPath(slug);
    const absPath = await resolveSafeWritePath(ctx.cwd, relPath);
    diagnostics.collection = collection;
    diagnostics.failedRuns = runRecords.filter((run) => run.status === "failed");
    const content = renderPartialReport(report(), { status, runRecords, diagnostics, note });
    await withFileMutationQueue(absPath, async () => {
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
    });
    partialWritten = true;
    return relPath;
  };

  const supersedePartial = async (): Promise<void> => {
    if (!partialWritten) return;
    try {
      await writePartial("superseded");
    } catch {
      /* cleanup must not fail the run */
    }
  };

  const makeSummary = (
    status: AuditStatus,
    reportPath: string,
    counts: { findings?: number; accepted?: number; rejected?: number; deferred?: number; fixed?: number },
    verification: VerificationOutcome,
    failureNote?: string,
    implementFailedNote?: string,
    handoffPath?: string,
  ): AuditSummary => ({
    status,
    scope: input.scope,
    fileCount: input.fileCount,
    totalMs: Date.now() - runStartedAt,
    reviewers: selection.reviewers,
    passes: selection.passes,
    findingsCount: counts.findings ?? 0,
    acceptedCount: counts.accepted ?? 0,
    fixedCount: counts.fixed ?? 0,
    rejectedCount: counts.rejected ?? 0,
    deferredCount: counts.deferred ?? 0,
    verification: verification.status,
    verifyResults: verification.scripts,
    fixVerifications: verification.fixes,
    regressions: verification.regressions,
    verificationNotes: verification.notes,
    verificationRounds: verification.rounds,
    reportPath,
    expectedRuns: collection?.expectedRuns ?? selection.reviewers.length * selection.passes,
    receivedRuns: collection?.receivedRuns ?? 0,
    malformedCount: collection?.malformed.length ?? 0,
    missingCount: collection?.missingRuns.length ?? 0,
    cacheHits: reportCtx.cacheHits,
    freshRuns: reportCtx.freshRuns,
    failureNote,
    implementFailedNote,
    annotationNote: diagnostics.annotationNote,
    revoiceNote: diagnostics.revoiceNote,
    handoffPath,
  });

  try {
    // ── Agent discovery (frontmatter = source of truth for tools/model) ──
    const agents = discoverAgents(ctx.cwd);
    const reviewerAgent = agents.find((a) => a.name === REVIEWER_AGENT);
    const adjudicatorAgent = agents.find((a) => a.name === ADJUDICATOR_AGENT);
    const verifierAgent = agents.find((a) => a.name === VERIFIER_AGENT);
    if (!reviewerAgent || !adjudicatorAgent || !verifierAgent) {
      const available = agents.map((a) => a.name).join(", ") || "none";
      throw new Error(
        `Required agents not found (need "${REVIEWER_AGENT}", "${ADJUDICATOR_AGENT}" and "${VERIFIER_AGENT}"; available: ${available})`,
      );
    }
    // Validate personalities up front so we fail before spawning anything.
    // Skipped on resume: handoff reviewer names are historical labels, not
    // personalities to spawn.
    if (!input.resume) {
      for (const reviewer of selection.reviewers) {
        buildReviewerSystemPrompt(reviewerAgent, reviewer, input.temperament);
      }
    }

    // Resolve each phase's effective model/thinking: the post-ExpertPicker
    // picker's choice, falling back to the agent's frontmatter model.
    // Reassigned at the reviewer-failure checkpoint, where a model swap applies
    // to every later retry round.
    let reviewModel = resolvePhaseModel(input.phaseModels, "review", reviewerAgent.model);
    let reviewChoice = input.phaseModels?.review;
    const triageModel = resolvePhaseModel(input.phaseModels, "triage", adjudicatorAgent.model);
    const implementModel = resolvePhaseModel(input.phaseModels, "implement", adjudicatorAgent.model);
    // Reassigned only at the verifier-failure checkpoint, where a model swap
    // applies to the rest of the Verify phase.
    let verifyModel = resolvePhaseModel(input.phaseModels, "verify", verifierAgent.model);
    let verifyChoice = input.phaseModels?.verify;
    reportCtx.phaseModels = {
      ...(input.resume ? {} : { Review: reviewModel.label }),
      Triage: triageModel.label,
      Implement: implementModel.label,
      Verify: verifyModel.label,
    };
    progress?.setPhaseModels({
      ...(input.resume ? {} : { Review: reviewModel.model }),
      Triage: triageModel.model,
      Implement: implementModel.model,
      Verify: verifyModel.model,
    });

    // ── Step b: reviewer passes (cache-aware, concurrency-limited) ──────
    const cachedOutputs = input.cacheKey ? await loadCache(ctx.cwd, input.cacheKey) : [];
    const cachedByKey = new Map(cachedOutputs.map((o) => [`${o.reviewer}\u0000${o.pass}`, o]));

    const pendingTasks: { reviewer: string; pass: number }[] = [];
    let cachedRuns = 0;
    for (const reviewer of selection.reviewers) {
      for (let pass = 1; pass <= selection.passes; pass++) {
        // Every pass gets its row up front, so the table shows the full plan of
        // work (and which parts the cache already covers) before anything spawns.
        const rowLabel = selection.passes > 1 ? `${reviewer} #${pass}` : reviewer;
        const cached = cachedByKey.get(`${reviewer}\u0000${pass}`);
        if (cached) {
          cachedRuns++;
          runRecords.push({
            reviewer,
            pass,
            status: "cached",
            outputChars: cached.output.length,
          });
          progress?.addRow("Review", reviewRowKey(reviewer, pass), rowLabel, {
            state: "done",
            statusText: "cached",
          });
        } else {
          pendingTasks.push({ reviewer, pass });
          runRecords.push({ reviewer, pass, status: "pending", outputChars: 0 });
          progress?.addRow("Review", reviewRowKey(reviewer, pass), rowLabel);
        }
      }
    }
    reportCtx.cacheHits = cachedOutputs.length;
    reportCtx.freshRuns = pendingTasks.length;
    runSummary.reviewTotal = cachedRuns + pendingTasks.length;
    runSummary.reviewDone = cachedRuns;
    refreshSummary();
    if (!input.resume) progress?.setActivePhase("Review");

    const freshOutputs: ReviewerOutput[] = [];
    // Passes re-run on a model other than the one the cache key was built from.
    // Caching them would let a later run serve one model's review under another
    // model's key, so they reach the report but never the cache.
    const uncacheable = new Set<string>();

    const runRecordByKey = new Map(
      runRecords.map((record): [string, ReviewerRunRecord] => [`${record.reviewer}\u0000${record.pass}`, record]),
    );

    const runReviewerBatch = async (
      tasks: { reviewer: string; pass: number }[],
      model: { model: string | undefined; thinking: ThinkingLevel | undefined },
      isRetry: boolean,
    ): Promise<void> => {
      notifyPhase(
        `${isRetry ? "retrying" : "launching"} ${tasks.length} reviewer ${tasks.length === 1 ? "pass" : "passes"}…`,
      );
      await writePartial("partial");

      await mapWithConcurrencyLimit(tasks, REVIEWER_CONCURRENCY, async (task) => {
        const record = runRecordByKey.get(`${task.reviewer}\u0000${task.pass}`);
        // The row leaves "queued" only once a concurrency slot frees up, so the
        // table distinguishes waiting passes from running ones.
        const rowKey = reviewRowKey(task.reviewer, task.pass);
        progress?.startRow(rowKey, isRetry ? "retrying…" : "reviewing…");
        const result = await runAgentSession({
          agentName: `${task.reviewer} pass ${task.pass}`,
          systemPrompt: buildReviewerSystemPrompt(reviewerAgent, task.reviewer, input.temperament),
          tools: READ_ONLY_TOOLS,
          model: model.model,
          thinking: model.thinking,
          task: buildReviewerTask(input, ctx.cwd, baseLabel, task.reviewer),
          images: input.additionalContext?.images,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          signal: input.signal,
          idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
          onProgress: (snapshot) => progress?.applyProgress(rowKey, snapshot),
        });

        if (isFailedRun(result) || !result.allText.trim()) {
          const detail = result.errorMessage || (result.aborted ? "aborted" : result.stopReason) || "no output";
          if (record) {
            record.status = "failed";
            record.detail = detail;
          }
          progress?.settleRow(rowKey, result.aborted ? "cancelled" : "error", detail);
        } else {
          if (record) {
            record.status = "completed";
            record.outputChars = result.allText.length;
            record.detail = isRetry ? `succeeded on retry (${model.model ?? "session default"})` : undefined;
          }
          freshOutputs.push({ reviewer: task.reviewer, pass: task.pass, output: result.allText });
          progress?.settleRow(rowKey, "done", `${formatTokens(result.usage.outputTokens)} tokens${isRetry ? " · retried" : ""}`);
        }
        // A retry re-runs a pass already counted as attempted, so it must not
        // advance the attempted/total tally in the footer.
        if (!isRetry) runSummary.reviewDone++;
        refreshSummary();
        // Durable progress after every completed pass.
        await writePartial("partial");
      });
    };

    if (pendingTasks.length > 0) {
      await runReviewerBatch(pendingTasks, reviewModel, false);
    }

    if (input.signal?.aborted) {
      const relPath = await writePartial("cancelled", "Run aborted while reviewer passes were in flight.");
      progress?.settleOpenRows("cancelled", "aborted");
      return makeSummary("cancelled", relPath, {}, skippedVerification());
    }

    // ── Reviewer-failure checkpoint: retry, re-model, or skip ───────────
    // Prompting here rather than inside the batch keeps a human out of the
    // concurrency loop and folds simultaneous failures into one decision.
    while (input.onReviewFailures && !input.signal?.aborted) {
      const failed = runRecords.filter((run) => run.status === "failed");
      if (failed.length === 0) break;

      const decision = await input.onReviewFailures(
        failed.map((run) => ({
          reviewer: run.reviewer,
          pass: run.pass,
          label: selection.passes > 1 ? `${run.reviewer} #${run.pass}` : run.reviewer,
          detail: run.detail ?? "no output",
        })),
        reviewChoice,
      );

      if (decision.cancelled) {
        const relPath = await writePartial("cancelled", "Run cancelled at the reviewer-failure checkpoint.");
        progress?.settleOpenRows("cancelled", "cancelled");
        return makeSummary("cancelled", relPath, {}, skippedVerification());
      }
      // The signal can be aborted by the cancel shortcut while the overlay is
      // open, so it is rechecked here rather than only at the loop head.
      if (decision.retries.length === 0 || input.signal?.aborted) break;

      if (decision.model) {
        reviewChoice = decision.model;
        reviewModel = {
          model: modelRefLabel(decision.model.ref),
          thinking: decision.model.thinking,
          label: phaseModelChoiceLabel(decision.model),
        };
        reportCtx.phaseModels = { ...reportCtx.phaseModels, Review: reviewModel.label };
        if (progress) progress.setPhaseModels({ ...progress.phaseModels(), Review: reviewModel.model });
      }
      for (const task of decision.retries) {
        if (decision.model) uncacheable.add(`${task.reviewer}\u0000${task.pass}`);
        const record = runRecordByKey.get(`${task.reviewer}\u0000${task.pass}`);
        if (record) {
          record.status = "pending";
          record.detail = undefined;
        }
      }
      await runReviewerBatch(decision.retries, reviewModel, true);
    }

    if (input.signal?.aborted) {
      const relPath = await writePartial("cancelled", "Run aborted while reviewer passes were being retried.");
      progress?.settleOpenRows("cancelled", "aborted");
      return makeSummary("cancelled", relPath, {}, skippedVerification());
    }

    const allOutputs = [...cachedOutputs, ...freshOutputs];
    const cacheableFresh = freshOutputs.filter((o) => !uncacheable.has(`${o.reviewer}\u0000${o.pass}`));
    if (input.cacheKey && cacheableFresh.length > 0) {
      await saveCache(ctx.cwd, input.cacheKey, [...cachedOutputs, ...cacheableFresh]);
    }

    // ── Steps c–e: collection, re-voice, adjudication — skipped on resume ──
    let annotatedFindings: Finding[];
    if (input.resume) {
      // Findings were already collected, deduped, and adjudicated in the
      // original run; the handoff carries them losslessly.
      progress?.setActivePhase("Triage");
      annotatedFindings = input.resume.findings;
      runSummary.findings = annotatedFindings.length;
      refreshSummary();
    } else {
      // ── Step c: deterministic collection + dedup (direct call) ──────────
      progress?.setActivePhase("Triage");
      notifyPhase("collecting findings from reviewer passes…");
      // Deterministic collection is Triage preparation: it decides what the
      // adjudicator is asked to reconcile, so it belongs in that group.
      progress?.addRow("Triage", COLLECT_ROW, "collection", { state: "working", statusText: "deduplicating…" });
      collection = collectReviewerFindings(selection.reviewers, selection.passes, allOutputs);
      diagnostics.collection = collection;
      progress?.settleRow(
        COLLECT_ROW,
        "done",
        `${collection.inputCount} raw → ${collection.dedupedFindings.length} unique`,
      );
      runSummary.findings = collection.dedupedFindings.length;
      refreshSummary();

      // ── Step d: no findings → compact report, unless collection failed ──
      if (collection.dedupedFindings.length === 0) {
        diagnostics.failedRuns = runRecords.filter((run) => run.status === "failed");
        const relPath = reportRelPath(slug);

        if (collection.expectedRuns > 0 && collection.receivedRuns === 0) {
          const failureDetails = runRecords
            .filter((run) => run.status === "failed")
            .map((run) => `${run.reviewer} pass ${run.pass}: ${run.detail ?? "no output"}`)
            .join("; ");
          const reason = `All ${collection.expectedRuns} reviewer ${collection.expectedRuns === 1 ? "pass has" : "passes have"} failed${failureDetails ? ` — ${failureDetails}` : ". This typically means the model could not be resolved or the agent session failed to start; see the per-pass failure details above."}. (${collection.missingRuns.length} missing, ${collection.malformed.length} malformed)`;
          ctx.ui.notify(`persona-audit: ${reason}`, "error");
          await writeReportFile(ctx.cwd, relPath, renderCollectionFailureReport(report(), { diagnostics, reason }));
          await supersedePartial();
          return makeSummary("failed", relPath, { findings: 0 }, skippedVerification(), reason);
        }

        await writeReportFile(
          ctx.cwd,
          relPath,
          renderCompactReport(report(), { reason: "no-findings", deferred: [], rejected: [], diagnostics }),
        );
        await supersedePartial();
        return makeSummary("no-findings", relPath, { findings: 0 }, skippedVerification());
      }

      // ── Step d2: register re-voice (hot registers only, voice-only rewrite) ─
      // Register-in-JSON is model-dependent: some review models write neutral
      // structured output during long agentic sessions no matter what the task
      // demands, but comply in a short no-tools call — which this is.
      const revoiceTargets = selectRevoiceTargets(collection.dedupedFindings, input.temperament);
      if (revoiceTargets.length > 0 && !input.signal?.aborted) {
        notifyPhase("re-voicing findings into the configured register…");
        progress?.addRow("Triage", REVOICE_ROW, "register re-voice", { state: "working", statusText: "re-voicing…" });
        const revoicePersonality = getPersonality(LINUS_TORVALDS, input.temperament);
        const revoiceResult = await runAgentSession({
          agentName: "register re-voice",
          systemPrompt: ["Obey the following persona exactly.", "", "## Your Reviewer Personality", "", revoicePersonality ?? ""].join("\n"),
          tools: [],
          model: reviewModel.model,
          thinking: reviewModel.thinking,
          task: buildRevoiceTask(revoiceTargets, input.temperament ?? DEFAULT_TEMPERAMENT),
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          signal: input.signal,
          idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
          onProgress: (snapshot) => progress?.applyProgress(REVOICE_ROW, snapshot),
        });
        if (isFailedRun(revoiceResult) || !revoiceResult.allText.trim()) {
          diagnostics.revoiceNote = `register re-voice failed (${
            revoiceResult.errorMessage || (revoiceResult.aborted ? "aborted" : revoiceResult.stopReason) || "no output"
          }) — findings keep the reviewer's original text`;
          progress?.settleRow(REVOICE_ROW, revoiceResult.aborted ? "cancelled" : "error", "kept original text");
        } else {
          const revoiced = applyRevoicedFindings(
            collection.dedupedFindings,
            revoiceTargets.map((t) => t.index),
            [revoiceResult.finalText, revoiceResult.allText],
          );
          collection.dedupedFindings = revoiced.findings;
          diagnostics.revoiceNote = revoiced.note;
          progress?.settleRow(REVOICE_ROW, "done", `${revoiced.matched}/${revoiceTargets.length} re-voiced`);
        }
      }

      // ── Step e: adjudicator reconcile (read-only agent session) ────────────
      notifyPhase("adjudicating findings…");
      progress?.addRow("Triage", RECONCILE_ROW, "adjudicator · reconcile", {
        state: "working",
        statusText: "annotating…",
      });
      const reconcileOptions: HeadlessOptions = {
        agentName: "adjudicator reconcile",
        systemPrompt: adjudicatorAgent.systemPrompt,
        tools: READ_ONLY_TOOLS,
        model: triageModel.model,
        thinking: triageModel.thinking,
        task: buildReconcileTask(input, baseLabel, collection.dedupedFindings),
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        signal: input.signal,
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        onProgress: (snapshot) => progress?.applyProgress(RECONCILE_ROW, snapshot),
      };
      let reconcileResult = await runAgentSession(reconcileOptions);
      // A transient provider error drops every recommendation from this phase, so it gets one retry before being recorded as failed.
      // A "Model not found" error is resolveModelRef rejecting the ref before any network call — deterministic and permanent, so retrying just wastes 5s.
      if (
        isFailedRun(reconcileResult) &&
        reconcileResult.stopReason === "error" &&
        !isPermanentRunFailure(reconcileResult.errorMessage) &&
        !input.signal?.aborted
      ) {
        await new Promise((r) => setTimeout(r, 5_000));
        reconcileResult = await runAgentSession(reconcileOptions);
      }

      annotatedFindings = collection.dedupedFindings;
      if (isFailedRun(reconcileResult)) {
        annotatedFindings = collection.dedupedFindings.map((f) => ({ ...f, recommendation: "defer" }));
        diagnostics.annotationNote = `adjudicator reconcile failed (${
          reconcileResult.errorMessage || reconcileResult.stopReason || "aborted"
        }) — findings triaged without recommendations`;
        progress?.settleRow(RECONCILE_ROW, "error", "no recommendations");
      } else {
        let annotated = annotateFindings(collection.dedupedFindings, [
          reconcileResult.finalText,
          reconcileResult.allText,
        ]);
        // A session that succeeded but produced nothing usable gets one more
        // chance before every finding falls back to a reason-less defer.
        if (annotated.matched === 0 && collection.dedupedFindings.length > 0 && !input.signal?.aborted) {
          progress?.startRow(RECONCILE_ROW, "output unusable — retrying…");
          const retryRun = await runAgentSession(reconcileOptions);
          if (!isFailedRun(retryRun)) {
            const retried = annotateFindings(collection.dedupedFindings, [retryRun.finalText, retryRun.allText]);
            if (retried.matched > 0) {
              annotated = retried;
            } else if (retried.note) {
              annotated = { ...retried, note: `${retried.note} (after one retry)` };
            }
          }
        }
        annotatedFindings = annotated.findings;
        diagnostics.annotationNote = annotated.note;
        progress?.settleRow(
          RECONCILE_ROW,
          annotated.matched > 0 ? "done" : "error",
          `${annotated.matched}/${collection.dedupedFindings.length} annotated`,
        );
      }

      if (input.signal?.aborted) {
        const relPath = await writePartial("cancelled", "Run aborted during adjudication.");
        progress?.settleOpenRows("cancelled", "aborted");
        return makeSummary("cancelled", relPath, { findings: collection.dedupedFindings.length }, skippedVerification());
      }
    }

    const testCoverage = new Map(
      await mapWithConcurrencyLimit(
        [...new Set(annotatedFindings.map((finding) => finding.file))],
        8,
        async (file) => [file, await hasCorrespondingTest(ctx.cwd, file)] as const,
      ),
    );
    annotatedFindings = annotatedFindings.map((finding) => ({
      ...finding,
      blastRadius: computeBlastRadius({
        fanIn: input.blastFanIn?.get(finding.file) ?? 0,
        tags: sensitivityTags(finding.file),
        hasTest: testCoverage.get(finding.file),
        changeKind: finding.changeKind,
      }),
    }));

    // ── Step f: findings review TUI (direct call) ───────────────────────
    notifyPhase(`reviewing ${annotatedFindings.length} finding${annotatedFindings.length === 1 ? "" : "s"}`);
    // The overlay owns the interaction; the table only reports that the run is
    // parked on a human decision.
    runSummary.note = "awaiting triage decisions";
    refreshSummary();
    const { showFindingsReview } = await import("./components/FindingsReview.ts");
    const { runFixNow } = await import("./fixNow.ts");
    const { openFixProgress } = await import("./components/FixProgress.ts");
    // The overlay resolves early with a fixNow outcome, the interactive fix
    // flow runs, and the overlay reopens with its state restored — looping
    // until the user finalizes or cancels.
    let sessionState: ReviewSessionState | undefined;
    let review: FindingsReviewResult | undefined;
    let fixNowCount = 0;
    for (;;) {
      const outcome = await showFindingsReview(
        ctx,
        annotatedFindings,
        {
          slug,
          isoDate: iso,
          scope: input.scope,
          reviewers: selection.reviewers,
        },
        diagnostics.annotationNote,
        sessionState,
      );

      if (outcome.kind === "cancelled") {
        const relPath = await writePartial(
          "cancelled",
          "User cancelled during findings review. No fixes were applied; findings are listed above.",
        );
        runSummary.note = "cancelled at triage";
        refreshSummary();
        progress?.settleOpenRows("cancelled", "cancelled");
        return makeSummary("cancelled", relPath, { findings: annotatedFindings.length }, skippedVerification());
      }

      if (outcome.kind === "finalized") {
        review = outcome.result;
        break;
      }

      sessionState = outcome.state;
      const target = annotatedFindings[outcome.index];
      if (!target) continue;
      if (!input.fileManifest.includes(target.file)) {
        ctx.ui.notify(`persona-audit: ${target.file} is outside the audited scope — cannot fix now`, "warning");
        continue;
      }
      const fixNowRowKey = `implement:fixnow:${outcome.index}:${fixNowCount++}`;
      progress?.addRow("Implement", fixNowRowKey, `fix now · ${findingLabel(target)}`, { state: "working" });
      await runFixNow(
        {
          ctx,
          adjudicatorSystemPrompt: adjudicatorAgent.systemPrompt,
          verifierSystemPrompt: verifierAgent.systemPrompt,
          adjudicatorTools: adjudicatorAgent.tools ?? EDIT_TOOLS,
          readOnlyTools: READ_ONLY_TOOLS,
          implementModel: { model: implementModel.model, thinking: implementModel.thinking },
          verifyModel: { model: verifyModel.model, thinking: verifyModel.thinking },
          signal: input.signal,
          // Working/settling status and telemetry land as nested detail on the
          // fix-now row — the controller is the single telemetry path, so no
          // onTelemetry mirror is needed here.
          openProgress: (progressCtx, progressFinding, onCancel) =>
            openFixProgress(progressCtx, progressFinding, onCancel, progress ? { key: fixNowRowKey, progress } : undefined),
        },
        target,
        outcome.index,
        sessionState,
      );
      const landed = sessionState.statuses[outcome.index] === "fixed";
      progress?.settleRow(fixNowRowKey, landed ? "done" : "cancelled", landed ? "fixed" : "not applied");
      if (input.signal?.aborted) {
        const relPath = await writePartial("cancelled", "Run aborted during findings review.");
        progress?.settleOpenRows("cancelled", "aborted");
        return makeSummary(
          "cancelled",
          relPath,
          { findings: annotatedFindings.length, fixed: sessionState.fixed.size },
          skippedVerification(),
        );
      }
    }

    // Runs before the zero-accepted check below so a set emptied by scoping
    // still lands on the none-accepted path.
    const scoped = scopeAcceptedFindings(review.accepted, input.fileManifest);
    if (scoped.outOfScope.length > 0) {
      review.accepted = scoped.inScope;
      diagnostics.outOfScope = scoped.outOfScope;
      ctx.ui.notify(
        `persona-audit: ${scoped.outOfScope.length} accepted finding${scoped.outOfScope.length === 1 ? "" : "s"} outside the audited scope — not applied`,
        "warning",
      );
    }

    runSummary.note = undefined;
    runSummary.accepted = review.accepted.length;
    refreshSummary();
    if (review.handoffPath) {
      ctx.ui.notify(`persona-audit: deferred findings handoff → ${review.handoffPath}`, "info");
    }

    // ── Step g: zero accepted → compact report ──────────────────────────
    // Interactive fixes are already on disk (and committed), so a run with
    // fixed findings but no batch-accepted ones still counts as completed —
    // it just skips the implement/verify pipeline.
    if (review.accepted.length === 0) {
      diagnostics.failedRuns = runRecords.filter((run) => run.status === "failed");
      const relPath = reportRelPath(slug);
      await writeReportFile(
        ctx.cwd,
        relPath,
        renderCompactReport(report(), {
          reason: "none-accepted",
          deferred: review.deferred,
          rejected: review.rejected,
          fixed: review.fixed,
          diagnostics,
        }),
      );
      await supersedePartial();
      return makeSummary(
        review.fixed.length > 0 ? "completed" : "none-accepted",
        relPath,
        {
          findings: annotatedFindings.length,
          rejected: review.rejected.length,
          deferred: review.deferred.length,
          fixed: review.fixed.length,
        },
        skippedVerification(),
        undefined,
        undefined,
        review.handoffPath,
      );
    }

    // ── Step h′: pre-fix snapshots (the baseline every later layer needs) ──
    const acceptedFiles = [...new Set(review.accepted.map((f) => f.file))];
    const snapshots: Map<string, FileSnapshot> = await snapshotFiles(ctx.cwd, slug, acceptedFiles);

    // ── Step h: adjudicator implement (parallel edit-capable agent sessions) ──
    progress?.setActivePhase("Implement");
    const { batches: applyBatches, overflow: applyOverflow } = partitionApplyBatches(review.accepted);
    const acceptedLabel = `${review.accepted.length} accepted fix${review.accepted.length === 1 ? "" : "es"}`;
    notifyPhase(
      applyBatches.length === 1
        ? `applying ${acceptedLabel}…`
        : `applying ${acceptedLabel} across ${applyBatches.length} parallel agents…`,
    );
    for (const batch of applyBatches) {
      progress?.addRow("Implement", applyRowKey(batch.index), applyBatchLabel(batch), {
        statusText: `${batch.findings.length} fix${batch.findings.length === 1 ? "" : "es"} queued`,
      });
    }

    const applyRuns = await mapWithConcurrencyLimit(applyBatches, APPLY_CONCURRENCY, async (batch) => {
      const rowKey = applyRowKey(batch.index);
      progress?.startRow(rowKey, `applying ${batch.findings.length}…`);
      const result = await runAgentSession({
        agentName: `adjudicator implement ${batch.index + 1}/${applyBatches.length}`,
        systemPrompt: adjudicatorAgent.systemPrompt,
        tools: (adjudicatorAgent.tools ?? EDIT_TOOLS).filter((t) => t !== "bash"),
        model: implementModel.model,
        thinking: implementModel.thinking,
        task: buildApplyTask(batch),
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        signal: input.signal,
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        onProgress: (snapshot) => progress?.applyProgress(rowKey, snapshot),
      });
      const failureReason = isFailedRun(result)
        ? result.errorMessage || result.stopReason || "aborted"
        : undefined;
      progress?.settleRow(
        rowKey,
        failureReason === undefined ? "done" : "error",
        failureReason === undefined ? "fixes applied" : "apply failed",
      );
      return { batch, text: result.finalText || result.allText, failureReason };
    });

    // Only a total wipeout skips verification: if any agent landed edits, the
    // tree changed and the report has to be built from what is actually there.
    const failedApplyRuns = applyRuns.filter((run) => run.failureReason !== undefined);
    const applyFailed = failedApplyRuns.length === applyRuns.length;
    const applyFailureReason = failedApplyRuns.length > 0
      ? [...new Set(failedApplyRuns.map((run) => run.failureReason))].join("; ")
      : undefined;
    const applyReport = mergeApplyReports(applyRuns, applyOverflow);

    // ── Step i: verification ─────────────────────────────────────────────
    // Three layers, then the script gate last so it also covers any test
    // authored along the way. Unlike the pre-implement checkpoints, an abort
    // here does not cancel the run: fixes are already on disk, and the report
    // is the only durable record of what happened to them.
    //
    // A round that does not pass is handed to a repair agent (the same
    // adjudicator, edit-capable), then every layer re-runs from scratch
    // against the same round-1 baseline snapshots — a repair can regress an
    // earlier layer, so a partial re-check would miss that.
    progress?.setActivePhase("Verify");
    const verification: VerificationOutcome = skippedVerification();
    if (applyOverflow.length > 0) {
      verification.notes.push(
        `${applyOverflow.length} accepted finding${applyOverflow.length === 1 ? "" : "s"} ranked past the ${MAX_APPLY_EDITS}-fix per-run cap and were not applied`,
      );
    }
    if (!applyFailed) {
      for (const run of failedApplyRuns) {
        verification.notes.push(
          `implement batch ${run.batch.index + 1} (${run.batch.files.join(", ")}) failed — ${run.failureReason}`,
        );
      }
    }

    if (applyFailed) {
      progress?.addRow("Verify", "verify:skipped", "verification", {
        state: "cancelled",
        statusText: "skipped — implement failed",
      });
      verification.notes.push("implement phase failed — verification was skipped");
    } else {
      const runVerificationRound = async (round: number, applyReportText: string): Promise<VerificationRound> => {
        const suffix = round > 1 ? ` (round ${round})` : "";
        const landedRow = `verify:landed:${round}`;
        const verifierRow = `verify:agent:${round}`;
        const regressionAuthorRow = `verify:regress:author:${round}`;
        const outcome: VerificationRound = {
          round,
          status: "skipped",
          fixVerdicts: [],
          regressions: [],
          scripts: [],
          notes: [],
        };

        // ── i1: did each fix land? (deterministic, no tokens spent) ───────
        notifyPhase(`verifying applied fixes${suffix}…`);
        progress?.addRow("Verify", landedRow, `fix landed${suffix}`, { state: "working", statusText: "comparing…" });
        const changeEvidence = await compareToSnapshots(ctx.cwd, snapshots);
        const selfReports = parseApplyReport(applyReportText);
        const changedFiles = [...changeEvidence.values()].filter(
          (e) => e.state !== "unchanged" && e.state !== "unreadable",
        ).length;
        runSummary.fixesTotal = acceptedFiles.length;
        runSummary.fixesLanded = changedFiles;
        refreshSummary();
        progress?.settleRow(
          landedRow,
          changedFiles === acceptedFiles.length ? "done" : "error",
          `${changedFiles}/${acceptedFiles.length} files changed`,
        );

        // ── i2: agent verdict per finding ────────────────────────────────
        let verifierTexts: string[] = [];
        if (input.signal?.aborted) {
          outcome.notes.push("run aborted during verification — fixes were not judged");
        } else {
          progress?.addRow("Verify", verifierRow, `verifier${suffix}`, { state: "working", statusText: "judging fixes…" });
          const applyRetryModel = (decision: VerifierRetryDecision): void => {
            if (!decision.model) return;
            verifyChoice = decision.model;
            const label = modelRefLabel(decision.model.ref);
            verifyModel = { model: label, thinking: decision.model.thinking, label: phaseModelChoiceLabel(decision.model) };
            reportCtx.phaseModels = { ...reportCtx.phaseModels, Verify: verifyModel.label };
            if (progress) progress.setPhaseModels({ ...progress.phaseModels(), Verify: verifyModel.model });
          };
          // A verifier failure is usually provider-level (credits, rate limit),
          // and skipping it leaves every accepted finding at "cannot-verify", so
          // the user gets a chance to re-run it on a different model.
          let unusableRetries = 0;
          for (;;) {
            const verifyRun = await runAgentSession({
              agentName: `verifier${suffix}`,
              systemPrompt: verifierAgent.systemPrompt,
              tools: READ_ONLY_TOOLS,
              model: verifyModel.model,
              thinking: verifyModel.thinking,
              task: buildVerifierTask(ctx.cwd, review.accepted, changeEvidence, selfReports, applyReportText, input.fileManifest),
              cwd: ctx.cwd,
              modelRegistry: ctx.modelRegistry,
              signal: input.signal,
              idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
              onProgress: (snapshot) => progress?.applyProgress(verifierRow, snapshot),
            });
            if (!isFailedRun(verifyRun)) {
              verifierTexts = [verifyRun.finalText, verifyRun.allText];
              // A run can complete yet produce claims that join to almost no
              // findings (wrong format, truncated array). That is as useless as
              // a crash, so it goes through the same retry checkpoint — but the
              // partial verdicts are kept if the user declines.
              const parsed = parseFixVerdicts(review.accepted, changeEvidence, selfReports, verifierTexts, ctx.cwd);
              if (!verifierOutputUnusable(parsed.matched, parsed.judgeable)) break;
              if (unusableRetries >= MAX_UNUSABLE_VERIFIER_RETRIES) {
                outcome.notes.push(
                  `verifier output still matched only ${parsed.matched}/${parsed.judgeable} findings after ${unusableRetries} retries — keeping the partial verdicts`,
                );
                break;
              }
              const outputDetail = `verifier run completed but its verdicts matched only ${parsed.matched}/${parsed.judgeable} findings`;
              const outputDecision =
                input.onVerifierFailure && !input.signal?.aborted
                  ? await input.onVerifierFailure(outputDetail, verifyChoice)
                  : { retry: false };
              if (!outputDecision.retry || input.signal?.aborted) break;
              unusableRetries++;
              applyRetryModel(outputDecision);
              outcome.notes.push(`${outputDetail} — retried on ${verifyModel.label}`);
              progress?.startRow(verifierRow, "output unusable — retrying…");
              continue;
            }

            const detail = verifyRun.errorMessage || verifyRun.stopReason || "aborted";
            const decision =
              input.onVerifierFailure && !verifyRun.aborted && !input.signal?.aborted
                ? await input.onVerifierFailure(detail, verifyChoice)
                : { retry: false };
            // The signal can be aborted by the cancel shortcut while the overlay
            // is open, so it is rechecked after the prompt resolves.
            if (!decision.retry || input.signal?.aborted) {
              outcome.notes.push(`verifier run failed (${detail}) — changed files could not be judged`);
              progress?.settleRow(verifierRow, "error", "no verdicts");
              break;
            }

            applyRetryModel(decision);
            outcome.notes.push(`verifier run failed (${detail}) — retried on ${verifyModel.label}`);
            progress?.startRow(verifierRow, "retrying…");
          }
        }

        const verdicts = parseFixVerdicts(review.accepted, changeEvidence, selfReports, verifierTexts, ctx.cwd);
        outcome.fixVerdicts = verdicts.verifications;
        if (verdicts.note) outcome.notes.push(verdicts.note);

        if (verifierTexts.length > 0) {
          const verdictCounts = new Map<FixVerdict, number>();
          for (const f of outcome.fixVerdicts) {
            verdictCounts.set(f.verdict, (verdictCounts.get(f.verdict) ?? 0) + 1);
          }
          const notFixed = verdictCounts.get("not-fixed") ?? 0;
          progress?.settleRow(
            verifierRow,
            notFixed > 0 ? "error" : "done",
            `${verdictCounts.get("fixed") ?? 0} fixed · ${verdictCounts.get("partial") ?? 0} partial · ${notFixed} not fixed · ${verdictCounts.get("cannot-verify") ?? 0} unverified`,
          );
        }
        // Only problem verdicts get their own row: a large audit would otherwise
        // bury the phase branch under one row per accepted finding.
        for (const fix of outcome.fixVerdicts) {
          if (fix.verdict !== "not-fixed" && fix.verdict !== "cannot-verify") continue;
          progress?.addRow("Verify", `${fixRowKey(fix)}:${round}`, `${findingLabel(fix)}${suffix}`, {
            state: fix.verdict === "not-fixed" ? "error" : "cancelled",
            statusText: fix.verdict,
          });
        }

        // ── i3: red/green regression evidence for the highest-signal fixes ─
        const candidates = input.signal?.aborted
          ? []
          : selectRegressionCandidates(review.accepted, outcome.fixVerdicts, REGRESSION_LIMIT);
        if (candidates.length > 0) {
          notifyPhase(`authoring ${candidates.length} regression test${candidates.length === 1 ? "" : "s"}${suffix}…`);
          progress?.addRow("Verify", regressionAuthorRow, `regression tests${suffix}`, {
            state: "working",
            statusText: "authoring…",
          });
          const authored = await runAgentSession({
            agentName: `verifier regression${suffix}`,
            systemPrompt: verifierAgent.systemPrompt,
            tools: [...READ_ONLY_TOOLS, "write", "edit"],
            model: verifyModel.model,
            thinking: verifyModel.thinking,
            task: buildRegressionTask(ctx.cwd, candidates, outcome.fixVerdicts),
            cwd: ctx.cwd,
            modelRegistry: ctx.modelRegistry,
            signal: input.signal,
            idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
            onProgress: (snapshot) => progress?.applyProgress(regressionAuthorRow, snapshot),
          });

          if (isFailedRun(authored)) {
            outcome.notes.push("regression test authoring failed — no red/green evidence was collected");
            progress?.settleRow(regressionAuthorRow, "error", "authoring failed");
          } else {
            const parsed = parseRegressionPlans(candidates, [authored.finalText, authored.allText], ctx.cwd);
            if (parsed.note) outcome.notes.push(parsed.note);
            progress?.settleRow(regressionAuthorRow, "done", `${parsed.plans.length}/${candidates.length} authored`);
            for (const plan of parsed.plans) {
              progress?.addRow("Verify", `${regressRowKey(plan)}:${round}`, `regression · ${findingLabel(plan)}${suffix}`);
            }
            const harness = await runRegressionHarness({
              cwd: ctx.cwd,
              plans: parsed.plans,
              snapshots,
              signal: input.signal,
              onStart: (plan) => progress?.startRow(`${regressRowKey(plan)}:${round}`, "red/green…"),
              onDone: (result) =>
                progress?.settleRow(`${regressRowKey(result)}:${round}`, result.proven ? "done" : "error", result.outcome),
            });
            outcome.regressions = harness.results;
            outcome.notes.push(...harness.notes);
            outcome.fixVerdicts = applyRegressionEvidence(outcome.fixVerdicts, harness.results);
          }
        }

        // ── i4: script gate, last so it covers newly authored tests ───────
        if (input.signal?.aborted) {
          outcome.notes.push("run aborted during verification — scripts were not run");
        } else {
          notifyPhase(`running verification scripts${suffix}…`);
          const verifyScripts = await discoverVerifyScripts(ctx.cwd);
          if (verifyScripts.length === 0) {
            progress?.addRow("Verify", `verify:none:${round}`, `no scripts${suffix}`, {
              state: "done",
              statusText: "nothing to verify",
            });
            outcome.notes.push("no verification scripts discovered — the tree was not re-checked");
          } else {
            for (const script of verifyScripts) {
              progress?.addRow("Verify", `verify:${script}:${round}`, `npm run ${script}${suffix}`);
            }
            runSummary.verifyTotal = verifyScripts.length;
            runSummary.verifyDone = 0;
            refreshSummary();
          }
          for (const script of verifyScripts) {
            progress?.startRow(`verify:${script}:${round}`, "running…");
            const result = await runVerifyScript(ctx.cwd, script, input.signal);
            outcome.scripts.push(result);
            progress?.settleRow(
              `verify:${result.script}:${round}`,
              result.status === "pass" ? "done" : "error",
              result.status === "pass" ? "passed" : `failed (exit ${result.exitCode})`,
            );
            runSummary.verifyDone++;
            refreshSummary();
          }
        }

        outcome.status = aggregateVerificationStatus({
          implementFailed: false,
          acceptedCount: review.accepted.length,
          fixes: outcome.fixVerdicts,
          scripts: outcome.scripts,
        });
        return outcome;
      };

      // Round 1 is the original implement + verify; the rest are gate repairs.
      // The cap is user-configurable via /persona-audit-settings; 1 disables
      // auto-repair entirely.
      const maxRounds = input.maxVerifyRounds ?? DEFAULT_VERIFY_ROUNDS;
      let currentApplyReport = applyReport;
      let round = await runVerificationRound(1, currentApplyReport);
      verification.rounds.push(round);
      // How often each actionable failure set has been seen. A repair that
      // leaves the set unchanged (or returns it to an earlier state — A→B→A)
      // gets one escalated root-cause retry with the full attempt history; a
      // set that survives even that will not converge, so the loop stops
      // rather than burn the remaining round budget on identical repairs.
      const fingerprintCounts = new Map<string, number>();
      recordFingerprint(fingerprintCounts, actionableFingerprint(round));
      const contested: ContestedVerdict[] = [];
      let escalateNext = false;

      while (round.status !== "passed" && verification.rounds.length < maxRounds && !input.signal?.aborted) {
        const escalated = escalateNext;
        escalateNext = false;
        const repair = buildRepairTask(ctx.cwd, round, review.accepted, input.fileManifest, {
          priorRounds: verification.rounds.slice(0, -1),
          escalated,
          snapshots,
        });
        if (repair.targetCount === 0) break;

        const nextRound = verification.rounds.length + 1;
        const repairRow = `repair:round:${nextRound}`;
        const escalatedSuffix = escalated ? " (escalated)" : "";
        notifyPhase(`repairing verification failures (round ${nextRound}${escalatedSuffix})…`);
        progress?.addRow("Verify", repairRow, `gate repair ${nextRound}${escalatedSuffix}`, {
          state: "working",
          statusText: `${repair.targetCount} target(s)`,
        });
        const repairRun = await runAgentSession({
          agentName: `adjudicator repair round ${nextRound}${escalatedSuffix}`,
          systemPrompt: adjudicatorAgent.systemPrompt,
          tools: (adjudicatorAgent.tools ?? EDIT_TOOLS).filter((t) => t !== "bash"),
          model: implementModel.model,
          thinking: implementModel.thinking,
          task: repair.task,
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          signal: input.signal,
          idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
          onProgress: (snapshot) => progress?.applyProgress(repairRow, snapshot),
        });

        if (isFailedRun(repairRun)) {
          const detail = repairRun.errorMessage || repairRun.stopReason || "aborted";
          round.repairOutcome = `gate repair round ${nextRound} failed — ${detail}`;
          round.repairEscalated = escalated || undefined;
          verification.notes.push(
            `gate repair round ${nextRound} failed to run (${detail}) — round ${round.round}'s verification failures were left unrepaired`,
          );
          progress?.settleRow(repairRow, "error", "repair failed");
          break;
        }

        const repairText = repairRun.finalText || repairRun.allText;
        round.repairOutcome = repairText;
        round.repairEscalated = escalated || undefined;
        contested.push(...parseContestedVerdicts(review.accepted, [repairText], nextRound));
        progress?.settleRow(repairRow, "done", "repair applied");
        currentApplyReport = [currentApplyReport, `## Gate repair round ${nextRound}`, "", repairText].join("\n\n");

        round = await runVerificationRound(nextRound, currentApplyReport);
        verification.rounds.push(round);

        const outcome = recordFingerprint(fingerprintCounts, actionableFingerprint(round));
        if (outcome === "recurred") {
          verification.notes.push(
            `round ${nextRound}: the same verification failures recurred — escalating the next repair to root-cause mode`,
          );
          escalateNext = true;
        } else if (outcome === "exhausted") {
          verification.notes.push(
            `repair loop stopped after round ${nextRound}: the same verification failures recurred even after an escalated root-cause repair`,
          );
          break;
        }
      }

      verification.fixes = round.fixVerdicts;
      verification.regressions = round.regressions;
      verification.scripts = round.scripts;
      verification.notes.push(...round.notes);

      // Disputes about findings the loop subsequently repaired are moot; the
      // rest are surfaced for human adjudication but never change the status.
      const stillFailing = new Set(
        round.fixVerdicts.filter(isRepairableVerdict).map((v) => verificationKey(v.file, v.line, v.category)),
      );
      verification.contested = contested.filter((c) => stillFailing.has(verificationKey(c.file, c.line, c.category)));
      for (const dispute of verification.contested) {
        verification.notes.push(
          `repair agent contested the verifier verdict on ${dispute.file}:${dispute.line} (${dispute.category}) — see Contested Verdicts in the report`,
        );
      }
    }

    verification.status = aggregateVerificationStatus({
      implementFailed: applyFailed,
      acceptedCount: review.accepted.length,
      fixes: verification.fixes,
      scripts: verification.scripts,
    });

    // ── Step j: full report ──────────────────────────────────────────────
    diagnostics.failedRuns = runRecords.filter((run) => run.status === "failed");
    const relPath = reportRelPath(slug);
    await writeReportFile(
      ctx.cwd,
      relPath,
      renderFullReport(report(), {
        accepted: review.accepted,
        deferred: review.deferred,
        rejected: review.rejected,
        fixed: review.fixed,
        applyReport,
        verification,
        diagnostics,
        partialReportPath: partialWritten ? partialReportRelPath(slug) : undefined,
      }),
    );
    await supersedePartial();

    return makeSummary(
      "completed",
      relPath,
      {
        findings: annotatedFindings.length,
        accepted: review.accepted.length,
        rejected: review.rejected.length,
        deferred: review.deferred.length,
        fixed: review.fixed.length,
      },
      verification,
      undefined,
      applyFailed
        ? `Implement phase failed — no accepted fixes were written to disk: ${applyFailureReason}`
        : undefined,
      review.handoffPath,
    );
  } catch (error) {
    // Durable failure artifact, then rethrow for the command handler to notify.
    try {
      await writePartial("failed", `Error: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      /* reporting must not mask the original error */
    }
    // Only unfinished rows go red: completed passes stay readable as evidence
    // of how far the run got before it broke.
    progress?.settleOpenRows("error", "failed");
    throw error;
  }
}
