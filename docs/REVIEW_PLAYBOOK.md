# Review Playbook

このファイルは、人間と AI が同じ観点で差分レビューしやすくするための基準です。

## まず見ること

- issue の完了条件を満たしているか
- 変更範囲が issue の scope に収まっているか
- out-of-scope を壊していないか

## 重点レビュー観点

- 回帰がないか
- shell integration を壊していないか
- Windows PowerShell 互換が保たれているか
- proxy の起動や turn 記録を悪化させていないか
- UI が出しゃばりすぎていないか
- README やセットアップ導線との差が生まれていないか

## 特に注意するファイル

- `src/proxyRuntime.ts`
- `src/index.ts`
- `src/scoring.ts`
- `src/db.ts`
- `scripts/setup.mjs`

## レビューコメントの書き方

- 再現条件を書く
- どの挙動が壊れるかを書く
- 可能なら代替案も添える
- 「なぜ気になるか」を 1 段落で伝える

## AI レビュー時の観点

- docs 更新漏れがないか
- issue / PR template に沿っているか
- build / test の結果があるか
- handoff で次の人が困らないか

