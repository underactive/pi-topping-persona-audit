import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runAudit } from "./orchestrator.ts";
import { REVIEWER_OUTPUT_CONTRACT, getPersonality } from "./skillContent.ts";
import { renderChatSummary } from "./report.ts";
import {
  AUDIT_PROGRESS_ENTRY_TYPE,
  AUDIT_PROGRESS_WIDGET_KEY,
  AuditProgressWidget,
  renderAuditSnapshot,
  type AuditProgressSnapshot,
} from "./components/AuditProgress.ts";
import { discoverAgents, mapWithConcurrencyLimit } from "./subprocess.ts";
import { EXPERT_PICKER_WIDGET_KEY } from "./components/ExpertPicker.ts";
import { showPhaseModelPicker, MODEL_PICKER_WIDGET_KEY } from "./components/ModelPicker.ts";
import { showReviewerRetryPrompt, REVIEWER_RETRY_WIDGET_KEY } from "./components/ReviewerRetry.ts";
import { showVerifierRetryPrompt, VERIFIER_RETRY_WIDGET_KEY } from "./components/VerifierRetry.ts";
import { showReportViewer } from "./components/ReportViewer.ts";
import { showSettingsMenu, SETTINGS_MENU_WIDGET_KEY } from "./components/SettingsMenu.ts";
import {
  loadPersonaAuditConfig,
  modelRefLabel,
  savePersonaAuditConfig,
  type PhaseModelChoice,
  type PhaseModelSelection,
  type Temperament,
} from "./modelConfig.ts";
import type { ReviewerSelection } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Module-level reference to the currently-mounted progress widget, if any.
 * Used by lifecycle handlers to tear down the table's render ticker during
 * /reload, /new, and session shutdown — preventing the `setInterval` from
 * firing on a disposed extension context.
 */
let activeProgress: AuditProgressWidget | null = null;

/**
 * Module-level reference to the AbortController backing the in-flight audit,
 * if any. `ctx.signal` is undefined while a command handler runs (see the
 * cancellation note atop orchestrator.ts), so the audit owns its own signal
 * here, created before `runAudit` and aborted by the shortcut/command below.
 */
let activeAuditController: AbortController | null = null;

const DIFF_SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const GENERATED_OR_MINIFIED_FILE_RE = /\.(min\.[^.]+|map|generated\.[^.]+)$/i;
const FULL_TREE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|cxx|hpp|hh|cs|swift|m|mm|scala|sh|sql|lua|yaml|yml|toml|json|md|html|css|scss|less|vue|svelte)$/i;
const LOCKFILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/i;
// Secret/.env/lockfile exclusions only trim the audit manifest — they are not
// a security boundary. Reviewer/adjudicator/verifier sessions run with
// read-only tools (READ_ONLY_TOOLS in orchestrator.ts: read/grep/find/ls) over
// the whole cwd, so excluded files can still be read by the model. Scrub or
// relocate secrets before auditing a repo that contains them.
const SECRET_FILE_RE = /(^|\/)(secrets?|credentials?)\/|(^|\/)[^/]*(secrets?|credentials?|serviceaccount)[^/]*\.(json|ya?ml|toml)$|\.tfvars(\.json)?$/i;
const DIFF_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", ".venv", "vendor", ".cache"]);
const FULL_TREE_SKIP_DIRS = new Set([
  ...DIFF_SKIP_DIRS,
  ".rpiv",
  ".pi",
  "target",
  "out",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  ".terraform",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".dart_tool",
  "Pods",
  "DerivedData",
]);

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function pathHasExcludedSegment(relativePath: string, excludedNames: Set<string>): boolean {
  return normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => excludedNames.has(segment));
}

function pathHasEnvSegment(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => segment.startsWith(".env"));
}

function stripKnownExtension(filePath: string): string {
  if (filePath.endsWith(".d.ts")) return filePath.slice(0, -5);
  if (filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) return filePath.slice(0, -6);
  const ext = path.extname(filePath);
  return ext ? filePath.slice(0, -ext.length) : filePath;
}

function buildAbsoluteFileCandidates(absolutePath: string, includeIndexParent = false): string[] {
  const normalized = normalizeRelativePath(path.normalize(absolutePath));
  const candidates = new Set<string>();
  candidates.add(normalized);
  const withoutExt = stripKnownExtension(normalized);
  candidates.add(withoutExt);
  if (includeIndexParent && path.basename(withoutExt) === "index") {
    candidates.add(normalizeRelativePath(path.dirname(withoutExt)));
  }
  return [...candidates];
}

async function collectFiles(
  rootDir: string,
  cwd: string,
  includeFile: (relativePath: string) => boolean,
  excludedNames: Set<string>,
): Promise<string[]> {
  const cwdPath = path.resolve(cwd);
  const rootPath = path.resolve(rootDir);
  const results: string[] = [];
  const rootRelative = normalizeRelativePath(path.relative(cwdPath, rootPath));
  if (pathHasExcludedSegment(rootRelative, excludedNames)) return results;

  const rootStat = await lstat(rootPath);
  if (rootStat.isFile()) {
    if (includeFile(rootRelative)) results.push(rootRelative);
    return results;
  }
  if (!rootStat.isDirectory()) return results;

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Failed to scan directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relativePath = normalizeRelativePath(path.relative(cwdPath, absPath));
      if (excludedNames.has(entry.name)) continue;
      if (entry.isDirectory()) {
        subdirs.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (includeFile(relativePath)) results.push(relativePath);
    }
    // Fanned out per level rather than one global worker pool: a shared queue
    // would starve while every in-flight worker is still descending its own
    // subtree with nothing left to dequeue.
    await mapWithConcurrencyLimit(subdirs, 8, walk);
  };

  await walk(rootPath);
  return [...new Set(results)].sort();
}

async function getMergeBase(cwd: string): Promise<string> {
  let lastErrorMessage = "";
  for (const args of [
    ["merge-base", "HEAD", "main"],
    ["merge-base", "HEAD", "origin/main"],
  ]) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", timeout: 5_000 });
      const base = stdout.trim();
      if (base) return base;
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Failed to determine merge-base against main or origin/main${lastErrorMessage ? `: ${lastErrorMessage}` : ""}. Pass --base <commit> explicitly.`);
}

/**
 * Get files changed in git diff against a base commit.
 * If no base commit is specified, uses merge-base with main branch.
 */
export async function getChangedFiles(
  cwd: string,
  scope: string,
  baseCommit?: string,
): Promise<string[]> {
  try {
    let base = baseCommit;
    if (!base) {
      base = await getMergeBase(cwd);
    }

    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`],
      { cwd, encoding: "utf-8", timeout: 15_000 },
    );

    const files = stdout.split("\0").filter((f) => f.length > 0);
    const auditable = files.filter((f) => !LOCKFILE_RE.test(f) && !SECRET_FILE_RE.test(f) && !pathHasEnvSegment(f));
    const normalizedScope = normalizeRelativePath(scope).replace(/^\.\//, "");
    if (normalizedScope && normalizedScope !== ".") {
      const scopePrefix = normalizedScope.endsWith("/") ? normalizedScope : `${normalizedScope}/`;
      return auditable.filter((f) => f.startsWith(scopePrefix) || f === normalizedScope);
    }

    return auditable;
  } catch (error) {
    throw new Error(`Failed to get changed files: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bump when reviewer prompt/task composition changes in ways the hashed inputs
 * below don't capture (v3: hot-register enforcement is appended after the
 * output contract).
 */
const REVIEWER_CACHE_SCHEMA = "v3";

/** Concurrency cap for the manifest-file reads that seed the cache key hash. */
const CACHE_KEY_READ_CONCURRENCY = 8;

/**
 * Build the incremental-cache key from the manifest file contents, reviewer
 * prompt fingerprint, selected reviewers, and pass count.
 */
async function buildReviewerCacheKey(
  cwd: string,
  files: string[],
  reviewers: string[],
  passes: number,
  mode: "diff" | "full",
  temperament: Temperament,
  reviewModel?: PhaseModelChoice,
): Promise<string> {
  const sortedFiles = files.slice().sort();
  const hashes = await mapWithConcurrencyLimit(sortedFiles, CACHE_KEY_READ_CONCURRENCY, async (file) =>
    createHash("sha256").update(await readFile(path.resolve(cwd, file))).digest("hex"),
  );
  const fileHash = createHash("sha256");
  sortedFiles.forEach((file, i) => {
    fileHash.update(file);
    fileHash.update("\0");
    fileHash.update(hashes[i]!);
    fileHash.update("\0");
  });

  const reviewerAgent = discoverAgents(cwd).find((agent) => agent.name === "persona-audit-reviewer");
  const sortedReviewers = [...new Set(reviewers)].sort();
  const promptHash = createHash("sha256");
  promptHash.update(REVIEWER_CACHE_SCHEMA);
  promptHash.update("\0");
  if (reviewerAgent) {
    promptHash.update(reviewerAgent.systemPrompt.trim());
    promptHash.update("\0");
    // A review-model override changes what the reviewer actually produces, so it
    // must be folded in here — otherwise a stale cache hit could serve output
    // from a different model than the one just selected.
    promptHash.update(reviewModel ? modelRefLabel(reviewModel.ref) : reviewerAgent.model ?? "");
    promptHash.update("\0");
    promptHash.update(reviewModel?.thinking ?? "");
    promptHash.update("\0");
    promptHash.update(Array.from(new Set(reviewerAgent.tools ?? [])).sort().join("\0"));
    promptHash.update("\0");
  }
  promptHash.update(REVIEWER_OUTPUT_CONTRACT);
  promptHash.update("\0");
  for (const reviewer of sortedReviewers) {
    promptHash.update(reviewer);
    promptHash.update("\0");
    promptHash.update(getPersonality(reviewer, temperament) ?? "");
    promptHash.update("\0");
  }

  const cacheInput = JSON.stringify({
    manifest: fileHash.digest("hex"),
    promptFingerprint: promptHash.digest("hex"),
    reviewers: sortedReviewers,
    passes,
    mode,
  });
  return createHash("sha256").update(cacheInput).digest("hex").slice(0, 24);
}

/**
 * Find direct importers of a list of files.
 * Scans JS/TS source files for relative-path import/require statements
 * referencing the changed files.
 */
async function getDirectImporters(
  cwd: string,
  changedFiles: string[],
): Promise<string[]> {
  if (changedFiles.length === 0) return [];

  try {
    const sourceFiles = await collectFiles(
      cwd,
      cwd,
      (relativePath) =>
        DIFF_SOURCE_FILE_RE.test(relativePath) &&
        !GENERATED_OR_MINIFIED_FILE_RE.test(relativePath) &&
        !LOCKFILE_RE.test(relativePath) &&
        !SECRET_FILE_RE.test(relativePath) &&
        !pathHasEnvSegment(relativePath),
      DIFF_SKIP_DIRS,
    );

    const changedTargets = new Set<string>();
    const changedPaths = new Set<string>();
    for (const file of changedFiles) {
      const normalized = normalizeRelativePath(file.replace(/^\.\//, ""));
      changedPaths.add(normalized);
      const absolute = path.resolve(cwd, normalized);
      for (const candidate of buildAbsoluteFileCandidates(absolute, true)) {
        changedTargets.add(candidate);
      }
    }

    const importPatterns = [
      /from\s+['"](\.[^'"]+)['"]/g,
      /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
      /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    ];

    const results = await mapWithConcurrencyLimit(sourceFiles, 8, async (sourceFile) => {
      if (changedPaths.has(sourceFile)) return undefined;

      const absSource = path.resolve(cwd, sourceFile);
      let content: string;
      try {
        content = await readFile(absSource, "utf-8");
      } catch {
        return undefined;
      }

      for (const pattern of importPatterns) {
        for (const match of content.matchAll(pattern)) {
          const importPath = match[1];
          if (!importPath) continue;

          const resolvedImport = path.resolve(path.dirname(absSource), importPath);
          if (buildAbsoluteFileCandidates(resolvedImport).some((candidate) => changedTargets.has(candidate))) {
            return sourceFile;
          }
        }
      }
      return undefined;
    });

    const importers = new Set<string>();
    for (const result of results) {
      if (result !== undefined) importers.add(result);
    }
    return [...importers].sort();
  } catch (error) {
    throw new Error(`Failed to scan importers: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve the context window for a reviewer/adjudicator agent session from the
 * provider and model it reported. An id-only match is only trusted when it is
 * unambiguous, since the same id can exist under several providers with
 * different windows. Rows that never reported a model stay unresolved, so the
 * table shows raw token counts rather than a percentage of a guessed window.
 */
function resolveContextWindow(
  ctx: ExtensionCommandContext,
  provider: string | undefined,
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  if (provider) {
    const exact = ctx.modelRegistry.find(provider, model)?.contextWindow;
    if (exact) return exact;
  }
  const matches = ctx.modelRegistry.getAvailable().filter((m) => m.id === model);
  if (matches.length === 1) return matches[0]!.contextWindow;
  return undefined;
}

/** Default cap for --full mode file manifests (deterministic, sorted, no silent sampling). */
export const FULL_TREE_FILE_CAP = 500;

/**
 * Deterministic sort + cap + truncation-detection over a file list.
 * Pure function (no I/O) so it can be unit tested without shelling out.
 * Truncation is always reported via `truncated`/`totalFound` rather than
 * silently sampling
 */
export function capFileList(
  files: string[],
  cap: number,
): { files: string[]; truncated: boolean; totalFound: number } {
  const sorted = [...new Set(files)].sort();
  const totalFound = sorted.length;
  if (totalFound <= cap) {
    return { files: sorted, truncated: false, totalFound };
  }
  return { files: sorted.slice(0, cap), truncated: true, totalFound };
}

/**
 * Scan the full directory tree under `scope` for source files — no git
 * required. Used by --full mode. Unlike `getDirectImporters`, this uses a
 * broad, language-agnostic extension allowlist since it's the primary
 * manifest source for non-git / non-diff audits, not just JS/TS import
 * resolution.
 */
async function getFullTreeManifest(cwd: string, scope: string): Promise<string[]> {
  const root = path.resolve(cwd, scope && scope !== "." ? scope : ".");
  const rel = path.relative(path.resolve(cwd), root);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Scope escapes the project root: ${scope}`);

  try {
    return await collectFiles(
      root,
      cwd,
      (relativePath) =>
        FULL_TREE_FILE_RE.test(relativePath) &&
        !GENERATED_OR_MINIFIED_FILE_RE.test(relativePath) &&
        !LOCKFILE_RE.test(relativePath) &&
        !SECRET_FILE_RE.test(relativePath) &&
        !pathHasEnvSegment(relativePath),
      FULL_TREE_SKIP_DIRS,
    );
  } catch (error) {
    throw new Error(`Failed to scan full tree: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * pi-topping-persona-audit — multi-persona code review via /persona-audit.
 *
 * The extension owns the entire audit deterministically: arg parsing, git
 * diff manifest + importer scan, ExpertPicker TUI, incremental cache, then
 * the orchestrator (src/orchestrator.ts) runs reviewer passes and adjudicator
 * reconcile/apply as isolated in-process agent sessions, shows the
 * FindingsReview TUI, runs the verification gate, and writes the report.
 * No child LLM session orchestrates the flow, and no audit tools are
 * registered — collection/dedup/triage are direct function calls.
 */
export default function (pi: ExtensionAPI): void {
  // ── Audit summary renderer (Step 7 chat sink) ──────────────────────
  pi.registerMessageRenderer("persona-audit-summary", (message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .filter(Boolean)
          .join("\n");
    return new Markdown(content.trim(), 0, 0, getMarkdownTheme());
  });

  // Frozen, read-only copy of the progress table left in the transcript on
  // completion. Rendered here; never sent back to the model (see appendEntry
  // call below).
  pi.registerEntryRenderer<AuditProgressSnapshot>(AUDIT_PROGRESS_ENTRY_TYPE, (entry, _options, theme) =>
    entry.data ? renderAuditSnapshot(entry.data, theme, loadPersonaAuditConfig().meter) : undefined,
  );

  // ── /persona-audit command ─────────────────────────────────────
  pi.registerCommand("persona-audit", {
    description: "Run a multi-persona code audit on a deterministic file manifest (--diff or --full)",
    handler: async (args, ctx) => {
      const argsList = args.trim().split(/\s+/);
      let useDiff = false;
      let useFull = false;
      let baseCommit: string | undefined;
      let scope = ".";

      for (let i = 0; i < argsList.length; i++) {
        const arg = argsList[i];
        if (arg === "--diff") {
          useDiff = true;
        } else if (arg === "--full") {
          useFull = true;
        } else if (arg === "--base") {
          const next = argsList[++i];
          if (!next || next.startsWith("-")) {
            ctx.ui.notify("Error: --base requires a commit.", "error");
            return;
          }
          baseCommit = next;
        } else if (arg && !arg.startsWith("-")) {
          scope = arg;
        }
      }

      if (useDiff === useFull) {
        ctx.ui.notify(
          "Error: exactly one of --diff or --full is required. " +
            "--diff (git-based, requires a git repository): /persona-audit --diff [--base <commit>] [path]. " +
            "--full (whole-tree scan, no git required): /persona-audit --full [path].",
          "error",
        );
        return;
      }

      if (useFull && baseCommit) {
        ctx.ui.notify("Note: --base only applies to --diff mode and will be ignored.", "warning");
      }

      const mode: "diff" | "full" = useFull ? "full" : "diff";

      // Guard: expert picker + findings review require TUI mode
      if (ctx.mode !== "tui") {
        ctx.ui.notify("persona-audit requires TUI mode", "error");
        return;
      }

      // ── Step 1: Programmatic file scan (no LLM) ─────────────────────
      ctx.ui.notify(mode === "full" ? "Scanning full directory tree…" : "Scanning changed files…", "info");

      let fileManifest: string[];
      let fileCount: number;
      let changedFiles: string[] = [];
      let importers: string[] = [];
      let truncated = false;
      let totalFilesFound: number | undefined;

      if (mode === "diff") {
        try {
          changedFiles = await getChangedFiles(ctx.cwd, scope, baseCommit);

          if (changedFiles.length === 0) {
            ctx.ui.notify(`No changed files found in scope "${scope}"`, "error");
            return;
          }

          importers = await getDirectImporters(ctx.cwd, changedFiles);

          const allFiles = [...new Set([...changedFiles, ...importers])].sort();
          fileManifest = allFiles;
          fileCount = allFiles.length;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const hint = /not a git repository/i.test(message)
            ? " This directory does not appear to be a git repository — use /persona-audit --full [path] instead."
            : "";
          ctx.ui.notify(`Failed to scan files: ${message}${hint}`, "error");
          return;
        }
      } else {
        try {
          const found = await getFullTreeManifest(ctx.cwd, scope);
          const capped = capFileList(found, FULL_TREE_FILE_CAP);

          if (capped.totalFound === 0) {
            ctx.ui.notify(`No auditable files found in scope "${scope}"`, "error");
            return;
          }

          truncated = capped.truncated;
          totalFilesFound = capped.totalFound;
          fileManifest = capped.files;
          fileCount = capped.files.length;

          if (truncated) {
            ctx.ui.notify(
              `Full-tree scan found ${capped.totalFound} files; capped to the first ${FULL_TREE_FILE_CAP} (sorted) to keep the audit deterministic. Narrow the scope path to audit the rest.`,
              "warning",
            );
          }
        } catch (error) {
          ctx.ui.notify(`Failed to scan files: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
      }

      // ── Step 2: expert picker (live run-cost preview), then the
      //    per-phase model + thinking picker. Esc on the model picker steps
      //    back here, reopening the expert picker with the same selection.
      const { showExpertPicker } = await import("./components/ExpertPicker.ts");
      let selection: ReviewerSelection;
      let phaseModels: PhaseModelSelection;
      let restoredReviewers: ReviewerSelection | undefined;
      let restoredModels: PhaseModelSelection | undefined;
      for (;;) {
        const reviewers = await showExpertPicker(ctx, fileCount, restoredReviewers);
        if (!reviewers) {
          ctx.ui.notify("Audit cancelled.", "info");
          return;
        }
        const models = await showPhaseModelPicker(ctx, pi.getThinkingLevel(), restoredModels);
        if (models.action === "cancel") {
          ctx.ui.notify("Audit cancelled.", "info");
          return;
        }
        if (models.action === "start") {
          selection = reviewers;
          phaseModels = models.selections;
          break;
        }
        restoredReviewers = reviewers;
        restoredModels = models.selections;
      }

      const settings = loadPersonaAuditConfig();

      let cacheKey: string | undefined;
      try {
        cacheKey = await buildReviewerCacheKey(
          ctx.cwd,
          fileManifest,
          selection.reviewers,
          selection.passes,
          mode,
          settings.temperament,
          phaseModels.review,
        );
      } catch (error) {
        ctx.ui.notify(
          `Skipping incremental cache because cache key construction failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }

      const modelsNote = ` · Review ${modelRefLabel(phaseModels.review.ref)}/${phaseModels.review.thinking} · Triage ${modelRefLabel(phaseModels.triage.ref)}/${phaseModels.triage.thinking} · Implement ${modelRefLabel(phaseModels.implement.ref)}/${phaseModels.implement.thinking}`;
      ctx.ui.notify(
        (mode === "diff"
          ? `Found ${fileCount} files (${changedFiles.length} changed, ${importers.length} importers) · ${selection.reviewers.length} reviewers selected · ${selection.passes} pass${selection.passes === 1 ? "" : "es"} each`
          : `Found ${fileCount} files (full-tree scan${truncated ? `, truncated from ${totalFilesFound}` : ""}) · ${selection.reviewers.length} reviewers selected · ${selection.passes} pass${selection.passes === 1 ? "" : "es"} each`) + modelsNote,
        "info",
      );

      // ── Mount the live progress table above the editor ─────────────────────
      const progress = new AuditProgressWidget(
        ctx,
        scope === "." ? undefined : scope,
        (provider, model) => resolveContextWindow(ctx, provider, model),
        settings.meter,
      );
      activeProgress = progress;
      progress.mount();

      // ── Step 3: Deterministic orchestration (no child LLM session) ───
      const auditController = new AbortController();
      activeAuditController = auditController;
      try {
        const summary = await runAudit(ctx, {
          scope,
          mode,
          baseCommit,
          changedFiles,
          importers,
          fileManifest,
          fileCount,
          truncated,
          totalFilesFound,
          selection,
          cacheKey,
          progress,
          phaseModels,
          temperament: settings.temperament,
          maxVerifyRounds: settings.maxVerifyRounds,
          signal: auditController.signal,
          onReviewFailures: (failures, current) =>
            showReviewerRetryPrompt(
              ctx,
              failures,
              {
                label: modelRefLabel((current ?? phaseModels.review).ref),
                ref: (current ?? phaseModels.review).ref,
              },
              current?.thinking ?? pi.getThinkingLevel(),
            ),
          onVerifierFailure: (detail, current) =>
            showVerifierRetryPrompt(
              ctx,
              detail,
              {
                label: current ? modelRefLabel(current.ref) : "the agent's own model",
                ...(current ? { ref: current.ref } : {}),
              },
              current?.thinking ?? pi.getThinkingLevel(),
            ),
        });

        // Frozen transcript copy of the finished table, excluded from LLM
        // context (unlike the summary message below). Captured before the
        // `finally` block's progress.stop() drops the table and its meter traces.
        pi.appendEntry<AuditProgressSnapshot>(AUDIT_PROGRESS_ENTRY_TYPE, progress.snapshot());

        // Step 7: durable chat summary + notification
        pi.sendMessage(
          {
            customType: "persona-audit-summary",
            content: renderChatSummary(summary),
            display: true,
            details: summary,
          },
          { triggerTurn: false },
        );
        const level = summary.implementFailedNote
          ? "error"
          : summary.status === "failed" ||
              summary.verification === "failed" ||
              summary.verification === "partial"
            ? "warning"
            : "info";
        ctx.ui.notify(`Audit ${summary.status} — report: ${summary.reportPath}`, level);

        if (summary.status !== "cancelled") {
          let reportText: string;
          try {
            reportText = await readFile(path.resolve(ctx.cwd, summary.reportPath), "utf-8");
          } catch (error) {
            ctx.ui.notify(
              `Could not read audit report ${summary.reportPath}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
            return;
          }

          // stop() is idempotent, and prevents the progress ticker from rendering behind the modal.
          progress.stop();
          try {
            await showReportViewer(ctx, reportText, {
              status: summary.status,
              findingCount: summary.findingsCount,
              verification: summary.verification,
              reportPath: summary.reportPath,
            });
          } catch (error) {
            ctx.ui.notify(
              `Could not show audit report ${summary.reportPath}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
      } catch (error) {
        ctx.ui.notify(
          `Audit failed: ${error instanceof Error ? error.message : String(error)}. If reviewer passes completed, see .pi/persona-audit/audits/*_progress_snapshot.md for durable progress.`,
          "error",
        );
      } finally {
        // Unmount here rather than leaving the table up: its ticker must not
        // outlive the run, and a later /reload would otherwise find it stale.
        progress.stop();
        if (activeProgress === progress) {
          activeProgress = null;
        }
        if (activeAuditController === auditController) {
          activeAuditController = null;
        }
      }
    },
  });

  // ── Cancellation triggers: shortcut (primary) + command (fallback) ─────
  //
  // `ctx.signal` on the /persona-audit command context is undefined for
  // the whole life of the handler (see the cancellation note atop
  // orchestrator.ts), so the audit's AbortController above is the only
  // signal that can stop an in-flight run. Both triggers below just abort
  // it; the shortcut fires on a raw keypress independent of session busy
  // state, so it is expected to work while the command handler is still
  // awaiting.
  const cancelActiveAudit = (ctx: ExtensionContext): void => {
    if (!activeAuditController) {
      ctx.ui.notify("No persona-audit is currently running.", "info");
      return;
    }
    activeAuditController.abort();
    ctx.ui.notify("Cancelling persona-audit…", "info");
  };

  pi.registerShortcut("ctrl+shift+c", {
    description: "Cancel the in-flight persona-audit",
    handler: async (ctx) => {
      cancelActiveAudit(ctx);
    },
  });

  // ── /persona-audit-settings command ───────────────────────────
  pi.registerCommand("persona-audit-settings", {
    description: "Configure the persona-audit activity monitor and reviewer temperament",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("persona-audit-settings requires TUI mode", "error");
        return;
      }
      const edited = await showSettingsMenu(ctx, loadPersonaAuditConfig());
      if (!edited) return;
      try {
        savePersonaAuditConfig(edited);
      } catch (error) {
        ctx.ui.notify(
          `Could not save persona-audit settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      ctx.ui.notify("Persona-audit settings saved", "info");
    },
  });

  // ── Session lifecycle: tear down pipeline on shutdown/reload ─────────
  //
  // `session_shutdown` fires during /reload (reason: "reload"), /new
  // (reason: "new"), and session quit. It is the correct hook for
  // cleanup because it runs BEFORE the old extension context is disposed,
  // ensuring the spinner timer is stopped while the widget context is
  // still valid. This prevents the `setInterval` ticker from continuing
  // to fire on a disposed context and causing a /reload hang.
  pi.on("session_shutdown", (_event) => {
    if (activeAuditController) {
      activeAuditController.abort();
      activeAuditController = null;
    }
    if (activeProgress) {
      activeProgress.stop();
      activeProgress = null;
    }
  });

  // `session_start` is a secondary safety net: clear any stale widget
  // state that may have survived a shutdown (e.g. if stop was skipped).
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget(AUDIT_PROGRESS_WIDGET_KEY, undefined);
    ctx.ui.setWidget(EXPERT_PICKER_WIDGET_KEY, undefined);
    ctx.ui.setWidget(MODEL_PICKER_WIDGET_KEY, undefined);
    ctx.ui.setWidget(REVIEWER_RETRY_WIDGET_KEY, undefined);
    ctx.ui.setWidget(VERIFIER_RETRY_WIDGET_KEY, undefined);
    ctx.ui.setWidget(SETTINGS_MENU_WIDGET_KEY, undefined);
  });
}
