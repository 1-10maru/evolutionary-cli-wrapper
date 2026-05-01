# Evolutionary CLI Wrapper

[![CI](https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml)

EvoPet is a local statusline companion for [Claude Code](https://claude.com/claude-code) that surfaces short prompt-engineering tips, session mood comments, and a one-line context/rate-limit gauge directly inside the Claude Code statusline. Tips are sourced from a curated list plus an auto-synced subset of Anthropic's public Claude Code docs. The tool runs entirely locally — it does not consume Claude API tokens, send telemetry, or upload session content.

There are two distinct ways to use this repository:

- **As an npm consumer** — install the package globally and wire only the statusline into Claude Code. This is the supported path for most users.
- **As a developer** — clone the repo to work on the codebase, run the test suite, or use the in-repo shell-integration / proxy machinery (which is not shipped to npm).

Skip ahead to the section that matches your goal.

---

## For users (install from npm)

### What you get

After installing, your Claude Code statusline shows three things:

1. The model name, the cwd, and (when Claude Code provides them) `ctx`, `5h`, and `7d` usage gauges as colored dots with percentages.
2. An EvoPet mood line that rotates a session-start boost message or a cwd/turn-aware comment.
3. A short prompt-engineering tip with an optional `❌ before / ✅ after` example pair.

The Python statusline script is invoked by Claude Code on each render (no polling, no background process). It reads the JSON Claude Code passes on stdin, plus an optional `~/.claude/.evo-live.json` file that the in-repo proxy writes when a developer is running through it. When `~/.claude/.evo-live.json` is absent, the statusline self-tracks call counts in `~/.claude/.evo-self.json` and rotates through 125 tips (60 of which are auto-synced from the official Claude Code docs; see [Update behavior](#update-behavior) below).

### Install

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

### Update behavior

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

### Configuration

Environment variables that affect the npm-installed statusline:

| Variable | Default | Effect |
|---|---|---|
| `EVO_NO_UPDATE_CHECK` | unset | When `1`, suppresses both the registry fetch and the update notice. |
| `EVO_HOME` | `~` | Override for where the update-check cache lives (`<EVO_HOME>/.evo/update-check.json`). |

The remaining environment variables documented in the Developers section (`EVO_LOG_LEVEL`, `EVO_LOG_DIR`, `EVO_LOG_DISABLE`, `EVO_CONFIG`, `EVO_PROXY_ACTIVE`) only have effect when running the `evo` Node CLI itself, which the npm-shipped statusline does not invoke.

### What gets stored locally

The npm package only ships `dist/`, `bin/`, `statusline.py`, `README.md`, and `LICENSE` (see `files` in `package.json`). When you run `evo install-statusline` plus normal Claude Code sessions, the following files appear under your home directory:

- `~/.claude/base_statusline.py` — the deployed statusline script (a copy of the package's `statusline.py`).
- `~/.claude/settings.json` — modified in place to add the `statusLine` entry. A `.bak.<timestamp>` sibling is written before each overwrite.
- `~/.claude/.evo-self.json` — small JSON file the statusline uses to track call counts and last-seen session id when running standalone (no proxy).
- `~/.evo/update-check.json` — registry update cache (24h TTL). Path overridable via `EVO_HOME`.

No files are written under your project directories by the npm-installed flow. SQLite databases, `.evo/` per-project state, and shell shims described in `CLAUDE.md` only appear if you run the developer-mode `npm run setup` from a clone of this repo (see below).

### Network behavior

- No Claude API calls. The statusline does not consume Claude tokens.
- No telemetry. Nothing is uploaded.
- One non-blocking HEAD-style fetch to `https://registry.npmjs.org/evolutionary-cli-wrapper/latest` per 24 hours, behind a stale-while-revalidate cache, used only to render the optional update notice. Disable with `EVO_NO_UPDATE_CHECK=1`.

### Uninstall

```bash
evo install-statusline --uninstall
npm uninstall -g evolutionary-cli-wrapper
```

`--uninstall` removes `~/.claude/base_statusline.py` and restores the most recent backup of `~/.claude/settings.json` (or strips the evopet `statusLine` key in place if no backup is present). It does not delete `~/.claude/.evo-self.json` or `~/.evo/update-check.json`; remove those manually if desired.

---

## For developers (clone and contribute)

### Clone, build, test

```bash
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run build       # tsc → dist/
npm test            # vitest run tests
```

`npm run setup` (defined in `package.json`) runs `node scripts/setup.mjs`, which performs `npm run build`, `evo init`, `evo setup-shell` (which writes PowerShell / cmd / bash profile hooks under the repo's `bin/` to make `claude` go through the Evo proxy), and copies `statusline.py` to `~/.claude/base_statusline.py`. This script is **not** shipped to npm; it only runs from a clone.

The proxy pipeline that records episodes, scores prompts, and writes per-project `.evo/` SQLite data is exercised through `claude` (intercepted by the shim) once `setup-shell` has run. Run `evo undo-shell` or `evo uninstall` to revert.

### Repo layout

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
- `statusline.py` — the Python statusline shipped to npm consumers and deployed by `evo install-statusline`.
- `scripts/setup.mjs` — developer convenience script (build + init + setup-shell + statusline copy).
- `scripts/sync-claude-docs.mjs` — used by the weekly GitHub Actions cron to refresh AUTO-GENERATED tip blocks in `statusline.py`.
- `install/evopet-install.sh` + `install/evopet-uninstall.sh` — bash-only alternative to `evo install-statusline` for users running from a clone (not in the npm package).
- `tests/` — vitest suite plus a Python statusline render test.

### Environment variables (developer mode)

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

### Auto-sync pipeline

The weekly `Sync Claude Code Docs` workflow (`.github/workflows/sync-claude-docs.yml`, cron `0 3 * * 1`) does the following:

1. Runs `node scripts/sync-claude-docs.mjs`, which fetches the public Claude Code best-practices and commands pages, extracts bullet points, and rewrites the `# AUTO-GENERATED:START ... # AUTO-GENERATED:END` blocks in `statusline.py`.
2. If `statusline.py` changed, opens a PR labeled `auto-merge-ok`. The label is created on the workflow's first run.
3. An external auto-merge handler (the upstream uses `~/.claude/scripts/pr-handler.sh`) squash-merges PRs carrying that label after CI passes.
4. On merge to `main`, `.github/workflows/publish-on-merge.yml` triggers, runs `npm version patch` (creating a tag and a `chore: release vX.Y.Z [skip ci]` commit), pushes, and runs `npm publish --access public`.

### Maintainer setup (one-time, on a fork)

1. Generate an npm Automation token at `https://www.npmjs.com/settings/<user>/tokens`.
2. Add it as a repository secret named `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Optionally pair with an auto-merge handler that squash-merges `auto-merge-ok` PRs after CI passes; otherwise merge them manually.

### Versioning

Semantic Versioning. Tags are `vX.Y.Z`. Patch bumps are produced by the publish workflow on every doc-sync merge. See [VERSIONING.md](./VERSIONING.md) and [CHANGELOG.md](./CHANGELOG.md).

### Other developer docs

- [ROADMAP.md](./ROADMAP.md), [CONTRIBUTING.md](./CONTRIBUTING.md), [docs/AGENT_WORKFLOW.md](./docs/AGENT_WORKFLOW.md), [docs/PROJECT_MAP.md](./docs/PROJECT_MAP.md), [docs/REVIEW_PLAYBOOK.md](./docs/REVIEW_PLAYBOOK.md).

---

## License

ISC. See [LICENSE](./LICENSE).
