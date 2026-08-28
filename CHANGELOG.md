# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Aggregate progress-table cost readout** — the footer now shows the cumulative model cost beside whole-run elapsed time; an asterisk marks a partial total when one or more rows have unavailable or invalid cost telemetry.

- **Resume from a deferred-findings handoff** — `/persona-audit --handoff <path>` re-opens a handoff written during triage (`H` in the findings review) and resumes the audit from there: the reviewer and adjudication phases are skipped, the deferred findings load straight into the findings review overlay (pre-set to apply), and the implement/verify pipeline plus final report run as usual. Handoffs now embed a schema-versioned machine-readable payload (lossless findings JSON plus the HEAD commit at write time); on resume the run warns when the tree has moved since the handoff was written and drops findings whose target file no longer exists. Handoffs written before this release have no payload and cannot be resumed.

- **Tool-call and cost columns in the progress table** — rows now show cumulative tool calls and model cost (`$0.000`, or `—` when the model cannot be resolved) beside turns and elapsed time; the stats block still sheds as one unit on narrow terminals

- **Diff base hash in the progress table header** — in `--diff` mode the title bar now shows the short hash of the commit the audit diffed from (e.g. `src/components · @a1b2c3d`), reporting the merge-base when `--base` names a ref rather than that ref's own tip; the hash also persists into the frozen transcript snapshot

### Changed

- **Audit progress phase separators** — phase subheadings now use horizontal rules, with blank lines separating each phase group; the responsive height budget accounts for the added rows.

- **Compact audit progress layout** — phase headings now separate agent groups, while agent rows use the sibling status-and-label geometry without phase or tree-connector columns; responsive width and height budgets account for the compact layout.

- **Headless progress table displays generated token counts** — instead of character counts, uses abbreviated formatting (e.g., "1.2K tokens") for easier reading in the ACTIVITY column.

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
