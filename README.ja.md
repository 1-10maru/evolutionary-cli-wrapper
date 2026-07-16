<div align="center">
  <a href="https://www.npmjs.com/package/evolutionary-cli-wrapper">
    <img src="https://raw.githubusercontent.com/1-10maru/evolutionary-cli-wrapper/main/assets/evopet-banner.png" alt="EvoPet — ターミナルで育つペット" width="100%">
  </a>
</div>

<p align="center">
  <a href="./README.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  ローカルで動く <a href="https://claude.com/claude-code">Claude Code</a> のステータスライン・コンパニオン。プロンプトのコツを教えながらドット絵のペットが育ちます — <b>トークン消費ゼロ、テレメトリゼロ、すべて手元のマシンで完結。</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/evolutionary-cli-wrapper"><img src="https://img.shields.io/npm/v/evolutionary-cli-wrapper?logo=npm&label=npm&color=CB4B16" alt="npm version"></a>
  <a href="https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml"><img src="https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-5FA04E?logo=node.js&logoColor=white" alt="Node 20 or newer">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/evolutionary-cli-wrapper?color=4C9A2A" alt="License: ISC"></a>
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<!--
  DEMO PLACEHOLDER — 別タスクでステータスラインのデモ GIF を録画し、ここに差し込みます。例:
  <div align="center">
    <img src="https://raw.githubusercontent.com/1-10maru/evolutionary-cli-wrapper/main/assets/evopet-demo.gif" alt="EvoPet statusline demo" width="100%">
  </div>
  それまでの間、仮の / モックの画像を貼らないこと。
-->

---

**EvoPet** は [Claude Code](https://claude.com/claude-code) のステータスラインに常駐します。描画のたびに 3 つを表示します: コンテキスト / レート制限のゲージ、ドット絵ペットのムード行、そして短く実践的なプロンプトエンジニアリングのヒント（ときに `❌ before / ✅ after` の例つき）。指示が鋭くなればペットは成長し、曖昧な依頼や修正ループに陥るとそれを検知してそっと軌道修正します。

動作は**完全にローカル**です。Claude API を呼ばず、トークンを消費せず、テレメトリも送らず、セッションの内容は一切アップロードされません。`evo install-statusline` がデプロイするステータスライン自体はネットワーク通信を一切行いません。唯一の任意通信は「更新あり」通知のための 1 日 1 回の npm レジストリ確認だけで、これは `evo` CLI 自身のレンダラーが行い、`EVO_NO_UPDATE_CHECK=1` で無効化できます。

このリポジトリの使い方は 2 通りあります。

- **npm ユーザーとして** — パッケージをインストールし、Claude Code のステータスラインだけを差し替える。多くの人向けの推奨パスです。
- **開発者として** — リポジトリを clone してコードを触る、テストスイートを回す、またはセッション全体を記録・スコアリングする in-repo の proxy を使う（npm には同梱されません）。

## クイックインストール

> **前提:** [Node.js](https://nodejs.org) 20 以上（`evo` CLI 用）と、`PATH` 上の Python 3（デプロイされるステータスラインは Claude Code が描画ごとに呼び出す Python スクリプトです）。

```bash
npm install -g evolutionary-cli-wrapper
evo install-statusline
```

`evo install-statusline` はデフォルト対話モードで動き、以下の 2 つだけを実行します。

1. パッケージの `statusline.py` を `~/.claude/base_statusline.py` にコピー。
2. `~/.claude/settings.json` の `statusLine` を
   `{ "type": "command", "command": "python \"<HOME>/.claude/base_statusline.py\"" }` に設定（他のキーはすべて保持）。既存の `settings.json` は上書き前に `~/.claude/settings.json.bak.<timestamp>` にバックアップされ、現在の `statusLine` が EvoPet 以外を指している場合は置き換え前に確認されます。

その後、**Claude Code セッションを再起動**すると新しいステータスラインが有効になります。CI やプロビジョニングで確認をスキップしたい場合は `--yes` を付けてください。

グローバルインストールしたくない場合は `npx` で一度だけ実行できます。

```bash
npx evolutionary-cli-wrapper install-statusline
```

### トラブルシューティング

| 症状 | 対処 |
|---|---|
| インストール後にステータスラインが空 | Claude Code セッションを再起動。既定の表示モードは v3.5.0 以降 `expansion` です。古いデプロイの場合は `evo display expansion` の後 `evo install-statusline --yes` を実行。 |
| 描画時に `python: command not found` | ステータスラインは Python スクリプトです。Python 3 をインストールし、`python` が `PATH` で解決できることを確認してください。 |
| `npm update -g` してもヒントが変わらない | デプロイ済みの `~/.claude/base_statusline.py` はパッケージファイルの*コピー*です。`evo install-statusline --yes` で再デプロイしてください。 |
| `⚠ update:` 通知がうるさい / オフライン | この通知はデプロイ済みステータスラインではなく `evo` CLI 自身のレンダラーが出します。`EVO_NO_UPDATE_CHECK=1` でレジストリ確認と通知を抑制できます。 |
| 元のステータスラインに戻したい | `evo install-statusline --uninstall` でスクリプトを削除し、直近の `settings.json` バックアップを復元します。 |

## はじめに

ステータスラインが有効になれば、EvoPet は追加設定なしで動きます — 入力するプロンプトがスコアリングされ、ペットが反応します。覚えておくと便利なコマンド:

```bash
evo stats                 # 現在のランク・育成度・直近の履歴
evo pet list              # 10 種類のペットを一覧
evo pet choose fox        # 好きな子を選ぶ
evo display toggle        # コンパクト表示と拡張表示を切り替え
```

アンインストールは対称的です。

```bash
evo install-statusline --uninstall   # ステータスラインを削除し、バックアップを復元
npm uninstall -g evolutionary-cli-wrapper
```

## コマンドリファレンス

ほとんどのユーザーが触るコマンド:

| コマンド | 内容 |
|---|---|
| `evo install-statusline` | `statusline.py` を `~/.claude/` にデプロイし `settings.json` に組み込む。`--yes` で確認省略、`--uninstall` で復元。 |
| `evo stats` | EvoPet のランク・育成度・エピソード履歴を表示。 |
| `evo pet list` | 利用可能な EvoPet の種類を一覧。 |
| `evo pet choose <id>` | ペットの種類を設定（例: `evo pet choose cat`）。 |
| `evo display [mode]` | ステータスラインのレイアウトを切り替え: `minimum` / `expansion` / `toggle`。引数なしで現在のモードを表示。 |
| `evo doctor` | 1 ページのヘルスレポートを表示 — バージョン・環境・ファイル確認・直近のエラー・ライブステートの鮮度（`--json` で機械可読出力）。 |
| `evo logs [--tail N] [--since 30m] [--bundle]` | 直近の Evo ログ行を表示、または `--bundle` で直近 7 日のログ + doctor 出力を秘匿処理した zip にまとめる（バグ報告用）。 |

開発者・パワーユーザー向けコマンド（多くは clone して `npm run setup` した後に有効）:

| コマンド | 内容 |
|---|---|
| `evo init` | ローカルの `.evo/config.json` を既定値で作成。 |
| `evo setup-shell` | ターミナル統合と proxy shim を導入し、`claude` を Evo 経由にする。 |
| `evo undo-shell` | 管理下のシェル統合ブロックを削除。 |
| `evo shell on \| off \| status` | 新しいターミナル向けのシェル統合を有効化・無効化・確認。 |
| `evo pause` / `evo resume` | 新規セッションの auto-proxy を一時停止 / 再開。 |
| `evo mode <auto\|active\|quiet>` | proxy セッションの既定アドバイス量を設定。 |
| `evo proxy --cli claude -- <args>` | `claude` を 1 回だけ Evo proxy 経由で実行。 |
| `evo run -- <command>` | 任意の LLM CLI コマンドをエピソード記録・スコアリング付きで実行。 |
| `evo explain <episodeId>` | 記録済みエピソードのスコア算出根拠を説明。 |
| `evo storage` | ローカル DB の使用量と保持状況を表示。 |
| `evo compact` | 学習済みロールアップを残しつつ古い生エピソードをアーカイブ。 |
| `evo export-knowledge --output <path>` | 学習済みのローカル統計をポータブルな JSON バンドルに書き出し。 |
| `evo import-knowledge --input <path>` | ナレッジバンドルをローカル統計にマージ。 |
| `evo issue show <number> [--repo owner/name]` | GitHub issue を AI エージェント向けに要約表示。 |
| `evo forget` | プロジェクトフォルダのローカル `.evo` 履歴を削除。 |
| `evo uninstall [--purge-data]` | シェル統合を削除し、任意でローカル Evo データも削除。 |
| `evo statusline` | stdin の JSON から EvoPet 部分のステータスラインを描画（内部利用）。 |

## 仕組み

Python ステータスラインスクリプトは Claude Code が描画ごとに呼び出します（ポーリングなし、バックグラウンドプロセスなし）。Claude Code が stdin で渡す JSON と、開発者が in-repo proxy 経由で動かしている時に書き込まれるオプションの `~/.claude/.evo-live.json` ライブステートを読みます。

- **proxy が有効なとき**、EvoPet は実際のセッションシグナルを反映します: セッション単位のターンカウンタ、検出したループ、プロンプト品質スコア、現在のムード。
- **無効なとき**（既定の npm パス）、ステータスラインは `~/.claude/.evo-self-state.json` に呼び出し回数を記録し、ヒントライブラリ全体（手書きの厳選リスト + Anthropic 公式 Claude Code ドキュメントから自動同期された全件）を、Tier 重み付き（core / default / niche を 5 : 2 : 1）のラウンドロビンでローテーションします。

ターンカウンタは現在の Claude Code セッション ID にスコープされるため、サブエージェントへの委譲や同一ディレクトリの並列セッションが互いの数値を膨らませたり上書きしたりしません。v3.4.0 以降、セッション単位の状態は `<cwd>/.evo/sessions/<sessionId>.json` に保存され、7 日より古いファイルは自動的に削除されます。

## ドキュメント

`docs/` 配下の全体マップは **[docs/README.md](./docs/README.md)** にあります。主なもの:

| ドキュメント | 内容 |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | リリース履歴とバージョンごとの挙動変更。 |
| [docs/VERSIONING.md](./docs/VERSIONING.md) | セマンティックバージョニング方針とリリースラインの構成。 |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | コミット規約・ラベル・PR チェックリスト。 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | 計画中の作業と共有リスク領域。 |
| [docs/ai/](./docs/ai/) | エージェント作業手順・判断ログ・プロジェクトマップ・レビュー観点・Windows/Zellij ノート。 |

## 設定

デプロイされるステータスライン（`base_statusline.py`）は設定不要で、環境変数も読みません。以下の変数は **`evo` CLI**（特に組み込みの `evo statusline` レンダラーと更新チェック）に影響します:

| 変数 | 既定 | 効果 |
|---|---|---|
| `EVO_NO_UPDATE_CHECK` | 未設定 | `1` で `evo` CLI の npm レジストリ更新チェックと `⚠ update:` 通知を無効化。 |
| `EVO_HOME` | `~` | update-check キャッシュの保存先（`<EVO_HOME>/.evo/update-check.json`）を上書き。 |

`evo` CLI 経由で（`evo statusline`）ステータスラインを描画した場合、軽量な更新チェックを行います。新鮮なキャッシュがなければ `registry.npmjs.org` へ非ブロッキングの GET を 1 回投げ（stale-while-revalidate）、新しいバージョンが公開されていれば `⚠ update: <current> → <latest>` を付加します。`evo install-statusline` がデプロイする Python ステータスラインはこれを行いません。

<details>
<summary><b>開発者モードの環境変数</b>（<code>evo</code> Node CLI を直接動かす時のみ有効）</summary>

| 変数 | 既定 | 効果 |
|---|---|---|
| `EVO_CONFIG` | `<cwd>/.evo/config.json` | `evo` CLI が読む config（シェル shim が設定）。 |
| `EVO_LOG_LEVEL` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG`。`DEBUG` は stderr にもミラー。 |
| `EVO_LOG_DIR` | `<cwd>` | ログのベースディレクトリ（`<EVO_LOG_DIR>/.evo/logs/session-YYYYMMDD.log`）。 |
| `EVO_LOG_DISABLE` | `0` | `1` で全ログ出力を no-op に。 |
| `EVO_PROXY_ACTIVE` | 未設定 | proxy が本物の `claude` を起動する際に `1` を設定。再入検出に使用。 |
| `EVO_FORCE_NORMAL` | 未設定 | cwd ヒューリスティクスに関係なくフル（非軽量）トラッキングを強制。`EVO_FORCE_LIGHT` より優先。 |
| `EVO_FORCE_LIGHT` | 未設定 | cwd ヒューリスティクスに関係なく軽量トラッキングを強制。 |

</details>

## プライバシー / 保存されるデータ

Evo はコラボレーションを**ローカルで**スコアリングします。データはどこにも送信されません。唯一の通信は任意の npm 更新チェックのみです（`EVO_NO_UPDATE_CHECK=1` で無効化）。

**保存されるもの。** ターンごとに、ラップした CLI へ送った**入力のプレビュー（最大 500 文字）**、入力全体の **sha256 ハッシュと長さ**（テキストを保持せず同一プロンプトを識別するため）、短い**出力プレビュー（約 160 文字）**、および派生指標（検出したファイルパス、トークン数、フリクション/複雑度スコア）。

**保存場所。** `<project>/.evo/` 配下 — SQLite データベース `.evo/evolutionary.db`、秘匿処理済みログ `.evo/logs/`、セッション単位カウンタ `.evo/sessions/`。ステータスライン用の小さなライブ状態ファイルが `~/.claude/.evo-live.json` にも書かれます。

**保持期間。** 7 日より古いログは自動削除され、データベースはサイズ/経過ポリシーで圧縮されます（`evo storage` で使用量確認、`evo compact` で古い生エピソードをまとめる）。

**プロンプトテキスト保存の無効化。** `<project>/.evo/config.json` で `capture.promptText` を `false` にすると、Evo は入力の sha256 ハッシュと長さ**のみ**を保存し、入力テキスト・入力プレビュー・出力プレビューを一切保存しません（出力には入力が引用され得るため、出力プレビューも対象に含めています）。

```json
{ "capture": { "promptText": false } }
```

**削除方法。** `evo forget` は現在のプロジェクトのローカル `.evo/` 履歴を削除します。`evo uninstall --purge-data` はシェル統合を削除し、プロジェクトの `.evo/` データも削除します。

## ペットについて

EvoPet がこのツールを単なる linter ではなく*コンパニオン*たらしめています。Claude Code の使い方に反応する個性を持っています。

**10 種類**から選べます — ペットは 🐣 `chick` からスタートし、`evo pet choose <id>` でいつでも変更できます。

🐣 chick · 🐱 cat · 🐶 dog · 🦊 fox · 🐰 rabbit · 🐻 bear · 🐼 panda · 🐨 koala · 🐯 tiger · 🐧 penguin

**5 つの育成段階。** 重要なのは、段階が**累積経験値ではなく Ideal State Gauge（ISG）**— *直近の指示品質*のローリング指標 — で決まる点です。明確で構造化されたプロンプトを書き続ければペットは昇格し、品質が落ちれば段階が下がることもあります。それこそが狙いです。

| 段階 | ランク | ISG バンド |
|---|---|---|
| 🥚 egg | 初心者 | `< 25` |
| 🌱 sprout | 見習い | `25 – 45` |
| 🐾 buddy | 実践者 | `45 – 65` |
| 🧙 wizard | 熟練者 | `65 – 82` |
| 👑 legend | 達人 | `82+` |

**5 つのムード**がセッションに応じて変化します: アイドル時は `まったり`、一発成功で `ごきげん`、指示改善でトークンを大きく節約できそうな時は `やる気MAX`、修正ループや探索ループを検知すると `しんぱい`、プロンプト構造が本当に決まっている時は `どや顔`。

**コンボと育成度ゲージ。** 「良い」プロンプト（構造化されていて、一発成功、ループなし）はコンボを伸ばし、3 / 5 / 10 / 20 連続で祝福が出ます。表示される育成度ゲージ（育成度）は Ideal State Gauge そのもので、直近のプロンプト品質が高く**かつ**直近数エピソードがループフリーの時にだけ 100% 近くに張り付きます。

内部では、シグナル検出器が `prompt_too_vague`（曖昧な指示）・`same_function_revisit`（同じ関数の再訪）・`scope_creep`（対象の散らばり）・`no_success_criteria`（完了条件なし）・`approval_fatigue`（承認疲れ）などのパターンを監視し、最も重要な 1 件を、あなた自身の依頼文の before/after 書き換えを添えた具体的な提案に変換します。

## コントリビュート

歓迎します。要点だけ:

- 日常の開発は `main` で、安定版ラインは `release/vX` に置きます。
- 1 issue = 1 ブランチ（`codex/<issue-or-topic>`）= 1 PR。ドキュメントと実装は同じ PR にまとめ、途中でスコープを広げないこと。
- 共有リスク領域（`src/proxyRuntime.ts`・`src/index.ts`・`src/scoring.ts`・`src/db.ts`・`scripts/setup.mjs`）を触る前に、issue か [docs/ROADMAP.md](./docs/ROADMAP.md) に一言残してください。
- ドキュメントはすべて UTF-8。

clone してビルド・テスト:

```bash
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run build      # tsc → dist/
npm test           # vitest
```

`npm run setup` はさらにシェル shim とステータスラインをデプロイしてフル開発者モードにします。`evo undo-shell` か `evo uninstall` で元に戻せます。詳しいガイドライン: [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)。

## ライセンス

[ISC](./LICENSE) © 1-10maru
