# Zellij on Windows

## 症状

- PowerShell では Evo が出るのに、Zellij 経由で `claude` を起動すると出ない
- `claude --version` 自体は通るが、tracking 表示や episode 記録が入らない
- または、古い一時フォルダを参照して `MODULE_NOT_FOUND` になる

## 原因

今回の事例では、`bin/claude.cmd` は新しい install 先を指していた一方で、

- `bin/claude.ps1`
- `bin/claude`

が古い一時フォルダ配下の `dist/index.js` を向いたまま残っていました。

PowerShell 系や Zellij 経由では、その古い shim が優先される経路があり、結果として Evo が正しく噛みませんでした。

## 確認方法

1. `Get-Command claude`
2. `where.exe claude`
3. `bin/claude.cmd` / `bin/claude.ps1` / `bin/claude` の中身を確認
4. `stats` で episode が増えているかを見る

## 再発防止ルール

- shell integration の再生成では `.cmd` だけでなく `.ps1` と拡張子なし shim も必ず更新する
- Zellij のような環境を使う場合、`cmd` 経由だけで確認を終えない
- shim の `EVO_HOME` と `dist/index.js` が現行 install 先か必ず見る

## 運用メモ

- この知見は README には入れない
- Windows + Zellij のような限定環境ノウハウは `docs/knowledge/` に残す

