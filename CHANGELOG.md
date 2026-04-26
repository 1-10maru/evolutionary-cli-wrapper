# Changelog

このプロジェクトは Semantic Versioning に沿って管理します。

## [Unreleased] - 2026-04-26

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
