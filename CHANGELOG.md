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

### Changed

- CONTRIBUTING を GitHub Issues / PR 中心の運用に拡張
- ROADMAP を `Now / Next / Later` ベースに整理
- README に GitHub backlog / CI / AI 並列開発の導線を追加

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
