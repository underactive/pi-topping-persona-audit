# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
- **Conflict resolution** — a fixed precedence chain (category → severity → blast radius → root cause) reconciles findings that touch the same region, capped at 40 applied fixes per run
- **Three-layer fix verification** — byte-level fix-landed hashing, a verifier agent session's evidence-based verdict per finding, and harness-adjudicated red/green regression tests run in a throwaway git worktree
- **Automatic gate-repair rounds** — a round that doesn't pass triggers a bounded repair-and-reverify loop (configurable cap, default 3), with stagnation detection to stop unproductive repeats
- **Incremental cache** — reviewer passes cached by manifest+selection hash; unchanged re-runs skip agent-session spawns
- **Durable progress** — partial report written after every reviewer pass so cancellation or failure never loses completed work
- **Report viewer** — scrollable Markdown overlay opened automatically on completed (non-cancelled) audits
- **Reviewer/verifier retry checkpoints** — retry or re-model failed reviewer passes and failed verifier runs without restarting the audit
- **Settings menu** (`/persona-audit-settings`) — configure the activity monitor's color/direction, the Linus Torvalds reviewer's temperament, and the fix + verify round cap
