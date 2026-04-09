# Project Map

このファイルは、repo を開いた AI や新しい開発者が「どこから読めばよいか」を素早く把握するための地図です。

## Main Entry Points

- `src/index.ts`
  - CLI の入口
- `src/proxyRuntime.ts`
  - `codex` / `claude` のプロキシ実行と turn 記録
- `src/runtime.ts`
  - 保守用の `run` 実行フロー
- `src/scoring.ts`
  - Surrogate Cost、predictive nudge、介入判定
- `src/db.ts`
  - SQLite 保存
- `src/mascot.ts`
  - EvoPet の状態と表示
- `src/shellIntegration.ts`
  - shell integration と shim 管理
- `src/issueIntake.ts`
  - GitHub issue を agent intake 向けに読む
- `scripts/setup.mjs`
  - セットアップ処理

## Docs Roles

- `README.md`
  - ユーザー向けの全体案内
- `START_HERE_JA.md`
  - 最短セットアップ
- `CONTRIBUTING.md`
  - 並列開発ルール
- `ROADMAP.md`
  - 未実装と優先度
- `docs/DECISIONS.md`
  - 判断理由
- `docs/AGENT_WORKFLOW.md`
  - AI エージェント向け作業手順
- `docs/REVIEW_PLAYBOOK.md`
  - レビュー観点
- `docs/issue-intake.md`
  - `evo issue show` の目的と使い方
- `docs/knowledge/`
  - 環境依存や運用事故の再発防止ノウハウ
- `docs/future/`
  - 将来のモジュール構想

## Shared-Risk Areas

同時に複数ブランチで触ると競合しやすい場所です。

- `src/proxyRuntime.ts`
- `src/index.ts`
- `src/scoring.ts`
- `src/db.ts`
- `scripts/setup.mjs`

## Setup / Runtime Notes

- 主対象は Windows PowerShell
- shell integration 後は `codex` / `claude` をそのまま打つ
- 広すぎるフォルダでは `light` モードに落ちる
- 学習データは project-local `.evo`
- EvoPet は global 側に保存される
- 将来の orchestration は本体 CLI と分離したモジュールとして切り出す
## Friction Layer

- `src/capture/frictionCore.ts` aggregates approvals, tool errors, retries, and stop-and-reframe signals.
- `src/capture/codexCapture.ts` is the Codex-first adapter.
- `src/capture/genericCapture.ts` is the fallback adapter for Claude / generic CLIs.
- Keep this layer separate from future issue-intake / dispatch / review-loop modules.
