/**
 * Fix Now: interactively fix a single finding from the review overlay.
 * Runs an edit-capable fix agent, a lightweight single-finding verifier, then
 * a user diff gate (accept / retry / discard, or chat to ask about impact or
 * request changes). Accepting commits exactly the touched files; discard/cancel
 * restores only files that were clean before the fix started.
 */

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createInteractiveAgentSession,
  runAgentSession,
  type InteractiveAgentSession,
} from "./agentRunner.ts";
import { openFixProgress, type FixChatMessage, type FixProgressController } from "./components/FixProgress.ts";
import { gitCommitFiles, gitDiff, gitRestoreFiles, gitStatusPorcelain, type FileGitStatus } from "./git.ts";
import type { ThinkingLevel } from "./modelConfig.ts";
import { FIX_NOW_APPLY_DIRECTIVE, UNTRUSTED_DATA_RULE } from "./skillContent.ts";
import { resolveTargetPath } from "./snapshot.ts";
import { isFailedRun } from "./subprocess.ts";
import type { Finding, FixedFinding, HeadlessOptions, HeadlessResult, ReviewSessionState } from "./types.ts";

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

/**
 * Directive for the single-finding verifier pass. Kept lean — the full pipeline
 * verifier machinery is batch-phase only. Test edits in the diff are part of the
 * fix, so the verifier must judge them rather than count them as regressions.
 */
const FIX_VERIFY_DIRECTIVE = [
  "You are verifying that a single code-review fix was correctly applied to the working tree.",
  "Read the changed files and judge whether the fix resolves the finding without introducing obvious regressions.",
  "The fix agent was told to update existing tests that exercise the changed code. Test edits in the diff are part of the fix, not regressions, unless they weaken an assertion.",
  "Grep the test files for the changed symbols. A test that still asserts the old behavior the fix replaced means the fix is partial.",
  "A deleted, skipped, commented-out, or loosened assertion means the fix is not-fixed, whatever the source change looks like.",
  "Do not edit anything.",
  "",
  "Report your judgement as the final two lines of your reply, exactly:",
  "VERDICT: fixed | partial | not-fixed | cannot-verify",
  "EVIDENCE: <one line of concrete evidence for the verdict>",
].join("\n");

function buildFixTask(finding: Finding, verifierFeedback?: string): string {
  const sections = [
    FIX_NOW_APPLY_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Target File",
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

function buildFixFollowUpTask(userMessage: string): string {
  return [
    "The user is reviewing your proposed fix in Fix Now and sent a follow-up message / question.",
    "",
    "Instructions:",
    "- If the user asks a question, requests clarification, or asks about impact / callers, use read/grep/find/ls tools to inspect the repository and answer accurately. Do not edit files unless explicitly asked to modify the code.",
    "- If the user asks you to modify, adjust, or redo the fix, apply the edits directly using edit/write tools, then re-check the existing tests that exercise the changed code and update any that encode the replaced behavior. Never weaken an assertion to make a test agree.",
    "- Never modify files that were dirty before the fix started or are unrelated to this finding.",
    "",
    "## User Message",
    "",
    userMessage,
  ].join("\n");
}

/** Parse the verifier's trailing VERDICT/EVIDENCE lines. Undefined when unparsable. */
export function parseFixVerdict(text: string): { verdict: string; evidence: string } | undefined {
  const matches = [
    ...text.matchAll(/^[ \t]*VERDICT:\s*(fixed|partial|not-fixed|cannot-verify)\s*$(?:\r?\n(?:[ \t]*\r?\n)*[ \t]*EVIDENCE:\s*(.*)$)?/gim),
  ];
  const last = matches[matches.length - 1];
  if (!last) return undefined;
  return { verdict: last[1]!.toLowerCase(), evidence: last[2]?.trim() ?? "" };
}

/** Hard cap on the rendered commit subject, prefix included. */
const COMMIT_SUBJECT_MAX = 72;

/** Directive for the no-tools commit-subject summarizer run at accept time. */
const COMMIT_SUMMARY_DIRECTIVE = [
  "Summarize the code-review finding below into a git commit subject.",
  "Requirements:",
  "- Imperative mood (e.g. \"Stop trusting user-editable metadata for admin checks\").",
  "- At most 55 characters.",
  "- No file paths, line numbers, type prefix, quotes, or trailing period.",
  "Reply with the subject line only.",
].join("\n");

function buildCommitSummaryTask(finding: Finding): string {
  return [
    COMMIT_SUMMARY_DIRECTIVE,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "## Finding (JSON)",
    "",
    JSON.stringify(finding),
  ].join("\n");
}

/**
 * Sanitize the summarizer's reply into a usable subject fragment: first
 * non-empty line, stripped of fences/quotes/type prefixes/trailing period,
 * whitespace collapsed. Undefined when nothing usable remains, so the caller
 * falls back to the finding's rationale.
 */
export function parseCommitSummary(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("```"));
  if (!line) return undefined;
  const cleaned = line
    .replace(/^[`"'“]+|[`"'”]+$/g, "")
    .replace(/^(?:fix|feat|chore|refactor)(?:\([^)]*\))?:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim();
  return cleaned || undefined;
}

/**
 * Build the commit message from the finding: an LLM-summarized subject when a
 * summary is available (rationale otherwise), never the file/line — that
 * detail belongs to the diff, and locations blow the subject-length budget.
 */
export function fixCommitMessage(finding: Finding, summary?: string): string {
  const prefix = `fix(${finding.category}): `;
  const budget = Math.max(20, COMMIT_SUBJECT_MAX - prefix.length);
  const raw = summary?.trim() || finding.rationale;
  const clipped = raw.length > budget ? `${raw.slice(0, budget - 1).trimEnd()}…` : raw;
  const subject = `${prefix}${clipped}`;
  const body = [
    `Audit finding (${finding.severity} priority) by ${finding.reviewer} persona.`,
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

  const targetPath = resolveTargetPath(ctx.cwd, finding.file);
  if (targetPath === undefined) {
    notify(`fix now unavailable — target path escapes project root: ${finding.file}`, "error");
    return;
  }
  const cwdReal = await realpath(path.resolve(ctx.cwd));
  const targetReal = await realpath(targetPath).catch(() => undefined);
  if (targetReal) {
    const relToCwd = path.relative(cwdReal, targetReal);
    if (relToCwd.startsWith("..") || path.isAbsolute(relToCwd)) {
      notify(`fix now unavailable — target path escapes project root via symlink: ${finding.file}`, "error");
      return;
    }
  }

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
      let session: InteractiveAgentSession | undefined;
      const chatHistory: FixChatMessage[] = [];
      try {
        if (deps.runSession) {
          let disposed = false;
          session = {
            async prompt(task: string): Promise<HeadlessResult> {
              if (disposed) return { finalText: "", allText: "", aborted: false, stopReason: "error", errorMessage: "session disposed", usage: { turns: 0, contextTokens: 0, outputTokens: 0 } };
              return deps.runSession!({
                agentName: "fix now implement",
                systemPrompt: deps.adjudicatorSystemPrompt,
                tools: deps.adjudicatorTools.filter((t) => t !== "bash"),
                model: deps.implementModel.model,
                thinking: deps.implementModel.thinking,
                task,
                cwd: ctx.cwd,
                modelRegistry: ctx.modelRegistry,
                signal: abort.signal,
                idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
                onProgress: (snapshot) => {
                  controller.applyProgress(snapshot);
                },
              });
            },
            dispose() {
              disposed = true;
            },
          };
        } else {
          session = await createInteractiveAgentSession({
            agentName: "fix now implement",
            systemPrompt: deps.adjudicatorSystemPrompt,
            tools: deps.adjudicatorTools.filter((t) => t !== "bash"),
            model: deps.implementModel.model,
            thinking: deps.implementModel.thinking,
            cwd: ctx.cwd,
            modelRegistry: ctx.modelRegistry,
            signal: abort.signal,
            idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
            onProgress: (snapshot) => {
              controller.applyProgress(snapshot);
            },
          });
        }

        controller.setPhase("fixing", `applying ${finding.category} fix`, attempt);
        const fixRun = await session.prompt(buildFixTask(finding, verifierFeedback));
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
        let changedFiles = [...touched.cleanTracked, ...touched.cleanUntracked, ...touched.wasDirty];
        let diff = changedFiles.length > 0 ? await gitDiff(ctx.cwd, changedFiles, touched.cleanUntracked) : "";

        // ── Lightweight verifier pass ────────────────────────────────────────
        let warnings: string[] = [];
        let verdictNote: string | undefined;
        let verdict: { verdict: string; evidence: string } | undefined;

        const runVerifierPass = async (currentDiff: string): Promise<void> => {
          warnings = [];
          verdictNote = undefined;
          verdict = undefined;
          if (currentDiff.trim().length === 0) {
            warnings.push("the fix agent reported success but made no changes on disk");
            return;
          }
          controller.setPhase("verifying", "checking the fix", attempt);
          const verifyRun = await runSession({
            agentName: "fix now verify",
            systemPrompt: deps.verifierSystemPrompt,
            tools: deps.readOnlyTools,
            model: deps.verifyModel.model,
            thinking: deps.verifyModel.thinking,
            task: buildFixVerifyTask(ctx.cwd, finding, currentDiff),
            cwd: ctx.cwd,
            modelRegistry: ctx.modelRegistry,
            signal: abort.signal,
            idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
            onProgress: (snapshot) => {
              controller.applyProgress(snapshot);
            },
          });
          if (abort.signal.aborted) return;
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
        };

        await runVerifierPass(diff);
        if (abort.signal.aborted) {
          await cleanup();
          notify("fix cancelled — edits reverted");
          return;
        }

        // ── Conversational gate loop ──────────────────────────────────────────
        let attemptDecision: "accept" | "retry" | "discard" | undefined;
        while (!attemptDecision) {
          const activeWarnings = [...warnings];
          if (!autoCommit) activeWarnings.push("auto-commit is off for this fix — accepted changes stay uncommitted");

          const decision = await controller.gate({
            diff,
            verdictNote,
            warnings: activeWarnings,
            commitPlanned: autoCommit,
            attempt,
            chatHistory,
          });

          if (typeof decision === "object" && decision.type === "chat") {
            chatHistory.push({ role: "user", text: decision.message });
            controller.setPhase("fixing", "refining fix / answering question", attempt);
            const preDiff = diff;
            const chatRun = await session.prompt(buildFixFollowUpTask(decision.message));
            if (abort.signal.aborted) {
              await computeTouched();
              await cleanup();
              notify("fix cancelled — edits reverted");
              return;
            }

            const replyText = chatRun.finalText || chatRun.allText;
            if (isFailedRun(chatRun)) {
              const errText = `Fix agent error: ${briefError(chatRun.errorMessage || chatRun.stopReason)}`;
              chatHistory.push({ role: "assistant", text: replyText ? `${replyText}\n\n${errText}` : errText });
            } else {
              chatHistory.push({ role: "assistant", text: replyText || "(No reply text provided.)" });
            }

            await computeTouched();
            changedFiles = [...touched.cleanTracked, ...touched.cleanUntracked, ...touched.wasDirty];
            const newDiff = changedFiles.length > 0 ? await gitDiff(ctx.cwd, changedFiles, touched.cleanUntracked) : "";

            if (newDiff !== preDiff) {
              diff = newDiff;
              await runVerifierPass(diff);
              if (abort.signal.aborted) {
                await cleanup();
                notify("fix cancelled — edits reverted");
                return;
              }
            }
            continue;
          }

          if (decision === "accept" || decision === "retry" || decision === "discard") {
            attemptDecision = decision;
          }
        }

        if (attemptDecision === "retry") {
          session.dispose();
          await cleanup();
          touched = { cleanTracked: [], cleanUntracked: [], wasDirty: [] };
          verifierFeedback = verdict
            ? `VERDICT: ${verdict.verdict}\nEVIDENCE: ${verdict.evidence}`
            : "The previous attempt produced no acceptable change.";
          continue;
        }
        if (attemptDecision === "discard") {
          session.dispose();
          await cleanup();
          notify("fix discarded — edits reverted");
          return;
        }

        // ── Accept ───────────────────────────────────────────────────────────
        session.dispose();
        const commitFiles = [...new Set([...touched.cleanTracked, ...touched.cleanUntracked, ...(baseline.has(finding.file) ? [finding.file] : [])])];
        let commitSha: string | undefined;
        if (autoCommit && commitFiles.length > 0) {
          // Short no-tools pass to compress the rationale into a subject-length
          // summary. Any failure (including a cancel) just falls back to the
          // rationale — the fix is already accepted and must still be committed.
          let summary: string | undefined;
          const summaryRun = await runSession({
            agentName: "fix now commit subject",
            systemPrompt: "You write concise, imperative git commit subjects.",
            tools: [],
            model: deps.implementModel.model,
            thinking: deps.implementModel.thinking,
            task: buildCommitSummaryTask(finding),
            cwd: ctx.cwd,
            modelRegistry: ctx.modelRegistry,
            signal: abort.signal,
            idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
            onProgress: (snapshot) => {
              controller.applyProgress(snapshot);
            },
          });
          if (!isFailedRun(summaryRun)) {
            summary = parseCommitSummary(summaryRun.finalText || summaryRun.allText);
          }
          try {
            commitSha = await gitCommitFiles(ctx.cwd, commitFiles, fixCommitMessage(finding, summary));
          } catch (error) {
            notify(`commit failed: ${error instanceof Error ? error.message : String(error)} — fix kept on disk, uncommitted`, "error");
          }
        }
        const fixed: FixedFinding = { finding, commitSha, files: commitFiles };
        state.statuses[index] = "fixed";
        state.fixed.set(index, fixed);
        notify(commitSha ? `fixed ${finding.file} — committed ${commitSha}` : `fixed ${finding.file} — not committed`);
        return;
      } finally {
        session?.dispose();
      }
    }
    notify(`giving up after ${MAX_FIX_ATTEMPTS} attempts — finding left unfixed`, "warning");
    await cleanup();
  } catch (error) {
    await computeTouched();
    await cleanup();
    throw error;
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
