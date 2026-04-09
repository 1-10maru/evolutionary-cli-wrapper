# Issue Intake

`evo issue show <number>` は、AI エージェントが GitHub issue を受け取った時に、着手前に必要な情報だけを読みやすく整えるための入口です。

## 目的

- issue を開いて必要項目を拾う手間を減らす
- `agent task` issue の完了条件を取りこぼしにくくする
- branch を切る前に scope / out-of-scope を確認しやすくする

## 使い方

```powershell
evo issue show 123
evo issue show 123 --repo owner/name
```

## 読み取り対象

- title
- url
- labels
- objective
- scope
- out-of-scope
- acceptance
- docs update requirement
- reviewer expectation

## `agent task` と通常 issue の違い

- `agent task` は issue form の見出しを拾って、構造化して表示する
- 通常 issue は title / labels / body ベースで最低限の情報を出す

## 前提

- `gh` が入っている
- `gh auth login` 済みである
- repo を cwd から判定できるか、`--repo` を付ける

## 今回やらないこと

- issue の state 変更
- label 更新
- branch 作成
- PR 作成

