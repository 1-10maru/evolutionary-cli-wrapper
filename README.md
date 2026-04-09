# Evolutionary CLI Wrapper

CLI ベースの LLM を、毎回ラップ用コマンドで起動し直さなくても使えるようにしつつ、作業の進み方をローカルで記録・分析するツールです。

現状は Windows の PowerShell で使う `codex` と `claude` を対象にしています。  
セットアップ後は、ふだん通り `codex` または `claude` と打つだけで Evo が裏で中継し、履歴・スコア・改善提案を残します。

## できること

- `codex` / `claude` のセッションを自動で記録する
- 手戻りや探索の散らばりを Surrogate Cost として評価する
- edit loop / search loop を検知する
- 過去履歴をもとに、より楽に進めるための提案や称賛を出す
- TS / JS / Python は関数単位の差分も追う
- ローカル学習結果を `.evo` に保存し、他 PC へ持ち運べる

## このツールの考え方

このツールは、トークン API に依存して「何 token 使ったか」だけを見るものではありません。  
本当に見たいのは、AI にどれだけ文脈を再学習させたか、どれだけやり直しが発生したか、どれだけ探索が散ったかです。

そのため、中心になるのは次のような代理指標です。

- 読んだファイル数
- 読んだ行数
- 同じ場所への再訪回数
- 変更のやり直し回数
- テストや検証の失敗回数
- 探索の散らばり具合

CLI 側が usage を表示する場合はそれも保存しますが、Evo の中核は token 非依存で動きます。

## セットアップ

```powershell
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run setup
```

セットアップ後は PowerShell を開き直してください。  
その後は `codex` または `claude` をいつも通り起動するだけです。

最短手順だけ見たい場合は [START_HERE_JA.md](./START_HERE_JA.md) を読んでください。

## 使い始め

```powershell
codex
```

```powershell
claude
```

起動時に次のような表示が出れば、Evo 経由で動いています。

```text
Evo tracking ON | cli=claude | dir=... | mode=auto
```

親フォルダのように広すぎる場所で起動した場合は、軽量モードになり、末尾に `| light` が付きます。

```text
Evo tracking ON | cli=claude | dir=... | mode=auto | light
```

## 何が保存されるか

保存先は、CLI を起動したフォルダの `.evo` です。

```text
<対象フォルダ>\.evo\config.json
<対象フォルダ>\.evo\evolutionary.db
```

既定では次を保存します。

- プロンプト本文そのものではなく、長さや構造などの特徴量
- episode ごとの要約
- turn ごとの要約
- adapter が拾えたイベント
- 変更が入ったファイルのスナップショット
- TS / JS / Python の関数単位差分
- CLI が表示した usage 行

保存しないもの:

- 生の全文プロンプトを常に保存すること
- リポジトリ全体の全ファイル内容
- サーバーへの送信

## 記録の単位

Evo では大きく 3 つの単位で管理します。

- 保存先の単位: CLI を起動したフォルダごと
- episode の単位: `codex` / `claude` を 1 回起動して閉じるまで
- turn の単位: その session 内のやり取りごと

例:

- `C:\work\app-a` で `claude` を起動すると、記録は `C:\work\app-a\.evo\...`
- `C:\work\app-b` で `claude` を起動すると、記録は `C:\work\app-b\.evo\...`

## 軽量モード

ホーム直下や、複数プロジェクトが並ぶ親フォルダで起動すると、通常のフル追跡は重くなります。  
そのため Evo は自動で軽量モードに切り替えます。

軽量モードでは次のような重い処理を抑えます。

- 起動前後の大規模スナップショット
- 広すぎる範囲へのファイル監視

これで `Documents` や `PythonScripts` のような親フォルダでも起動待ちが長引きにくくなります。

## よく使うコマンド

```powershell
evo stats --cwd <project>
```

- 記録済み episode の一覧と現在の傾向を見る

```powershell
evo explain <episodeId> --cwd <project>
```

- その episode がどう採点されたかを見る

```powershell
evo storage --cwd <project>
```

- `.evo` の保存サイズと保持状態を見る

```powershell
evo compact --cwd <project>
```

- 古い raw episode を圧縮し、学習結果を残したまま軽くする

```powershell
evo shell off
```

```powershell
evo shell on
```

- 一時的に自動中継を切る / 戻す

```powershell
evo mode auto --cwd <project>
```

```powershell
evo mode active --cwd <project>
```

```powershell
evo mode quiet --cwd <project>
```

- 提案表示の出し方を切り替える

## 保持と圧縮

既定の `.evo/config.json` では次のポリシーを使います。

- `keepRecentRawEpisodes = 200`
- `maxDatabaseBytes = 67108864`
- `compactOnRun = true`
- `vacuumOnCompact = true`

保存は 2 層に分かれています。

- Raw layer: recent episodes, events, changed-file snapshots, symbol diffs
- Knowledge layer: `stats_buckets`, `archived_episodes`

そのため、古い raw episode を削っても、学習済みのローカルルールは残ります。

## 他 PC へ移す

いちばん簡単なのは、フォルダごと持っていく方法です。

1. このリポジトリを clone
2. 必要なら元 PC の `.evo` をコピー
3. 新しい PC で `npm install`
4. `npm run setup`

学習状態だけ軽く持っていくなら次も使えます。

```powershell
evo export-knowledge --cwd <project> --output evo-knowledge.json
evo import-knowledge --cwd <project> --input evo-knowledge.json
```

## 現在の前提と制限

- 自動プロキシは Windows PowerShell 向け
- 主対象 CLI は `codex` と `claude`
- TS / JS / Python は symbol-level tracking、その他は file-level fallback
- CLI 出力からのイベント抽出はヒューリスティックで、完全ではない

## こんな時は

### 起動時に重い

親フォルダで起動している可能性があります。`Evo tracking ON ... | light` なら軽量モードです。  
普段の開発では、できるだけ対象プロジェクトのルートで起動するのがおすすめです。

### 動いているか分かりづらい

起動直後に `Evo tracking ON | ...` が出ていれば、その session は Evo 経由です。

### 一時的に素の CLI を使いたい

```powershell
evo shell off
```

戻す時:

```powershell
evo shell on
```

## 補足

`npm install` と `npm run setup` 自体は、LLM の消費 token を増やしません。  
増えるのは `codex` や `claude` を実際に起動して使った時だけです。
