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

## リリース手順
- **RC channel**: `git tag v3.6.0-rc.1 && git push origin v3.6.0-rc.1` → `release-rc.yml` が走り `@next` で公開
- **Stable channel**: GitHub Actions UI から「Release Stable」を手動実行(version 入力)→ `release-stable.yml` が走り `@latest` で公開
- 詳細: [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md)
- ロールバック: [docs/runbooks/rollback-bad-release.md](docs/runbooks/rollback-bad-release.md)

## 既知の問題
- **Miniconda Prompt フリーズ**: cmd.exe AutoRun 統合で conda_hook.bat と干渉。Evo 起因ではない可能性が高いが、cmd.exe AutoRun 統合は当面無効化済み
