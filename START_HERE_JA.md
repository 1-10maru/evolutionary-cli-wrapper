# Evolutionary CLI Wrapper

## セットアップ

```powershell
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run setup
```

## 使い始め

```powershell
codex
```

```powershell
claude
```

- `npm run setup` のあとで PowerShell を開き直すと、`codex` と `claude` は自動で Evo 経由になります

## 保存場所

```text
<対象フォルダ>\.evo\config.json
<対象フォルダ>\.evo\evolutionary.db
```

- 設定と履歴は、CLI を起動したフォルダの `.evo` に保存されます

## 一時的に切る

```powershell
evo shell off
```

```powershell
evo shell on
```

## 移行

```powershell
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run setup
```
