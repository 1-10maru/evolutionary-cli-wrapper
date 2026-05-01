# Versioning

## 基本方針

- バージョンは Semantic Versioning を使います
- タグは `vX.Y.Z` 形式にします
- `package.json` の version と Git tag を一致させます
- 変更履歴は `CHANGELOG.md` に残します

## ブランチ運用

- `main`
  - 次のリリース候補を積む通常開発ブランチ
  - GitHub Issues から切った作業ブランチは PR 経由でここへ戻す
  - `main` 反映は CI 通過後を前提にする
- `release/vX`
  - メジャーバージョンごとの安定ブランチ
  - 例: `release/v2`

## 切り方

- breaking change を含む大きな更新
  - `main` で準備
  - `package.json` を次の major に上げる
  - `CHANGELOG.md` を更新
  - `release/vX` を切る
  - `vX.0.0` タグを打つ
- 通常の機能追加
  - `main` に積む
  - minor を上げる
  - 例: `v2.1.0`
- バグ修正のみ
  - 対象の `release/vX` へ反映
  - patch を上げる
  - 例: `v2.1.1`

## 毎回やること

1. `package.json` の version を更新
2. `CHANGELOG.md` を更新
3. `npm run release:check`
4. コミット
5. 必要なら `release/vX` を作成または更新
6. `vX.Y.Z` タグを作成して push

## この repo の実務ルール

- 一区切りの機能ごとに、できるだけ小さく commit を切る
- commit 前に関連 md を更新する
- `CHANGELOG.md` には仕様更新の履歴を残す
- リモート反映は原則、一区切りごとに行う
- push が認証や権限で止まった場合も、ローカル commit は残し、次の手として push 方法を提案する

## この repo の現行ライン

- 現在の major: `v2`
- 安定ブランチ: `release/v2`
- 現在タグ: `v2.0.0`
