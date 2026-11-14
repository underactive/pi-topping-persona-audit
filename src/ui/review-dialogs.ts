import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog, type DialogHost } from "@underactive/pi-topping-opentui/host";
import { isThinkingLevel, type ThinkingLevel } from "@underactive/pi-topping-primitives/models";
import { createElement } from "react";
import type { FixGateInput, FixGateDecision } from "../components/FixProgress.ts";
import type { ReportViewerHeader } from "../components/ReportViewer.ts";
import { hasSuggestion, type TriageSuggestion, type TriageSuggestionFeed } from "../decision/triage.ts";
import { modelRefLabel, type ModelRef, type PhaseModelChoice } from "../modelConfig.ts";
import type { Finding, FixedFinding, FindingsReviewOutcome, FindingsReviewResult, ReviewSessionState } from "../types.ts";
import { modelKey, readDialogModels } from "./dialog-models.ts";
import {
  DIALOG_MAX_HEIGHT,
  FIX_GATE_DIALOG_SIZE,
  FINDINGS_REVIEW_DIALOG_SIZE,
  REPORT_VIEWER_DIALOG_SIZE,
  RETRY_DIALOG_SIZE,
} from "./dialog-fit.ts";
import { FindingsReview, type ReviewOutcome as DialogReviewOutcome, type ReviewState as DialogReviewState } from "./generated/persona-audit/findings-review.ts";
import type { Finding as DialogFinding, FindingSuggestion, ModelChoice as DialogModelChoice } from "./generated/persona-audit/data.ts";
import { RetryCheckpoint, type RetryKind, type RetryResult, type ReviewerFailure as DialogReviewerFailure } from "./generated/persona-audit/prompts.ts";
import { FixGate, ReportViewer } from "./generated/persona-audit/viewers.ts";

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

export async function openFindingsReviewDialog(
  ctx: ExtensionCommandContext,
  findings: Finding[],
  terminalRows: number,
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
        width: FINDINGS_REVIEW_DIALOG_SIZE.columns,
        height: terminalRows,
        findings: dialogFindings,
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
        width: FINDINGS_REVIEW_DIALOG_SIZE.columns,
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
        width: RETRY_DIALOG_SIZE.columns,
        kind,
        current: selected,
        models,
        ...(options.detail !== undefined ? { detail: options.detail } : {}),
        ...(options.failures !== undefined ? { failures: options.failures } : {}),
        onDone: done,
      }),
      {
        title: `persona-audit: ${kind} retry checkpoint`,
        width: RETRY_DIALOG_SIZE.columns,
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
  terminalRows: number,
  onReady?: (settle: (decision: FixGateDecision) => void) => void,
  onError?: (error: unknown) => void,
): Promise<FixGateDecision | undefined> {
  try {
    return await showOpenTuiDialog<FixGateDecision>(
      ctx,
      (done) => {
        onReady?.(done);
        return createElement(FixGate, {
          width: FIX_GATE_DIALOG_SIZE.columns,
          height: terminalRows,
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
        width: FIX_GATE_DIALOG_SIZE.columns,
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
  terminalRows: number,
): Promise<boolean> {
  const title = header.title ?? `Audit Report — ${header.status} · ${header.findingCount} findings · verification ${header.verification}`;
  try {
    await showOpenTuiDialog<void>(
      ctx,
      (done) => createElement(ReportViewer, {
        width: REPORT_VIEWER_DIALOG_SIZE.columns,
        height: terminalRows,
        title,
        path: header.reportPath,
        markdown: reportText,
        onDone: done,
      }),
      {
        title: `persona-audit: ${title}`,
        width: REPORT_VIEWER_DIALOG_SIZE.columns,
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
