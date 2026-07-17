# Evolutionary CLI Wrapper

Claude Code / Codex のバイブコーディングを育成型 EvoPet で改善する CLI ラッパー。
詳細は [README.md](README.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照。

## 技術スタック
- **言語**: TypeScript (ES2022, CommonJS)
- **ランタイム**: Node.js
- **DB**: better-sqlite3 (`.evo/evolutionary.db`)
- **AST**: tree-sitter (JS/TS/Python の関数単位差分)
- **テスト**: vitest
- **CI**: GitHub Actions (`ci.yml`)

## ビルド・テスト
```bash
npm run build          # tsc でコンパイル → dist/
npm test               # vitest run tests
npm run release:check  # build + test（リリース前確認）
npm run setup          # shim デプロイ + PATH 設定
```

## プロジェクト構造
- `src/index.ts` — CLI エントリポイント（commander）
- `src/proxyRuntime.ts` — claude/codex プロキシ中継・JSONL監視
- `src/runtime.ts` — エピソード実行・スコアリング
- `src/scoring.ts` — Surrogate Cost 計算
- `src/capture/` — CLI別フリクションキャプチャ（claude/codex/generic）
- `src/mascot.ts` — EvoPet 育成・表示
- `src/shellIntegration.ts` — shim 生成・PATH 設定（PS/bash/cmd）
- `src/db.ts` — SQLite 永続化
- `src/ast.ts` — tree-sitter AST 差分
- `tests/` — vitest テスト群

## バージョニング
Semantic Versioning。詳細は [docs/VERSIONING.md](docs/VERSIONING.md)。
現行: v3.x 系。リリース前は必ず `npm run release:check`。

## 開発機セットアップ（重要・必読）

**この repo を触る開発機では `npm install -g evolutionary-cli-wrapper` を絶対に使わない**。代わりにソースから直接リンクする:

```bash
cd <path-to-this-repo>
npm install
npm run build
npm link
```

これで「ソースを編集 → `npm run build` → 即座に `evo` コマンドに反映」というサイクルになる。`npm install -g` は npm レジストリの公開版で開発版を上書きしてしまうので絶対に避ける。

すでに `npm install -g` してしまった場合の戻し方:
```bash
npm uninstall -g evolutionary-cli-wrapper
cd <path-to-this-repo>
npm install
npm run build
npm link
```

PATH 上に複数の `evo` がある場合の確認:
```bash
where evo   # Windows
which -a evo  # Unix
```

ソース側 (`<repo>/bin/evo`) が npm グローバル側より先に来ているか確認する。

## ライブツリー規律（AI・自動開発時の厳守・ハードルール）

ユーザーのライブ `claude` は **この実 repo の `dist/`**（`bin/claude` 経由）から起動する。
つまり実 repo の `dist/` を書き換えると、ユーザーが次に打つ `claude` がその中身で動く。

**AI / 自動化されたエージェントが開発する間は、以下を厳守する:**

- **feature/fix ブランチ上で実 repo の `dist/` を絶対に再ビルドしない**（`npm run build` / `build:release` を実 repo で走らせない）。ブランチのコードでユーザーのライブ `claude` を差し替えてしまう。
- **開発ビルド・検証はすべてサンドボックスのコピーで行う**（`git archive <commit>` で対象ツリーを取り出し、`node_modules` はコピーで用意する。junction/symlink は使わない）。
- **実 repo の `dist/` を再ビルドしてよいのは、リリース直後に released `main` からだけ**。それ以外のタイミングで実 repo の `dist/` を触らない。
- **作業ツリーを feature ブランチに置いたまま放置しない**。作業後は必ず `main`（= リリース済みコード）へ戻す。
- 上の「ソースを編集 → `npm run build`」サイクルは**人間のオーナーが npm link で対話開発する場合の説明**であり、AI エージェントの自動開発には適用しない（エージェントは上のサンドボックス規律に従う）。

**事故（2026-07-17）**: レビュー用ビルドが実 repo の `dist/` をブランチコードで上書きし、ユーザーのライブ `claude` が未リリースコードで動く状態になった。コーディネーターが公開済み 3.6.1 の tarball（リリース済みバイト列）から `dist/` を復元して復旧。実 repo の `dist/` はリリース済みコードで「休ませる」のが原則。

## QA 実機統合の規律（AI 開発時・厳守）

- **実機統合テスト（wrapper を実際に spawn して挙動を見る検証）は、必ず隔離した cwd + EVO 設定 + HOME で行う**。実 repo の cwd / 実 `~/.claude` / 実 `.evo/config.json` を使わない。QA の mock `claude` は repo 内の固定 fixture（`scripts/qa/fixtures/`）に置き、**Temp/scratchpad 配下の解決対象を実設定（originalCommandMap）に絶対に混入させない**。
- **リリース検証・shim 再生成の前後は、実際の `claude` バージョン行（例 `2.1.212 (Claude Code)`）を必ず引用して報告する**。banner / 育成度ゲージだけでは mock 混入を見逃す。`resolveOriginalCommand` が Temp/scratchpad を解決対象にしていないかを `evo doctor`（Critical フラグ）で確認する。
- **事故（2026-07-17）**: QA の mock `claude` が実 `.evo/config.json` の originalCommandMap に永続化され、再生成した shim に焼き込まれた（新しい claude ウィンドウが mock を起動しかけた）。コーディネーターの doctor スポットチェックで検出・同時間に修復。wrapper 側は agent/QA シグネチャの解決対象 — `scratchpad` パスセグメントを含むもの、または `<os.tmpdir()>/claude/` 配下 — を拒否し（Temp 全域ではない。Temp 直下の正当な統合テスト fixture は解決可能なまま）、`evo doctor` が Critical で警告する（この対策は本 repo に実装済み）。

## リリース手順
- 公開は単一ワークフロー `.github/workflows/release.yml` が npm OIDC Trusted Publishing で実行（`NPM_TOKEN` 不要）
- **RC channel**: `git tag v3.6.0-rc.2 && git push origin v3.6.0-rc.2` → `release.yml`（RC 経路）が走り `@next` で公開
- **Stable channel**: GitHub Actions UI から「Release」を手動実行(version 入力)→ `release.yml`（stable 経路）が走り `@latest` で公開
- 初回のみ npmjs.com で Trusted Publisher 登録が必要（user=`1-10maru` / repo=`evolutionary-cli-wrapper` / workflow filename=`release.yml`）
- 詳細: [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md)
- ロールバック: [docs/runbooks/rollback-bad-release.md](docs/runbooks/rollback-bad-release.md)

## 既知の問題
- **Miniconda Prompt フリーズ**: cmd.exe AutoRun 統合で conda_hook.bat と干渉。Evo 起因ではない可能性が高いが、cmd.exe AutoRun 統合は当面無効化済み
