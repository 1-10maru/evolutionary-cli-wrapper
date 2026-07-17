# RESUME — 他 PC 引き継ぎ（2026-07-18 早朝確定・このファイルが唯一の再開点）

前 PC のセッションはここで停止。残作業はすべて本ファイルから再開する。
（旧 v3.6.0 期の RESUME 内容は履歴コミット 40e46f9 参照・完了済みのため削除）

## 完了済み（全て npm latest 経由公開・GET 裏取り済み）
v3.6.1 起動保証バンドル+shim fallback / v3.6.2 起動セルフチェック+evo doctor --quick / v3.6.3 全文法点検 / v3.6.4 観測性+Temp パス拒否ガード / v3.6.5 入力伏せ字化+tmp 掃除 / v3.6.6 promptText ゲート+sk- 厳格化+QA スイート scripts/qa 収容 / v3.6.7 出力側伏せ字化+install-statusline 安全化+tier 方針文書。
D3 犯人特定(QA junction)+除去 / D4 containment-guard 修正(claude-config #97) / D5 定常 PR 16 本消化。

## ★最優先: 3.6.8 の飛行中パイプラインを完遂する
- 内容 = #30 部品更新: commander 14→15 + better-sqlite3 12.9→12.11.1 + tier 方針docs（PR #113 @ f618a49、両独立ゲート合格、Tier 3）
- 停止時点の正確な位置は本ファイル末尾の「3.6.8 in-flight close-out」節（実装担当が追記）を読むこと。
- 残工程の型: rc soak（v3.6.8-rc.1 → @next、OIDC Publish green 必須）→ 昇格 diff-verify（src バイト同一なら全数再検査不要）→ stable dispatch（release.yml -f version=3.6.8）→ dist を released main から再構築。

## 優先 1（ユーザ未承認・提案済み）: B1 記録側セッション紐付け（Tier 3・実働 2.5〜4h）
- 症状: 多窓で proxy が「同 cwd の最新記録」に吸い付き乗り移り → EvoPet 表示が乱れる（表示側対症療法 #73 は導入済み）
- 確定設計（2026-07-15 arch）: bind-first-stick-hard + owner registry（.evo/sessions/.owners/<sid>、pid 生存確認）+ opt-in `claude --session-id` 注入（EVO_BIND_SESSION_ID、実機検証必須）。src/proxy/jsonlWatcher.ts:159-199, 303-374
- 手順: プラン PR → 設計承認 → 実装 → フルゲート → rc soak → 公開

## 優先 2: 小粒残（単独で動かさず次の列車に同乗）
- #34: 検証イベント command 欄の伏せ字 + install-statusline 非標準 wrapper 名検知
- doctor 旧 selfcheck パス(~/.claude/.evo-selfcheck.json)の後方互換読み / repo CLAUDE.md guard 文言 precision / raw ハッシュ設計メモ / QA スイート(tempguard/aseries/h9系)の run-all 収容
- A5 README デモ動画（要ユーザ実写・モック禁止）

## 優先 3: 中期（着手前にユーザ承認必須）
B2 3シンク整合(seq+pid/torn-read/GC レース) / B3 助言エスカレーション(signalFireCounts 拡張) / B4 ヒント辞書一本化(TS/Python→JSON 単一) / B5 evo status 常設ビュー / B6 育成度曲線 / C1 statusline TS 一本化 / C2 5層+ADR（resilient-sunset プラン照合）

## 運用規約（確立済み・必ず適用）
- **階級制ゲート**（docs/RELEASE_PROCESS.md + ~/.claude/rules/risk-scaled-verification.md）: Tier1 docs/test=CI のみ / Tier2 軽微=版数同梱 PR+単一ゲート担当+rc 省略+diff-verify 昇格（合格→公開 ~15 分）/ Tier3 起動・ネイティブ・メジャー=独立 2 ゲート+rc soak。部品更新変種 = 新部品 npm ci CI + 的絞りスモーク + rc
- **担当直結**（~/.claude/rules/no-passive-wait-orchestration.md）: implementer が freeze と同時に reviewer/QA へ直接依頼、verdict も直接返し。coordinator は CC 監視+kill のみ
- 検査資産: scripts/qa/（Windows 専用・copy-only・junction 禁止・leak-audit・H7ext/H7run 収容済み）

## 罠（実績ベース・全部踏んだ）
- GitHub/API/teammate 時刻は **UTC**（JST-9h。経過時間は date/date -u で正規化してから計算）
- gh アカウントは**書込み直前に毎回** `gh api user` 確認（他セッションが切替える）
- 実 repo の dist/ は**公開版のみ**（feature ブランチでビルド禁止・live claude が読む）。QA/モック PATH で wrapper や setup-shell を実行しない（originalCommandMap 汚染 → 全窓モック接続の実害事故あり）
- QA サンドボックスは copy-only（junction は node_modules 実体破壊事故の原因）
- dev は npm link 構成・npm install -g 厳禁 / 公開は OIDC Trusted Publishing のみ（NPM_TOKEN 廃止済み）
- CONFLICTING PR の CI は黙って走らない / `gh run rerun` は当時のコミットの workflow を使う

---
（以下、3.6.8 in-flight close-out を実装担当が追記）
