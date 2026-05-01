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
現行: v2.x 系。リリース前は必ず `npm run release:check`。

## 既知の問題
- **Miniconda Prompt フリーズ**: cmd.exe AutoRun 統合で conda_hook.bat と干渉。Evo 起因ではない可能性が高いが、cmd.exe AutoRun 統合は当面無効化済み
