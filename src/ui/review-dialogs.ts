import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog, type DialogHost } from "@underactive/pi-topping-opentui/host";
import { isThinkingLevel, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";
import { createElement } from "react";
import type { FixGateInput, FixGateDecision } from "../components/FixProgress.ts";
import { normalizeFindingText } from "../dedup.ts";
import { hasSuggestion, type TriageSuggestion, type TriageSuggestionFeed } from "../decision/triage.ts";
import { compareFindingsByExploitability, compareFindingsBySuggestion } from "../findingOrder.ts";
import { gitHeadCommit } from "../git.ts";
import { modelRefLabel, type ModelRef, type PhaseModelChoice } from "../modelConfig.ts";
import { handoffRelPath, renderDeferredHandoff, writeReportFile } from "../report.ts";
import { SEVERITY_ORDER } from "../types.ts";
import type { Finding, FixedFinding, FindingsReviewOutcome, FindingsReviewResult, ReviewSessionState, ReviewSortMode } from "../types.ts";
import { modelKey, readDialogModels } from "./dialog-models.ts";
import { DIALOG_MAX_HEIGHT, DIALOG_WIDTH } from "./dialog-fit.ts";
import { FindingsReview, type ReviewOutcome as DialogReviewOutcome, type ReviewState as DialogReviewState } from "./generated/persona-audit/findings-review.ts";
import type { Finding as DialogFinding, FindingSuggestion, ModelChoice as DialogModelChoice } from "./generated/persona-audit/data.ts";
import { RetryCheckpoint, type RetryKind, type RetryResult, type ReviewerFailure as DialogReviewerFailure } from "./generated/persona-audit/prompts.ts";
import { FixGate, ReportViewer } from "./generated/persona-audit/viewers.ts";

/** Header metadata shown above the saved report. */
export interface ReportViewerHeader {
  /** Optional replacement for the standard audit-report heading. */
  title?: string;
  status: string;
  findingCount: number;
  verification: string;
  reportPath: string;
}

function reportFailure(ctx: Pick<ExtensionCommandContext, "ui">, label: string, error: unknown): void {
  ctx.ui.notify(`${label} dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
}

function toDialogSuggestion(suggestion: TriageSuggestion | undefined): FindingSuggestion | undefined {
  if (!suggestion || !hasSuggestion(suggestion)) return undefined;
  return {
    ...(suggestion.category ? { category: suggestion.category } : {}),
    categoryConfidence: suggestion.categoryConfidence,
    ...(suggestion.verdict ? { verdict: suggestion.verdict } : {}),
    verdictConfidence: suggestion.verdictConfidence,
    ...(suggestion.changeKind ? { changeKind: suggestion.changeKind } : {}),
    changeKindConfidence: suggestion.changeKindConfidence,
  };
}

function toDialogFinding(finding: Finding): DialogFinding {
  const suggestion = toDialogSuggestion(finding.triageSuggestion);
  return {
    reviewer: finding.reviewer,
    file: finding.file,
    line: finding.line,
    category: finding.category,
    severity: finding.severity,
    summary: finding.summary ?? finding.rationale,
    rationale: finding.rationale,
    suggestedChange: finding.suggestedChange,
    recommendation: finding.recommendation ?? "apply",
    ...(finding.recommendationReason ? { recommendationReason: finding.recommendationReason } : {}),
    ...(finding.exploitability ? { exploitability: finding.exploitability } : {}),
    ...(finding.exploitabilityReason ? { exploitabilityReason: finding.exploitabilityReason } : {}),
    ...(finding.blastRadius ? { blast: finding.blastRadius } : {}),
    ...(finding.disputes ? { disputes: finding.disputes } : {}),
    ...(finding.derivedFrom ? { derivedFrom: finding.derivedFrom } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

function toDialogReviewState(state: ReviewSessionState): DialogReviewState {
  const fixedSha: Record<number, string> = {};
  for (const [index, fixed] of state.fixed) {
    if (fixed.commitSha) fixedSha[index] = fixed.commitSha;
  }
  return {
    statuses: [...state.statuses],
    selected: state.selectedIndex,
    sort: state.sortMode ?? "file",
    expanded: [...(state.expanded ?? [])],
    fixedSha,
    ...(state.handoffPath ? { handoffPath: state.handoffPath } : {}),
  };
}

function fromDialogReviewState(state: DialogReviewState, previous?: ReviewSessionState): ReviewSessionState {
  const handoffPath = state.handoffPath ?? previous?.handoffPath;
  return {
    statuses: [...state.statuses],
    selectedIndex: state.selected,
    sortMode: state.sort,
    expanded: [...state.expanded],
    fixed: new Map(previous?.fixed ?? []),
    ...(handoffPath ? { handoffPath } : {}),
  };
}

function fromDialogReviewOutcome(
  outcome: DialogReviewOutcome,
  findings: readonly Finding[],
  previous?: ReviewSessionState,
): FindingsReviewOutcome {
  if (outcome.kind === "cancelled") return { kind: "cancelled" };
  const state = fromDialogReviewState(outcome.state, previous);
  if (outcome.kind === "fixNow") return { kind: "fixNow", index: outcome.index, state };

  const accepted: Finding[] = [];
  const rejected: Finding[] = [];
  const deferred: Finding[] = [];
  const fixed: FixedFinding[] = [];
  outcome.state.statuses.forEach((status, index) => {
    const finding = findings[index];
    if (!finding) return;
    if (status === "apply") accepted.push(finding);
    else if (status === "reject") rejected.push(finding);
    else if (status === "defer") deferred.push(finding);
    else fixed.push(state.fixed.get(index) ?? { finding, files: [finding.file] });
  });
  const result: FindingsReviewResult = {
    accepted,
    rejected,
    deferred,
    fixed,
    ...(state.handoffPath ? { handoffPath: state.handoffPath } : {}),
  };
  return { kind: "finalized", result };
}

/**
 * The review's order within a recommendation group, by finding index: the extension's ranking,
 * not the mockup's sample one. File sorts by path, line, then severity; priority is the
 * exploitability order the report uses; reviewer ignores case; blast puts the widest reach
 * first; suggested ranks by what the decision classifier suggested, read from the live feed
 * so it matches the badges, and falls back to the exploitability order. Ties keep the
 * adjudicator's order.
 */
export function findingsComparator(
  findings: readonly Finding[],
  feed?: TriageSuggestionFeed,
): (sort: ReviewSortMode, a: number, b: number) => number {
  const suggested = (index: number): Finding => {
    const finding = findings[index]!;
    const suggestion = feed?.get(index);
    return suggestion ? { ...finding, triageSuggestion: suggestion } : finding;
  };
  return (sort, a, b) => {
    const left = findings[a]!;
    const right = findings[b]!;
    const severity = SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity);
    const file = left.file.localeCompare(right.file);
    const line = left.line - right.line;
    const original = a - b;
    switch (sort) {
      case "file":
        return file || line || severity || original;
      case "priority":
        return compareFindingsByExploitability(left, right) || original;
      case "reviewer":
        return left.reviewer.localeCompare(right.reviewer, undefined, { sensitivity: "base" }) || severity || file || line || original;
      case "blast":
        return (right.blastRadius?.score ?? -1) - (left.blastRadius?.score ?? -1) || severity || file || line || original;
      case "suggested":
        return compareFindingsBySuggestion(suggested(a), suggested(b)) || original;
    }
  };
}

export async function openFindingsReviewDialog(
  ctx: ExtensionCommandContext,
  findings: Finding[],
  degradationNote?: string,
  restore?: ReviewSessionState,
  feed?: TriageSuggestionFeed,
  onWriteHandoff?: (deferred: Finding[]) => Promise<string>,
): Promise<FindingsReviewOutcome | undefined> {
  try {
    const dialogFindings = findings.map(toDialogFinding);
    const outcome = await showOpenTuiDialog<DialogReviewOutcome>(
      ctx,
      (done) => createElement(FindingsReview, {
        width: DIALOG_WIDTH,
        findings: dialogFindings,
        compare: findingsComparator(findings, feed),
        ...(degradationNote ? { degradationNote } : {}),
        ...(restore ? { restore: toDialogReviewState(restore) } : {}),
        ...(onWriteHandoff ? {
          onHandoff: (indices: number[]) => onWriteHandoff(indices.flatMap((index) => findings[index] ? [findings[index]!] : [])),
        } : {}),
        ...(feed ? {
          suggestionFor: (index: number) => toDialogSuggestion(feed.get(index)),
          subscribeSuggestions: (onChange: () => void) => feed.subscribe(onChange),
        } : {}),
        onDone: done,
      }),
      {
        title: "persona-audit: Findings Review",
        width: DIALOG_WIDTH,
        maxHeight: DIALOG_MAX_HEIGHT,
        fallback: { kind: "cancelled", state: { statuses: [], selected: 0, sort: "file", expanded: [], fixedSha: {} } },
      },
    );
    return fromDialogReviewOutcome(outcome, findings, restore);
  } catch (error) {
    reportFailure(ctx, "Persona-audit findings review", error);
    return undefined;
  }
}

function currentModelRef(ctx: ExtensionCommandContext, current: { label: string; ref?: ModelRef }, availableRefs: readonly ModelRef[]): ModelRef | undefined {
  if (current.ref) return current.ref;
  if (ctx.model) return { provider: ctx.model.provider, id: ctx.model.id };
  return availableRefs[0];
}

export function dialogRetryModelToPhaseChoice(
  choice: DialogModelChoice,
  refs: readonly ModelRef[],
): PhaseModelChoice | undefined {
  const ref = refs.find((candidate) => modelKey(candidate) === choice.id);
  if (!ref) return undefined;
  const thinking: ThinkingLevel = isThinkingLevel(choice.level) ? choice.level : "off";
  return { ref: { ...ref }, thinking };
}

export async function openRetryCheckpointDialog(
  ctx: ExtensionCommandContext,
  kind: RetryKind,
  current: { label: string; ref?: ModelRef },
  currentThinking: ThinkingLevel,
  availableRefs: ModelRef[],
  options: { detail?: string; failures?: DialogReviewerFailure[] } = {},
): Promise<RetryResult | undefined> {
  const activeRef = currentModelRef(ctx, current, availableRefs);
  if (!activeRef) return undefined;
  const sessionRef = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const pinned = [current.ref, sessionRef].filter((ref): ref is ModelRef => ref !== undefined);
  const models = readDialogModels(ctx, availableRefs, pinned);
  const selected: DialogModelChoice = { id: modelRefLabel(activeRef), level: currentThinking };
  const fallback: RetryResult = kind === "reviewer"
    ? { kind, cancelled: false, retries: [] }
    : { kind, retry: false };
  try {
    return await showOpenTuiDialog<RetryResult>(
      ctx,
      (done) => createElement(RetryCheckpoint, {
        width: DIALOG_WIDTH,
        kind,
        current: selected,
        models,
        // Provider errors arrive with line breaks and stray control bytes; the checkpoint shows them as one line.
        ...(options.detail !== undefined ? { detail: normalizeFindingText(options.detail) } : {}),
        ...(options.failures !== undefined
          ? { failures: options.failures.map((failure) => ({ ...failure, detail: normalizeFindingText(failure.detail).replace(/\s+/g, " ") })) }
          : {}),
        onDone: done,
      }),
      {
        title: `persona-audit: ${kind} retry checkpoint`,
        width: DIALOG_WIDTH,
        maxHeight: DIALOG_MAX_HEIGHT,
        fallback,
      },
    );
  } catch (error) {
    reportFailure(ctx, `Persona-audit ${kind} retry`, error);
    return undefined;
  }
}

export function toDialogFixFinding(finding: Finding): DialogFinding {
  return toDialogFinding(finding);
}

export async function openFixGateDialog(
  ctx: DialogHost,
  finding: Finding,
  input: FixGateInput,
  onReady?: (settle: (decision: FixGateDecision) => void) => void,
  onError?: (error: unknown) => void,
): Promise<FixGateDecision | undefined> {
  try {
    return await showOpenTuiDialog<FixGateDecision>(
      ctx,
      (done) => {
        onReady?.(done);
        return createElement(FixGate, {
          width: DIALOG_WIDTH,
          finding: toDialogFixFinding(finding),
          diff: input.diff,
          ...(input.verdictNote ? { verdict: input.verdictNote } : {}),
          ...(input.warnings ? { warnings: input.warnings } : {}),
          commitPlanned: input.commitPlanned,
          attempt: input.attempt,
          ...(input.chatHistory ? { chat: input.chatHistory } : {}),
          onDone: done,
        });
      },
      {
        title: `persona-audit: Fix Now — ${finding.file}`,
        width: DIALOG_WIDTH,
        maxHeight: DIALOG_MAX_HEIGHT,
        fallback: "discard",
      },
    );
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

export async function openReportViewerDialog(
  ctx: ExtensionCommandContext,
  reportText: string,
  header: ReportViewerHeader,
): Promise<boolean> {
  const title = header.title ?? `Audit Report — ${header.status} · ${header.findingCount} findings · verification ${header.verification}`;
  try {
    await showOpenTuiDialog<void>(
      ctx,
      (done) => createElement(ReportViewer, {
        width: DIALOG_WIDTH,
        title,
        path: header.reportPath,
        markdown: reportText,
        onDone: done,
      }),
      {
        title: `persona-audit: ${title}`,
        width: DIALOG_WIDTH,
        maxHeight: DIALOG_MAX_HEIGHT,
        fallback: undefined,
      },
    );
    return true;
  } catch (error) {
    reportFailure(ctx, "Persona-audit report viewer", error);
    return false;
  }
}

/** Show the scrollable report after a completed audit. A dialog that fails has said why. */
export async function showReportViewer(
  ctx: ExtensionCommandContext,
  reportText: string,
  header: ReportViewerHeader,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  await openReportViewerDialog(ctx, reportText, header);
}

/**
 * Show the findings review. Deferred findings handed off from inside it are written to a handoff
 * file here. Outside TUI mode, or when the dialog fails (it has said why), the review is cancelled,
 * which keeps any Fix Now fixes and applies nothing else.
 */
export async function showFindingsReview(
  ctx: ExtensionCommandContext,
  findings: Finding[],
  handoff: { slug: string; isoDate: string; scope: string; reviewers: string[] },
  degradationNote?: string,
  restore?: ReviewSessionState,
  /** Live classifier suggestions; badges repaint as they arrive. */
  feed?: TriageSuggestionFeed,
): Promise<FindingsReviewOutcome> {
  const onWriteHandoff = async (deferred: Finding[]): Promise<string> => {
    const relPath = handoffRelPath(handoff.slug);
    const headCommit = await gitHeadCommit(ctx.cwd);
    await writeReportFile(
      ctx.cwd,
      relPath,
      renderDeferredHandoff(
        {
          isoDate: handoff.isoDate,
          scope: handoff.scope,
          reviewers: handoff.reviewers,
          ...(headCommit ? { headCommit } : {}),
        },
        deferred,
      ),
    );
    return relPath;
  };
  if (ctx.mode !== "tui") return { kind: "cancelled" };
  return (await openFindingsReviewDialog(ctx, findings, degradationNote, restore, feed, onWriteHandoff)) ?? { kind: "cancelled" };
}
