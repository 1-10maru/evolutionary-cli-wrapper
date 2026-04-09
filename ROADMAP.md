# Roadmap

このファイルは、他の PC で clone した人や AI エージェントが「何ができていて、次に何をやるか」をすぐ把握するための一覧です。

## Now

- PowerShell 上で `codex` / `claude` を Evo プロキシ経由にする shell integration
- episode / turn 単位の記録
- Surrogate Cost ベースの scoring
- usage 観測の保存
- TS / JS / Python の symbol-level tracking
- edit loop / search loop 検知
- 1 行 EvoPet フィードバック
- グローバル EvoPet 育成状態
- pause / resume / forget / uninstall
- Semantic Versioning と `release/v2`
- GitHub Issues / PR / CI 中心の共同開発基盤

## Next

- Claude / Codex の出力パターン差に強い turn 境界検出
- README のスクリーンショット例を実際の最新 UI に合わせて継続更新
- `evo stats` を育成ステータス画面としてさらに読みやすくする
- `evo explain` を研究モードとして分かりやすくする
- proxy 実行時の軽量モード判定をさらに賢くする

## Later

- 非 PowerShell シェル対応
- 対応 CLI の追加
- 収束予測の説明性向上
- token calibration の自動再学習
- UI テーマ切り替え

## Good First Parallel Tasks

- README と `START_HERE_JA.md` の同期
- EvoPet 文言テンプレートの追加
- `stats` / `explain` の表示改善
- テストケース追加
- shell integration 周辺のエラーメッセージ改善

## Shared-Risk Areas

- `src/proxyRuntime.ts`
- `src/index.ts`
- `src/scoring.ts`
- `src/db.ts`
- `scripts/setup.mjs`

同時に触る時は、ブランチを分けてテーマをずらすこと。

## Update Rule

- 新しい未実装を見つけたらこのファイルへ追加する
- 片付いたら `done` へ移す
- 仕様判断が入ったら `docs/DECISIONS.md` に理由も残す
