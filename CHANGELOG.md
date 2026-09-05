# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.1.7] - 2026-09-04

### Changed

- **Implement passes keep tests in step with the fix** — both the batch implement phase and Fix Now now grep for and update existing tests that exercise the changed code, and the Fix Now verifier treats those edits as part of the fix. Stale assertions no longer leave the verdict stuck at "partial" and no longer need a manual chat follow-up. Weakening an assertion is still forbidden and is reported under Tests Left Failing instead. Batch agents receive a Reserved Files list so parallel workers never edit each other's targets.

- **Fix Now commit messages lead with severity** — the provenance line now reads "Audit finding (high priority) by Linus Torvalds persona."

### Fixed

- **Fix Now resolves symlinks before editing** — after the lexical path check, the target's real path must also stay inside the project root, mirroring the handoff containment guard; a target that escapes via a symlink is refused.

- **Fix Now follow-up chats carry the untrusted-data rule** — the follow-up task now includes the same untrusted-data directive as the fix and verifier tasks.

- **README describes batch ownership and Fix Now test edits accurately** — the implement section documents the Reserved Files list and related-test edits, and the Fix Now note no longer promises a user-visible Tests Updated section.

## [0.1.6] - 2026-09-02

### Added

- **Reusable reviewer rosters** — `/persona-audit-settings` can stage and save up to 20 named 1–10-reviewer combinations. Valid rosters appear alphabetically above individual reviewers in `/persona-audit`, filter by roster or member name, and expand to one pass per reviewer with the existing high-cost confirmation gate.

- **Labeled finding summaries** — Findings Review, audit reports, and deferred handoffs now preserve an authoritative rationale alongside a simplified-technical-English summary and suggested change. Reconciliation generates summaries when available; older handoffs and degraded runs receive a conservative fallback.

### Fixed

- **Adjudicator failures offer recovery before triage** — provider failures during reconciliation now offer retry with the current or a replacement model instead of immediately opening Findings Review without recommendations.

- **Progress-table costs account for routed and provider-reported billing** — paid downstream models no longer appear as `$0.000` when a router or proxy reports a different model or bill.

- **Fix Now highlights the correct phase in the progress band** — during an interactive fix the phase band now highlights Implement while the fix agent edits and Verify while the verifier runs, instead of staying stuck on Triage; the pre-episode phase is restored when the fix episode closes.

- **Degradation warnings are sanitized before terminal rendering** — untrusted degradation notes are sanitized before they are wrapped and displayed in Findings Review, preventing terminal control sequences from reaching the warning banner.

- **Provider and reviewer diagnostics normalize untrusted error text** — provider failures and reviewer/re-voice diagnostics now normalize error details before placing them in notifications, reports, or handoff metadata.

- **Adjudicator retry details sanitize provider labels and finding text** — retry-overlay labels and failure details are sanitized before rendering, preventing provider- or finding-supplied terminal control sequences from reaching the prompt.

- **Handoff notes are sanitized before footer rendering** — deferred handoff status text is sanitized before it is displayed in the Findings Review footer.

- **Resumed handoff targets are contained by real path** — handoff files are admitted only when their resolved paths remain inside the project root, including when a symlink would otherwise escape it.

- **Artifact collection reads the audits directory once** — report and progress discovery now shares one directory read and per-entry stat pass instead of scanning the directory twice.

## [0.1.5] - 2026-08-30

### Added

- **Per-command full-tree exclusions** — `/persona-audit --full` accepts repeatable `--exclude <dir-or-path>` values with quote-aware parsing, global directory-name matching, and exact project-root-relative path matching while retaining mandatory built-in exclusions.

- **Pre-audit reviewer context** — normal audits now show a guidance screen where shared text and up to five existing PNG, JPG, JPEG, GIF, or WebP files (5 MiB each) can be attached to every reviewer pass. Context is reviewer-only, included in cache identity, and represented in reports by counts rather than raw content.

### Changed

- **Floating prompts anchor at the terminal bottom** — focused persona-audit overlays now span the full width, cover Pi's editor while open, and leave consistent spacing around the prompt.

- **Progress ticker pauses when no rows are active** — the render loop yields while every row is completed, so a finished audit no longer burns CPU on pointless refreshes.

- **Audit progress reuses its row snapshot** — footer cost calculation no longer rebuilds the progress rows during the same render tick.

- **Fix Now toasts truncate agent-session errors** — large error payloads (e.g., the full model catalog in a Model-not-found error) are capped at the first line, 200 characters, preventing transcript flooding.

- **Hardened audit progress rendering** — edge-case title overflow in the progress table and refresh-race conditions in the fix-now sub-rows are handled more robustly.

- **Simplified overlay plumbing** — prompt components share one overlay helper and geometry, while unused audit-summary configuration, border-counter, and per-call overlay-option parameters were removed.

### Fixed

- **Guidance and context views preserve their height** — switching between the additional-context editor and guidance menu no longer changes the overlay height.

- **Finding text is sanitized before terminal rendering** — rationale, suggested changes, recommendation reasons, reviewer names, paths, categories, and blast-radius reasons no longer pass terminal control sequences through the Findings Review overlay.

- **Fix Now rejects out-of-root targets before edits** — the dirty-target check now shares the existing `resolveTargetPath` guard and returns an error notification instead of starting an agent session for a file outside the project root.

- **Fix Now validates targets against the file manifest** — selecting a finding whose file is not in `input.fileManifest` is refused with a warning before creating the Fix Now row or session.

- **Fix Now cleans up partial file edits on rejection** — when the fix session rejects, all edits are rolled back before the listener and controller teardown, preventing stale edits from leaking into the tree.

- **Verdict parsing picks the last pair** — the verifier now collects the last matching verdict/evidence pair from the response instead of the first global match, matching ordering in the system prompt.

- **Tracker snapshot moved into throttled branch** — `tracker.snapshot()` is now called inside the progress-emission branch instead of unconditionally every render tick, reducing overhead when no output is due.

- **Removed unused `createInteractiveSession` injection** — dead code path and type removed from `FixNowDeps`; the `if` ladder collapses to a single `runSession` branch with no behavior change.

## [0.1.4] - 2026-08-29

### Added

- **Fix Now inline conversation and requested modifications** — press `C` in the Fix Now gate to chat directly with the fix agent. Users can ask impact and caller questions without touching the diff, or request targeted modifications to refine the fix; diffs and verifier verdicts automatically refresh when code changes, and prior conversation context persists across turns within the attempt.

- **Findings review sorting and blast-radius risk** — press `S` to cycle file, severity-priority, reviewer, and blast-radius ordering within each recommendation section. Blast radius is a deterministic 0–100 score from direct importer fan-in, sensitive code surfaces, corresponding tests, and the reviewer's change-kind classification; the overlay shows Low/Medium/High/Critical buckets with leading reasons and preserves the active sort across Fix Now.

- **Artifact purge command** — `/persona-audit-purge [--older-than <days>]` lists reports, progress snapshots, handoffs, pre-fix snapshots, and this repo's reviewer cache in a tag-and-confirm menu for permanent deletion. Sections explain retention purpose and display their parent folder; `P` opens a read-only Markdown or pretty-printed JSON preview. Unknown files and settings are never touched; cache entries are never pre-tagged.

- **Aggregate progress-table cost readout** — the footer now shows the cumulative model cost beside whole-run elapsed time; an asterisk marks a partial total when one or more rows have unavailable or invalid cost telemetry.

- **Resume from a deferred-findings handoff** — `/persona-audit --handoff <path>` re-opens a handoff written during triage (`H` in the findings review) and resumes the audit from there: the reviewer and adjudication phases are skipped, the deferred findings load straight into the findings review overlay (pre-set to apply), and the implement/verify pipeline plus final report run as usual. Handoffs now embed a schema-versioned machine-readable payload (lossless findings JSON plus the HEAD commit at write time); on resume the run warns when the tree has moved since the handoff was written and drops findings whose target file no longer exists. Handoffs written before this release have no payload and cannot be resumed.

- **Tool-call and cost columns in the progress table** — rows now show cumulative tool calls and model cost (`$0.000`, or `—` when the model cannot be resolved) beside turns and elapsed time; the stats block still sheds as one unit on narrow terminals

- **Diff base hash in the progress table header** — in `--diff` mode the title bar now shows the short hash of the commit the audit diffed from (e.g. `src/components · @a1b2c3d`), reporting the merge-base when `--base` names a ref rather than that ref's own tip; the hash also persists into the frozen transcript snapshot

### Changed

- **Escape shortcut labels** — Findings Review and Fix Now now show `Esc` instead of `Esc Esc` in their shortcut hints; the two-press cancellation confirmation remains unchanged.

- **Fix Now shows progress after acceptance** — accepting a single fix now switches the overlay to an animated busy state while the commit or final state update completes, preventing repeated acceptance keypresses.

- **Fix Now commit subjects are summarized** — the auto-commit subject no longer embeds the file path and raw rationale (which routinely blew past subject-length limits); a short no-tools model pass now compresses the finding into an imperative summary (`fix(security): Stop trusting user metadata for admin checks`), falling back to the clipped rationale when the summarizer fails. Subjects are hard-capped at 72 characters; the commit body is unchanged.

- **Audit progress phase separators** — phase subheadings now use horizontal rules, with blank lines separating each phase group; the responsive height budget accounts for the added rows.

- **Compact audit progress layout** — phase headings now separate agent groups, while agent rows use the sibling status-and-label geometry without phase or tree-connector columns; responsive width and height budgets account for the compact layout.

- **Headless progress table displays generated token counts** — instead of character counts, uses abbreviated formatting (e.g., "1.2K tokens") for easier reading in the ACTIVITY column.

- **Interactive prompts are lifecycle-aware overlays** — the expert picker, per-phase model picker, reviewer and verifier retry checkpoints, settings menu, and purge menu moved from docked above-editor widgets (`setWidget` plus a raw terminal-input listener) to centered focused `ctx.ui.custom()` overlays, so Pi 0.84.4+ brackets each genuine prompt with its `ui_prompt_start`/`ui_prompt_end` lifecycle events instead of being unable to report the wait.

- **Fix Now status nests inside the audit table** — the working, verifying, and settling phases (rationale, phase status, cancel hint) now render as nested sub-rows under the Implement phase's `fix now · …` row instead of a separate framed above-editor widget; agent telemetry already lived on that row, so the fix no longer doubles its footprint above the editor. The double-Escape cancel gesture is unchanged, and the accept/retry/discard gate remains a focused overlay.

- **Findings review hotkeys** — `A`, `R`, and `D` now set the selected finding to apply, reject, or defer directly; `O` defer-override is removed while `Space` continues to cycle statuses.

### Fixed

- **Findings review keeps complete summaries** — issue rationale text is no longer cut off at 100 characters before the TUI can wrap and display it.

- **Findings review paging** — `PageUp` and `PageDown` now move through the findings by a rendered page while keeping the selected finding visible.

- **Fix Now no longer reports agent work as a user wait** — fixing, verifying, and post-decision settling no longer take keyboard focus or open a prompt surface: they report through the audit table's `fix now · …` row while a raw input listener consumes only Escape (double-Escape still cancels; printable input and Ctrl+C pass through to the editor). The accept/retry/discard decision opens a fresh focused custom overlay per attempt that settles via its `done` callback the moment a key is pressed. Pi therefore reports a user wait only while that decision gate is open, not across the whole fix episode.

## [0.1.3] - 2026-08-21

### Fixed

- **Model picker labels now truncate cleanly** — long slash-namespaced model refs keep the important path segments visible (model name, namespace root, then nearest parent) instead of overflowing the picker; skipped runs collapse to a single ellipsis
- **Truncated model labels no longer leak ANSI escape codes** — the fallback truncation path for very narrow pickers now strips stray escape sequences from the rendered label

## [0.1.2] - 2026-08-18

### Fixed

- **Reviewer picker no longer skips a row per keypress** — on terminals that negotiate the Kitty keyboard protocol, one physical arrow press arrives as separate press, repeat, and release sequences; the shared widget input handler forwarded all of them, so every Down/Up moved the cursor twice and skipped a reviewer. Key-release events are now dropped in the handshake (press and repeat are kept, so held keys still move), fixing navigation across every persona-audit picker
- **Corrected the Implement-phase model-picker summary** — it claimed Implement was the only phase that writes to your files, but gate repairs and regression tests in the Verify phase also write; the summary now says so

## [0.1.1] - 2026-08-17

### Fixed

- **Fixed: a repair round that failed to even run was invisible in the report** — when the gate-repair agent session itself failed (provider error, idle timeout, abort) rather than the verification it was repairing, the failure was recorded on the round object but never rendered, because the rounds table only appeared once a second round existed; that failure now always shows in the report and the chat-summary notes
- **Adjudicator degradation is now loud and retried** — a reconcile session that succeeds but produces unusable output gets one retry before the all-defer fallback, and any annotation degradation (unparsable output, failed reconcile, partial coverage) is shown as a warning banner in the Findings Review header instead of only appearing in the report

### Added

- **Repair loop no longer gives up on the first stall** — every gate-repair round now receives the full attempt history (per-finding verdict history, prior repair reports, and pre-fix snapshot paths for diffing); a recurring failure set triggers one escalated root-cause repair round instead of an immediate stop, and only a set that survives the escalated repair ends the loop (still capped by the configurable round budget)
- **Contested verdicts** — an escalated repair agent that can prove a verifier verdict wrong may dispute it with evidence; disputes are surface-only (rendered in a "Contested Verdicts" report section and noted in the chat summary for human adjudication) and never change verification status

## [0.1.0] - 2026-08-14

Initial release of `/persona-audit` — multi-persona code reviews with interactive TUI expert selection and findings triage.

### Added

- **Multi-persona reviews** — parallel reviewer agents drawn from 40 personas across three tiers (Holistic, Specialist, and named-engineer Persona tiers), each with distinct focus areas and severity grading
- **Deterministic orchestration** — the audit is driven end-to-end by TypeScript, not by an LLM following instructions; LLM reasoning is confined to isolated in-process agent sessions (reviewer passes, adjudication, fix application, verification)
- **Diff mode** (`--diff`) — reviews changed files plus their direct importers, with automatic merge-base detection and `--base`/path scoping
- **Full-tree mode** (`--full`) — deterministic, capped, non-sampled whole-directory scan for projects without git
- **TUI expert picker** — cross-tier multi-select reviewer picker with type-to-filter and per-reviewer pass count (1-5)
- **Per-phase model + thinking picker** — assign a model and thinking level to each of Review/Triage/Implement/Verify
- **Live progress table** — phased `aboveEditor` widget showing per-row context usage, an output-activity meter, in-flight tool calls, turn count, and elapsed time, with a phase/model band and a frozen transcript copy on completion
- **Findings review** — accept/reject/defer triage TUI, with deferred-findings handoff export (`H`) and two-step cancellation
- **Auto-fix** — accepted findings partitioned by file and applied in parallel (up to 3 concurrent) by edit-capable adjudicator agent sessions
- **Conflict resolution** — a fixed precedence chain (category → severity → file → line) ranks findings that touch the same region, capped at 40 applied fixes per run
- **Three-layer fix verification** — byte-level fix-landed hashing, a verifier agent session's evidence-based verdict per finding, and harness-adjudicated red/green regression tests run in a throwaway git worktree
- **Automatic gate-repair rounds** — a round that doesn't pass triggers a bounded repair-and-reverify loop (configurable cap, default 3), with stagnation detection to stop unproductive repeats
- **Incremental cache** — reviewer passes cached by manifest+selection hash; unchanged re-runs skip agent-session spawns
- **Durable progress** — partial report written after every reviewer pass so cancellation or failure never loses completed work
- **Report viewer** — scrollable Markdown overlay opened automatically on completed (non-cancelled) audits
- **Reviewer/verifier retry checkpoints** — retry or re-model failed reviewer passes and failed verifier runs without restarting the audit
- **Settings menu** (`/persona-audit-settings`) — configure the activity monitor's color/direction, the Linus Torvalds reviewer's temperament, and the fix + verify round cap
