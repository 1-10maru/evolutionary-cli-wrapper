# Contributing

このリポジトリは、人間エンジニアと AI エージェントが並列に作業しやすい形で運用します。
日々の実行単位は GitHub Issues、repo 内の全体地図は `ROADMAP.md` です。

## 最初にやること

1. `main` を pull する
2. `README.md` を読む
3. GitHub Issues から担当する task を決める
4. `ROADMAP.md` を見て、他の active 作業と shared-risk area を確認する
5. 作業ごとに新しいブランチを切る

## ブランチ運用

- 日常開発は `main`
- メジャー安定ラインは `release/vX`
- 作業ブランチは `codex/<issue-or-topic>` を推奨
- 1 issue = 1 branch = 1 PR
- 大きな作業を始める前に、同じ範囲を別ブランチで触っていないか確認する

例:

- `codex/readme-collab`
- `codex/proxy-turn-boundary`
- `codex/mascot-copy-pass`

## 並列作業の基本ルール

- 実装ブランチとドキュメント更新を同じブランチで持ってよい
- ただし、同時に広い範囲を触らない
- issue に着手したら `status:active` 扱いで進める
- 競合しやすい場所を触る時は、先に `ROADMAP.md` に一言残す
- 未実装を触ったら、対応後に `ROADMAP.md` の状態も更新する
- 仕様判断をしたら `docs/DECISIONS.md` に残す
- docs は UTF-8 で編集する
- 再現した環境依存トラブルは `docs/knowledge/` に残す
- 一区切りごとに `CHANGELOG.md` も確認し、必要なら更新する
- こまめな milestone 単位で `commit -> push` を基本にする
- push が止まった時は、その理由と次の打ち手を明示する

## ドキュメント更新ルール

変更内容に応じて、次を一緒に更新する。

- ユーザー向け導線が変わる: `README.md`
- セットアップ導線が変わる: `START_HERE_JA.md`
- 運用ルールが変わる: `VERSIONING.md`
- 優先順位や未実装が変わる: `ROADMAP.md`
- 判断理由を残したい: `docs/DECISIONS.md`

## 未実装項目の見方

`ROADMAP.md` の各項目は次のどれかで管理する。

- `done`
- `active`
- `next`
- `later`

新しく見つけた課題は、コードだけで抱えず `ROADMAP.md` に追加する。

## AI エージェント向けメモ

- まず `README.md` と `ROADMAP.md` を読む
- その後に GitHub issue の完了条件を確認する
- 仕様変更を伴う時は `docs/DECISIONS.md` を更新する
- 一度に複数テーマを混ぜない
- UI 文言を変えたら README の例も追随させる
- Windows PowerShell と Claude/Codex まわりの互換性を壊さない

## ラベル運用

推奨ラベルは次です。

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

## GitHub Projects を使うなら

列は次を推奨します。

- `Backlog`
- `Ready`
- `Active`
- `Review`
- `Done`

## PR 前チェック

1. `npm run build`
2. `npm test`
3. 変更に応じて関連ドキュメントを更新
4. `ROADMAP.md` の状態を更新
5. linked issue を PR に書く
6. `CHANGELOG.md` が必要な変更なら追記

## コミットメッセージ

短くてもよいので、何を変えたかが分かる形にする。

例:

- `Add collaboration docs and roadmap`
- `Refine proxy turn boundary detection`
- `Polish mascot one-line feedback`
