# Evolutionary CLI Wrapper

[![CI](https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml)

[English](#english) | [日本語](#日本語)

---

## English

EvoPet is a local statusline companion for [Claude Code](https://claude.com/claude-code) that surfaces short prompt-engineering tips, session mood comments, and a one-line context/rate-limit gauge directly inside the Claude Code statusline. Tips are sourced from a curated list plus an auto-synced subset of Anthropic's public Claude Code docs. The tool runs entirely locally — it does not consume Claude API tokens, send telemetry, or upload session content.

#### v3.1 highlights

- **Stage progression is now ISG-based** (Ideal State Gauge — sustained prompt quality), not cumulative EXP. Stages map to ISG bands: egg <25 / sprout 25-45 / buddy 45-65 / wizard 65-82 / legend 82+. Existing users may see their stage drop until prompt quality catches up.
- **Mascot is PC-global**: `EVO_HOME` defaults to `~/.claude` instead of `<cwd>`. A one-time migration copies any existing per-cwd `.evo/mascot.json` into `~/.claude/.evo/` on first launch.
- **Tips are now category-aware**: when the proxy detects a signal (e.g., `prompt_too_vague`), the statusline filters tips to the matching category (`specificity`, `verification`, `permissions`, `context`, `recovery`, `exploration`).
- **Mood comments work in proxy mode too**: the 5-band mood comment (start / early / working / busy / critical) appears in the proxy-active path when no advice line is present, not just the no-proxy fallback.

There are two distinct ways to use this repository:

- **As an npm consumer** — install the package globally and wire only the statusline into Claude Code. This is the supported path for most users.
- **As a developer** — clone the repo to work on the codebase, run the test suite, or use the in-repo shell-integration / proxy machinery (which is not shipped to npm).

### Quick install (users)

```bash
npm install -g evolutionary-cli-wrapper
evo install-statusline
```

`evo install-statusline` is interactive by default. It performs exactly two actions:

1. Copies `<package>/statusline.py` to `~/.claude/base_statusline.py`.
2. Sets `statusLine` in `~/.claude/settings.json` to:
   ```json
   { "type": "command", "command": "python \"<HOME>/.claude/base_statusline.py\"" }
   ```
   Other keys in `settings.json` are preserved. If `settings.json` already exists, a timestamped backup is created at `~/.claude/settings.json.bak.<ISO-timestamp>` before the file is overwritten. If the existing `statusLine.command` is non-evopet, you are prompted before it is replaced.

Flags:

- `--yes` — skip all prompts (use in CI / automated provisioning).
- `--uninstall` — delete `~/.claude/base_statusline.py` and restore the most recent `settings.json.bak.*`. If no backup exists but the current `statusLine.command` points at `base_statusline.py`, the key is deleted.

After install, restart your Claude Code session to pick up the new statusline.

### What it does

After installing, your Claude Code statusline shows three things:

1. The model name, the cwd, and (when Claude Code provides them) `ctx`, `5h`, and `7d` usage gauges as colored dots with percentages.
2. An EvoPet mood line that rotates a session-start boost message or a cwd/turn-aware comment.
3. A short prompt-engineering tip with an optional `❌ before / ✅ after` example pair.

### How it works

The Python statusline script is invoked by Claude Code on each render (no polling, no background process). It reads the JSON Claude Code passes on stdin, plus an optional `~/.claude/.evo-live.json` file that the in-repo proxy writes when a developer is running through it. When `~/.claude/.evo-live.json` is absent, the statusline self-tracks call counts in `~/.claude/.evo-self.json` and rotates through every tip — both the curated list and all entries auto-synced from the official Claude Code docs — using a tier-weighted round-robin (Tier 1 core / Tier 2 default / Tier 3 niche, weighted 5 : 2 : 1; see [Updating](#updating) below).

EvoPet's "X回目" counter reflects only user-typed messages within the current Claude Code session (identified by session ID). Sub-agent dispatches are tracked separately in the sub-agent's own JSONL and do not inflate the parent count. Switching directories or starting a new session resets the counter.

Starting in v3.4.0, EvoPet's state is written per-session to `<cwd>/.evo/sessions/<sessionId>.json` (alongside the legacy `<cwd>/.evo/live-state.json` kept for back-compat). The statusline reads the file matching Claude Code's current `session_id` from the stdin payload, so multiple Claude Code sessions in the same directory no longer interfere with each other's metrics. Per-session files older than 7 days are pruned automatically at proxy startup. (v3.4.0 以降、EvoPet の状態は `<cwd>/.evo/sessions/<sessionId>.json` にセッション単位で保存され、同一ディレクトリで並列起動した Claude Code セッションが互いのメトリクスを上書きすることはなくなりました。)

### Updating

The published patch versions of this package roll forward automatically:

- Every Monday at 03:00 UTC, the upstream repository's `Sync Claude Code Docs` workflow regenerates the auto-synced tip blocks inside `statusline.py` from `https://code.claude.com/docs/en/best-practices` and `https://code.claude.com/docs/en/commands`.
- If anything changed, the workflow opens a PR labeled `auto-merge-ok`. When that PR merges to `main`, `Publish to npm` bumps the patch version and runs `npm publish`.

To pull the latest tips:

```bash
npm update -g evolutionary-cli-wrapper
evo install-statusline --yes   # re-deploy the refreshed statusline.py
```

The deployed `~/.claude/base_statusline.py` is a copy of the file from the package, so you must re-run `install-statusline` after `npm update` for the new tips to take effect.

The statusline itself also performs a lightweight update check: on render, if there is no fresh cache at `<EVO_HOME>/.evo/update-check.json` (default: `~/.evo/update-check.json`), it fires a non-blocking HTTP GET to `https://registry.npmjs.org/evolutionary-cli-wrapper/latest` with a 24-hour stale-while-revalidate cache. When the cached `latest` is newer than the running version, an `⚠ update: <current> → <latest> (npm update -g evolutionary-cli-wrapper)` notice is included in the render. Set `EVO_NO_UPDATE_CHECK=1` to disable.

### Uninstall

```bash
evo install-statusline --uninstall
npm uninstall -g evolutionary-cli-wrapper
```

`--uninstall` removes `~/.claude/base_statusline.py` and restores the most recent backup of `~/.claude/settings.json` (or strips the evopet `statusLine` key in place if no backup is present). It does not delete `~/.claude/.evo-self.json` or `~/.evo/update-check.json`; remove those manually if desired.

### Configuration / env vars

Environment variables that affect the npm-installed statusline:

| Variable | Default | Effect |
|---|---|---|
| `EVO_NO_UPDATE_CHECK` | unset | When `1`, suppresses both the registry fetch and the update notice. |
| `EVO_HOME` | `~` | Override for where the update-check cache lives (`<EVO_HOME>/.evo/update-check.json`). |

The remaining environment variables documented in the [For developers](#for-developers) section (`EVO_LOG_LEVEL`, `EVO_LOG_DIR`, `EVO_LOG_DISABLE`, `EVO_CONFIG`, `EVO_PROXY_ACTIVE`) only have effect when running the `evo` Node CLI itself, which the npm-shipped statusline does not invoke.

### Network behavior (no telemetry)

- No Claude API calls. The statusline does not consume Claude tokens.
- No telemetry. Nothing is uploaded.
- One non-blocking HEAD-style fetch to `https://registry.npmjs.org/evolutionary-cli-wrapper/latest` per 24 hours, behind a stale-while-revalidate cache, used only to render the optional update notice. Disable with `EVO_NO_UPDATE_CHECK=1`.

### What gets stored locally

The npm package only ships `dist/`, `bin/`, `statusline.py`, `README.md`, and `LICENSE` (see `files` in `package.json`). When you run `evo install-statusline` plus normal Claude Code sessions, the following files appear under your home directory:

- `~/.claude/base_statusline.py` — the deployed statusline script (a copy of the package's `statusline.py`).
- `~/.claude/settings.json` — modified in place to add the `statusLine` entry. A `.bak.<timestamp>` sibling is written before each overwrite.
- `~/.claude/.evo-self.json` — small JSON file the statusline uses to track call counts and last-seen session id when running standalone (no proxy).
- `~/.evo/update-check.json` — registry update cache (24h TTL). Path overridable via `EVO_HOME`.

No files are written under your project directories by the npm-installed flow. SQLite databases, `.evo/` per-project state, and shell shims described in `CLAUDE.md` only appear if you run the developer-mode `npm run setup` from a clone of this repo (see below).

### For developers

#### Clone, build, test

```bash
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run build       # tsc → dist/
npm test            # vitest run tests
```

`npm run setup` (defined in `package.json`) runs `node scripts/setup.mjs`, which performs `npm run build`, `evo init`, `evo setup-shell` (which writes PowerShell / cmd / bash profile hooks under the repo's `bin/` to make `claude` go through the Evo proxy), and copies `statusline.py` to `~/.claude/base_statusline.py`. This script is **not** shipped to npm; it only runs from a clone.

The proxy pipeline that records episodes, scores prompts, and writes per-project `.evo/` SQLite data is exercised through `claude` (intercepted by the shim) once `setup-shell` has run. Run `evo undo-shell` or `evo uninstall` to revert.

#### Repo layout

- `src/index.ts` — `evo` CLI entrypoint (commander).
- `src/cli/installStatusline.ts` — `evo install-statusline` (the npm-consumer path).
- `src/cli/statusline.ts` + `src/cli/statusline-data*.ts` — `evo statusline` Node renderer (parallel implementation of the Python `statusline.py`, used in tests).
- `src/proxyRuntime.ts` + `src/proxy/` — proxy session driver and live-state writer (`~/.claude/.evo-live.json`).
- `src/runtime.ts`, `src/scoring.ts`, `src/signalDetector.ts` — episode lifecycle, surrogate cost scoring, signal detection.
- `src/db.ts` — better-sqlite3 persistence (`<cwd>/.evo/evolutionary.db`).
- `src/ast.ts` — tree-sitter function-level diffs (TypeScript / JavaScript / Python).
- `src/shellIntegration.ts` — shim and profile management for PowerShell, cmd, and bash.
- `src/logger.ts` — file logger writing to `<EVO_LOG_DIR or cwd>/.evo/logs/session-<UTC-date>.log`, 30-day retention.
- `src/updateCheck.ts` — npm-registry update check with 24h cache.
- `src/issueIntake.ts` — GitHub issue reader for agent intake (used by `evo issue show`).
- `src/capture/frictionCore.ts` + `src/capture/codexCapture.ts` + `src/capture/genericCapture.ts` — friction event aggregation, score, and stop-and-reframe decision; CLI-specific adapters for Codex and Claude/generic.
- `src/mascot.ts` — EvoPet state and rendering.
- `statusline.py` — the Python statusline shipped to npm consumers and deployed by `evo install-statusline`.
- `scripts/setup.mjs` — developer convenience script (build + init + setup-shell + statusline copy).
- `scripts/sync-claude-docs.mjs` — used by the weekly GitHub Actions cron to refresh AUTO-GENERATED tip blocks in `statusline.py`.
- `install/evopet-install.sh` + `install/evopet-uninstall.sh` — bash-only alternative to `evo install-statusline` for users running from a clone (not in the npm package).
- `tests/` — vitest suite plus a Python statusline render test.

#### Shared-risk areas (coordinate before parallel edits)

- `src/proxyRuntime.ts`
- `src/index.ts`
- `src/scoring.ts`
- `src/db.ts`
- `scripts/setup.mjs`

#### Environment variables (developer mode)

| Variable | Default | Effect |
|---|---|---|
| `EVO_HOME` | repo root or `~` | Resolves the global `.evo` directory used by mascot state and the update-check cache. |
| `EVO_CONFIG` | `<cwd>/.evo/config.json` | Set by the shell shims so the `evo` CLI knows which config to read. |
| `EVO_LOG_LEVEL` | `INFO` | One of `ERROR` / `WARN` / `INFO` / `DEBUG`. `DEBUG` also mirrors lines to stderr. |
| `EVO_LOG_DIR` | `<cwd>` | Base directory; logs are written under `<EVO_LOG_DIR>/.evo/logs/session-YYYYMMDD.log`. |
| `EVO_LOG_DISABLE` | `0` | When `1`, all log emission is a no-op. |
| `EVO_NO_UPDATE_CHECK` | unset | When `1`, suppresses the npm-registry update check. |
| `EVO_PROXY_ACTIVE` | unset | Set to `1` by the proxy when invoking the underlying `claude` binary, used to detect re-entry. |
| `EVOPET_ENABLED` | `1` | Read by `install/evopet-install.sh`'s shim only. Set to `0` to skip PATH wiring. |
| `DISABLE_OPTIONAL_PROJECTS` | `0` | Read by the same shim only. Master kill-switch for `optional-projects.sh`. |

#### Auto-sync pipeline

The weekly `Sync Claude Code Docs` workflow (`.github/workflows/sync-claude-docs.yml`, cron `0 3 * * 1`) does the following:

1. Runs `node scripts/sync-claude-docs.mjs`, which fetches the public Claude Code best-practices and commands pages, extracts bullet points, and rewrites the `# AUTO-GENERATED:START ... # AUTO-GENERATED:END` blocks in `statusline.py`.
2. If `statusline.py` changed, opens a PR labeled `auto-merge-ok`. The label is created on the workflow's first run.
3. An external auto-merge handler (the upstream uses `~/.claude/scripts/pr-handler.sh`) squash-merges PRs carrying that label after CI passes.
4. On merge to `main`, `.github/workflows/publish-on-merge.yml` triggers, runs `npm version patch` (creating a tag and a `chore: release vX.Y.Z [skip ci]` commit), pushes, and runs `npm publish --access public`.

#### Maintainer setup (one-time, on a fork)

1. Generate an npm Automation token at `https://www.npmjs.com/settings/<user>/tokens`.
2. Add it as a repository secret named `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Optionally pair with an auto-merge handler that squash-merges `auto-merge-ok` PRs after CI passes; otherwise merge them manually.

#### Versioning

Semantic Versioning. Tags are `vX.Y.Z`. The `package.json` version and the Git tag are kept in sync. Patch bumps are produced by the publish workflow on every doc-sync merge. Manual bumps follow these rules:

- Breaking changes: bump major (e.g. `v2.0.0` → `v3.0.0`), prepare on `main`, cut a `release/vX` branch, tag.
- Normal feature additions: bump minor on `main` (e.g. `v2.1.0`).
- Bug fix only: bump patch on the relevant `release/vX` line (e.g. `v2.1.1`).

Each manual release: update `package.json` version, update `CHANGELOG.md`, run `npm run release:check` (build + test), commit, optionally update `release/vX`, create and push the `vX.Y.Z` tag. Release-line state and full process: see [docs/VERSIONING.md](./docs/VERSIONING.md) and [CHANGELOG.md](./CHANGELOG.md).

#### Branching and parallel work

- Daily development on `main`. Major stable lines on `release/vX`.
- Working branches: `codex/<issue-or-topic>` (1 issue = 1 branch = 1 PR).
- Don't widen scope mid-branch; hold docs and implementation in the same PR.
- Before touching shared-risk areas, leave a note in the issue or in [docs/ROADMAP.md](./docs/ROADMAP.md). UTF-8 for all docs.

For full contributor guidelines (commit style, recommended labels, PR checklist), see [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md). For agent-specific workflow, decision logs, project map, review playbook, and Windows/Zellij troubleshooting knowledge, see [docs/ai/](./docs/ai/).

### License

ISC. See [LICENSE](./LICENSE).

---

## 日本語

EvoPet は、[Claude Code](https://claude.com/claude-code) のステータスラインに常駐するローカルのコンパニオンです。プロンプトエンジニアリングのヒント、セッションのムードコメント、コンテキスト/レート制限の 1 行ゲージを直接ステータスラインに表示します。ヒントは厳選リストと、Anthropic の Claude Code 公式ドキュメントから自動同期されたサブセットから供給されます。完全にローカルで動作し、Claude API トークンを消費せず、テレメトリも送信せず、セッション内容もアップロードしません。

#### v3.1 ハイライト

- **育成段階が ISG ベース化**: 累積 EXP ではなく Ideal State Gauge（直近の指示品質）で段階が決まります。バンド: egg <25 / sprout 25-45 / buddy 45-65 / wizard 65-82 / legend 82+。既存ユーザーは指示品質が安定するまで段階が下がる可能性があります。
- **マスコットが PC グローバル**: `EVO_HOME` の既定が `<cwd>` から `~/.claude` に変更。初回起動時に既存の `<cwd>/.evo/mascot.json` を `~/.claude/.evo/` に自動コピーします（センチネルファイルで再実行を防止）。
- **ヒントがカテゴリ対応**: プロキシが検出したシグナル（例: `prompt_too_vague`）に対応するカテゴリのヒント（`specificity` / `verification` / `permissions` / `context` / `recovery` / `exploration`）に絞り込まれます。
- **ムードコメントがプロキシ稼働時にも表示**: アドバイス行がない場合、5 バンドのムードコメント（start / early / working / busy / critical）がプロキシ稼働パスにも表示されるようになりました。

このリポジトリの使い方は 2 通りあります。

- **npm からインストールするユーザー** — グローバルにパッケージをインストールし、Claude Code のステータスラインだけを差し替える。多くの利用者向けの推奨パスです。
- **開発者として** — リポジトリを clone してコードベースを触る、テストスイートを動かす、または npm に同梱されない shell-integration / proxy を使う。

### クイックインストール

#### npm 経由（一番カンタン）

```bash
npm install -g evolutionary-cli-wrapper
evo install-statusline
```

`evo install-statusline` はデフォルト対話モードで動き、以下の 2 アクションのみ実行します:

1. `<package>/statusline.py` を `~/.claude/base_statusline.py` にコピー
2. `~/.claude/settings.json` の `statusLine` を次の形に設定:
   ```json
   { "type": "command", "command": "python \"<HOME>/.claude/base_statusline.py\"" }
   ```
   `settings.json` の他のキーは保持されます。既存ファイルがあれば上書き前に `~/.claude/settings.json.bak.<ISO-timestamp>` にバックアップを作成。既存の `statusLine.command` が evopet 以外を指している場合は確認プロンプトが出ます。

オプション:

- `--yes` — 全プロンプトをスキップ（CI や自動プロビジョニング用）
- `--uninstall` — `~/.claude/base_statusline.py` を削除し、直近の `settings.json.bak.*` から復元

インストール後は Claude Code セッションを再起動してください。

#### clone してフルセットアップする場合（開発者向け）

```powershell
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run setup
```

PowerShell を開き直すと、`codex` と `claude` が自動で Evo 経由になります。

```powershell
codex
claude
```

設定と履歴は CLI を起動したフォルダの `.evo` に保存されます:

```text
<対象フォルダ>\.evo\config.json
<対象フォルダ>\.evo\evolutionary.db
```

別 PC への移行は同じ手順を繰り返すだけです。

### できること

ステータスラインに次の 3 つが表示されます:

1. モデル名、cwd、`ctx` / `5h` / `7d` の使用量ゲージ（カラードット + パーセント表示）
2. EvoPet のムード行（セッション開始時のブースト or cwd/ターン認識のコメント）
3. プロンプトエンジニアリングの短いヒント（オプションで `❌ before / ✅ after` の例ペア付き）

### 仕組み

Python ステータスラインスクリプトは Claude Code が描画ごとに呼び出します（ポーリングなし、バックグラウンドプロセスなし）。Claude Code が stdin で渡す JSON と、開発者が proxy 経由で動かしている時に書き込まれるオプションの `~/.claude/.evo-live.json` を読みます。`~/.claude/.evo-live.json` がない時はステータスライン側で `~/.claude/.evo-self.json` に呼び出し回数を記録し、手書きヒントと公式ドキュメントから自動同期される全件ヒントを Tier 1 (主要) / Tier 2 (標準) / Tier 3 (ニッチ) を 5:2:1 で重み付けしたラウンドロビンでローテーションします。

EvoPet の「X回目」カウンタは、現在の Claude Code セッション（セッション ID で識別）内のユーザー入力メッセージのみをカウントします。サブエージェントへの委譲はサブエージェント側の JSONL に独立して記録されるため、親セッションのカウントは増えません。ディレクトリ切り替えや新規セッション開始でカウンタはリセットされます。

### 一時的に切る・再開する

```powershell
evo shell off
evo shell on
```

### アップデート

このパッケージの patch バージョンは自動的に進みます:

- 毎週月曜 03:00 UTC に upstream の `Sync Claude Code Docs` workflow が、`https://code.claude.com/docs/en/best-practices` と `https://code.claude.com/docs/en/commands` から自動同期ヒントブロックを `statusline.py` に再生成します。
- 変更があれば `auto-merge-ok` ラベル付きの PR が作成され、`main` にマージされると `Publish to npm` が patch 版をリリースします。

最新ヒントを取り込む手順:

```bash
npm update -g evolutionary-cli-wrapper
evo install-statusline --yes   # 更新後の statusline.py を再デプロイ
```

`~/.claude/base_statusline.py` はパッケージからのコピーなので、`npm update` 後に `install-statusline` を再実行する必要があります。

ステータスライン自体も軽量な更新チェックを行います: 描画時に `<EVO_HOME>/.evo/update-check.json`（既定: `~/.evo/update-check.json`）が新鮮でなければ、`https://registry.npmjs.org/evolutionary-cli-wrapper/latest` に非ブロッキングで HTTP GET（24 時間 stale-while-revalidate キャッシュ）を投げ、新しいバージョンを検出した場合のみ `⚠ update: <current> → <latest>` を表示します。`EVO_NO_UPDATE_CHECK=1` で無効化できます。

### アンインストール

```bash
evo install-statusline --uninstall
npm uninstall -g evolutionary-cli-wrapper
```

`--uninstall` は `~/.claude/base_statusline.py` を削除し、`~/.claude/settings.json` を直近のバックアップから復元します（バックアップがない場合は evopet の `statusLine` キーだけを削除）。`~/.claude/.evo-self.json` と `~/.evo/update-check.json` は削除されないので、必要なら手動で削除してください。

### 設定・環境変数

npm 版ステータスラインに影響する環境変数:

| 変数 | 既定 | 効果 |
|---|---|---|
| `EVO_NO_UPDATE_CHECK` | 未設定 | `1` でレジストリ fetch と更新通知を抑制 |
| `EVO_HOME` | `~` | update-check キャッシュの保存先（`<EVO_HOME>/.evo/update-check.json`）を上書き |

その他の環境変数（`EVO_LOG_LEVEL`、`EVO_LOG_DIR`、`EVO_LOG_DISABLE`、`EVO_CONFIG`、`EVO_PROXY_ACTIVE`）は `evo` Node CLI を直接動かす時のみ効きます（[英語版 For developers](#for-developers) を参照）。

### 通信動作

- Claude API は呼びません。トークンを消費しません。
- テレメトリ送信は一切ありません。
- `https://registry.npmjs.org/evolutionary-cli-wrapper/latest` への 24 時間に 1 回の非ブロッキング fetch（更新通知用）のみ。`EVO_NO_UPDATE_CHECK=1` で無効化できます。

### ローカルに保存されるもの

npm パッケージが配布するのは `dist/`、`bin/`、`statusline.py`、`README.md`、`LICENSE` のみ（`package.json` の `files` 参照）。`evo install-statusline` と通常の Claude Code セッションで生成されるのは:

- `~/.claude/base_statusline.py` — デプロイされたステータスラインスクリプト
- `~/.claude/settings.json` — `statusLine` エントリ追加。上書き前に `.bak.<timestamp>` を作成
- `~/.claude/.evo-self.json` — proxy なし時の呼び出し回数・最終 session id
- `~/.evo/update-check.json` — レジストリ更新キャッシュ（24h TTL、`EVO_HOME` で変更可）

npm 経由の利用ではプロジェクトディレクトリ配下に何も書きません。SQLite DB、プロジェクトごとの `.evo/` 状態、shell shim は `npm run setup`（clone した repo から）を実行した場合にのみ作られます。

### 開発者向け

英語版の [For developers](#for-developers) を参照してください。リポジトリ構造、共有リスク領域、環境変数（開発者モード）、自動同期パイプライン、メンテナ初期設定、バージョニング方針、ブランチ運用が書かれています。

並列開発・コミット規約・ラベル運用・PR チェックリスト・AI エージェント向け作業手順・判断ログ・プロジェクトマップ・レビュー観点・Windows/Zellij トラブルシューティングは [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) と [docs/ai/](./docs/ai/) にまとまっています。

### ライセンス

ISC。[LICENSE](./LICENSE) を参照。
