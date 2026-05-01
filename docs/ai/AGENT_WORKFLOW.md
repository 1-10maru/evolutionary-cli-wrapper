# Agent Workflow

このファイルは、Codex / Claude / Copilot などの AI エージェントが GitHub 上の issue を受けて、迷わず branch / PR / handoff まで進めるための手順です。

## 最初に読む順番

1. `README.md`
2. `docs/ROADMAP.md`
3. `docs/CONTRIBUTING.md`
4. このファイル
5. 必要なら `docs/ai/PROJECT_MAP.md`

## 基本ルール

- 1 issue = 1 branch = 1 PR
- branch 名は `codex/<issue-number-or-topic>`
- issue に着手したら `status:active` を付ける前提で進める
- shared-risk area を触る issue は同時に 1 本までを推奨
- 実装変更時は関連 docs を同じ PR に含める
- docs は UTF-8 で編集する
- 再現した環境事故や運用事故は `docs/ai/knowledge/` に残す

## 受けた issue から着手する流れ

1. `evo issue show <number>` で issue を読む
2. 完了条件と out-of-scope を確認する
3. `docs/ROADMAP.md` の shared-risk area と重ならないか見る
4. branch を切る
5. 実装
6. `npm run build`
7. `npm test`
8. 必要な docs を更新
9. self-review
10. PR を作る

## どの docs を更新するか

- ユーザー向けの見え方が変わる: `README.md`
- セットアップ導線が変わる: `README.md` の日本語クイックインストールセクション
- 優先度や未実装が変わる: `docs/ROADMAP.md`
- 判断理由を残す: `docs/ai/DECISIONS.md`
- 再発防止ノウハウを残す: `docs/ai/knowledge/`
- repo の構造理解が変わる: `docs/ai/PROJECT_MAP.md`
- レビュー観点が増える: `docs/ai/REVIEW_PLAYBOOK.md`

## PR タイトル規約

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`

例:

- `feat: add GitHub issue forms and CI`
- `docs: clarify agent workflow`

## self-review の観点

- issue の完了条件を満たしているか
- 触らない範囲を壊していないか
- Windows PowerShell と shell integration を壊していないか
- README など導線 docs が古くなっていないか
- build / test が通っているか

## handoff 書式

次の agent や人間レビューへ渡す時は、最低限これを残す。

```text
Summary:
- 何を変えたか

Checks:
- npm run build
- npm test

Docs:
- 更新した docs

Risks:
- まだ気になる点

Next:
- 次にやるとよいこと
```

## 推奨ラベル

- `type:feature`
- `type:bug`
- `type:docs`
- `agent:codex`
- `agent:claude`
- `agent:copilot`
- `status:active`
- `status:blocked`
- `status:review`
- `area:proxy`
- `area:ui`
- `area:docs`

## Friction Notes

- If Codex work reveals repeated approval bursts, tool failures, or retry loops, add the reusable lesson to `docs/ai/knowledge/codex-friction.md`.
- If you change friction capture rules, update the runtime tests and the knowledge note in the same PR.
