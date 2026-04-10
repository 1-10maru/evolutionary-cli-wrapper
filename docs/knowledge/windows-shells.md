# Windows Shell Notes

Windows では、同じ `claude` / `codex` でも、どの shell から起動するかで拾われる wrapper が変わることがあります。

## 解決順で気をつけること

- `cmd` は `.cmd` を拾いやすい
- PowerShell は `.ps1` を優先することがある
- 一部の terminal multiplexer や shell ラッパーは、拡張子なしの shim を先に使うことがある

## 再発防止ルール

- `.cmd` だけ直して終わらない
- `.ps1` と拡張子なし shim も同時に確認する
- shim が指す `dist/index.js` と `EVO_HOME` が現在の install 先かを見る
- shell integration を直したら、`cmd` / PowerShell / multiplexer 経由の 3 経路を最低確認する

## 最低限の確認ポイント

- `where.exe claude`
- `Get-Command claude`
- `bin/claude.cmd`
- `bin/claude.ps1`
- `bin/claude`
