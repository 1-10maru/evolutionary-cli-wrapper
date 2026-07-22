# RESUME — 引き継ぎ（2026-07-22 v3.7.0 安定版公開完了・このファイルが唯一の再開点）

優先3 バッチ（C2 除く）は v3.7.0 として完遂・公開済み。次セッションはここから再開する。

## 完了済み（2026-07-22・全て GET/実測裏取り済み）
- **v3.7.0 を npm latest へ公開**（`latest: 3.7.0` / `next: 3.7.0-rc.1`、GitHub Release v3.7.0、OIDC 緑）。列車の中身 = 優先3 の 6 件 + 週次辞書同期:
  - **B2** 3 シンク live-state 整合（#122・Tier3）: seq+writerPid+writtenAt 刻印 / 読み裂け対策 / GC-vs-live-writer 競合根治（B1 owner registry 連携）/ 新 `src/proxy/liveStateReader.ts`（total-order 選択、レビューで非推移性バグを事前捕獲→修正済）
  - **B3** 助言エスカレーション（#121・Tier2）: 同一シグナル反復で 3 段階に強化（1-2 通常 / 3-4 強め / 5-6 最強 / 7+ 控えめ化）。賞賛系は従来通り。`adviceEscalationLevel` を live-state に露出
  - **B4** ヒント辞書一本化（#125）: `src/data/statusline-dict.json` が唯一の源。`scripts/gen-statusline-dict.mjs`（--check = ドリフトゲート、vitest 組込み）で python 側へ埋め込み生成。旧 statusline-data-raw.ts 廃止
  - **B5** `evo status`（#123・Tier2）: 読み取り専用 1 画面集約 + `--watch`。完全 read-only をテストで証明
  - **B6** 育成度曲線一本化（#124・Tier2）: ISG が唯一の曲線。旧 EXP 曲線（v3.1 以降 dead code）除去。旧データ完全互換
  - **C1** statusline TS 一本化（#126・Tier3 両ゲート合格）: install-statusline は `evo statusline --full` を配線（python ファイル配布廃止・再実行で移行+掃除）。**旧 python 描画とバイト完全一致**を 3 状態で実測。手作り wrapper 保護（#116）維持。平均描画 231ms
  - **#127** 週次辞書同期（B4 ブリッジ初稼働。自動 PR は CI が走らない → ローカルで --check 検証してからマージした）
- rc soak（公開バイトで実測）: エピソード DB 完全往復 / statusline インストール+描画 / doctor クリーン → GO
- リリース PR: #128（rc.1 準備）→ #129（stable 昇格、rc とのソース同一性 diff-verify 済）。2 段 PR 方式は前例(#114/#115)通り

## 4 日停止事故（2026-07-18→22）と恒久対策
- 07-18 に使用制限でセッション+全サブエージェントが停止。limit-restart watchdog は検知したが、**受信メッセージ（teammate/task 通知）が transcript を更新し続けたため「生存」と誤判定 → false_positive → 自動再開されず**、ユーザの手動「再開」まで 4 日放置。
- 恒久修正: watchdog の生存判定を「transcript mtime」→「**assistant 発話エントリの timestamp**」に変更する PR を claude-config に提出（fix/limit-watchdog-staleness-assistant-ts。状態は claude-config 側 PR を確認）。

## 未完（次セッションの候補・すべて非ブロッキング）
- **C2 5層+ADR**: 照合先 `resilient-sunset` プランは**前 PC のみに存在**（本 repo/履歴/この PC の plans に痕跡ゼロ、2026-07-18 徹底捜索済み）。前 PC で plan 回収 or ユーザ再仕様化まで着手禁止（捏造回避）。
- **QA run-all 収容**: tempguard/a-series/h9 ハーネスも前 PC のセッションローカル産で未コミット（同上）。
- **A5 README デモ動画**: ユーザ実写素材が必要。
- **Node 24 (Windows) クリーンインストール不能**（上流・全版共通・悪化なし）: tree-sitter@0.25.0 に node24 prebuild が無く MSVC で C1189。対応候補: prebuild 付き版へ bump / optionalDependencies 化 / node<=22 サポート表明。独立 triage。
- **B4 followup**: workflow yml に statusline-dict.json を正式追加しブリッジ削除（要 `workflow` スコープ付き 1-10maru トークン: `gh auth refresh -h github.com -u 1-10maru -s workflow`）。
- **C1 任意改善**（レビュー指摘・全て非ブロッキング）: sessionless 時の per-session mtime スキャン移植 or 注記 / token 行を先に描画して EvoPet 例外から守る / PATH 依存の運用リスク監視 / update-check の 1.5s 余韻。
- **B5 任意改善**: collectPet try/catch 対称化 / mascot default twin の再統一 / --watch の fake-timers テスト。

## 他 PC への申し送り
- **repo の dist/ から live claude を起動している PC**（前 PC）: released main（v3.7.0）に ff して dist/ 再構築、または公開 tarball 3.7.0 から復元（live-tree 規律）。**C1 により install-statusline の既定が TS 配線に変わった** — 再インストールすると base_statusline.py が撤去される（意図された移行）。
- 本 PC（takeo）: global evo = npm 公開版。repo は clone のみ・live 影響なし。

## 罠（要点。詳細は前版 3171876 の RESUME 参照）
- rc タグの版数ゲート: prepare PR は 2 段（rc.1 → stable 昇格）。package.json == タグ文字列 全体。
- auto モード権限分類器は確率的: merge/dispatch が弾かれたら 1 回リトライ → 駄目ならユーザへ 1 行コマンド。
- この PC (node v24) は tree-sitter ビルド不能: フルテストの環境ベースライン = 6 件失敗（ast×3, health native×2, native-closure×1）。「新規失敗ゼロ + CI 権威」で判定。
- 自動生成 PR（週次同期等）は CI が走らないことがある → マージ前に `node scripts/gen-statusline-dict.mjs --check` 等をローカル実行。
- gh は書込み直前に `gh api user` 確認 / UTC 時刻 / 実 repo dist/ は公開版のみ / QA は隔離 sandbox・copy-only / dev で npm install -g 厳禁 / 公開は OIDC のみ。

## 運用規約（確立済み）
- 階級制ゲート（risk-scaled-verification）: 軽=CI のみ / 中=レビュー1+差分検査 / 重=独立2ゲート+rc soak。発注前に階級宣言。
- 担当直結（no-passive-wait）: implementer が freeze と同時に reviewer/QA へ直接依頼・verdict 直接返し・合格=自動GO。coordinator は監視+異常介入のみ。
- サブエージェントは「報告なしの停止禁止」を発注文に明記（停滞は resume でなく交代）。
