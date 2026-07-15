# Changelog

このプロジェクトは Semantic Versioning に沿って管理します。

## Unreleased

### Fixed
- Fixed a remaining fast-exit hang on Windows (e.g. `claude --bad-flag`): when the resolved `claude` was an npm interpreter shim (`claude.ps1` / `claude.cmd`) whose real `.exe` was not a sibling, evo spawned it through a PowerShell/cmd layer. npm's PowerShell shim runs `if ($MyInvocation.ExpectingInput) { $input | & claude.exe }`, and with a redirected stdin that never reaches EOF PowerShell blocked on stdin forever even after `claude.exe` exited — so evo's direct child never exited and the teardown watchdog (keyed on that child) never fired. Two independent fixes: (1) original-command resolution now follows an interpreter shim through to the real `.exe` it targets and spawns that directly, removing the interpreter layer entirely (shims that target a `.js`/`cli.js` launcher are left alone); (2) on the non-interactive path the wrapper now closes the wrapped child's stdin, delivering EOF so any remaining interpreter layer cannot wedge.
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
