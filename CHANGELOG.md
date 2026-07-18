# Changelog

このプロジェクトは Semantic Versioning に沿って管理します。

## Unreleased

## v3.6.9 (2026-07-18)

_Patch release promoted from `v3.6.9-rc.1`. Fixes the multi-window session "hijack" where the tracker could re-attach to another Claude Code window's session in the same directory, and folds in a small privacy/hygiene batch (verification-command masking, non-standard statusline-wrapper detection, and a legacy `evo doctor` self-check fallback)._

### Added
- **Opt-in exact session binding.** Set `EVO_BIND_SESSION_ID=1` and the wrapper injects a `--session-id <uuid>` into the `claude` it launches, so the tracker binds to that exact session's transcript from the start — the most precise fix when you run several Claude Code windows in the same folder. Strictly opt-in and safe: it does nothing for a non-`claude` CLI, when you already pass your own `--session-id`, when resuming/continuing (`-c`/`--continue`/`-r`/`--resume`), for `--help`/`--version`, or for `claude` subcommands (`mcp`/`config`/`doctor`/…); in any of those it falls back to the default binding. (Requires a `claude` that accepts `--session-id`.)

### Fixed
- **Multi-window session attribution.** With several Claude Code windows open in the same directory, the tracker could migrate its lock to a newer window's transcript, misattributing turns, tool calls, and grade to the wrong session's EvoPet (corrupting both the live statusline and the recorded episode). The tracker now **binds to its own session and stays there**: once locked it never re-attaches to a different transcript in the same directory. A per-session owner registry under `<project>/.evo/sessions/.owners/` (keyed by session id + pid, with dead-process cleanup) keeps parallel windows from claiming each other's session. This is the recording-side root fix complementing the earlier display-side mitigation. All registry operations fail open: a broken or unwritable registry degrades to the previous binding strength instead of stopping tracking. Escape hatch: `EVO_DISABLE_STICK_HARD=1` restores the previous behavior.
- **Verification events no longer store the raw command.** The test/build verification event persisted the raw executed command into the local database while its output previews were already secret-masked; the stored `command` is now masked too (the command actually run is unchanged), so a token passed on a command line can't linger in `.evo/evolutionary.db`.
- **`evo install-statusline` detects non-standard wrapper setups.** The guard that avoids clobbering an existing wrapper-based statusline previously only matched standard wrapper names in `statusLine.command`. It now also does a best-effort, read-only peek into the referenced script(s) for wrapper markers, so a hand-built wrapper with a non-standard script name is left intact instead of being overwritten (which would render EvoPet twice).

### Changed
- **`evo doctor` reads the legacy self-check location as a fallback.** When the primary `<EVO_HOME>/.evo/` self-check state is absent or unreadable, `doctor` now falls back to the pre-v3.6.4 `~/.claude/.evo-selfcheck.json` (read-only; the primary always wins when present), so a self-check written by an older build is still surfaced.

### Internal
- Tightened the wording of the live-tree / QA discipline rule in the repo `CLAUDE.md` (review nit from #100/#101) and added a `docs/ai/raw-hash-design.md` design memo (indexed in `docs/ai/README.md`).
- B1 binding logic is fully unit-tested (stick-hard non-migration, exact-binding, owner claim/conflict/stale-pid reclaim/GC, injection gating + fallbacks incl. subcommand skip); all binding operations are best-effort / fail-open so a broken registry degrades to prior behavior rather than blocking tracking. Design doc: `docs/ai/b1-session-binding.md`.

## v3.6.9-rc.1 (2026-07-18)

### Added
- **Opt-in exact session binding.** Set `EVO_BIND_SESSION_ID=1` and the wrapper injects a `--session-id <uuid>` into the `claude` it launches, so the tracker binds to that exact session's transcript from the start — the most precise fix when you run several Claude Code windows in the same folder. Strictly opt-in and safe: it does nothing for a non-`claude` CLI, when you already pass your own `--session-id`, when resuming/continuing (`-c`/`--continue`/`-r`/`--resume`), for `--help`/`--version`, or for `claude` subcommands (`mcp`/`config`/`doctor`/…); in any of those it falls back to the default binding. (Requires a `claude` that accepts `--session-id`.)

### Fixed
- **Multi-window session attribution.** With several Claude Code windows open in the same directory, the tracker could migrate its lock to a newer window's transcript, misattributing turns, tool calls, and grade to the wrong session's EvoPet (corrupting both the live statusline and the recorded episode). The tracker now **binds to its own session and stays there**: once locked it never re-attaches to a different transcript in the same directory. A per-session owner registry under `<project>/.evo/sessions/.owners/` (keyed by session id + pid, with dead-process cleanup) keeps parallel windows from claiming each other's session. This is the recording-side root fix complementing the earlier display-side mitigation. All registry operations fail open: a broken or unwritable registry degrades to the previous binding strength instead of stopping tracking. Escape hatch: `EVO_DISABLE_STICK_HARD=1` restores the previous behavior.
- **Verification events no longer store the raw command.** The test/build verification event persisted the raw executed command into the local database while its output previews were already secret-masked; the stored `command` is now masked too (the command actually run is unchanged), so a token passed on a command line can't linger in `.evo/evolutionary.db`.
- **`evo install-statusline` detects non-standard wrapper setups.** The guard that avoids clobbering an existing wrapper-based statusline previously only matched standard wrapper names in `statusLine.command`. It now also does a best-effort, read-only peek into the referenced script(s) for wrapper markers, so a hand-built wrapper with a non-standard script name is left intact instead of being overwritten (which would render EvoPet twice).

### Changed
- **`evo doctor` reads the legacy self-check location as a fallback.** When the primary `<EVO_HOME>/.evo/` self-check state is absent or unreadable, `doctor` now falls back to the pre-v3.6.4 `~/.claude/.evo-selfcheck.json` (read-only; the primary always wins when present), so a self-check written by an older build is still surfaced.

### Internal
- Tightened the wording of the live-tree / QA discipline rule in the repo `CLAUDE.md` (review nit from #100/#101) and added a `docs/ai/raw-hash-design.md` design memo (indexed in `docs/ai/README.md`).
- B1 binding logic is fully unit-tested (stick-hard non-migration, exact-binding, owner claim/conflict/stale-pid reclaim/GC, injection gating + fallbacks incl. subcommand skip); all binding operations are best-effort / fail-open so a broken registry degrades to prior behavior rather than blocking tracking. Design doc: `docs/ai/b1-session-binding.md`.

## v3.6.8 (2026-07-18)

_Patch release promoted from `v3.6.8-rc.1`. Dependency maintenance: `commander` 14 → 15 and `better-sqlite3` 12.9 → 12.11, with no user-facing behavior change; also documents the compressed risk-tiered release-gate flow._

### Changed
- Dependency bumps: `commander` 14 → 15 (the CLI argument-parsing library — major version) and `better-sqlite3` 12.9 → 12.11 (the native SQLite driver). No user-facing behavior change intended; the CLI surface and DB layer are unchanged.

### Internal
- Updated the risk-tiered release-gate policy in `docs/RELEASE_PROCESS.md`: Tier 2 now skips the RC channel entirely (version bump folded into the train PR, a single combined review+matrix gate agent, direct stable dispatch — the stable workflow's own 3-OS smoke + OIDC publish is the safety net); Tier 3 keeps the RC soak + two independent gate agents. A pure dependency bump uses a Tier-3 variant: CI clean-`npm ci` build+test+closure-guard with the new deps + a targeted new-deps smoke + the RC soak, instead of a full behavioral matrix on hand-provisioned deps.

## v3.6.8-rc.1 (2026-07-18)

### Changed
- Dependency bumps: `commander` 14 → 15 (the CLI argument-parsing library — major version) and `better-sqlite3` 12.9 → 12.11 (the native SQLite driver). No user-facing behavior change intended; the CLI surface and DB layer are unchanged.

### Internal
- Updated the risk-tiered release-gate policy in `docs/RELEASE_PROCESS.md`: Tier 2 now skips the RC channel entirely (version bump folded into the train PR, a single combined review+matrix gate agent, direct stable dispatch — the stable workflow's own 3-OS smoke + OIDC publish is the safety net); Tier 3 keeps the RC soak + two independent gate agents.

## v3.6.7 (2026-07-18)

_Patch release promoted from `v3.6.7-rc.1`. Extends the secret-masking to CLI **output** captured in events, guards `evo install-statusline` against clobbering a wrapper-based statusline setup, and documents the risk-tiered release-gate policy._

### Fixed
- CLI **output** text captured into tool-lifecycle and adapter events is now secret-masked before it is stored in the local database. Previously the ≤300-char output-line snippets in `episode_events.details_json` (tool call/edit/approval/retry/recovery events, search/log/test/build detections) and the command output previews of verification runs were persisted raw — CLI output can echo a pasted token/key. Detection still runs on the raw line; only the persisted snippet is masked.
- `evo install-statusline` no longer overwrites an existing **wrapper-based** statusline setup. If your `statusLine.command` runs a wrapper (or `evo statusline`) — the split "token-only base + `evo statusline`" construction that `npm run setup` deploys — the installer now prints a one-line notice and leaves your wiring untouched, instead of deploying the full renderer on top of a token-only base (which would render EvoPet twice).

### Internal
- Documented the risk-tiered release-gate policy in `docs/RELEASE_PROCESS.md` (Tier 1 docs/test → CI + self-check; Tier 2 minor behavior → one review + targeted matrix + diff-verify promotion; Tier 3 startup/native/major-deps → full ceremony), plus the RC-OIDC hard gate and the direct implementer⇄reviewer/QA handoff.

## v3.6.7-rc.1 (2026-07-18)

### Fixed
- CLI **output** text captured into tool-lifecycle and adapter events is now secret-masked before it is stored in the local database. Previously the ≤300-char output-line snippets in `episode_events.details_json` (tool call/edit/approval/retry/recovery events, search/log/test/build detections) and the command output previews of verification runs were persisted raw — CLI output can echo a pasted token/key. Detection still runs on the raw line; only the persisted snippet is masked.
- `evo install-statusline` no longer overwrites an existing **wrapper-based** statusline setup. If your `statusLine.command` runs a wrapper (or `evo statusline`) — the split "token-only base + `evo statusline`" construction that `npm run setup` deploys — the installer now prints a one-line notice and leaves your wiring untouched, instead of deploying the full renderer on top of a token-only base (which would render EvoPet twice).

### Internal
- Documented the risk-tiered release-gate policy in `docs/RELEASE_PROCESS.md` (Tier 1 docs/test → CI + self-check; Tier 2 minor behavior → one review + targeted matrix + diff-verify promotion; Tier 3 startup/native/major-deps → full ceremony), plus the RC-OIDC hard gate and the direct implementer⇄reviewer/QA handoff.

## v3.6.6 (2026-07-18)

_Patch release promoted from `v3.6.6-rc.1`. Follow-ups to the 3.6.5 secret-masking work: the `evo run` path now honors `capture.promptText`, the `sk-…` secret pattern is tightened, the secret-masking behavioral gates are adopted into the QA suite, and a flaky Windows CI test is stabilized._

### Fixed
- The `evo run` path now honors `capture.promptText`: when prompt-text capture is disabled, the prompt-submitted event no longer stores a preview of your prompt in the local database (it previously persisted one unconditionally, bypassing the privacy flag). When enabled, the preview stays secret-masked.

### Changed
- Tightened the standalone `sk-…` secret pattern used when masking stored text: it now requires a real key-length body and recognizes `sk-proj-`/`sk-svcacct-` in addition to `sk-ant-`, so short benign words like `sk-cli` are no longer masked while real API keys still are.

### Internal
- Adopted the secret-masking behavioral gates into `scripts/qa/` as permanent suites wired into `run-all`: **H7ext** checks masking across every persisted text site (turn input/previews, episode + prompt-profile previews, and `episode_events.details_json`), and **H7run** checks the `evo run` prompt-submitted event path.
- Stabilized the flaky Windows interpreter-shim wedge test (raised its timeout budget and added one retry) so loaded-runner contention no longer false-fails CI; a genuine `/exit`-hang regression still fails.

## v3.6.6-rc.1 (2026-07-18)

### Fixed
- The `evo run` path now honors `capture.promptText`: when prompt-text capture is disabled, the prompt-submitted event no longer stores a preview of your prompt in the local database (it previously persisted one unconditionally, bypassing the privacy flag). When enabled, the preview stays secret-masked.

### Changed
- Tightened the standalone `sk-…` secret pattern used when masking stored text: it now requires a real key-length body and recognizes `sk-proj-`/`sk-svcacct-` in addition to `sk-ant-`, so short benign words like `sk-cli` are no longer masked while real API keys still are.

### Internal
- Adopted the secret-masking behavioral gates into `scripts/qa/` as permanent suites wired into `run-all`: **H7ext** checks masking across every persisted text site (turn input/previews, episode + prompt-profile previews, and `episode_events.details_json`), and **H7run** checks the `evo run` prompt-submitted event path.
- Stabilized the flaky Windows interpreter-shim wedge test (raised its timeout budget and added one retry) so loaded-runner contention no longer false-fails CI; a genuine `/exit`-hang regression still fails.

## v3.6.5 (2026-07-18)

_Patch release promoted from `v3.6.5-rc.1`. Privacy + hygiene: prompt/output text stored in the local tracking database is secret-masked before write (across every persisted text site), startup sweeps orphaned atomic-write temp files, and the v3.6.0 `SQLITE_BUSY` notes are consolidated into one narrative._

### Changed
- Prompt/output text stored in the local tracking database is now **secret-masked** before it is written. In addition to `KEY=…`/`"KEY":"…"` assignment values (token/key/secret/password names), standalone credential shapes pasted into a prompt are masked too — AWS `AKIA…`/`ASIA…` access keys, GitHub `ghp_…`/`gho_…` tokens, `sk-…` (and `sk-ant-…`) API keys, Google `AIza…` keys, Slack `xox…` tokens, `Bearer …` headers, and PEM private-key blocks — each replaced with `[REDACTED]`. This covers every persisted text site (turn input/previews, episode and prompt-profile previews, and the prompt-submitted event). The sha256 and length recorded for dedupe/metrics are still computed over the **raw** input, so masking does not change measurement. The redaction patterns are now shared with `evo logs --bundle` (single source in `src/redact.ts`).

### Fixed
- Startup now sweeps orphaned atomic-write temp files — `*.tmp.<pid>.<ts>.<rand>` left behind when a process is killed between the temp write and the rename — from `<cwd>/.evo/` and `.evo/sessions/`, alongside the existing stale per-session GC. Only files matching that exact temp shape and older than an hour are removed; the sweep is best-effort and never blocks startup.

### Internal
- Consolidated the three overlapping `SQLITE_BUSY` bullets in the v3.6.0 changelog notes into a single three-tier narrative (`busy_timeout` for ordinary contention → `IMMEDIATE` transactions for upgrade-deadlocks → first-open WAL-switch retry). Documentation only — no behavior change.

## v3.6.5-rc.1 (2026-07-18)

### Changed
- Prompt/output text stored in the local tracking database is now **secret-masked** before it is written. In addition to `KEY=…`/`"KEY":"…"` assignment values (token/key/secret/password names), standalone credential shapes pasted into a prompt are masked too — AWS `AKIA…`/`ASIA…` access keys, GitHub `ghp_…`/`gho_…` tokens, `sk-…` (and `sk-ant-…`) API keys, Google `AIza…` keys, Slack `xox…` tokens, `Bearer …` headers, and PEM private-key blocks — each replaced with `[REDACTED]`. This covers every persisted text site (turn input/previews, episode and prompt-profile previews, and the prompt-submitted event). The sha256 and length recorded for dedupe/metrics are still computed over the **raw** input, so masking does not change measurement. The redaction patterns are now shared with `evo logs --bundle` (single source in `src/redact.ts`).

### Fixed
- Startup now sweeps orphaned atomic-write temp files — `*.tmp.<pid>.<ts>.<rand>` left behind when a process is killed between the temp write and the rename — from `<cwd>/.evo/` and `.evo/sessions/`, alongside the existing stale per-session GC. Only files matching that exact temp shape and older than an hour are removed; the sweep is best-effort and never blocks startup.

### Internal
- Consolidated the three overlapping `SQLITE_BUSY` bullets in the v3.6.0 changelog notes into a single three-tier narrative (`busy_timeout` for ordinary contention → `IMMEDIATE` transactions for upgrade-deadlocks → first-open WAL-switch retry). Documentation only — no behavior change.

## v3.6.4 (2026-07-18)

_Patch release promoted from `v3.6.4-rc.1`. Sharpens the wrapper self-check's observability and trust: the fallback warning now names the exact broken component and prints as plain ASCII on every Windows console, the wrapper refuses to cache or persist a `claude` that resolves into a temp/scratchpad path (and `evo doctor` flags it as critical), and the self-check state is written under the project's own `.evo/` (honoring `EVO_HOME`) instead of your global `~/.claude`._

### Added
- `evo doctor` now flags a `claude` command that resolves into a temp/scratchpad path (almost always a stale QA mock) as a **critical issue**, and tells you exactly how to fix it.

### Changed
- The wrapper now **refuses to use or persist** a `claude` resolved under a temp/scratchpad path, so a stray mock can never be cached into your config or baked into regenerated shims.
- The self-check warning is clearer and safer: it **names the specific broken component** (e.g. the exact tree-sitter grammar), and the one-line Node-level warning is now **ASCII/English** so it renders identically on every Windows console codepage (a legacy `chcp 932` console would mojibake UTF-8 bytes). The generated shim-level fallback was already ASCII.
- The self-check state is now written under the project's own `.evo/` directory (honoring `EVO_HOME`) instead of your global `~/.claude`, so a normal launch no longer writes into `~/.claude`.

### Internal
- Added unit tests for self-check state persistence, `EVO_HOME` resolution, `evo doctor` rendering, and the temp-resident-target guard; updated the behavioral harness to match; added a QA discipline rule (isolated cwd/EVO/HOME for real-integration runs, quote the real claude version line in release verifications).

## v3.6.4-rc.1 (2026-07-18)

### Added
- `evo doctor` now flags a `claude` command that resolves into a temp/scratchpad path (almost always a stale QA mock) as a **critical issue**, and tells you exactly how to fix it.

### Changed
- The wrapper now **refuses to use or persist** a `claude` resolved under a temp/scratchpad path, so a stray mock can never be cached into your config or baked into regenerated shims.
- The self-check warning is clearer and safer: it **names the specific broken component** (e.g. the exact tree-sitter grammar), and the one-line Node-level warning is now **ASCII/English** so it renders identically on every Windows console codepage (a legacy `chcp 932` console would mojibake UTF-8 bytes). The generated shim-level fallback was already ASCII.
- The self-check state is now written under the project's own `.evo/` directory (honoring `EVO_HOME`) instead of your global `~/.claude`, so a normal launch no longer writes into `~/.claude`.

### Internal
- Added unit tests for self-check state persistence, `EVO_HOME` resolution, `evo doctor` rendering, and the temp-resident-target guard; updated the behavioral harness to match; added a QA discipline rule (isolated cwd/EVO/HOME for real-integration runs, quote the real claude version line in release verifications).

## v3.6.3 (2026-07-17)

_Patch release promoted from `v3.6.3-rc.1`. Hardens the wrapper self-check added in 3.6.2: it now checks that every code parser (JavaScript, Python, and TypeScript) actually loads, so a broken parser is caught at startup and the wrapper falls back to the real `claude`, instead of the problem only surfacing later on the first file of that language._

### Changed
- The startup self-check (and `evo doctor --quick`) now verifies that **all** of the code parsers load — JavaScript, Python, and TypeScript — not just JavaScript. A parser whose native component is present but broken is now caught up front (and triggers the safe fallback to the real `claude`) instead of only failing later, on the first file of that language.

### Internal
- Hardened the native-dependency drift-guard test to derive the set it exercises from the addon list, so a newly added native addon is covered automatically and the checked list can't quietly go stale. Added a repository rule against rebuilding the released bundle from a feature branch.

## v3.6.3-rc.1 (2026-07-17)

### Changed
- The startup self-check (and `evo doctor --quick`) now verifies that **all** of the code parsers load — JavaScript, Python, and TypeScript — not just JavaScript. A parser whose native component is present but broken is now caught up front (and triggers the safe fallback to the real `claude`) instead of only failing later, on the first file of that language.

### Internal
- Hardened the native-dependency drift-guard test to derive the set it exercises from the addon list, so a newly added native addon is covered automatically and the checked list can't quietly go stale. Added a repository rule against rebuilding the released bundle from a feature branch.

## v3.6.2 (2026-07-17)

_Patch release promoted from `v3.6.2-rc.1`. Makes a broken Evo install visible and non-blocking: the `claude` wrapper now runs a fast self-check at startup and, if anything is wrong (for example a native component that won't load), prints one clear warning line and runs the real `claude` directly instead of crashing or hanging. The result is recorded and shown in `evo doctor`, and a new `evo doctor --quick` gives an on-demand health check. Native components now load on first use, so `claude --version` and `evo doctor` keep working even when one is broken._

### Added
- `evo doctor --quick`: a fast self-check — bundle present, native dependencies present, native components actually load, and the real `claude` is resolvable — that exits non-zero if anything is wrong. Use it to diagnose a broken wrapper, or as a quick pre-release check.
- Wrapper self-health-check. Before starting a tracked session, the `claude` wrapper now confirms it can actually run. If something is broken (for example a native component that won't load), it prints one clear warning line and runs the real `claude` directly instead of crashing or hanging — so a broken Evo install is never silent and never blocks you.
- The result of that self-check is recorded and shown in `evo doctor`: a "Wrapper Self-check" line reports whether the last startup was healthy, and a failed check is called out as a critical issue with what to fix.

### Changed
- Native components (the database and code-parsing engines) now load the first time they're needed instead of at startup. This means `claude --version` and `evo doctor` keep working — and can tell you what's wrong — even when a native component is broken, rather than failing before anything can run.

### Internal
- The list of native runtime dependencies the wrapper checks for is now covered by a drift-guard test that measures the packages actually loaded when exercising the native components, so the list can't silently go stale. Removed unused, stale wrapper-generation code.

## v3.6.2-rc.1 (2026-07-17)

### Added
- `evo doctor --quick`: a fast self-check — bundle present, native dependencies present, native components actually load, and the real `claude` is resolvable — that exits non-zero if anything is wrong. Use it to diagnose a broken wrapper, or as a quick pre-release check.
- Wrapper self-health-check. Before starting a tracked session, the `claude` wrapper now confirms it can actually run. If something is broken (for example a native component that won't load), it prints one clear warning line and runs the real `claude` directly instead of crashing or hanging — so a broken Evo install is never silent and never blocks you.
- The result of that self-check is recorded and shown in `evo doctor`: a "Wrapper Self-check" line reports whether the last startup was healthy, and a failed check is called out as a critical issue with what to fix.

### Changed
- Native components (the database and code-parsing engines) now load the first time they're needed instead of at startup. This means `claude --version` and `evo doctor` keep working — and can tell you what's wrong — even when a native component is broken, rather than failing before anything can run.

### Fixed

### Internal
- The list of native runtime dependencies the wrapper checks for is now covered by a drift-guard test that measures the packages actually loaded when exercising the native components, so the list can't silently go stale. Removed unused, stale wrapper-generation code.

## v3.6.1 (2026-07-17)

_Patch release promoted from `v3.6.1-rc.1`. It makes `claude` resilient to a dev-box problem where an external process repeatedly deleted dependency folders out of `node_modules`, which had been stopping `claude` from starting. The launcher now ships as one self-contained bundle with every plain-JavaScript dependency baked in, and the generated `claude`/`codex` wrappers fall back to running the real CLI directly if the bundle or a native component is ever missing._

### Added
- Single-file executable. `evo` and the `claude` wrapper now launch from one self-contained file (`dist/evo.bundle.cjs`) that has every plain-JavaScript dependency baked in. Startup no longer depends on the many small dependency folders inside `node_modules` still being there.

### Changed
- The build now produces the bundled executable as part of `npm run build` and the release build, and the published package launches from it.

### Fixed
- `claude` could fail to start with a "Cannot find module …" error when something on the machine trimmed files out of `node_modules` (this happened repeatedly on one dev PC, deleting ~25 dependency packages). Because the launcher's plain-JavaScript dependencies are now baked into the single bundle, deleting them from `node_modules` can no longer stop `claude` from starting.
- Launch safety net. If the bundle is missing, Node isn't available, or one of the few native components the wrapper still needs has been deleted, the `claude` wrapper now runs the real `claude` directly instead of failing — so `claude` always launches. It also prints the one-line way to bypass the wrapper entirely (`EVO_PROXY_ACTIVE=1`). The existing bypass behavior is unchanged.

## v3.6.1-rc.1 (2026-07-17)

### Added
- Single-file executable. `evo` and the `claude` wrapper now launch from one self-contained file (`dist/evo.bundle.cjs`) that has every plain-JavaScript dependency baked in. Startup no longer depends on the many small dependency folders inside `node_modules` still being there.

### Changed
- The build now produces the bundled executable as part of `npm run build` and the release build, and the published package launches from it.

### Fixed
- `claude` could fail to start with a "Cannot find module …" error when something on the machine trimmed files out of `node_modules` (this happened repeatedly on one dev PC, deleting ~25 dependency packages). Because the launcher's plain-JavaScript dependencies are now baked into the single bundle, deleting them from `node_modules` can no longer stop `claude` from starting.
- Launch safety net. If the bundle is missing, Node isn't available, or one of the few native components the wrapper still needs has been deleted, the `claude` wrapper now runs the real `claude` directly instead of failing — so `claude` always launches. It also prints the one-line way to bypass the wrapper entirely (`EVO_PROXY_ACTIVE=1`). The existing bypass behavior is unchanged.

## v3.6.0 (2026-07-17)

_First stable release of the 3.6 line, promoted from `v3.6.0-rc.3` after two clean QA rounds; it consolidates everything from rc.1 through rc.3. Highlights: the `/logout` and `/exit` terminal-hang fixes (and the interpreter-shim / stdin-EOF and nested-proxy edge cases behind them), compatibility with Claude Code's native auto-updater, statusline determinism (a single session-bound EvoPet block, meaning-based truncation, provenance tags, and a hard size cap), multi-window stability under concurrent same-directory sessions (atomic config/mascot writes plus SQLite `IMMEDIATE`-transaction / first-open migration / WAL-switch hardening), a lean package published tokenlessly through npm OIDC trusted publishing, and privacy controls for prompt-text capture at rest (`capture.promptText`)._

### Added
- Model-aware prompting tips: the statusline and the proxy's end-of-episode comments now layer model-tuned guidance on top of the base best-practices — Claude Fable / Mythos map to the Fable prompting doc, Opus to the Opus doc, and every other model falls back to the base tips. Backed by a new bundled `src/data/prompting-guidance.json` and `src/promptingGuidance.ts`.
- Weekly rule-based (zero-LLM) sync of Anthropic's Japanese prompt-engineering docs into the bundled guidance, via `scripts/sync-claude-docs.mjs` and the `sync-claude-docs.yml` workflow, with `scripts/validate-guidance.mjs` guarding the data shape.
- `capture.promptText` config flag (default `true`). Prompt-text capture at rest is now bounded: each turn stores at most a 500-character preview of the wrapped CLI's input alongside a sha256 hash and length of the full input. Setting `capture.promptText: false` in `<project>/.evo/config.json` stores **only** the hash and length — no input text, no input previews, and no output previews (CLI output can echo the input back, so it is covered too). New README "Privacy / Data at rest" section (English + Japanese) documents what is stored, where, retention, and how to disable/purge.
- `evo advice` prints the full (untruncated) EvoPet advice — headline, detail, and before/after example — for the most recently active session in the directory (it points here from the truncated statusline).
- Provenance tags on statusline tip lines: `[公式]` for Anthropic base best-practice tips, `[<model>向け]` (e.g. `[Fable 5向け]`) for model-tuned tips, and `[汎用]` for the static libraries, so model-specific advice is distinguishable from generic advice.

### Changed
- Lean release build: publishing now runs `build:release` (via `tsconfig.build.json`), which omits source maps and `.d.ts` declaration files. The published tarball drops ~360 kB of dead-weight `*.js.map`/`*.d.ts` (dev builds are unchanged via `npm run build`). `prepublishOnly` and the release workflow's publish/smoke jobs build the lean artifact.
- `package.json` metadata: set `author` to `1-10maru` and added a `bugs` URL.
- Statusline line 1 is trimmed to the essentials (grade / 指示の質 / 育成度); the 会話回数 and combo counters were dropped from the cramped line and remain in `evo stats`.

### Fixed
- Eliminated the `SQLITE_BUSY: database is locked` crashes under concurrent same-cwd proxies. These came from three distinct causes, and adding `busy_timeout` alone fixed only the first. **(1) Ordinary contention:** the database opened in WAL mode but never set a busy timeout, so a second concurrent writer errored immediately instead of waiting its short turn (~1/10 runs with 3 sessions launching together). The connection now sets `busy_timeout = 5000ms`, and the opportunistic `wal_checkpoint(TRUNCATE)` during compaction is guarded so a busy checkpoint (racing another proxy's finalize writes) is logged and skipped instead of failing the session — the WAL is truncated on a later run. **(2) Upgrade-deadlocks:** several write paths ran as DEFERRED transactions (or read-then-write auto-commit paths) that took a read snapshot and then upgraded to a write; under concurrency that upgrade fails **immediately** with `SQLITE_BUSY` because the busy handler is bypassed for deadlocks, so the timeout never applies. Every write transaction now BEGINs `IMMEDIATE`, taking the write lock up front so concurrent writers serialize instead of deadlocking; the multi-write entry points (`createEpisode`, `finishEpisode`, token calibration) are wrapped in a single atomic transaction; a bounded `SQLITE_BUSY` retry (5 attempts, linear backoff) backstops the top-level writes; and the CLI logs the failing statement stack and error code at debug so future DB errors are diagnosable. **(3) First-open WAL switch:** on a brand-new database the connection's `PRAGMA journal_mode = WAL` takes a brief exclusive lock and, like the deadlock above, can return `SQLITE_BUSY` immediately without invoking the busy handler (~2/25 two-way fresh-db launches). The WAL switch is now wrapped in the same bounded retry, so on a retry the winning proxy has finished, the database is already in WAL, and the pragma returns without contention. Together these close every concurrent-first-open crash tier (config atomic writes, the stats/migration races, and the WAL switch).
- Fixed a `SQLITE_ERROR: duplicate column name` crash when two proxies first-open the same unmigrated database at once (~2/15 fresh-dual-launches). The schema migration (`ensureColumn`) is check-then-act — it reads `PRAGMA table_info` and, if a column is missing, runs `ALTER TABLE … ADD COLUMN`. Two connections could both observe the column missing and both ALTER; the loser threw. The ALTER is idempotent in intent, so the migration now swallows exactly the `duplicate column name` race (the column was added by the concurrent proxy) and rethrows anything else.
- Fixed catastrophic regex backtracking in output parsing: the file-path detector applied an unbounded pattern to each full line, backtracking quadratically on long word-runs (~297ms for a 16KB line). A child emitting megabytes of newline-sparse garbage (runaway/minified/base64 output) could peg the CPU and stall the stream so the wrapper never tore down. The pattern now uses a bounded quantifier and only scans the head of each line, making path detection linear.
- Passthrough argument quoting: native passthrough invocations (`claude review …`, update ops) now route through the same spawn helper as the proxy path, so arguments containing `"`, `&`, `|`, `<`, `>`, `^` are quoted correctly on Windows instead of being interpreted by cmd.exe (a command-injection / mangling risk). `.ps1` originals are also launched correctly.
- Fixed a stale-cache regression where the wrapper could launch the interpreter itself (e.g. `claude --version` printed the Node version). A poisoned `originalCommandMap` value from an old evo build (a bare `node.exe` cached from cli.js-era npm shims) was trusted and preferred over the correct discoverable live shim, and slipped through unchecked because `.exe` candidates skipped scrutiny. Original-command resolution now (1) rejects interpreter basenames (`node`, `npm`, `npx`, `pwsh`, `powershell`, `cmd`, `sh`, `bash`, `wscript`, `cscript`, `env`) outright, (2) accepts a resolved command only if its basename equals the CLI name or it lives inside a `node_modules` subtree, so a poisoned cache can neither win nor be re-persisted, and (3) contains shim follow-through to the shim's own `node_modules` subtree.
- Fixed a remaining fast-exit hang on Windows (e.g. `claude --bad-flag`): when the resolved `claude` was an npm interpreter shim (`claude.ps1` / `claude.cmd`) whose real `.exe` was not a sibling, evo spawned it through a PowerShell/cmd layer. npm's PowerShell shim runs `if ($MyInvocation.ExpectingInput) { $input | & claude.exe }`, and with a redirected stdin that never reaches EOF PowerShell blocked on stdin forever even after `claude.exe` exited — so evo's direct child never exited and the teardown watchdog (keyed on that child) never fired. Two independent fixes: (1) original-command resolution now follows an interpreter shim through to the real `.exe` it targets and spawns that directly, removing the interpreter layer entirely (shims that target a `.js`/`cli.js` launcher are left alone); (2) on the non-interactive path the wrapper now closes the wrapped child's stdin, delivering EOF so any remaining interpreter layer cannot wedge.
- Fixed the `/logout` hang: logging out (and any other flow where Claude Code re-invokes `claude` by name, e.g. a re-auth relaunch) no longer freezes the terminal until Ctrl+C. The evo shim sits first on PATH, so the inner `claude` hit the shim again and opened a **nested** proxy session that the outer wrapper waited on forever. The `proxy` action now detects `EVO_PROXY_ACTIVE=1` and passes straight through to the real CLI (inherited stdio, forwarded exit code) with no nested tracking/episode, and every generated shim (cmd/ps1/sh) execs the real claude directly when already inside a proxy.
- Fixed interference with Claude Code's native auto-updater (`update_apply_exe_locked`). Update-family invocations — `claude update`, `claude install`, `claude migrate-installer`, and the top-level `claude --update` flag — now bypass the proxy entirely at any level, so evo never holds the running `claude` executable open as a managed child (Windows could not replace the locked image) and never installs the signal handlers that could tree-kill a deferred updater helper. The updater owns its own child processes.
- Teardown can no longer be trapped by a child whose stdio lingers: in addition to the child's `close` event, teardown now proceeds on the child's `exit` event via a short watchdog (default 2000ms, `EVO_EXIT_WATCHDOG_MS`), so a grandchild that inherits and holds a stdio pipe open cannot keep the wrapper alive after the wrapped CLI has already exited. Exit-code propagation semantics are unchanged.
- Wrapper no longer hangs after the wrapped CLI exits (the `/exit` hang). The `proxy` action now propagates the wrapped CLI's exit code and force-exits, instead of always exiting `0` and lingering on open handles. `runProxySession` returns the child's exit code.
- Interactive (TTY) stdin forwarding is now paused and unref'd on teardown, so a resumed stdin can no longer keep the event loop alive after the child has exited.
- `SIGINT` / `SIGTERM` / `SIGHUP` are forwarded to the wrapped CLI instead of exiting the wrapper with `0` and orphaning the child. The wrapper now exits with the child's status (or `128 + signal`), and on Windows tears down the whole `cmd.exe`/`pwsh` process tree so nothing is left orphaned. During interactive passthrough the first Ctrl+C is left for the child to handle; a second signal (or a console-close `SIGHUP`) escalates to a forced tree-kill.
- The background update-check timeout and the log-flush listener no longer keep the process alive: the fetch timer is `unref`'d and the log file descriptor is closed on exit.
- On Windows, original-command resolution rejects candidates that cannot actually be launched on the platform (e.g. an extensionless POSIX stub), preventing a broken command mapping from being cached.
- 育成度 (Ideal State Gauge) no longer sits frozen at a stale value (e.g. a contradictory `0%` beside `指示の質: とても良い!`) during a live session. The gauge was computed only from finalized-episode history (`recentEpisodes`, updated at process exit), so it was frozen mid-session and reflected prior sessions. It now blends a live rolling per-turn promptScore window (fed each turn in `ProxyLiveState`) with the historical gauge, so it moves within a session and tracks the same signal that drives 指示の質. It emits the `-1` "測定中" sentinel only when there is genuinely no data (empty live window AND no finalized episodes); a literal `0%` is impossible unless the prompt scores are genuinely ~0.
- Advice no longer repeats the same nudge on every edit. Per-session fire memory (keyed by `signalKind:target`) renders the 1st and 2nd fire of an identical signal but suppresses the 3rd+ (falling through to a rotating tip); a different target keeps its own counter. The raw `N回目` counter was dropped from the `same_file_revisit` headline.
- Fixed a crash under concurrent same-cwd proxies: with ~3 sessions launching together, ~1/3 crashed with "Unexpected end of JSON input" (session tracking lost, exit 1). `config.json` and `mascot.json` are now written atomically (tmp file + rename) instead of a non-atomic `writeFileSync` that let a reader observe a half-written file, and reads use a bounded retry (3 attempts) that heals a transient torn read. On a persistent read failure the proxy falls back to defaults **in memory without overwriting the file** (so a valid config another process just wrote is never clobbered); only a genuinely-absent file is heal-written. `mascot.json` had the same race but was silently caught into an EvoPet reset (progress loss) — it now retries instead of resetting. The atomic-write helper is extracted to `src/utils/atomicFile.ts` and shared across config, mascot, and live-state.
- Statusline no longer renders two EvoPet blocks at once. `scripts/setup.mjs` now deploys a genuinely token-only script (`scripts/token_statusline.py`) as `~/.claude/base_statusline.py`, so a wrapper that runs both `base_statusline.py` and `evo statusline` produces exactly one EvoPet block (token line from the base script, EvoPet from `evo statusline`).
- Statusline is now strictly bound to its own session. Both renderers (`evo statusline` and `statusline.py`) resolve the session id from `session_id` (else the `transcript_path` filename stem) and read ONLY `<cwd>/.evo/sessions/<sid>.json`. A miss/stale render shows nothing (TS) or a quiet `🦊 EvoPet · 待機中` placeholder (Python) — never another session's state from the shared sinks. Sessionless invocations keep the legacy shared-sink behavior. The Python self-state file is now per-session (`~/.claude/.evo-self/<sid>.json`) to stop cross-pane call-counter corruption.
- Before/after examples and advice are truncated by meaning instead of a fixed byte offset: width-aware (CJK counts as 2 columns), whole-string filesystem paths collapse to their basename, overflow is cut at the last clause/word boundary, and elided headlines end with `→ 続きは \`evo advice\`` instead of a mid-glyph cut. Signal example paths are shortened to a repo-relative basename at generation time. As a final safety net on top of the per-field truncation, both renderers enforce an absolute hard total-block cap (`EVOPET_BLOCK_MAX_CHARS`, 500 visible chars) on the assembled EvoPet block, so a pathological payload (e.g. a crafted 200KB advice or nickname) can never flood the statusline — the block is cut hard with the `evo advice` pointer.

### Removed
- Deleted the committed `bin/claude` and `bin/codex` shim scripts (they embedded a hardcoded developer path) and dropped `bin/` from the published `files` list. The real `evo` bin entry (`dist/index.js`) is unaffected.

### Internal
- Declared `engines.node >= 20`.

### Documentation
- Hero-branded README overhaul (English `README.md` + new `README.ja.md`) with new banner and icon assets under `assets/`, a `docs/` index, and refreshed `package.json` `keywords` and `homepage`.

## v3.6.0-rc.3 (2026-07-16)

_Release candidate for v3.6.0. Builds on v3.6.0-rc.1 and rc.2, and adds the interpreter-shim / stdin-EOF hang fix, stale-cache interpreter-denylist resolution hardening, statusline determinism (single session-bound block, meaning-based truncation, provenance tags, hard cap), a live 育成度 gauge and advice-repeat suppression, atomic config/mascot writes, the ReDoS fix, a lean 47-file package, privacy controls (`capture.promptText`), and passthrough argument quoting. This is the first RC published through npm OIDC trusted publishing._

### Added
- `capture.promptText` config flag (default `true`). Prompt-text capture at rest is now bounded: each turn stores at most a 500-character preview of the wrapped CLI's input alongside a sha256 hash and length of the full input. Setting `capture.promptText: false` in `<project>/.evo/config.json` stores **only** the hash and length — no input text, no input previews, and no output previews (CLI output can echo the input back, so it is covered too). New README "Privacy / Data at rest" section (English + Japanese) documents what is stored, where, retention, and how to disable/purge.
- `evo advice` prints the full (untruncated) EvoPet advice — headline, detail, and before/after example — for the most recently active session in the directory (it points here from the truncated statusline).
- Provenance tags on statusline tip lines: `[公式]` for Anthropic base best-practice tips, `[<model>向け]` (e.g. `[Fable 5向け]`) for model-tuned tips, and `[汎用]` for the static libraries, so model-specific advice is distinguishable from generic advice.

### Changed
- Lean release build: publishing now runs `build:release` (via `tsconfig.build.json`), which omits source maps and `.d.ts` declaration files. The published tarball drops ~360 kB of dead-weight `*.js.map`/`*.d.ts` (dev builds are unchanged via `npm run build`). `prepublishOnly` and the release workflow's publish/smoke jobs build the lean artifact.
- `package.json` metadata: set `author` to `1-10maru` and added a `bugs` URL.
- Statusline line 1 is trimmed to the essentials (grade / 指示の質 / 育成度); the 会話回数 and combo counters were dropped from the cramped line and remain in `evo stats`.

### Fixed
- Eliminated the `SQLITE_BUSY: database is locked` crashes under concurrent same-cwd proxies. These came from three distinct causes, and adding `busy_timeout` alone fixed only the first. **(1) Ordinary contention:** the database opened in WAL mode but never set a busy timeout, so a second concurrent writer errored immediately instead of waiting its short turn (~1/10 runs with 3 sessions launching together). The connection now sets `busy_timeout = 5000ms`, and the opportunistic `wal_checkpoint(TRUNCATE)` during compaction is guarded so a busy checkpoint (racing another proxy's finalize writes) is logged and skipped instead of failing the session — the WAL is truncated on a later run. **(2) Upgrade-deadlocks:** several write paths ran as DEFERRED transactions (or read-then-write auto-commit paths) that took a read snapshot and then upgraded to a write; under concurrency that upgrade fails **immediately** with `SQLITE_BUSY` because the busy handler is bypassed for deadlocks, so the timeout never applies. Every write transaction now BEGINs `IMMEDIATE`, taking the write lock up front so concurrent writers serialize instead of deadlocking; the multi-write entry points (`createEpisode`, `finishEpisode`, token calibration) are wrapped in a single atomic transaction; a bounded `SQLITE_BUSY` retry (5 attempts, linear backoff) backstops the top-level writes; and the CLI logs the failing statement stack and error code at debug so future DB errors are diagnosable. **(3) First-open WAL switch:** on a brand-new database the connection's `PRAGMA journal_mode = WAL` takes a brief exclusive lock and, like the deadlock above, can return `SQLITE_BUSY` immediately without invoking the busy handler (~2/25 two-way fresh-db launches). The WAL switch is now wrapped in the same bounded retry, so on a retry the winning proxy has finished, the database is already in WAL, and the pragma returns without contention. Together these close every concurrent-first-open crash tier (config atomic writes, the stats/migration races, and the WAL switch).
- Fixed a `SQLITE_ERROR: duplicate column name` crash when two proxies first-open the same unmigrated database at once (~2/15 fresh-dual-launches). The schema migration (`ensureColumn`) is check-then-act — it reads `PRAGMA table_info` and, if a column is missing, runs `ALTER TABLE … ADD COLUMN`. Two connections could both observe the column missing and both ALTER; the loser threw. The ALTER is idempotent in intent, so the migration now swallows exactly the `duplicate column name` race (the column was added by the concurrent proxy) and rethrows anything else.
- Fixed catastrophic regex backtracking in output parsing: the file-path detector applied an unbounded pattern to each full line, backtracking quadratically on long word-runs (~297ms for a 16KB line). A child emitting megabytes of newline-sparse garbage (runaway/minified/base64 output) could peg the CPU and stall the stream so the wrapper never tore down. The pattern now uses a bounded quantifier and only scans the head of each line, making path detection linear.
- Passthrough argument quoting: native passthrough invocations (`claude review …`, update ops) now route through the same spawn helper as the proxy path, so arguments containing `"`, `&`, `|`, `<`, `>`, `^` are quoted correctly on Windows instead of being interpreted by cmd.exe (a command-injection / mangling risk). `.ps1` originals are also launched correctly.
- Fixed a stale-cache regression where the wrapper could launch the interpreter itself (e.g. `claude --version` printed the Node version). A poisoned `originalCommandMap` value from an old evo build (a bare `node.exe` cached from cli.js-era npm shims) was trusted and preferred over the correct discoverable live shim, and slipped through unchecked because `.exe` candidates skipped scrutiny. Original-command resolution now (1) rejects interpreter basenames (`node`, `npm`, `npx`, `pwsh`, `powershell`, `cmd`, `sh`, `bash`, `wscript`, `cscript`, `env`) outright, (2) accepts a resolved command only if its basename equals the CLI name or it lives inside a `node_modules` subtree, so a poisoned cache can neither win nor be re-persisted, and (3) contains shim follow-through to the shim's own `node_modules` subtree.
- Fixed a remaining fast-exit hang on Windows (e.g. `claude --bad-flag`): when the resolved `claude` was an npm interpreter shim (`claude.ps1` / `claude.cmd`) whose real `.exe` was not a sibling, evo spawned it through a PowerShell/cmd layer. npm's PowerShell shim runs `if ($MyInvocation.ExpectingInput) { $input | & claude.exe }`, and with a redirected stdin that never reaches EOF PowerShell blocked on stdin forever even after `claude.exe` exited — so evo's direct child never exited and the teardown watchdog (keyed on that child) never fired. Two independent fixes: (1) original-command resolution now follows an interpreter shim through to the real `.exe` it targets and spawns that directly, removing the interpreter layer entirely (shims that target a `.js`/`cli.js` launcher are left alone); (2) on the non-interactive path the wrapper now closes the wrapped child's stdin, delivering EOF so any remaining interpreter layer cannot wedge.
- Fixed the `/logout` hang: logging out (and any other flow where Claude Code re-invokes `claude` by name, e.g. a re-auth relaunch) no longer freezes the terminal until Ctrl+C. The evo shim sits first on PATH, so the inner `claude` hit the shim again and opened a **nested** proxy session that the outer wrapper waited on forever. The `proxy` action now detects `EVO_PROXY_ACTIVE=1` and passes straight through to the real CLI (inherited stdio, forwarded exit code) with no nested tracking/episode, and every generated shim (cmd/ps1/sh) execs the real claude directly when already inside a proxy.
- Fixed interference with Claude Code's native auto-updater (`update_apply_exe_locked`). Update-family invocations — `claude update`, `claude install`, `claude migrate-installer`, and the top-level `claude --update` flag — now bypass the proxy entirely at any level, so evo never holds the running `claude` executable open as a managed child (Windows could not replace the locked image) and never installs the signal handlers that could tree-kill a deferred updater helper. The updater owns its own child processes.
- Teardown can no longer be trapped by a child whose stdio lingers: in addition to the child's `close` event, teardown now proceeds on the child's `exit` event via a short watchdog (default 2000ms, `EVO_EXIT_WATCHDOG_MS`), so a grandchild that inherits and holds a stdio pipe open cannot keep the wrapper alive after the wrapped CLI has already exited. Exit-code propagation semantics are unchanged.
- Wrapper no longer hangs after the wrapped CLI exits (the `/exit` hang). The `proxy` action now propagates the wrapped CLI's exit code and force-exits, instead of always exiting `0` and lingering on open handles. `runProxySession` returns the child's exit code.
- Interactive (TTY) stdin forwarding is now paused and unref'd on teardown, so a resumed stdin can no longer keep the event loop alive after the child has exited.
- `SIGINT` / `SIGTERM` / `SIGHUP` are forwarded to the wrapped CLI instead of exiting the wrapper with `0` and orphaning the child. The wrapper now exits with the child's status (or `128 + signal`), and on Windows tears down the whole `cmd.exe`/`pwsh` process tree so nothing is left orphaned. During interactive passthrough the first Ctrl+C is left for the child to handle; a second signal (or a console-close `SIGHUP`) escalates to a forced tree-kill.
- The background update-check timeout and the log-flush listener no longer keep the process alive: the fetch timer is `unref`'d and the log file descriptor is closed on exit.
- On Windows, original-command resolution rejects candidates that cannot actually be launched on the platform (e.g. an extensionless POSIX stub), preventing a broken command mapping from being cached.
- 育成度 (Ideal State Gauge) no longer sits frozen at a stale value (e.g. a contradictory `0%` beside `指示の質: とても良い!`) during a live session. The gauge was computed only from finalized-episode history (`recentEpisodes`, updated at process exit), so it was frozen mid-session and reflected prior sessions. It now blends a live rolling per-turn promptScore window (fed each turn in `ProxyLiveState`) with the historical gauge, so it moves within a session and tracks the same signal that drives 指示の質. It emits the `-1` "測定中" sentinel only when there is genuinely no data (empty live window AND no finalized episodes); a literal `0%` is impossible unless the prompt scores are genuinely ~0.
- Advice no longer repeats the same nudge on every edit. Per-session fire memory (keyed by `signalKind:target`) renders the 1st and 2nd fire of an identical signal but suppresses the 3rd+ (falling through to a rotating tip); a different target keeps its own counter. The raw `N回目` counter was dropped from the `same_file_revisit` headline.
- Fixed a crash under concurrent same-cwd proxies: with ~3 sessions launching together, ~1/3 crashed with "Unexpected end of JSON input" (session tracking lost, exit 1). `config.json` and `mascot.json` are now written atomically (tmp file + rename) instead of a non-atomic `writeFileSync` that let a reader observe a half-written file, and reads use a bounded retry (3 attempts) that heals a transient torn read. On a persistent read failure the proxy falls back to defaults **in memory without overwriting the file** (so a valid config another process just wrote is never clobbered); only a genuinely-absent file is heal-written. `mascot.json` had the same race but was silently caught into an EvoPet reset (progress loss) — it now retries instead of resetting. The atomic-write helper is extracted to `src/utils/atomicFile.ts` and shared across config, mascot, and live-state.
- Statusline no longer renders two EvoPet blocks at once. `scripts/setup.mjs` now deploys a genuinely token-only script (`scripts/token_statusline.py`) as `~/.claude/base_statusline.py`, so a wrapper that runs both `base_statusline.py` and `evo statusline` produces exactly one EvoPet block (token line from the base script, EvoPet from `evo statusline`).
- Statusline is now strictly bound to its own session. Both renderers (`evo statusline` and `statusline.py`) resolve the session id from `session_id` (else the `transcript_path` filename stem) and read ONLY `<cwd>/.evo/sessions/<sid>.json`. A miss/stale render shows nothing (TS) or a quiet `🦊 EvoPet · 待機中` placeholder (Python) — never another session's state from the shared sinks. Sessionless invocations keep the legacy shared-sink behavior. The Python self-state file is now per-session (`~/.claude/.evo-self/<sid>.json`) to stop cross-pane call-counter corruption.
- Before/after examples and advice are truncated by meaning instead of a fixed byte offset: width-aware (CJK counts as 2 columns), whole-string filesystem paths collapse to their basename, overflow is cut at the last clause/word boundary, and elided headlines end with `→ 続きは \`evo advice\`` instead of a mid-glyph cut. Signal example paths are shortened to a repo-relative basename at generation time. As a final safety net on top of the per-field truncation, both renderers enforce an absolute hard total-block cap (`EVOPET_BLOCK_MAX_CHARS`, 500 visible chars) on the assembled EvoPet block, so a pathological payload (e.g. a crafted 200KB advice or nickname) can never flood the statusline — the block is cut hard with the `evo advice` pointer.

### Removed
- Deleted the committed `bin/claude` and `bin/codex` shim scripts (they embedded a hardcoded developer path) and dropped `bin/` from the published `files` list. The real `evo` bin entry (`dist/index.js`) is unaffected.

### Internal
- Declared `engines.node >= 20`.

## v3.6.0-rc.2 (2026-07-15)

_Release candidate for v3.6.0. Builds on v3.6.0-rc.1 and adds the `/logout` hang fix and the native `claude` auto-update interference fix (#68)._

### Fixed
- Fixed the `/logout` hang: logging out (and any other flow where Claude Code re-invokes `claude` by name, e.g. a re-auth relaunch) no longer freezes the terminal until Ctrl+C. The evo shim sits first on PATH, so the inner `claude` hit the shim again and opened a **nested** proxy session that the outer wrapper waited on forever. The `proxy` action now detects `EVO_PROXY_ACTIVE=1` and passes straight through to the real CLI (inherited stdio, forwarded exit code) with no nested tracking/episode, and every generated shim (cmd/ps1/sh) execs the real claude directly when already inside a proxy.
- Fixed interference with Claude Code's native auto-updater (`update_apply_exe_locked`). Update-family invocations — `claude update`, `claude install`, `claude migrate-installer`, and the top-level `claude --update` flag — now bypass the proxy entirely at any level, so evo never holds the running `claude` executable open as a managed child (Windows could not replace the locked image) and never installs the signal handlers that could tree-kill a deferred updater helper. The updater owns its own child processes.
- Teardown can no longer be trapped by a child whose stdio lingers: in addition to the child's `close` event, teardown now proceeds on the child's `exit` event via a short watchdog (default 2000ms, `EVO_EXIT_WATCHDOG_MS`), so a grandchild that inherits and holds a stdio pipe open cannot keep the wrapper alive after the wrapped CLI has already exited. Exit-code propagation semantics are unchanged.
- Wrapper no longer hangs after the wrapped CLI exits (the `/exit` hang). The `proxy` action now propagates the wrapped CLI's exit code and force-exits, instead of always exiting `0` and lingering on open handles. `runProxySession` returns the child's exit code.
- Interactive (TTY) stdin forwarding is now paused and unref'd on teardown, so a resumed stdin can no longer keep the event loop alive after the child has exited.
- `SIGINT` / `SIGTERM` / `SIGHUP` are forwarded to the wrapped CLI instead of exiting the wrapper with `0` and orphaning the child. The wrapper now exits with the child's status (or `128 + signal`), and on Windows tears down the whole `cmd.exe`/`pwsh` process tree so nothing is left orphaned. During interactive passthrough the first Ctrl+C is left for the child to handle; a second signal (or a console-close `SIGHUP`) escalates to a forced tree-kill.
- The background update-check timeout and the log-flush listener no longer keep the process alive: the fetch timer is `unref`'d and the log file descriptor is closed on exit.
- On Windows, original-command resolution rejects candidates that cannot actually be launched on the platform (e.g. an extensionless POSIX stub), preventing a broken command mapping from being cached.

### Removed
- Deleted the committed `bin/claude` and `bin/codex` shim scripts (they embedded a hardcoded developer path) and dropped `bin/` from the published `files` list. The real `evo` bin entry (`dist/index.js`) is unaffected.

### Internal
- Declared `engines.node >= 20`.

## v3.6.0-rc.1 (2026-07-11)

_Release candidate for v3.6.0 — the changes below are exactly what the stable v3.6.0 will ship._

### Added
- Model-aware prompting tips: the statusline and the proxy's end-of-episode comments now layer model-tuned guidance on top of the base best-practices — Claude Fable / Mythos map to the Fable prompting doc, Opus to the Opus doc, and every other model falls back to the base tips. Backed by a new bundled `src/data/prompting-guidance.json` and `src/promptingGuidance.ts`.
- Weekly rule-based (zero-LLM) sync of Anthropic's Japanese prompt-engineering docs into the bundled guidance, via `scripts/sync-claude-docs.mjs` and the `sync-claude-docs.yml` workflow, with `scripts/validate-guidance.mjs` guarding the data shape.

### Fixed
- Wrapper no longer hangs after the wrapped CLI exits (the `/exit` hang). The `proxy` action now propagates the wrapped CLI's exit code and force-exits, instead of always exiting `0` and lingering on open handles. `runProxySession` returns the child's exit code.
- Interactive (TTY) stdin forwarding is now paused and unref'd on teardown, so a resumed stdin can no longer keep the event loop alive after the child has exited.
- `SIGINT` / `SIGTERM` / `SIGHUP` are forwarded to the wrapped CLI instead of exiting the wrapper with `0` and orphaning the child. The wrapper now exits with the child's status (or `128 + signal`), and on Windows tears down the whole `cmd.exe`/`pwsh` process tree so nothing is left orphaned. During interactive passthrough the first Ctrl+C is left for the child to handle; a second signal (or a console-close `SIGHUP`) escalates to a forced tree-kill.
- The background update-check timeout and the log-flush listener no longer keep the process alive: the fetch timer is `unref`'d and the log file descriptor is closed on exit.
- On Windows, original-command resolution rejects candidates that cannot actually be launched on the platform (e.g. an extensionless POSIX stub), preventing a broken command mapping from being cached.

### Documentation
- Hero-branded README overhaul (English `README.md` + new `README.ja.md`) with new banner and icon assets under `assets/`, a `docs/` index, and refreshed `package.json` `keywords` and `homepage`.

### Removed
- Deleted the committed `bin/claude` and `bin/codex` shim scripts (they embedded a hardcoded developer path) and dropped `bin/` from the published `files` list. The real `evo` bin entry (`dist/index.js`) is unaffected.

### Internal
- Declared `engines.node >= 20`.

## v3.5.1 (2026-05-12)

### Fixed
- `evo --version` now reports the actual package version (was hardcoded to `0.1.0` in `src/index.ts`). Now reads from `package.json` at runtime.

### Changed
- Statusline expansion mode: the four essentials row (`評価 / 回目 / 指示の質 / 育成度`) is now always rendered each tick, with dim-color placeholders when data hasn't been computed yet (e.g. early in a session). Previously the row would "thin out" if a metric wasn't yet available, making EvoPet feel inert. The advice/tip line below still rotates to keep things alive.

## v3.5.0 (2026-05-12)

### Added
- `evo doctor [--json]` command: one-page health report covering versions, env vars, file checks, recent errors, and live-state freshness. Machine-readable JSON output via `--json` is usable by tooling (including Claude reading the project state).
- `evo logs --bundle [--out <path>]`: bundle the last 7 days of logs + redacted config + doctor output into a single zip for bug reports. Sensitive paths and tokens are masked before bundling.
- Structured JSON log output via `EVO_LOG_FORMAT=json` env var (one JSON object per line; useful for log aggregation pipelines).
- `EVO_DEBUG=1` shortcut to raise log level to DEBUG without touching per-namespace flags.
- `DEBUG=evopet:*` namespace filter convention (matches the npm `debug` ecosystem style).
- `docs/observability.md`: full log format and diagnostics documentation.

### Documentation
- README: new "Privacy & Data Handling" section (English + 日本語) — single authoritative source documenting what EvoPet reads, stores, and explicitly does NOT do (no telemetry, no API tokens). Retention periods and user-control levers (`EVO_LOG_DISABLE`, manual `<cwd>/.evo/` removal, `EVO_NO_UPDATE_CHECK`) listed. The previous separate "Network behavior (no telemetry)" and "What gets stored locally" / 「通信動作」「ローカルに保存されるもの」 sections were removed; their content is now consolidated under Privacy & Data Handling.
- README: new "Troubleshooting" section (English + 日本語) with link to the EvoPet-not-appearing runbook.
- New `docs/runbooks/evopet-not-appearing.md`: step-by-step diagnostic runbook for "EvoPet missing from statusline" reports. Notes that it requires evopet ≥ v3.5.0 for the `evo doctor` and `evo logs --bundle` commands. Includes manual cleanup recipes for Unix and Windows PowerShell since `evo cleanup --stale` is planned for a future release.

### Internal
- CI matrix expanded to `[ubuntu-22.04, windows-2022, macos-14] × Node [20, 22]` (6 cells). Node 18 was evaluated but dropped: vitest 4.x transitively imports `styleText` from `node:util`, which only exists from Node 20.12 onward, so Node 18 cells failed at test startup.
- New `audit` job runs `npm audit --omit=dev --audit-level=high` as a blocking gate; moderate findings warn only.
- Added `concurrency` block to cancel superseded CI runs on the same ref.
- New `docs/PLATFORM_SUPPORT.md` documenting the official support matrix.
- Portability fix in `install/evopet-uninstall.sh`: replaced GNU-only `sed -i '\|pattern|d'` alternate-delimiter form (BSD sed on macOS errors `invalid command code f`) with a portable `perl -i -ne 'print unless m{...}'` one-liner. Pre-existing bug surfaced by adding macOS to CI.
- Replaced `publish-on-merge.yml` (auto-publish on every main push) with `release-rc.yml` (tag-triggered, `next` channel) and `release-stable.yml` (`workflow_dispatch`, `latest` channel).
- Smoke job before publish: install the packed tarball globally and verify `evo doctor --json` exits 0 with parseable JSON containing a `versions` key.
- `npm publish --provenance` enabled for both channels.
- `docs/RELEASE_PROCESS.md` documents the new flow; `docs/runbooks/rollback-bad-release.md` documents the rollback procedure.

### Breaking-flavored (release tooling)
- `git push origin main` no longer publishes to npm. To release, push a `vX.Y.Z-rc.N` tag (RC channel) or run the `Release Stable` workflow (latest channel).

## v3.5.1 (2026-05-09)

### Fixed
- Tips and advice text in the statusline are no longer truncated with `...`. Previously, `before` examples were cut at 30 chars, `after` examples at 55 chars, and detail/advice text at 70-80 chars, which made path-bearing tips unreadable (e.g. `src/Login.tsx のフォーム送信で、空パスワードでもsubm...`). Long tips now render in full so the user can actually read what is being suggested.
- `formatBeforeAfter` (used by `evo issue` output) likewise no longer applies a 30/60-char truncation.

## v3.5.0 (2026-05-07)

### Fixed
- First-time install UX: `evo statusline` was silently producing no output because the default display mode was `"minimum"` (which intentionally emits nothing). The default is now `"expansion"` so EvoPet is visible immediately after `npm install -g evolutionary-cli-wrapper` without any extra configuration step.
- `evo install-statusline` now writes `expansion` to the display-mode file when no file exists yet, as a belt-and-suspenders guarantee for the install flow.

## v3.4.4 (2026-05-09)

### Security
- Hardened spawn pipeline. `.cmd`/`.bat` now use array form with `windowsVerbatimArguments: true` instead of shell-string interpolation; paths containing shell metacharacters (`<>|&^"` backtick, newline, `%`, tab, NUL byte) are rejected at the boundary. `%` is included to block cmd.exe variable expansion (e.g. `%PATH%`).
- Per-arg cmd.exe-aware quoting (`quoteArgForCmd`) applied to args before spawn so that whitespace-containing args (e.g. `"hello world"`) reach the child process as a single token rather than being split by cmd.exe tokenization.
- Shim writer refuses to install into paths containing characters that are dangerous in either the PowerShell shim context (`'`, backtick, `$`, `;`) or the cmd.exe shim context (`"`, `%`, `&`, `|`, `<`, `>`, `^`), plus newline in either.
- `.ps1` execution prefers `pwsh` (PowerShell 7) and falls back to `powershell.exe`; adds `-ExecutionPolicy Bypass`. `resolvePowershellBinary` now gracefully falls back to `powershell` if the locate command itself throws.

## v3.4.0 (2026-05-02)

### Fixed
- Parallel Claude Code sessions in the same directory no longer overwrite each other's EvoPet state. Each proxy now writes to `<cwd>/.evo/sessions/<sessionId>.json`, and the statusline reads the file matching the current session ID from Claude Code's payload.
- Stale `live-state.json` from prior sessions can no longer shadow the current session's metrics.

### Added
- Automatic GC: session files older than 7 days are pruned at proxy startup.
- Backward-compatible writes: `<cwd>/.evo/live-state.json` is still updated alongside per-session files for compatibility with older statusline deployments.

### Internal
- `<cwd>/.evo/sessions/` directory introduced.

## v3.3.0 (2026-05-02)

### Fixed
- EvoPet statusline lines no longer disappear during long tool executions:
  - Proxy now heartbeats `live-state.json` every 10 seconds (idle or active) so the file's `updatedAt` doesn't go stale during multi-minute tool calls.
  - Statusline freshness window extended from 60 seconds to 5 minutes.
  - Stale path preserves the full layout (grade / 回目 / 指示の質 / 育成度) and only dims the colors, so the user always sees the full EvoPet state instead of a collapsed avatar-only line.

### Added
- `EVO_DISABLE_HEARTBEAT=1` environment variable to disable proxy heartbeat (escape hatch for diagnostics).

## v3.2.0 (2026-05-02)

### Fixed
- "X回目" counter is now session-scoped instead of cwd-scoped. Previously, opening a new Claude Code session in the same directory could inherit the previous session's count if the old JSONL retained a recent mtime. Now the JSONL watcher only binds to files modified after proxy startup and additionally tracks `sessionId` from the JSONL header for rotation detection.

### Added
- `sessionId` field exposed in `live-state.json` for diagnostic / future statusline use.

## v3.1.0 (2026-05-02)

### Breaking-flavored
- **Stage progression now ISG-based**: previously cumulative `totalBondExp` drove stage; now `computeIdealStateGauge` drives stage with thresholds 25/45/65/82. Existing users may see their stage drop until prompt quality (promptScore / structureScore / loop-free streaks) sustains the new thresholds. Past `totalBondExp` is preserved but no longer affects stage.
- **Mascot scope: PC-global by default**: `EVO_HOME` default changed from `<cwd>` to `<home>/.claude`. A one-time migration copies the existing cwd-based mascot.json to `~/.claude/.evo/mascot.json` on first launch (sentinel file prevents re-migration). Old cwd file is preserved as backup.

### Added
- Auto-synced tips now carry a `category` tag (`specificity`, `verification`, `permissions`, `context`, `recovery`, `exploration`, `general`).
- Statusline filters tips by detected signal category (e.g., `prompt_too_vague` → `specificity`-tagged tips).
- 5-band mood comments (`start` / `early` / `working` / `busy` / `critical`) now appear in the proxy-active main path, not just the no-proxy fallback.

### Changed
- `statusline.py` session-reset heuristic dropped the `_prev_ctx > 30 and _curr_ctx < 5` condition (was firing on benign auto-compact). Reset now triggers only on cwd change.

### Fixed
- Promotion to legend after low-quality sessions.
- "Conversation count reset on auto-compact" issue.

## v3.0.0 (2026-05-01)

### Breaking-flavored
- Tip dict shape now includes a `tier` field (1=core / 2=default / 3=niche). Existing renderers using `.get('tier', 2)` are forward-compatible. Update legacy `~/.claude/base_statusline.py` deployments via `evo install-statusline`.

### Added
- All entries from public Anthropic Claude Code docs (`best-practices` and `commands`) are now ingested without per-source caps.
- Tier-weighted deterministic round-robin (5 : 2 : 1) for tip rotation.

### Changed
- `scripts/sync-claude-docs.mjs` no longer limits to 30 entries per source.
- `statusline.py` builds a tier-expanded rotation list at module load.

## [Unreleased]

### Changed (docs)

- README.md is now a single bilingual entry point (English + 日本語). The legacy `START_HERE_JA.md` was merged into the README's 日本語 section; npm-only quick install and clone-based full setup both live in README. No information was lost in the merge.
- Top-level `ROADMAP.md` → `docs/ROADMAP.md`.
- Top-level `CONTRIBUTING.md` → `docs/CONTRIBUTING.md`.
- Top-level `VERSIONING.md` → `docs/VERSIONING.md`.
- AI-agent-oriented docs were grouped under `docs/ai/`:
  - `docs/AGENT_WORKFLOW.md` → `docs/ai/AGENT_WORKFLOW.md`
  - `docs/DECISIONS.md` → `docs/ai/DECISIONS.md`
  - `docs/PROJECT_MAP.md` → `docs/ai/PROJECT_MAP.md`
  - `docs/REVIEW_PLAYBOOK.md` → `docs/ai/REVIEW_PLAYBOOK.md`
  - `docs/issue-intake.md` → `docs/ai/issue-intake.md`
  - `docs/knowledge/` → `docs/ai/knowledge/`
- Added `docs/ai/README.md` (bilingual) describing the directory's purpose.
- Internal references updated: `CLAUDE.md`, `setup.cmd`, `src/ui.ts`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/{config,agent_task,feature_request}.yml`, `.github/workflows/pr-doc-check.yml`, and the moved docs themselves.
- `docs/future/` (ai-orchestration, friction-capture-architecture) kept in place — those are forward-looking design notes for humans, not agent runtime documentation.

## [Previously Unreleased] - 2026-04-26

### Added

- 構造化ログ機能: `<対象フォルダ>/.evo/logs/session-YYYYMMDD.log` にレベル別 (ERROR/WARN/INFO/DEBUG) で出力。日次ローテーションで 30 日保持
- `EVO_LOG_LEVEL=DEBUG` で起動・コマンド解決・shim 解決・エピソードライフサイクル等の判断分岐を可視化
- `evo logs --tail [N]`: 直近 N 行のログを表示（デフォルト 50 行）
- `evo logs --since DURATION`: 直近の活動を取り出す（例: `--since 30m`, `--since 2h`, `--since 1d`）
- 環境変数 `EVO_LOG_DIR` でログ保存先を上書き可能、`EVO_LOG_DISABLE=1` で全ログを無効化
- 公式 statusLine 統合: `install/evopet-install.sh` が `~/.claude/settings.json` の `statusLine.command` を冪等に登録
- `install/evopet-uninstall.sh`: shim・PATH エントリ・statusLine 設定を冪等に巻き戻す
- 環境変数 `EVOPET_ENABLED=0` で個別無効化、`DISABLE_OPTIONAL_PROJECTS=1` で全 optional add-on の一括停止
- subprocess の終了情報を永続化: `.evo-live.json` に `lastExitCode` / `lastExitSignal` / `lastExitAt` / `lastSubcommand` を保存。`episodes` テーブルに `exit_signal` カラムを追加
- proxy 経由の passthrough サブコマンド (`review` 等) でも live state を更新
- 統合テスト: mock CLI で proxy パイプライン全体を検証する 3 ケースを追加

### Changed

- statusline 更新方式をポーリングからイベントドリブンに変更 (chokidar + 250ms デバウンス + 5 秒セーフティネット)。表示遅延が 2 秒 → 1 秒未満に
- `.evo-live.json` の書き込みをアトミック化 (tmp + rename)。statusline が読み込み中の壊れた JSON を見るリスクを排除
- 12 箇所の silent catch をログレベル分類に置換。JSONL パーサは 10 秒間に 5 件超のエラーで自動停止し暴走を抑制
- Self-tracking statusline (`statusline.py`) — proxy なしでも常に EvoPet 表示。16 種類の tip ローテーション
- `statusline.py` をリポジトリに同梱。`npm run setup` で `~/.claude/base_statusline.py` にデプロイ
- Proxy が `~/.claude/.evo-live.json` にも書き込み（cwd ミスマッチ時のフォールバック）
- Bash shim (`bin/claude`, `bin/codex`) に `export` 追加 — Git Bash から正常動作
- `getShellHome()` に `__dirname` ベースのフォールバック追加 — `EVO_HOME` 未設定でも動作
- User PATH (`HKCU\Environment`) に evo bin を追加。全ターミナル (cmd.exe/PowerShell/Git Bash) 対応
- `undoShellIntegration` に `removeFromUserPath` 追加。uninstall 時に自動で元の claude に復帰

### Fixed

- proxy mode で対象 CLI の異常終了 (signal kill 含む) が記録されず、後追いで原因が分からなかった問題
- proxy 停止中に古い live state が残り続け、statusline が嘘を表示し続けることがある問題（exit イベントで明示的にクリア）

### Previously added

- GitHub Issue Forms for feature, bug, and agent-task intake
- GitHub Actions CI and PR docs warning workflow
- Dependabot configuration for npm and GitHub Actions
- Agent workflow, project map, and review playbook docs
- `evo issue show` for agent intake via GitHub CLI
- `docs/knowledge/` for environment-specific troubleshooting knowledge
- future doc for modular AI orchestration design
- Codex friction capture for approval / retry / error / recovery visibility
- Claude friction adapter that feeds the same normalized friction events into shared scoring
- stop-and-reframe feedback in runtime and explain output
- friction architecture docs for future modular extraction

### Changed

- CONTRIBUTING を GitHub Issues / PR 中心の運用に拡張
- ROADMAP を `Now / Next / Later` ベースに整理
- README に GitHub backlog / CI / AI 並列開発の導線を追加
- README の UI 説明を絵文字ベースで見やすく整理
- EvoPet の発話を、よりやわらかくゲーム寄りのトーンへ調整
- friction capture は CLI ごとの adapter 分離、score/feedback は共通化の方針を明確化

### Local milestone history

- `7fcf603` GitHub issue forms / CI / dependabot / agent docs
- `d61f60f` PowerShell shim fix and EvoPet species support
- `b528901` GitHub knowledge docs and `evo issue show`
- `2d8c906` Codex friction capture and stop-and-reframe signals
- `89f6761` README visuals and mascot tone polish
- `5c75b13` Claude friction adapter

## [2.1.0] - 2026-04-10

### Added

- JSONL transcript watcher: Claude Code の JSONL トランスクリプトを監視し、ターン数・ツール使用数をリアルタイム追跡
- `.evo/live-state.json` によるプロセス間通信: Evo wrapper → Claude Code statusline.py へ EvoPet 状態を受け渡し
- Claude Code ステータスライン統合: 下部ステータスバーに EvoPet（アバター・ムード・ターン数・アドバイス・Bond%）をカラフル表示
- `~/.bash_profile` への Evo PATH 前置（Git Bash / Zellij 対応）

### Changed

- cmd.exe AutoRun スクリプトの PATH チェックを `echo | findstr` パイプから単純 `set PATH=` に変更（パイプが AutoRun コンテキストでハングする問題を修正）
- EXP 計算: 何もしていないセッション（ターンなし・ファイル変更なし・ファイル読み取りなし）では EXP を 0 に（空セッションで +37 EXP が付いていたバグを修正）

### Removed

- DECSTBM row 1 ペイント: Claude Code TUI の alternate screen buffer と干渉してレイアウトを破壊するため完全削除
- OSC 0 ターミナルタイトル書き込み: Zellij ペイン名とちかちか競合するため削除

## [2.0.0] - 2026-04-09

### Added

- EvoPet による 1 行マスコットフィードバック
- PC 全体で 1 体育つグローバル育成状態
- Level Up / Rescue / Chance の特別イベント表示
- `pause`, `resume`, `forget`, `uninstall` の整理された停止導線
- README の日本語化とゲーム寄り UX 説明

### Changed

- 通常時の UI を多行パネル中心から 1 行中心へ変更
- フィードバック文言をゲーム寄り・相棒寄りに変更
- `stats` を補助コマンドとして位置づけ直し、EvoPet ステータス表示を追加

## [1.0.0] - 2026-04-09

### Added

- 初期版の Evolutionary CLI Wrapper
- Codex / Claude の auto-proxy
- Surrogate Cost と Predictive Nudge
- loop detection
- local knowledge storage
