import type { ImageContent } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./modelConfig.ts";

// ── Core audit types ───────────────────────────────────────────────────────

/** Valid finding categories — ordered by priority for conflict resolution. */
export const CATEGORY_PRIORITY = [
  "security",
  "bug",
  "performance",
  "maintainability",
  "style",
  "documentation",
  "accessibility",
  "reliability",
] as const;
export type FindingCategory = (typeof CATEGORY_PRIORITY)[number];

/** Valid severity levels — ordered by priority. */
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof SEVERITY_ORDER)[number];

/** Action the adjudicator can recommend for a finding. */
export type FindingRecommendation = "apply" | "reject" | "defer";

/** Nature of the change a reviewer expects a finding to require. */
export type ChangeKind = "signature" | "behavior" | "internal" | "cosmetic";

/** Blast-radius risk levels, ordered from highest to lowest. */
export const BLAST_ORDER = ["critical", "high", "medium", "low"] as const;
export type BlastLevel = (typeof BLAST_ORDER)[number];

/** Deterministic risk estimate attached after findings are collected. */
export interface BlastRadius {
  score: number;
  level: BlastLevel;
  reasons: string[];
}

/** Status assigned to a finding during the findings review overlay. */
export type FindingStatus = FindingRecommendation | "fixed";

/** A single finding from a reviewer subagent. */
export interface Finding {
  reviewer: string;
  file: string;
  line: number; // -1 if file-level
  category: FindingCategory;
  severity: FindingSeverity;
  rationale: string; // complete issue summary, newlines flattened
  /** Neutral ASD-STE100 restatement of rationale; never replaces the authoritative rationale. */
  summary?: string;
  suggestedChange: string; // max 2000 chars, newlines flattened
  changeKind?: ChangeKind; // reviewer-supplied nature of the proposed fix
  blastRadius?: BlastRadius; // deterministic risk estimate computed before review
  recommendation?: FindingRecommendation; // adjudicator's recommended action
  recommendationReason?: string; // why the adjudicator recommends reject/defer
}

/**
 * One implement-phase agent session's workload.
 *
 * Every finding for a given file lands in the same batch so that in-file edits
 * stay sequential — parallel agents editing one file would invalidate each
 * other's `oldText` anchors.
 */
export interface ApplyBatch {
  index: number;
  files: string[];
  findings: Finding[];
}

/** No-findings sentinel from a reviewer who found no issues. */
export interface NoFindings {
  reviewer: string;
  findings: 0;
}

// ── Reviewer personality data ──────────────────────────────────────────────

/** Tier classification, used to group reviewers under section headers in the picker. */
export type ReviewerTier = "holistic" | "specialist" | "persona";

/** Metadata about a single reviewer personality. */
export interface ReviewerInfo {
  name: string;
  description: string;
  focusAreas: string[];
  tier: ReviewerTier;
}

/** Tier grouping with all its reviewers. Each reviewer inherits `tier` from the group. */
export interface TierInfo {
  tier: ReviewerTier;
  label: string;
  reviewers: Omit<ReviewerInfo, "tier">[];
}

// ── Selection & audit config ───────────────────────────────────────────────

/** Result of the expert picker TUI. */
export interface ReviewerSelection {
  reviewers: string[]; // selected reviewer names, may span tiers
  passes: number; // runs per selected reviewer
}

/** How the file manifest was scoped for this audit run. */
export type AuditMode = "diff" | "full" | "handoff";

// ── Findings review types ───────────────────────────────────────────────────

/** Active ordering inside each recommendation section. */
export type ReviewSortMode = "file" | "priority" | "reviewer" | "blast";

/** A finding fixed interactively via the Fix Now flow. */
export interface FixedFinding {
  finding: Finding;
  /** Short SHA of the audit-fix commit. Absent when the user opted out of auto-commit. */
  commitSha?: string;
  /** Repo-relative files the fix touched. */
  files: string[];
}

/** Result returned by the findings review TUI. */
export interface FindingsReviewResult {
  accepted: Finding[];
  rejected: Finding[];
  deferred: Finding[];
  /** Findings fixed interactively during review, excluded from the batch implement phase. */
  fixed: FixedFinding[];
  /** Relative path of a deferred-findings handoff written during triage. */
  handoffPath?: string;
}

/** Snapshot of the review overlay's mutable state, carried across a Fix Now round-trip. */
export interface ReviewSessionState {
  /** Per-finding status, indexed by position in the original findings array. */
  statuses: FindingStatus[];
  selectedIndex: number;
  sortMode?: ReviewSortMode;
  /** Completed interactive fixes, keyed by original finding index. */
  fixed: Map<number, FixedFinding>;
  handoffPath?: string;
}

/** How one showing of the findings review overlay ended. */
export type FindingsReviewOutcome =
  | { kind: "finalized"; result: FindingsReviewResult }
  | { kind: "cancelled" }
  | { kind: "fixNow"; index: number; state: ReviewSessionState };

// ── Headless agent-session types ────────────────────────────────────────────

/** Aggregated usage stats from a headless pi agent-session run. */
export interface HeadlessUsage {
  turns: number;
  /** Latest reported context size (usage.totalTokens of the most recent turn). */
  contextTokens: number;
  /** Cumulative generated-output tokens across assistant turns (exact usage when the provider reports it, word-count estimate otherwise). */
  outputTokens: number;
}

/**
 * Live telemetry snapshot emitted while a headless agent session streams.
 *
 * `outputTokens` includes the in-flight turn (estimated from streamed deltas
 * when the provider reports no usage), so an activity meter keeps moving
 * between turn boundaries.
 */
export interface HeadlessProgress {
  /** Latest turn's total context size, for the CTX column. */
  contextTokens: number;
  /** Assistant turns completed so far. */
  turns: number;
  /** Tool calls started so far. */
  toolCalls: number;
  /** Cumulative model cost in USD, when the model resolves in the registry. */
  costUsd?: number;
  /** One-line description of the tool call currently executing. */
  activity?: string;
  /** Cumulative generated-output tokens, driving the activity meter. */
  outputTokens: number;
  /** Bumped when exact usage supersedes an estimate, so meters can reset. */
  outputRevision: number;
  /** Provider reported by the first assistant message, for context-window lookup. */
  provider?: string;
  /** Model id reported by the first assistant message, for context-window lookup. */
  model?: string;
}

/** Result of one headless AgentSession run. */
export interface HeadlessResult {
  /** Last assistant text block (primary output channel). */
  finalText: string;
  /** All assistant text blocks concatenated (superset of finalText). */
  allText: string;
  /** True when the run was terminated via AbortSignal. */
  aborted: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage: HeadlessUsage;
}

/** Options for running a headless pi agent session. */
export interface HeadlessOptions {
  /** Name used as the session's display name and in diagnostics. */
  agentName: string;
  /** Appended to the agent's default system prompt. */
  systemPrompt: string;
  /** Tool allowlist passed to the agent session (from agent .md frontmatter). */
  tools: string[];
  /** Model pattern resolved against the model registry (from agent .md frontmatter). */
  model?: string;
  /** Thinking level passed to the agent session, if a per-phase override is set. */
  thinking?: ThinkingLevel;
  /** Positional prompt (manifest / findings / apply directive). */
  task: string;
  /** Image attachments supplied with the prompt. */
  images?: ImageContent[];
  cwd: string;
  /** Shared registry used to resolve models in-process, including bridge/extension-registered providers. */
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
  /** If set, abort the session after this many ms without a streamed event and treat the run as failed. */
  idleTimeoutMs?: number;
  /** Called after every meaningful streamed event with a live telemetry snapshot. */
  onProgress?: (progress: HeadlessProgress) => void;
}

// ── Verification gate types ─────────────────────────────────────────────────

/** Result of running one discovered verification script. */
export interface VerifyResult {
  script: string;
  command: string;
  status: "pass" | "fail";
  exitCode: number;
  relevantOutput: string;
}

/** Overall verification status for the audit report. */
export type VerificationStatus = "passed" | "failed" | "partial" | "skipped";

/** Per-finding judgement of whether an accepted fix landed and holds up. */
export type FixVerdict = "fixed" | "partial" | "not-fixed" | "cannot-verify";

/** Deterministic state of a finding's target file after the implement phase. */
export type FileChangeState = "changed" | "unchanged" | "created" | "deleted" | "unreadable";

/** How the implement agent's own report classified a finding. */
export type SelfReport = "applied" | "deferred" | "unreported";

/** Outcome of the red/green regression harness for one finding. */
export type RegressionOutcome =
  | "proven"
  | "not-discriminating"
  | "green-check-failed"
  | "green-only"
  | "harness-error";

/** Layer-1 evidence: how one target file changed across the implement phase. */
export interface FileChangeEvidence {
  file: string;
  state: FileChangeState;
  /** Repo-relative path of the pre-fix copy, when one was taken. */
  snapshotPath?: string;
  preSha256?: string;
  postSha256?: string;
  detail?: string;
}

/** Red/green harness result for one accepted finding. */
export interface RegressionResult {
  file: string;
  line: number;
  category: FindingCategory;
  testFile: string;
  testCommand: string;
  outcome: RegressionOutcome;
  greenAfterFix: boolean;
  redWhenReverted: boolean;
  proven: boolean;
  detail?: string;
}

/** A repair agent's evidence-backed dispute of a verifier verdict (surface-only). */
export interface ContestedVerdict {
  file: string;
  line: number;
  category: FindingCategory;
  /** The repair agent's evidence for why the verifier's verdict is wrong. */
  reason: string;
  /** Repair round that raised the dispute. */
  round: number;
}

/** Verification verdict for one accepted finding. */
export interface FixVerification {
  file: string;
  line: number;
  category: FindingCategory;
  verdict: FixVerdict;
  evidence: string;
  changed: FileChangeState;
  selfReport: SelfReport;
  regression?: RegressionResult;
}

/**
 * One fix→verify round's outcome. Round 1 is the original implement + verify
 * pass; round N>1 is a repair agent's edits followed by full re-verification
 * against the same round-1 baseline snapshots.
 */
export interface VerificationRound {
  round: number;
  status: VerificationStatus;
  fixVerdicts: FixVerification[];
  regressions: RegressionResult[];
  scripts: VerifyResult[];
  notes: string[];
  /** Set on round 1 skip and every repair round: what the repair agent claimed to have done. */
  repairOutcome?: string;
  /** True when this round's repairOutcome came from an escalated root-cause repair. */
  repairEscalated?: boolean;
}

/** Everything the verify phase produced. */
export interface VerificationOutcome {
  status: VerificationStatus;
  fixes: FixVerification[];
  regressions: RegressionResult[];
  scripts: VerifyResult[];
  /** Degradation notes: verifier failed, output unparsable, no git repo, cap hit. */
  notes: string[];
  /** Every fix→verify round run, in order. Empty when verification was skipped entirely. */
  rounds: VerificationRound[];
  /** Verifier verdicts the repair agent disputed with evidence — still counted as failures. */
  contested: ContestedVerdict[];
}

// ── Audit orchestration types ───────────────────────────────────────────────

/** Terminal status of an audit run. */
export type AuditStatus =
  | "completed"
  | "no-findings"
  | "none-accepted"
  | "cancelled"
  | "failed";

/** One reviewer×pass execution record (for partial reports / diagnostics). */
export interface ReviewerRunRecord {
  reviewer: string;
  pass: number;
  status: "cached" | "completed" | "failed" | "pending";
  outputChars: number;
  detail?: string;
}

/** Summary returned by runAudit() for the final chat message. */
export interface AuditSummary {
  status: AuditStatus;
  scope: string;
  fileCount: number;
  /** Wall-clock duration of the whole run. */
  totalMs: number;
  reviewers: string[];
  passes: number;
  findingsCount: number;
  acceptedCount: number;
  /** Findings fixed interactively during review (Fix Now). */
  fixedCount: number;
  rejectedCount: number;
  deferredCount: number;
  verification: VerificationStatus;
  verifyResults: VerifyResult[];
  fixVerifications: FixVerification[];
  regressions: RegressionResult[];
  verificationNotes: string[];
  verificationRounds: VerificationRound[];
  reportPath: string;
  /** Set when the user opted to write a deferred-findings handoff during triage. */
  handoffPath?: string;
  expectedRuns: number;
  receivedRuns: number;
  malformedCount: number;
  missingCount: number;
  cacheHits: number;
  freshRuns: number;
  /** Set when the audit failed before producing trustworthy findings. */
  failureNote?: string;
  /** Set when adjudicator annotations were degraded or unavailable. */
  annotationNote?: string;
  /** Set when the register re-voice pass was degraded or unavailable. */
  revoiceNote?: string;
  /** Set when the adjudicator's implement agent session failed — no accepted fixes were written despite acceptedCount > 0. */
  implementFailedNote?: string;
}

export interface DedupFindingsResult {
  findings: Finding[];
  inputCount: number;
  outputCount: number;
  duplicateGroups: number;
}

/** Raw output from one reviewer subagent pass. */
export interface ReviewerOutput {
  reviewer: string;
  pass: number;
  output: string;
}

export interface MalformedReviewerOutput {
  reviewer?: string;
  pass?: number;
  sourceIndex: number;
  line?: string;
  reason: string;
}

export interface MissingReviewerRun {
  reviewer: string;
  pass: number;
}

export interface CollectReviewerFindingsResult {
  findings: Finding[];
  dedupedFindings: Finding[];
  noFindings: NoFindings[];
  malformed: MalformedReviewerOutput[];
  expectedRuns: number;
  receivedRuns: number;
  missingRuns: MissingReviewerRun[];
  inputCount: number;
  outputCount: number;
  duplicateGroups: number;
}
