# Changelog

このプロジェクトは Semantic Versioning に沿って管理します。

## [Unreleased]

### Added

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
