# Future: AI Orchestration

将来は、複数の AI が GitHub issue を見て、Claude / Codex / Copilot のいずれかへ task を投げ、相互レビューまで回せる構成を目指す。

今回はまだ実装しない。ここでは、他 repo でも流用しやすいようにモジュール境界だけ固定する。

## モジュール分割

### issue-intake

- GitHub issue を読む
- issue を task spec に正規化する

### agent-router

- Claude / Codex / Copilot のどれへ投げるか決める
- task の性質と write scope を見て振り分ける

### task-dispatch

- 各 agent 実行基盤へ task を渡す
- 実行ログと出力の受け口を統一する

### review-loop

- 別 agent に差分レビューをさせる
- regression / docs / shell compatibility などの観点を固定する

### handoff-log

- 次 agent や人間レビュアへ要約を残す
- issue / PR / local docs のどこへ残すかを統一する

## 実装順

1. repo 内 docs と CLI intake を整える
2. `issue-intake` を単独モジュールとして実装する
3. `agent-router` を追加する
4. `task-dispatch` と `review-loop` を追加する
5. `handoff-log` を整えて repo 横断利用にする

## 分離方針

- orchestration は Evo 本体の scoring / mascot から切り離す
- 他 repo でも流用できるよう、GitHub と agent adapter の境界を明確にする
- Evo 本体は引き続き collaboration coach に集中する

