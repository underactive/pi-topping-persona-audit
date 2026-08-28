/**
 * Audit report builders.
 *
 * Pure template functions over structured inputs — no LLM involvement.
 * Filename slug convention matches existing artifacts
 * (`YYYY-MM-DD_HH-MM-SS-mmm_persona-audit.md`); frontmatter carries the ISO date.
 */

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { normalizeFindingText, normalizeMultilineText } from "./dedup.ts";
import type {
  AuditMode,
  AuditSummary,
  CollectReviewerFindingsResult,
  Finding,
  FixedFinding,
  FixVerification,
  RegressionResult,
  ReviewerRunRecord,
  VerificationOutcome,
  VerificationRound,
} from "./types.ts";

const AUDITS_DIR = ".pi/persona-audit/audits";
const HANDOFFS_DIR = ".pi/persona-audit/handoffs";

/** Static context shared by every report flavor for one audit run. */
export interface ReportContext {
  slug: string;
  isoDate: string;
  scope: string;
  mode: AuditMode;
  baseLabel: string;
  changedCount: number;
  importerCount: number;
  fileCount: number;
  /** True when a --full scan exceeded the file cap and was deterministically truncated. */
  truncated?: boolean;
  /** Total files found by a --full scan before truncation (only set when truncated). */
  totalFilesFound?: number;
  reviewers: string[];
  passes: number;
  cacheHits: number;
  freshRuns: number;
  /** Per-phase model + thinking labels from the post-ExpertPicker picker, keyed by phase display name. */
  phaseModels?: Partial<Record<string, string>>;
  /** Wall-clock duration of the run at the moment the report is rendered. */
  totalMs?: number;
}

/** Collection-integrity diagnostics rendered into every report flavor. */
export interface CollectionDiagnostics {
  collection?: CollectReviewerFindingsResult;
  failedRuns: ReviewerRunRecord[];
  annotationNote?: string;
  /** Set when the register re-voice pass was degraded or unavailable. */
  revoiceNote?: string;
  /** Accepted findings dropped because their file sits outside the audited manifest. */
  outOfScope?: Finding[];
}

/** Context captured when deferred findings are saved for follow-up work. */
export interface DeferredHandoffContext {
  isoDate: string;
  scope: string;
  reviewers: string[];
}

export function makeSlug(date: Date = new Date()): { slug: string; iso: string } {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, "Z");
  const pad = (n: number) => String(n).padStart(2, "0");
  const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
  const slug =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}-${millis}`;
  return { slug, iso };
}

export function reportRelPath(slug: string): string {
  return `${AUDITS_DIR}/${slug}_persona-audit.md`;
}

export function partialReportRelPath(slug: string): string {
  return `${AUDITS_DIR}/${slug}_progress_snapshot.md`;
}

export function handoffRelPath(slug: string): string {
  return `${HANDOFFS_DIR}/${slug}_deferred-findings.md`;
}

function isWithinDirectory(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk from rootLexical down to absPath, following symlinks, and throw if any
 * segment — including the final leaf — resolves outside rootReal. Shared by
 * resolveSafeWritePath and any other caller that owns a sandboxed root
 * (e.g. the regression harness's scratch git worktree).
 */
export async function assertWriteContained(rootLexical: string, rootReal: string, absPath: string): Promise<void> {
  const relativeToRoot = path.relative(rootLexical, path.dirname(absPath));
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Refusing to write outside the root: ${absPath}`);
  }

  const segments = relativeToRoot.split(path.sep).filter(Boolean);
  let syntheticCurrent = rootLexical;
  let resolvedCurrent = rootReal;
  for (const segment of segments) {
    syntheticCurrent = path.join(syntheticCurrent, segment);
    const candidateResolved = path.join(resolvedCurrent, segment);
    try {
      const stats = await lstat(syntheticCurrent);
      if (stats.isSymbolicLink()) {
        const real = await realpath(syntheticCurrent);
        if (!isWithinDirectory(rootReal, real)) {
          throw new Error(`Refusing to write through a symlink outside the root: ${syntheticCurrent}`);
        }
        resolvedCurrent = real;
        continue;
      }
      if (stats.isDirectory() || stats.isFile()) {
        resolvedCurrent = candidateResolved;
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        resolvedCurrent = candidateResolved;
        break;
      }
      throw error;
    }
  }

  if (!isWithinDirectory(rootReal, resolvedCurrent)) {
    throw new Error(`Refusing to write outside the root: ${absPath}`);
  }

  const leaf = await lstat(absPath).catch(() => undefined);
  if (leaf?.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlinked path outside the root: ${absPath}`);
  }
}

/**
 * Resolve a write target safely under the current project root.
 * Rejects paths outside cwd and `.pi` writes that ride a symlink outside cwd.
 */
export async function resolveSafeWritePath(cwd: string, relPath: string): Promise<string> {
  const cwdPath = path.resolve(cwd);
  const cwdReal = await realpath(cwdPath);
  const absPath = path.resolve(cwdPath, relPath);
  const piRoot = path.resolve(cwdPath, ".pi");
  const relativeToPi = path.relative(piRoot, absPath);
  if (relativeToPi.startsWith("..") || path.isAbsolute(relativeToPi)) {
    throw new Error(`Refusing to write outside the .pi directory: ${relPath}`);
  }

  await assertWriteContained(cwdPath, cwdReal, absPath);

  return absPath;
}

export async function writeReportFile(cwd: string, relPath: string, content: string): Promise<string> {
  const absPath = await resolveSafeWritePath(cwd, relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  const cwdPath = path.resolve(cwd);
  const cwdReal = await realpath(cwdPath);
  await assertWriteContained(cwdPath, cwdReal, absPath);
  await writeFile(absPath, content, "utf-8");
  return relPath;
}

// ── Shared fragments ───────────────────────────────────────────────────────

function frontmatter(ctx: ReportContext, topic: string): string {
  return [
    "---",
    `date: ${ctx.isoDate}`,
    "author: pi-topping-persona-audit",
    `topic: ${topic}`,
    "tags: [audit, persona-audit, code-review]",
    "---",
  ].join("\n");
}

/** Human-readable run duration, e.g. `37s`, `11m 37s`, `1h 02m 13s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

function overviewSection(ctx: ReportContext, opts: { inProgress?: boolean } = {}): string {
  const modeLine =
    ctx.mode === "full"
      ? `- Mode: full-tree scan (no git required)`
      : `- Mode: diff-based (base: ${ctx.baseLabel})`;
  const filesLine =
    ctx.mode === "full"
      ? `- Files audited: ${ctx.fileCount} (full-tree scan${ctx.truncated ? `, capped from ${ctx.totalFilesFound} found — see note below` : ""})`
      : `- Files audited: ${ctx.fileCount} (${ctx.changedCount} changed, ${ctx.importerCount} importers)`;
  const lines = [
    "## Audit Overview",
    "",
    `- Scope: ${ctx.scope}`,
    modeLine,
    filesLine,
    `- Reviewers: ${ctx.reviewers.join(", ")}`,
    `- Passes per reviewer: ${ctx.passes}`,
    `- Reviewer runs: ${ctx.cacheHits} from cache, ${ctx.freshRuns} fresh`,
  ];
  if (ctx.totalMs !== undefined) {
    lines.push(`- Total time: ${formatDuration(ctx.totalMs)}${opts.inProgress ? " (in progress)" : ""}`);
  }
  if (ctx.mode === "full" && ctx.truncated) {
    lines.push(
      `- Note: the scan found ${ctx.totalFilesFound} files, more than the deterministic cap; the ` +
        "first files after a stable sort were audited and the rest were excluded (not sampled). Narrow the scope path to audit the remainder.",
    );
  }
  return lines.join("\n");
}

function findingLines(finding: Finding, extra?: string): string[] {
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  const lines = [
    `- **${location}** [${finding.severity}] — ${finding.category}: ${finding.rationale}`,
    `  - Fix: ${finding.suggestedChange}`,
    `  - Reviewers: ${finding.reviewer}`,
  ];
  if (finding.recommendationReason) {
    lines.push(`  - Adjudicator: ${finding.recommendationReason}`);
  }
  if (extra) lines.push(`  - ${extra}`);
  return lines;
}

function findingsSection(title: string, findings: Finding[], emptyText: string): string {
  const header = `### ${title} (${findings.length})`;
  if (findings.length === 0) return `${header}\n\n${emptyText}`;
  return `${header}\n\n${findings.flatMap((f) => findingLines(f)).join("\n")}`;
}

/** Findings fixed one at a time through the review overlay's Fix Now flow, each with its commit. */
function fixedInteractivelySection(fixed: FixedFinding[]): string {
  const header = `### Fixed interactively (${fixed.length})`;
  if (fixed.length === 0) return `${header}\n\nNone.`;
  const lines = fixed.flatMap((entry) =>
    findingLines(entry.finding, entry.commitSha ? `Commit: ${entry.commitSha}` : "Commit: none (auto-commit declined)"),
  );
  return `${header}\n\n${lines.join("\n")}`;
}

/** Render a self-contained handoff for findings deferred during TUI triage. */
export function renderDeferredHandoff(ctx: DeferredHandoffContext, deferred: Finding[]): string {
  const byFile = new Map<string, Finding[]>();
  for (const finding of deferred) {
    const findings = byFile.get(finding.file);
    if (findings) {
      findings.push(finding);
    } else {
      byFile.set(finding.file, [finding]);
    }
  }

  const deferredSection = deferred.length === 0
    ? ["## Deferred Findings (0)", "", "No findings were deferred."]
    : [
      `## Deferred Findings (${deferred.length})`,
      "",
      ...[...byFile.entries()].flatMap(([file, findings]) => [
        `### \`${file}\` (${findings.length})`,
        "",
        ...findings.flatMap((finding) => findingLines(finding)),
        "",
      ]),
    ];
  const actionItems = [...byFile.entries()].map(
    ([file, findings]) =>
      `- \`${file}\` — ${findings.length} deferred finding${findings.length === 1 ? "" : "s"}; review the findings above and decide whether to apply or reject them.`,
  );
  const reviewers = ctx.reviewers.join(", ") || "none";

  return [
    "---",
    `date: ${ctx.isoDate}`,
    "author: pi-topping-persona-audit",
    `topic: \"Deferred persona-audit findings — ${ctx.scope}\"`,
    "tags: [audit, persona-audit, deferred, handoff]",
    "status: pending",
    "---",
    "",
    "# Handoff: Deferred audit findings",
    "",
    "## Task(s)",
    "",
    `${deferred.length} deferred finding${deferred.length === 1 ? "" : "s"} from the persona-audit of \`${ctx.scope}\` (reviewers: ${reviewers}). Review each and apply or reject; see suggested changes below.`,
    "",
    ...deferredSection,
    "",
    "## Action Items & Next Steps",
    "",
    ...(actionItems.length > 0 ? actionItems : ["- No follow-up items."]),
    "",
    "## Other Notes",
    "",
    `- Scope: \`${ctx.scope}\``,
    `- Reviewers: ${reviewers}`,
    "",
  ].join("\n");
}

function collectionSection(ctx: ReportContext, diag: CollectionDiagnostics): string {
  const lines = ["### Collection Integrity", ""];
  const c = diag.collection;
  if (!c) {
    lines.push("- Findings collection did not run (audit ended before collection).");
  } else {
    lines.push(
      `- Reviewer passes: ${c.receivedRuns} received / ${c.expectedRuns} expected`,
      `- Findings parsed: ${c.inputCount} → ${c.outputCount} after dedup (${c.duplicateGroups} duplicate groups)`,
      `- No-findings sentinels: ${c.noFindings.length}`,
      `- Malformed outputs: ${c.malformed.length}`,
      `- Missing reviewer passes: ${c.missingRuns.length}`,
    );
    for (const m of c.missingRuns) {
      lines.push(`  - missing: ${m.reviewer} pass ${m.pass}`);
    }
    for (const m of c.malformed) {
      lines.push(`  - malformed: ${m.reviewer ?? "?"} pass ${m.pass ?? "?"} — ${m.reason}`);
    }
  }
  for (const run of diag.failedRuns) {
    const detail = normalizeFindingText(run.detail);
    lines.push(`  - failed run: ${run.reviewer} pass ${run.pass}${detail ? ` — ${detail}` : ""}`);
  }
  if (diag.outOfScope?.length) {
    lines.push(`- Accepted findings outside the audited scope (not applied): ${diag.outOfScope.length}`);
    for (const f of diag.outOfScope) {
      lines.push(`  - out of scope: \`${findingRef(f)}\` ${f.category} — ${f.reviewer}`);
    }
  }
  if (diag.annotationNote) {
    lines.push(`- Adjudicator annotation degradation: ${diag.annotationNote}`);
  }
  if (diag.revoiceNote) {
    lines.push(`- Register re-voice degradation: ${diag.revoiceNote}`);
  }
  return lines.join("\n");
}

function noFindingsReviewersSection(diag: CollectionDiagnostics): string {
  const names = [...new Set((diag.collection?.noFindings ?? []).map((n) => n.reviewer))];
  return [
    "### Reviewers with no findings",
    "",
    names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "None.",
  ].join("\n");
}

const REGRESSION_LABEL: Record<RegressionResult["outcome"], string> = {
  proven: "proven",
  "not-discriminating": "not discriminating",
  "green-check-failed": "inconclusive",
  "green-only": "green only",
  "harness-error": "harness error",
};

const REGRESSION_EXPLANATION: Record<RegressionResult["outcome"], string> = {
  proven: "Green with the fix in place, red when the fix is reverted.",
  "not-discriminating": "Green with the fix in place, still green when the fix is reverted — the test does not exercise the defect.",
  "green-check-failed": "The test did not pass against the current tree, so it could not be used as evidence. Either the test is wrong or the scratch checkout did not reproduce the working tree.",
  "green-only": "Ran once against the working tree; without a git commit to revert against, the test is not proven to catch the original defect.",
  "harness-error": "The harness could not run this test.",
};

function findingRef(item: { file: string; line: number }): string {
  return item.line > 0 ? `${item.file}:${item.line}` : item.file;
}

/** Markdown table cells cannot contain a raw pipe or newline. */
function cell(text: string): string {
  return normalizeFindingText(text).replace(/\|/g, "\\|") || "—";
}

function fixVerdictsTable(fixes: FixVerification[]): string[] {
  return [
    "#### Fix Verdicts",
    "",
    "| Finding | Verdict | File changed | Self-report | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...fixes.map(
      (f) =>
        `| \`${findingRef(f)}\` ${f.category} | ${f.verdict} | ${f.changed} | ${f.selfReport} | ${cell(f.evidence)} |`,
    ),
  ];
}

function regressionEvidence(regressions: RegressionResult[]): string[] {
  return [
    "#### Regression Evidence",
    "",
    ...regressions.flatMap((r) => {
      const lines = [
        `- \`${findingRef(r)}\` ${r.category} — ${REGRESSION_LABEL[r.outcome]}`,
        `  - Test: \`${r.testFile}\` · Command: \`${r.testCommand}\``,
        `  - ${REGRESSION_EXPLANATION[r.outcome]}`,
      ];
      if (r.detail && r.outcome !== "proven") lines.push(`  - Detail: ${cell(r.detail)}`);
      return lines;
    }),
  ];
}

function roundsSection(rounds: VerificationRound[]): string[] {
  // A repair round that failed to even run (agent error/timeout/abort) sets
  // repairOutcome on the round it was attempting to repair without pushing a
  // new round — rounds.length stays 1, but a repair was attempted and its
  // failure belongs in the report just as much as a successful repair does.
  if (rounds.length <= 1 && !rounds.some((r) => r.repairOutcome !== undefined)) return [];
  const lines = ["#### Fix + Verify Rounds", ""];
  lines.push("| Round | Status | Fix verdicts | Scripts | Repair outcome |", "| --- | --- | --- | --- | --- |");
  for (const round of rounds) {
    const verdicts = round.fixVerdicts.length > 0 ? verdictCounts(round.fixVerdicts) : "—";
    const scriptsCell =
      round.scripts.length > 0
        ? `${round.scripts.filter((s) => s.status === "pass").length}/${round.scripts.length} passed`
        : "—";
    const repairText = round.repairOutcome ? cell(round.repairOutcome) : round.round === 1 ? "—" : "none reported";
    const repairCell = round.repairEscalated ? `(escalated) ${repairText}` : repairText;
    lines.push(`| ${round.round} | ${round.status} | ${cell(verdicts)} | ${scriptsCell} | ${repairCell} |`);
  }
  return lines;
}

function verificationSection(outcome: VerificationOutcome): string {
  const lines = ["### Validation Summary", ""];
  if (outcome.fixes.length === 0 && outcome.scripts.length === 0 && outcome.notes.length === 0) {
    lines.push(
      outcome.status === "skipped"
        ? "- skipped — no accepted fixes or no verification scripts found"
        : `- ${outcome.status}`,
    );
    return lines.join("\n");
  }

  lines.push(`- Status: ${outcome.status}`);
  if (outcome.fixes.length > 0) {
    const tally = (verdict: FixVerification["verdict"]): number =>
      outcome.fixes.filter((f) => f.verdict === verdict).length;
    lines.push(
      `- Fixes verified: ${tally("fixed")} fixed · ${tally("partial")} partial · ${tally("not-fixed")} not fixed · ${tally("cannot-verify")} unverified`,
    );
  }
  for (const note of outcome.notes) lines.push(`- Note: ${normalizeFindingText(note)}`);

  const rounds = roundsSection(outcome.rounds);
  if (rounds.length > 0) lines.push("", ...rounds);
  if (outcome.contested.length > 0) {
    lines.push(
      "",
      "#### Contested Verdicts",
      "",
      "The repair agent disputed these verifier verdicts. They still count as failures;",
      "review the evidence and adjudicate manually.",
      "",
      ...outcome.contested.map((c) => `- \`${findingRef(c)}\` ${c.category} — ${cell(c.reason)}`),
    );
  }
  if (outcome.fixes.length > 0) lines.push("", ...fixVerdictsTable(outcome.fixes));
  if (outcome.regressions.length > 0) lines.push("", ...regressionEvidence(outcome.regressions));

  if (outcome.scripts.length > 0) {
    lines.push("", "#### Verification Scripts", "");
    for (const r of outcome.scripts) {
      lines.push(`- \`${r.command}\`: ${r.status} (exit ${r.exitCode})`);
      if (r.status === "fail" && r.relevantOutput) {
        lines.push("", "```", normalizeMultilineText(r.relevantOutput), "```");
      }
    }
  }
  return lines.join("\n");
}

function phaseModelsLine(phaseModels: Partial<Record<string, string>> | undefined): string | undefined {
  const entries = Object.entries(phaseModels ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (entries.length === 0) return undefined;
  return `- Models: ${entries.map(([phase, label]) => `${phase} ${label}`).join(" · ")}`;
}

// ── Report flavors ─────────────────────────────────────────────────────────

/** Compact report — no findings at all, or findings but zero accepted. */
export function renderCompactReport(
  ctx: ReportContext,
  opts: {
    reason: "no-findings" | "none-accepted";
    deferred: Finding[];
    rejected: Finding[];
    fixed?: FixedFinding[];
    diagnostics: CollectionDiagnostics;
  },
): string {
  const fixed = opts.fixed ?? [];
  const reasonText =
    opts.reason === "no-findings"
      ? "No findings were reported by any reviewer pass."
      : fixed.length > 0
        ? `Findings were reported; ${fixed.length} ${fixed.length === 1 ? "was" : "were"} fixed interactively during triage, and none were accepted for batch implementation.`
        : "Findings were reported, but the user accepted none during triage.";
  return [
    frontmatter(ctx, `Persona audit of ${ctx.scope} — no actionable findings`),
    "",
    overviewSection(ctx),
    "",
    fixed.length > 0 ? "## No Batch-Applied Findings" : "## No Actionable Findings",
    "",
    reasonText,
    "",
    ...(fixed.length > 0 ? [fixedInteractivelySection(fixed), ""] : []),
    findingsSection("Deferred", opts.deferred, "None."),
    "",
    findingsSection("Rejected", opts.rejected, "None."),
    "",
    noFindingsReviewersSection(opts.diagnostics),
    "",
    collectionSection(ctx, opts.diagnostics),
    "",
    "### Validation Summary",
    "",
    "- skipped — no accepted fixes",
    "",
  ].join("\n");
}

/** Failure report — reviewer collection was incomplete or malformed. */
export function renderCollectionFailureReport(
  ctx: ReportContext,
  opts: {
    diagnostics: CollectionDiagnostics;
    reason: string;
  },
): string {
  return [
    frontmatter(ctx, `Persona audit of ${ctx.scope} — failed`),
    "",
    overviewSection(ctx),
    "",
    "## Audit Failed",
    "",
    opts.reason,
    "",
    "No findings should be inferred from this run because reviewer collection did not complete successfully.",
    "",
    collectionSection(ctx, opts.diagnostics),
    "",
    "### Validation Summary",
    "",
    "- skipped — audit failed before fixes",
    "",
  ].join("\n");
}

/** Full report — one or more findings accepted and applied. */
export function renderFullReport(
  ctx: ReportContext,
  opts: {
    accepted: Finding[];
    deferred: Finding[];
    rejected: Finding[];
    fixed?: FixedFinding[];
    applyReport: string;
    verification: VerificationOutcome;
    diagnostics: CollectionDiagnostics;
    partialReportPath?: string;
  },
): string {
  const modelsLine = phaseModelsLine(ctx.phaseModels);
  return [
    frontmatter(ctx, `Persona audit of ${ctx.scope}`),
    "",
    overviewSection(ctx),
    ...(modelsLine ? [modelsLine] : []),
    "",
    findingsSection("Applied (batch)", opts.accepted, "None."),
    "",
    ...((opts.fixed?.length ?? 0) > 0 ? [fixedInteractivelySection(opts.fixed!), ""] : []),
    "#### Adjudicator apply report",
    "",
    normalizeMultilineText(opts.applyReport) || "_No apply report produced._",
    "",
    findingsSection("Deferred", opts.deferred, "None."),
    "",
    findingsSection("Rejected", opts.rejected, "None."),
    "",
    noFindingsReviewersSection(opts.diagnostics),
    "",
    collectionSection(ctx, opts.diagnostics),
    "",
    "### Partial Failure / Cancellation",
    "",
    opts.partialReportPath
      ? `- Run completed. Progress snapshots were written to ${opts.partialReportPath} during the run.`
      : "- Run completed without a partial report.",
    "",
    verificationSection(opts.verification),
    "",
  ].join("\n");
}

function verdictCounts(fixes: FixVerification[]): string {
  const tally = (verdict: FixVerification["verdict"]): number => fixes.filter((f) => f.verdict === verdict).length;
  return `${tally("fixed")} fixed, ${tally("partial")} partial, ${tally("not-fixed")} not fixed, ${tally("cannot-verify")} unverified`;
}

/** Step 7 — chat summary rendered by the command handler after runAudit(). */
export function renderChatSummary(summary: AuditSummary): string {
  const statusLabel: Record<AuditSummary["status"], string> = {
    completed: "completed",
    "no-findings": "completed — no findings",
    "none-accepted": "completed — no findings accepted",
    cancelled: "cancelled",
    failed: "failed",
  };
  const appliedLabel = summary.implementFailedNote ? "accepted (not applied)" : "applied";
  const lines = [
    "## Audit Summary",
    "",
    `Status: ${statusLabel[summary.status]}`,
    `Scope: ${summary.scope}`,
    `Files audited: ${summary.fileCount}`,
    `Total time: ${formatDuration(summary.totalMs)}`,
    `${summary.findingsCount} issue${summary.findingsCount === 1 ? "" : "s"} found | ${summary.acceptedCount} ${appliedLabel}${summary.fixedCount > 0 ? ` | ${summary.fixedCount} fixed interactively` : ""} | ${summary.deferredCount} deferred | ${summary.rejectedCount} rejected`,
    `Verification: ${summary.verification}` +
      (summary.fixVerifications.length > 0 ? ` | ${verdictCounts(summary.fixVerifications)}` : "") +
      (summary.verifyResults.length > 0
        ? ` | Scripts run: ${summary.verifyResults.map((r) => r.script).join(", ")}`
        : " | no scripts run"),
    ...(summary.regressions.length > 0
      ? [
        `Regression tests: ${summary.regressions.filter((r) => r.proven).length} proven, ${
          summary.regressions.filter((r) => !r.proven).length
        } inconclusive`,
      ]
      : []),
    ...(summary.verificationRounds.length > 1
      ? [`Fix + verify rounds: ${summary.verificationRounds.length} (final round ${summary.verificationRounds.length}: ${summary.verification})`]
      : []),
    `Collection: ${summary.receivedRuns}/${summary.expectedRuns} reviewer passes received | ${summary.malformedCount} malformed | ${summary.missingCount} missing | cache ${summary.cacheHits} hit${summary.cacheHits === 1 ? "" : "s"} / ${summary.freshRuns} fresh`,
  ];
  for (const note of summary.verificationNotes) lines.push(`Note: ${normalizeFindingText(note)}`);
  if (summary.failureNote) lines.push(`Note: ${summary.failureNote}`);
  if (summary.implementFailedNote) lines.push(`Note: ${summary.implementFailedNote}`);
  if (summary.annotationNote) lines.push(`Note: ${summary.annotationNote}`);
  if (summary.revoiceNote) lines.push(`Note: ${summary.revoiceNote}`);
  lines.push(
    "",
    "### Reviewers Used",
    summary.reviewers.join(", "),
    "",
    "### Audit Report",
    summary.reportPath,
  );
  if (summary.handoffPath) {
    lines.push("", "### Handoff Report", summary.handoffPath);
  }
  return lines.join("\n");
}

/** Partial report — durable progress artifact updated during the run. */
export function renderPartialReport(
  ctx: ReportContext,
  opts: {
    status: "partial" | "cancelled" | "failed" | "superseded";
    runRecords: ReviewerRunRecord[];
    diagnostics: CollectionDiagnostics;
    note?: string;
  },
): string {
  const statusLine =
    opts.status === "partial"
      ? "status: partial — audit in progress; findings incomplete, no fixes applied yet"
      : opts.status === "cancelled"
        ? "status: cancelled — audit stopped before fixes were applied; findings are incomplete"
        : opts.status === "failed"
          ? "status: failed — audit aborted on error; no fixes applied by the failed phase"
          : `status: superseded — final report written to ${reportRelPath(ctx.slug)}`;

  const runLines = opts.runRecords.map((run) => {
    const normalizedDetail = normalizeFindingText(run.detail);
    const detail = normalizedDetail ? ` — ${normalizedDetail}` : "";
    const chars = run.status === "completed" || run.status === "cached" ? ` (${run.outputChars} chars)` : "";
    return `- ${run.reviewer} pass ${run.pass}: ${run.status}${chars}${detail}`;
  });

  return [
    frontmatter(ctx, `Persona audit of ${ctx.scope} — partial progress`),
    "",
    `**${statusLine}**`,
    "",
    ...(opts.note ? [opts.note, ""] : []),
    overviewSection(ctx, { inProgress: opts.status === "partial" }),
    "",
    "### Reviewer Passes",
    "",
    ...(runLines.length > 0 ? runLines : ["- none launched yet"]),
    "",
    collectionSection(ctx, opts.diagnostics),
    "",
  ].join("\n");
}
