/**
 * Fix Now: interactively fix a single finding from the review overlay.
 * Runs an edit-capable fix agent, a lightweight single-finding verifier, then
 * a user diff gate (accept / retry / discard). Accepting commits exactly the
 * touched files; discard/cancel restores only files that were clean before the
 * fix started.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runAgentSession } from "./agentRunner.ts";
import { openFixProgress, type FixProgressController } from "./components/FixProgress.ts";
import { gitCommitFiles, gitDiff, gitRestoreFiles, gitStatusPorcelain, type FileGitStatus } from "./git.ts";
import type { ThinkingLevel } from "./modelConfig.ts";
import { ADJUDICATOR_APPLY_DIRECTIVE, UNTRUSTED_DATA_RULE } from "./skillContent.ts";
import { isFailedRun } from "./subprocess.ts";
import type { Finding, FixedFinding, HeadlessOptions, HeadlessProgress, HeadlessResult, ReviewSessionState } from "./types.ts";

const AGENT_IDLE_TIMEOUT_MS = 600_000;
const MAX_FIX_ATTEMPTS = 5;

export type DirtyFileChoice = "proceed" | "no-commit" | "abort";

interface PhaseModel {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface FixNowDeps {
  ctx: Pick<ExtensionCommandContext, "cwd" | "ui" | "modelRegistry">;
  adjudicatorSystemPrompt: string;
  verifierSystemPrompt: string;
  /** Adjudicator tool allowlist; bash is stripped here, matching the batch implement phase. */
  adjudicatorTools: string[];
  readOnlyTools: string[];
  implementModel: PhaseModel;
  verifyModel: PhaseModel;
  signal?: AbortSignal;
  /** Mirrors agent telemetry into the background audit-progress table. */
  onTelemetry?: (snapshot: HeadlessProgress) => void;
  /** Injectable for tests. */
  runSession?: (options: HeadlessOptions) => Promise<HeadlessResult>;
  /** Injectable for tests — defaults to a ctx.ui.select prompt. */
  promptDirtyChoice?: (files: string[]) => Promise<DirtyFileChoice>;
  /** Injectable for tests — defaults to openFixProgress. */
  openProgress?: (
    ctx: Pick<ExtensionCommandContext, "ui">,
    finding: Finding,
    onCancelRequest: () => void,
  ) => FixProgressController;
}

/** Directive for the single-finding verifier pass. Kept lean — the full pipeline verifier machinery is batch-phase only. */
const FIX_VERIFY_DIRECTIVE = [
  "You are verifying that a single code-review fix was correctly applied to the working tree.",
  "Read the changed files and judge whether the fix resolves the finding without introducing obvious regressions.",
  "Do not edit anything.",
  "",
  "Report your judgement as the final two lines of your reply, exactly:",
  "VERDICT: fixed | partial | not-fixed | cannot-verify",
  "EVIDENCE: <one line of concrete evidence for the verdict>",
].join("\n");

function buildFixTask(finding: Finding, verifierFeedback?: string): string {
  const sections = [
    ADJUDICATOR_APPLY_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Your Files",
    "",
    JSON.stringify([finding.file]),
    "",
    "## Accepted Findings (JSON)",
    "",
    JSON.stringify([finding]),
  ];
  if (verifierFeedback) {
    sections.push(
      "",
      "## Verifier Feedback",
      "",
      "A previous attempt at this fix was rejected. The changes were reverted — the tree is back to its pre-fix state. Address this feedback:",
      "",
      verifierFeedback,
    );
  }
  return sections.join("\n");
}

function buildFixVerifyTask(cwd: string, finding: Finding, diff: string): string {
  return [
    FIX_VERIFY_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Context",
    "",
    `- Working directory: ${cwd}`,
    "",
    "## Finding (JSON)",
    "",
    JSON.stringify(finding),
    "",
    "## Diff Of The Applied Fix",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/** Parse the verifier's trailing VERDICT/EVIDENCE lines. Undefined when unparsable. */
export function parseFixVerdict(text: string): { verdict: string; evidence: string } | undefined {
  const verdictMatch = /^VERDICT:\s*(fixed|partial|not-fixed|cannot-verify)\s*$/im.exec(text);
  if (!verdictMatch) return undefined;
  const evidenceMatch = /^EVIDENCE:\s*(.+)$/im.exec(text);
  return { verdict: verdictMatch[1]!.toLowerCase(), evidence: evidenceMatch?.[1]?.trim() ?? "" };
}

/** Build a deterministic commit message from the finding. */
export function fixCommitMessage(finding: Finding): string {
  const loc = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  const subject = `fix(${finding.category}): ${loc} — ${finding.rationale}`;
  const body = [
    `Audit finding by ${finding.reviewer} (${finding.severity}).`,
    "",
    finding.suggestedChange,
    "",
    "Fixed interactively via persona-audit Fix Now.",
  ].join("\n");
  return `${subject}\n\n${body}`;
}

/** Files the agent touched, split by whether they were clean before the fix. */
interface TouchedFiles {
  /** Clean before the fix — safe to restore on discard/retry. */
  cleanTracked: string[];
  /** Created by the agent — safe to delete on discard/retry. */
  cleanUntracked: string[];
  /** Dirty before the fix — never auto-reverted. */
  wasDirty: string[];
}

function diffTouched(baseline: Map<string, FileGitStatus>, post: Map<string, FileGitStatus>): TouchedFiles {
  const cleanTracked: string[] = [];
  const cleanUntracked: string[] = [];
  for (const [file, status] of post) {
    if (baseline.has(file)) continue;
    (status.untracked ? cleanUntracked : cleanTracked).push(file);
  }
  return { cleanTracked, cleanUntracked, wasDirty: [] };
}

/**
 * Run the interactive fix flow for one finding. On accept, mutates `state`
 * (status → "fixed", FixedFinding recorded); on discard/cancel/error the state
 * is left untouched so the review reopens exactly where it was.
 */
export async function runFixNow(
  deps: FixNowDeps,
  finding: Finding,
  index: number,
  state: ReviewSessionState,
): Promise<void> {
  const { ctx } = deps;
  const runSession = deps.runSession ?? runAgentSession;
  const notify = (message: string, type: "info" | "warning" | "error" = "info"): void =>
    ctx.ui.notify(`persona-audit: ${message}`, type);
  // Session errors can embed multi-hundred-line payloads (e.g. resolveModelRef
  // appends the full model catalog); a toast needs only the first line.
  const briefError = (message: string | undefined): string => {
    const firstLine = (message ?? "").split("\n", 1)[0]!.trim();
    return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine || "unknown error";
  };

  // ── Dirty-target check ───────────────────────────────────────────────────
  let autoCommit = true;
  let baseline: Map<string, FileGitStatus>;
  try {
    const targetStatus = await gitStatusPorcelain(ctx.cwd, [finding.file]);
    if (targetStatus.size > 0) {
      const promptChoice = deps.promptDirtyChoice ?? (async (files: string[]): Promise<DirtyFileChoice> => {
        const picked = await ctx.ui.select(
          `${files.join(", ")} already has uncommitted changes`,
          [
            "Proceed — my changes get included in the fix commit",
            "Fix without auto-commit — I'll commit manually",
            "Abort — back to the findings list",
          ],
        );
        if (picked?.startsWith("Proceed")) return "proceed";
        if (picked?.startsWith("Fix without")) return "no-commit";
        return "abort";
      });
      const choice = await promptChoice([...targetStatus.keys()]);
      if (choice === "abort") return;
      if (choice === "no-commit") autoCommit = false;
    }
    baseline = await gitStatusPorcelain(ctx.cwd);
  } catch (error) {
    notify(`fix now unavailable — git status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  // ── Fix / verify / gate loop ─────────────────────────────────────────────
  const abort = new AbortController();
  const onUpstreamAbort = (): void => abort.abort();
  deps.signal?.addEventListener("abort", onUpstreamAbort, { once: true });
  if (deps.signal?.aborted) abort.abort();

  const openProgress = deps.openProgress ?? openFixProgress;
  const controller = openProgress(ctx, finding, () => abort.abort());

  let touched: TouchedFiles = { cleanTracked: [], cleanUntracked: [], wasDirty: [] };
  const cleanup = async (): Promise<void> => {
    try {
      await gitRestoreFiles(ctx.cwd, touched.cleanTracked, touched.cleanUntracked);
    } catch (error) {
      notify(`could not revert the fix's edits: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    if (touched.wasDirty.length > 0) {
      notify(`left ${touched.wasDirty.join(", ")} untouched — had pre-existing edits`, "warning");
    }
  };

  try {
    let verifierFeedback: string | undefined;
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      controller.setPhase("fixing", `applying ${finding.category} fix`, attempt);
      const fixRun = await runSession({
        agentName: "fix now implement",
        systemPrompt: deps.adjudicatorSystemPrompt,
        tools: deps.adjudicatorTools.filter((t) => t !== "bash"),
        model: deps.implementModel.model,
        thinking: deps.implementModel.thinking,
        task: buildFixTask(finding, verifierFeedback),
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        signal: abort.signal,
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        onProgress: (snapshot) => {
          controller.applyProgress(snapshot);
          deps.onTelemetry?.(snapshot);
        },
      });
      if (abort.signal.aborted) {
        await computeTouched();
        await cleanup();
        notify("fix cancelled — edits reverted");
        return;
      }
      if (isFailedRun(fixRun)) {
        await computeTouched();
        await cleanup();
        notify(`fix agent failed: ${briefError(fixRun.errorMessage || fixRun.stopReason)}`, "error");
        return;
      }

      await computeTouched();
      const changedFiles = [...touched.cleanTracked, ...touched.cleanUntracked, ...touched.wasDirty];
      const diff = changedFiles.length > 0 ? await gitDiff(ctx.cwd, changedFiles, touched.cleanUntracked) : "";

      // ── Lightweight verifier pass ────────────────────────────────────────
      const warnings: string[] = [];
      let verdictNote: string | undefined;
      let verdict: { verdict: string; evidence: string } | undefined;
      if (diff.trim().length === 0) {
        warnings.push("the fix agent reported success but made no changes on disk");
      } else {
        controller.setPhase("verifying", "checking the fix", attempt);
        const verifyRun = await runSession({
          agentName: "fix now verify",
          systemPrompt: deps.verifierSystemPrompt,
          tools: deps.readOnlyTools,
          model: deps.verifyModel.model,
          thinking: deps.verifyModel.thinking,
          task: buildFixVerifyTask(ctx.cwd, finding, diff),
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          signal: abort.signal,
          idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
          onProgress: (snapshot) => {
            controller.applyProgress(snapshot);
            deps.onTelemetry?.(snapshot);
          },
        });
        if (abort.signal.aborted) {
          await cleanup();
          notify("fix cancelled — edits reverted");
          return;
        }
        if (isFailedRun(verifyRun)) {
          warnings.push(`verifier failed (${briefError(verifyRun.errorMessage || verifyRun.stopReason)}) — judge the diff yourself`);
        } else {
          verdict = parseFixVerdict(verifyRun.finalText || verifyRun.allText);
          if (!verdict) {
            warnings.push("verifier output was unparsable — judge the diff yourself");
          } else if (verdict.verdict === "fixed") {
            verdictNote = `verifier: fixed — ${verdict.evidence}`;
          } else {
            warnings.push(`verifier: ${verdict.verdict} — ${verdict.evidence}`);
          }
        }
      }
      if (!autoCommit) warnings.push("auto-commit is off for this fix — accepted changes stay uncommitted");

      // ── User gate ────────────────────────────────────────────────────────
      const decision = await controller.gate({ diff, verdictNote, warnings, commitPlanned: autoCommit, attempt });

      if (decision === "retry") {
        await cleanup();
        touched = { cleanTracked: [], cleanUntracked: [], wasDirty: [] };
        verifierFeedback = verdict
          ? `VERDICT: ${verdict.verdict}\nEVIDENCE: ${verdict.evidence}`
          : "The previous attempt produced no acceptable change.";
        continue;
      }
      if (decision === "discard") {
        await cleanup();
        notify("fix discarded — edits reverted");
        return;
      }

      // ── Accept ───────────────────────────────────────────────────────────
      const commitFiles = [...new Set([...changedFiles])];
      let commitSha: string | undefined;
      if (autoCommit && commitFiles.length > 0) {
        try {
          commitSha = await gitCommitFiles(ctx.cwd, commitFiles, fixCommitMessage(finding));
        } catch (error) {
          notify(`commit failed: ${error instanceof Error ? error.message : String(error)} — fix kept on disk, uncommitted`, "error");
        }
      }
      const fixed: FixedFinding = { finding, commitSha, files: commitFiles };
      state.statuses[index] = "fixed";
      state.fixed.set(index, fixed);
      notify(commitSha ? `fixed ${finding.file} — committed ${commitSha}` : `fixed ${finding.file} — not committed`);
      return;
    }
    notify(`giving up after ${MAX_FIX_ATTEMPTS} attempts — finding left unfixed`, "warning");
    await cleanup();
  } finally {
    deps.signal?.removeEventListener("abort", onUpstreamAbort);
    await controller.close();
  }

  async function computeTouched(): Promise<void> {
    const post = await gitStatusPorcelain(ctx.cwd);
    touched = diffTouched(baseline, post);
    if (baseline.has(finding.file) && post.has(finding.file)) {
      touched.wasDirty.push(finding.file);
    }
  }
}
