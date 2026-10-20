# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- Model references, catalogues, thinking helpers and the unframed picker now come from `@underactive/pi-topping-primitives` 0.5.0; phase, retry and warning policy remains local.
- Saved model references with an empty provider or id are now treated as unset.
- Model-picker footer hints wrap instead of being clipped, and pasted text filters models.
- In the model picker, typing or Backspace while the Select/Cancel buttons are focused now edits the filter and returns to Models; a selected model that still matches stays selected while filtering; kitty-encoded keys filter; Backspace follows pi's key parser and removes one whole character.
- Settings are read and written by the shared `@underactive/pi-topping-primitives` 0.2.0 settings store. The path and tab format are unchanged; temp files get unique names, the file is created 0600 (directory 0700 when new), and a failed save still shows `Could not save persona-audit settings: …`.
- Phase-model saves from the picker are now locked read-modify-write updates that merge into the file as it is now, instead of writing back a config read before the overlay opened. A settings file that is not valid JSON is refused rather than overwritten, with `Could not save phase model settings: …`.
- Use `PI_VIRTUAL_MODEL_API` from `@underactive/pi-topping-primitives/contracts` to identify virtual models.
- The activity meter, shimmer, tool-activity label, output-token tracker and run clock now come from `@underactive/pi-topping-primitives` 0.3.0 (`/activity` and `/activity-tui`) instead of vendored copies.
- The audit progress table's activity meters now saturate at an inclusive 80 tokens/s instead of 40, following the shared `rateToLevel` default.
- Cost formatting (`formatCost`), terminal-byte sanitising (`sanitizeTerminalText`) and the progress table's spinner frames now come from `@underactive/pi-topping-primitives` 0.6.0 (`./text`, `./glyphs`); rendered output is unchanged.

### Fixed

- Tool-activity labels are sanitised before truncation: terminal sequences and control characters are removed, so a tool argument can no longer inject escape sequences into the progress table.
- Invalid exact or partial usage (negative, NaN or Infinity) now falls back to the word-count estimate instead of being added to the output-token count.

## [0.3.1] - 2026-10-16

### Changed

- **Tested against pi 1.3.0** — the extension typechecks and its 636 tests pass against 1.3.0, and the development dependencies are now pinned to 1.3.0. pi 1.3.0 publishes no breaking changes for this surface and removes no symbol this extension imports, so every import from pi-ai, pi-tui and pi-coding-agent compiles unchanged. Host fixes inherited on 1.3.0 include overlay `done()` closing the correct stacked overlay ([#10648](https://github.com/earendil-works/pi/issues/10648)), which matters for Findings Review and Fix Now prompts, and updated thinking-level catalog data from `getSupportedThinkingLevels()`. The extension still registers no `before_agent_start` handler, and its one `pi.sendMessage()` call, the end-of-audit summary, passes `triggerTurn: false`.

- **Tested against pi 1.2.0** — the extension typechecks and its 636 tests pass against 1.2.0, and the development dependencies are now pinned to 1.2.0. pi 1.0.4–1.2.0 remove no symbol this extension imports, so every import from pi-ai, pi-tui and pi-coding-agent compiles unchanged. pi 1.2.0's breaking changes to `before_agent_start` and to runs started by `pi.sendMessage()` do not reach it: the extension registers no `before_agent_start` handler, and its one `pi.sendMessage()` call, the end-of-audit summary, passes `triggerTurn: false`, which still appends the message at once when the session is idle. pi 1.2.0 also stops depending on `@earendil-works/chord`, which removes it and its `esbuild` toolchain from the development install; the extension never imported either.

### Fixed

- **An adjudicator override can no longer give the code-editing sessions bash** — the batch implement, gate-repair and Fix Now sessions take their tools from the adjudicator's `tools:` frontmatter, and they removed only an entry spelled exactly `bash`. Since pi 1.0.4 a `*` in a tool list is a wildcard, and pi 1.1.0 reads a list made only of `+name`/`-name` entries as an edit of pi's own default tools (`read`, `bash`, `edit`, `write`). A `~/.pi/agent/agents/persona-audit-adjudicator.md` override with `tools: -write`, `+codemode` or `read, edit, *` therefore gave those sessions bash again. They now also exclude bash outright, which pi applies before any list entry, so nothing in the list can match it. `+name`/`-name` entries now edit the bundled adjudicator's list, which keeps `grep`, `find` and `ls` that pi's defaults lack, and pi only receives tool names. A list that mixes names with `+`/`-` entries, which pi rejects, now stops the audit before any session starts, with an error naming the file, instead of failing the implement phase after the review has run.

## [0.3.0] - 2026-10-12

### Fixed

- **Audit sessions name a virtual dispatch or phase model instead of reporting a missing API key** — virtual (router) models such as `litellm-auto/*` are listed in pi's model catalogue, so they can be selected as the Dispatch model, a phase model, or inherited as the session model. An isolated audit session replays registered providers onto a fresh model runtime but never the router that picks a physical model, so pi's auth preflight failed on the virtual provider — which holds no credential of its own — with `No API key found for litellm-auto`, surfacing as `Reviewer recommendation failed: No API key found for litellm-auto`. Audit sessions now detect a virtual model and report a failed run whose message names the model and points at the phase picker, the Dispatch model in `/persona-audit-settings`, or `/model` for the session. A physical provider with genuinely missing credentials still reports pi's original error.
- **Fix Now no longer aborts the audit on a virtual fix model** — creating the fix session threw the virtual-model error instead of reporting it. `runFixNow` rejected, the rejection propagated out of the audit, and every remaining finding was lost with it. The fix session now reports a failed run, so Fix Now takes its normal failure path: it notifies `fix agent failed: <model> is a virtual (router) model`, applies no fix, and the review continues.
- **Virtual-model rejections are no longer retried as transient errors** — the adjudicator's reconcile pass retries a non-permanent failure once after five seconds, and it recognized only `Model not found` as permanent. A virtual-model rejection also happens before any network call, so the retry fails the same way. The check now matches that message too, and the reconcile pass ends at once with the message that names the model.

## [0.2.5] - 2026-10-05

### Changed

- **Tested against pi 1.0.3** — the extension typechecks and its 624 tests pass against 1.0.3, and the development dependencies are now pinned to 1.0.3. pi 1.0.1–1.0.3 remove no symbol this extension imports; the changes to types it uses are additive (`samplingParamsByThinkingLevel` on provider model configs, which audit sessions inherit through the replayed provider configs).

## [0.2.4] - 2026-10-02

### Changed

- **Findings Review colors its detail text** — an expanded finding's block headings are now bold in the theme's `mdHeading` token instead of flat `text`, and the text under them is painted per segment: `` `code` `` in `mdCode`, `name()` in `syntaxFunction`, `path/file.ts:12` in `syntaxString`, and a fenced block in `mdCodeBlock`, with the prose around them left in `muted`. A segment carries its own color rather than sitting inside a muted line, so text after a highlighted identifier keeps its color. Headings stay non-status tokens — the ⚑ and the status column still carry severity — and the tokens match the ones pi's Markdown component uses, so the overlay and the saved report read alike.
- **Findings Review keeps expanded findings open** — expansion now belongs to the finding rather than the highlight, so `↑`/`↓` and `PageUp`/`PageDown` no longer collapse the finding the highlight leaves and several findings can be open at once. `←` collapses only the highlighted finding, every open finding is still open when the review reopens after `F`, and an open finding the highlight is not on keeps a dimmed `⌄` so its state stays visible.
- **Tested against pi 1.0.0, and the progress table leaves room for its fullscreen dock** — the extension typechecks and its 624 tests pass against 1.0.0 and still against 0.99.2, and the development dependencies are now pinned to 1.0.0. pi 1.0.0 removes no publicly exported symbol, so every import this extension makes from pi-ai, pi-tui and pi-coding-agent compiles unchanged; the only changes to the types it uses are additive (`ModelRegistry.generateImages()`, the `QuietStartup` settings type). pi 1.0.0 also defaults `tuiMode` to `"fullscreen"`, which pins the editor and footer in a dock below the transcript. The audit progress table now takes its half-height share from the rows above that dock instead of the whole terminal, so in fullscreen it folds settled and queued passes sooner and leaves the transcript more room. Overlays already draw over the full screen and keep their size, and the Fix Now gate now redraws when only the terminal's height changes, since pi does not invalidate components on resize. With `tuiMode: "regular"`, every size is unchanged.

### Fixed

- **Findings Review marks the expanded finding** — the highlighted finding's `❯` turns into a `⌄` while its details are open, so a row states its own expansion. Collapsing restores the `❯`, and a finding left open under another highlight keeps a dimmed `⌄`. Both glyphs are one column wide, so the row's columns never shift.
- **Findings Review repaints after the host invalidates it** — each finding's painted Summary and Rationale lines were cached per item, and those caches survived the component's `invalidate()`, so a host repaint after a theme change kept drawing the old colors on screen. `invalidate()` now clears every item's summary and detail paint caches. Navigation and other internal state changes go through a narrower private path, so moving through findings still reuses the word-wrapping caches instead of rebuilding them on every keystroke.
- **Scanning a finding's detail text no longer goes quadratic** — the pattern behind the detail colorizer could restart a call match inside an identifier or a dotted receiver, so long identifier-heavy text was scanned in quadratic time. A lookbehind now stops a match from beginning mid-identifier; what the pattern matches, including the path alternative, is unchanged.
- **README states the real cancellation and stopping behavior** — two sections described behavior the code stopped having some time ago. Fix + Verify stagnation no longer claims an immediate stop: a second occurrence of an actionable failure set schedules an escalated repair while round budget remains, and a third stops the loop. Cancellation no longer claims that Esc in the ExpertPicker cancels the command, or that cancelling the review applies no fixes: Esc there returns to reviewer-source selection, and two Escs in Findings Review cancel the remaining work while keeping the Fix Now fixes already applied and committed.

## [0.2.3] - 2026-09-30

### Changed

- **Findings Review opens collapsed** — each finding now shows only its status row and Summary. `→` expands the highlighted finding's Rationale, Exploitability, disputes, Derived from, Suggested Change, and recommendation reason; `←` collapses them, and moving the highlight with `↑`/`↓` or `PageUp`/`PageDown` collapses the finding it leaves, so at most one finding is open at a time. The header hint lists the two keys. A finding expanded when `F` starts Fix Now is still expanded when the review reopens.
- **Findings Review locations stand out** — each finding row's `file:line` now renders in bold `text` instead of `dim`, so the location reads at a glance beside the reviewer name.
- **Findings Review flags disputes** — each `Disputed by …` heading in an expanded finding now starts with a `⚑` in the theme's `warning` color, so a cross-examination objection stands out among the detail blocks. The `⚑` before the adjudicator's `Why defer:` reason is now `warning` and before `Why reject:` is `error`. Heading text keeps the shared heading color.
- **Rationale heading names the category** — an expanded finding's Rationale heading now reads `Rationale (bug):` instead of giving the category a line of its own. In blast-radius sort, the blast bucket and its leading reasons remain the first line of the block.
- **Development dependencies updated to pi 0.99.2** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` are pinned to 0.99.2 for development and testing.
- **Tested against pi 0.99.2** — the extension typechecks and its 589 tests pass against 0.99.2, and an audit session created through the extension's own `createInteractiveAgentSession()` completes a model call. No code change was needed: pi's published `dist/index.d.ts` is unchanged from 0.99.1, the release's MCP, codemode, and tool-exposure changes do not reach this extension (it registers no tools and no MCP servers), and audit sessions keep their isolated loader and read-only tool lists.
- **Upgrading pi brings host-side fixes to long audits** — pi 0.99.2 no longer looks the model catalog up once per assistant message while resolving a session's model, so submitting a prompt in the host session stays fast after an audit has filled it; merges a refreshed pi.dev catalog in linear time instead of quadratic time; backs off exponentially instead of retrying immediately when a provider sends an unparseable `Retry-After` date; and sends Anthropic tool schemas that use `minimum` or `maximum` as non-strict. All four land in pi itself, so the extension only benefits by requiring it.

### Fixed

- **Cancelling after Fix Now no longer claims no fixes were made** — Fix Now fixes land (and commit) before the review ends, and cancelling keeps them. The cancel confirmation now reads `N Fix Now fixes kept, no others applied` and wraps instead of being clipped at narrow widths. The Audit Summary counts them as fixed interactively. The partial report's status line and note say they were kept, and it lists them with their commits under `Fixed interactively`.

## [0.2.2] - 2026-09-29

### Added

- **Per-model audit image resizing is documented** — review models can opt into pi's `inputLimits.images.resize` profile for audit image attachments through `~/.pi/agent/models.json`.

### Changed

- **Development dependencies updated to pi 0.99.1** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` are pinned to 0.99.1 for development and testing.
- **Tested against pi 0.99** — the extension typechecks and its 578 tests pass against both 0.99.0 and the pinned 0.99.1, and an audit session created through the extension's own `createInteractiveAgentSession()` completes a model call on 0.99.0. No code change was needed: audit sessions keep their isolated loader and read-only tool lists.

### Fixed

- **Audit sessions follow pi's project trust** — audit agent sessions load the audited project's pi settings, packages, skills, and prompt files only when the host trusts the project. Before, an untrusted checkout's `.pi/settings.json` could install packages through its own `npmCommand` as soon as an audit session started.
- **Failed runtime builds are no longer cached** — the provider-replay runtime is cached per model registry so one build serves a whole audit's agent sessions, but a rejected build stayed in that cache. Every later session in the same host reused the failure and failed the same way. A failed build is now evicted, so the next session retries instead of inheriting the error.
- **Findings Review keeps wide and long detail text** — CJK and other wide characters no longer lose text at the frame edge, and long paths or URLs wrap without inserted `…` markers.
- **Findings Review detail blocks share one style** — Summary, Rationale, Exploitability, dispute, Derived from, Suggested Change, and recommendation-reason headings now render in one heading color with muted content beneath.
- **README states the real Node.js minimum** — the Requirements list said Node.js ≥ 22.x, but `package.json` requires ≥ 22.19.0 through `engines`. The README now says ≥ 22.19.0.

## [0.2.1] - 2026-09-20

### Changed

- **Development dependencies updated to pi 0.86.0** — `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` are pinned to 0.86.0 for development and testing.

### Fixed

- **Cross-examination dispute reasons are no longer amputated at 200 characters** — the merge keeps up to 500 characters, and the reviewer directive states the same limit. Reports and handoffs already written keep their shorter text.
- **Headless agent sessions no longer inherit cache warming** — pi 0.86.0 warms the prompt cache of every session it creates and reports that spend outside the progress table's message-driven COST column. Audit sessions now force warming off while preserving other global and project settings; the user's own cache-warming setting and `settings.json` remain untouched.
- **Retired models in saved settings are detected** — the per-phase picker, Dispatch model row, and pre-audit dispatcher validate saved refs against the model registry, name refs that disappeared, and fall back to the session model instead of failing with "Model not found" or resolving a same-named model under another provider.
- **`max` thinking reaches headless sessions** — the runner now forwards `max` to `createAgentSession()`, which clamps it to the selected model's capability, instead of silently replacing it with the session default.

## [0.2.0] - 2026-09-14

### Added

- **Reviewer source menu** — `/persona-audit` now opens on a choice between inspecting the repo for a recommendation, loading a saved roster, or selecting reviewers manually. The new dispatcher agent receives a deterministic repo fingerprint (languages, root manifests, frameworks, and auth/database/container/native/AI signals) plus read-only tools, and returns 3–10 reviewers with reasons; they open pre-checked in the expert picker. The recommendation is cached for the rest of the command, and `ctrl+shift+c` cancels the dispatcher.
- **Dispatch model setting** — `/persona-audit-settings` gains a Dispatch model row that opens the two-pane model/thinking selector; `Backspace` clears it, and an unset slot falls back to the session model with a warning.
- **Repo inspection feedback** — the dispatcher now shows a left-aligned animated spinner, elapsed time, and the cancellation shortcut while it fingerprints the repository and recommends reviewers.

- **Red Team reviewer tiers** — 13 security reviewers in two new picker tiers after Persona. Red Team Core covers authorization and tenancy, authentication and sessions, injection and input handling, the browser trust boundary, business logic and abuse, secrets/data/exposure, and infrastructure and supply chain. Red Team Specialists covers cryptography and protocols, memory safety and native code, embedded systems and hardware, concurrency and state machines, client and IPC surfaces, and AI and agent surfaces. The extension now includes 53 reviewers; the README notes which slots justify the strongest Review-phase model.

- **Thinking-level monitor colors** — added `thinkingLevel` as a selectable activity-monitor color mode and made it the default; existing fixed colors remain available.
- **Reviewer cross-examination and exploitability grading** — selected reviewers can run a second pass over the other reviewers' deduplicated findings to attach structured disputes (`false-positive`, `unreachable`, `overstated`) or raise composite findings. The setting supports `off`, Red Team Specialists (default), and all reviewers; each enabled reviewer adds one Review-slot session. Reports and handoffs preserve dispute and composite evidence, while the adjudicator grades findings as `direct`, `conditional`, `theoretical`, or `none` and orders apply findings by exploitability. Cross-examination cache entries are reused only when every first-pass review came from cache and the mode, reviewer set, directive, findings, and review model still match.

### Changed

- **Rosters moved out of the expert picker** — saved rosters now have their own picker behind the source menu's Load reviewer roster option, rendered as before (name, members, second-`Enter` cost confirmation). The expert picker lists only individual reviewers.
- **Esc steps back in the expert picker** — `Esc` in the multi-select picker returns to the source menu with the selection intact instead of cancelling the audit; the source menu's `Esc` cancels.
- **Color-coded tool activity** — progress-table `↳` sub-rows now color the tool name bold `toolTitle` and the argument `accent`, matching the sibling/pi renderers.
- **Styled roster reviewer picker** — reviewer slots now use the audit flow's tiered picker, with reviewers already assigned to other slots hidden.

### Fixed

- **Two-pane picker highlight spans full pane width** — selection background now applies only to the active pane's composed cell, matching the sibling project's layout.
- **Thinking pane sized to longest level** — content-aware width calculation replaces the fixed 50/50 split, giving models the remaining width.
- **Audit time excludes user waiting** — the audit no longer counts time spent waiting on the user toward its elapsed time; the excluded wait is now shown separately in the report, the chat summary, and the progress-table footer.

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
