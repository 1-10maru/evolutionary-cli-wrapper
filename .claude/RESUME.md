# RESUME — 引き継ぎ（2026-07-18 v3.6.9 安定版公開完了・このファイルが唯一の再開点）

前回（2026-07-18 早朝）の残作業はすべて完遂した。次セッションはここから再開する。

## 完了済み（2026-07-18・全て GET/実測裏取り済み）
- **v3.6.9 を npm latest へ公開**（`latest: 3.6.9` / `next: 3.6.9-rc.1`、GitHub Release v3.6.9 作成済み、OIDC 公開ジョブ緑）。列車の中身:
  - **B1 記録側セッション紐付け**（PR #117、Tier 3）: bind-first-stick-hard（一度掴んだ JSONL を離さない、逃道 `EVO_DISABLE_STICK_HARD=1`）+ owner registry（`.evo/sessions/.owners/<sid>`、pid 生存確認・死 pid/24h 回収・全操作 fail-open）+ opt-in `--session-id` 注入（`EVO_BIND_SESSION_ID=1`、subcommand/resume/ユーザ指定時はスキップ）。実装 src/proxy/{jsonlWatcher,sessionOwnership,sessionIdInjection}.ts、設計 docs/ai/b1-session-binding.md。**2 独立ゲート合格**: レビュー（指摘 2 件 = fail-open 穴 + subcommand 注入穴 → 91441e8 で修正・再確認済）+ 隔離 QA（2 窓奪い合い・taskkill 回復・実 claude 2.1.212 で --session-id 受理と JSONL sessionId 一致を実測）。
  - **小粒バッチ**（PR #116）: #34 検証イベント command 欄の伏せ字化 + install-statusline の非標準 wrapper 内容検知（read-only 64KB peek）/ doctor の旧 selfcheck パス `~/.claude/.evo-selfcheck.json` 後方互換読み / repo CLAUDE.md guard 文言精密化 / docs/ai/raw-hash-design.md。
  - rc soak で **エピソード DB 書込みの end-to-end を実測合格**（公開 tarball + better-sqlite3 で episodes 1 行の完全往復を確認）。
- リリース PR 群: #118（3.6.9 版数+CHANGELOG）→ #119（rc.1 版数是正）→ #120（stable 昇格、`git diff v3.6.9-rc.1..HEAD` = version 2 ファイルのみ = src バイト同一の diff-verify 済）。
- worktree / ローカルブランチ / リモートブランチの残骸は全て掃除済み（main のみ）。

## 未完（次セッションの候補）
- **QA run-all 収容（旧 優先2 の残り 1 件）**: tempguard / a-series / h9 系ハーネスは**リポジトリのどこにも存在しない**（tree/履歴/PR 全確認済み）。前 PC のセッションローカル産で未コミット。**前 PC で回収するか再仕様化が必要**。存在しないものを書き起こすのは捏造なので保留にした。
- **A5 README デモ動画**: ユーザ実写素材が必要（モック禁止）。
- **Node 24 (Windows) で npm install 不能（上流・全版共通・v3.6.9 の退行ではない）**: tree-sitter@0.25.0 は prebuild 無しで常にソースビルド → node24 ヘッダは C++20 要求 vs MSBuild が /std:c++17 強制で C1189。3.6.8 でも同一（standalone 再現済み）。対応候補: tree-sitter の prebuild 付き版へ bump / 自前 prebuild 配布 / node<=22 をサポート表明。**独立タスクとして triage**。
- **優先 3（着手前にユーザ承認必須・変更なし）**: B2 3シンク整合 / B3 助言エスカレーション / B4 ヒント辞書一本化 / B5 evo status 常設ビュー / B6 育成度曲線 / C1 statusline TS 一本化 / C2 5層+ADR。

## 他 PC への申し送り
- **repo の dist/ から live claude を起動している PC**（前 PC）: released main（v3.6.9 = 02229cd）に ff して dist/ を再構築するか、公開 tarball 3.6.9 から dist/ を復元すること（live-tree 規律）。
- 本 PC（takeo）は global evo = npm 公開版構成。repo は clone のみで dist/ 無し・live 影響なし。

## 罠（今回の追加分。既存の罠は下記に統合維持）
- **rc タグの版数ゲート**: release.yml は「タグ v X.Y.Z-rc.N ⇔ package.json == X.Y.Z-rc.N」を要求する。**prepare PR は 2 段**（#114/#115 前例: rc.1 準備 PR → stable 昇格 PR）。3.6.9 で 1 段でやろうとして rc タグが版数ゲートで落ち、タグ削除→#119 で是正した。
- **auto モードの権限分類器は確率的**: 同一の `gh pr merge` / `gh workflow run` が通ったり弾かれたりする（設定は全 PC 同一）。弾かれたら 1 回リトライ、それでも駄目ならユーザへ 1 行コマンド提示。恒久化するなら allow ルール追加（`Bash(gh pr merge:*)` / `Bash(gh workflow run:*)`）をユーザ承認の上で。
- **この PC (takeo, node v24) は tree-sitter がビルド不能**: repo の `npm ci` は途中失敗し node_modules は部分成立（vitest/better-sqlite3 は可）。**フルテストの環境起因ベースライン = 6 件失敗**（ast×3, health native×2, native-closure×1）。「新規失敗ゼロ + CI 権威」で判定する。
- GitHub/API/teammate 時刻は **UTC**（JST-9h）。
- gh アカウントは**書込み直前に毎回** `gh api user` 確認（他セッションが切替える）。
- 実 repo の dist/ は**公開版のみ**（feature ブランチでビルド禁止・live claude が読む）。QA/モック PATH で wrapper や setup-shell を実行しない。
- QA サンドボックスは copy-only（junction 禁止）。Temp/scratchpad の実行物を originalCommandMap に混入させない。
- dev は npm link 構成・npm install -g 厳禁 / 公開は OIDC Trusted Publishing のみ。
- CONFLICTING PR の CI は黙って走らない / `gh run rerun` は当時のコミットの workflow を使う。

## 運用規約（確立済み・必ず適用）
- **階級制ゲート**（docs/RELEASE_PROCESS.md + ~/.claude/rules/risk-scaled-verification.md）: Tier1 docs/test=CI のみ / Tier2 軽微=単一ゲート+rc 省略可 / Tier3 起動・ネイティブ・メジャー=独立 2 ゲート+rc soak（v3.6.9 で実践済み）。
- **担当直結**（~/.claude/rules/no-passive-wait-orchestration.md）: implementer が freeze と同時に reviewer/QA へ直接依頼、verdict も直接返し。
- 検査資産: scripts/qa/（Windows 専用・copy-only・junction 禁止）。
