<div align="center">
  <a href="https://www.npmjs.com/package/evolutionary-cli-wrapper">
    <img src="https://raw.githubusercontent.com/1-10maru/evolutionary-cli-wrapper/main/assets/evopet-banner.png" alt="EvoPet — a pet that evolves in your terminal" width="100%">
  </a>
</div>

<p align="center">
  <b>English</b> · <a href="./README.ja.md">日本語</a>
</p>

<p align="center">
  A local <a href="https://claude.com/claude-code">Claude Code</a> statusline companion that raises a pixel-art pet while it coaches your prompts — <b>zero tokens, zero telemetry, entirely on your machine.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/evolutionary-cli-wrapper"><img src="https://img.shields.io/npm/v/evolutionary-cli-wrapper?logo=npm&label=npm&color=CB4B16" alt="npm version"></a>
  <a href="https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml"><img src="https://github.com/1-10maru/evolutionary-cli-wrapper/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-5FA04E?logo=node.js&logoColor=white" alt="Node 20 or newer">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/evolutionary-cli-wrapper?color=4C9A2A" alt="License: ISC"></a>
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<!--
  DEMO PLACEHOLDER — a follow-up task records the statusline demo GIF and drops it here, e.g.:
  <div align="center">
    <img src="https://raw.githubusercontent.com/1-10maru/evolutionary-cli-wrapper/main/assets/evopet-demo.gif" alt="EvoPet statusline demo" width="100%">
  </div>
  Do not embed placeholder or mock media in the meantime.
-->

---

**EvoPet** lives in your [Claude Code](https://claude.com/claude-code) statusline. On every render it shows three things: a context / rate-limit gauge, a mood line from a little pixel pet, and a short, actionable prompt-engineering tip — sometimes with a `❌ before / ✅ after` example. Write sharper prompts and the pet levels up; drift into vague requests or fix-loops and it notices and nudges you back.

It runs **entirely locally**. No Claude API calls, no token consumption, no telemetry, and nothing about your sessions is ever uploaded. The statusline that `evo install-statusline` deploys makes no network calls of its own; the only optional network access is a once-a-day npm-registry check for an "update available" notice, performed by the `evo` CLI's own renderer and disabled with `EVO_NO_UPDATE_CHECK=1`.

There are two ways to use this repository:

- **As an npm user** — install the package and wire only the statusline into Claude Code. This is the supported path for most people.
- **As a developer** — clone the repo to hack on the code, run the test suite, or use the in-repo proxy machinery that records and scores whole sessions (not shipped to npm).

## Quick install

> **Prerequisites:** [Node.js](https://nodejs.org) 20 or newer (for the `evo` CLI) and Python 3 on your `PATH` (the deployed statusline is a Python script Claude Code invokes on each render).

```bash
npm install -g evolutionary-cli-wrapper
evo install-statusline
```

`evo install-statusline` is interactive by default and does exactly two things:

1. Copies the package's `statusline.py` to `~/.claude/base_statusline.py`.
2. Sets `statusLine` in `~/.claude/settings.json` to
   `{ "type": "command", "command": "python \"<HOME>/.claude/base_statusline.py\"" }`, preserving every other key. Your existing `settings.json` is backed up to `~/.claude/settings.json.bak.<timestamp>` first, and if the current `statusLine` points at a non-EvoPet command you're prompted before it's replaced.

Then **restart your Claude Code session** to pick up the new statusline. Prefer a no-prompt run for CI or provisioning? Add `--yes`.

Don't want to install globally? Run it once with `npx`:

```bash
npx evolutionary-cli-wrapper install-statusline
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| Statusline is blank after install | Restart the Claude Code session. The default display mode has been `expansion` since v3.5.0; if you're on an older deploy, run `evo display expansion` then `evo install-statusline --yes`. |
| `python: command not found` on render | The statusline is a Python script. Install Python 3 and make sure `python` resolves on your `PATH`. |
| Tips didn't change after `npm update -g` | The deployed `~/.claude/base_statusline.py` is a *copy* of the package file — re-run `evo install-statusline --yes` to redeploy the refreshed tips. |
| The `⚠ update:` notice is noisy / you're offline | The notice comes from the `evo` CLI's own renderer (not the deployed statusline). Set `EVO_NO_UPDATE_CHECK=1` to suppress the registry check and the notice. |
| You want your old statusline back | `evo install-statusline --uninstall` removes the script and restores the most recent `settings.json` backup. |

## Getting started

Once the statusline is live, EvoPet works with no further setup — every prompt you type is scored and the pet reacts. A few commands are worth knowing:

```bash
evo stats                 # your current rank, growth gauge, and recent history
evo pet list              # browse the 10 pet species
evo pet choose fox        # pick the one you like
evo display toggle        # switch between the compact and expanded statusline
```

Uninstalling is symmetric:

```bash
evo install-statusline --uninstall   # remove the statusline, restore your backup
npm uninstall -g evolutionary-cli-wrapper
```

## Command reference

Commands most users touch:

| Command | What it does |
|---|---|
| `evo install-statusline` | Deploy `statusline.py` to `~/.claude/` and wire it into `settings.json`. `--yes` skips prompts, `--uninstall` reverts. |
| `evo stats` | Show your EvoPet rank, growth gauge, and episode history. |
| `evo pet list` | List the available EvoPet species. |
| `evo pet choose <id>` | Set your pet species (e.g. `evo pet choose cat`). |
| `evo display [mode]` | Toggle the statusline layout: `minimum`, `expansion`, or `toggle`. No arg prints the current mode. |
| `evo doctor` | Print a one-page health report — versions, environment, file checks, recent errors, and live-state freshness (`--json` for machine-readable output). |
| `evo logs [--tail N] [--since 30m] [--bundle]` | Tail recent Evo log lines, or `--bundle` a redacted zip of the last 7 days of logs + doctor output for a bug report. |

Developer / power-user commands (mostly relevant after `npm run setup` from a clone):

| Command | What it does |
|---|---|
| `evo init` | Create a local `.evo/config.json` with sensible defaults. |
| `evo setup-shell` | Install the terminal integration and proxy shims so `claude` routes through Evo. |
| `evo undo-shell` | Remove the managed shell-integration block. |
| `evo shell on \| off \| status` | Enable, disable, or inspect shell integration for new terminals. |
| `evo pause` / `evo resume` | Temporarily stop / re-enable the auto-proxy for new sessions. |
| `evo mode <auto\|active\|quiet>` | Set the default advice verbosity for proxied sessions. |
| `evo proxy --cli claude -- <args>` | Run `claude` through the Evo proxy for one invocation. |
| `evo run -- <command>` | Run any LLM CLI command with episode tracking and scoring. |
| `evo explain <episodeId>` | Explain how a recorded episode was scored. |
| `evo storage` | Show the local database footprint and retention status. |
| `evo compact` | Archive old raw episodes while keeping learned rollups. |
| `evo export-knowledge --output <path>` | Export learned local stats to a portable JSON bundle. |
| `evo import-knowledge --input <path>` | Merge a knowledge bundle back into local stats. |
| `evo issue show <number> [--repo owner/name]` | Print a GitHub issue summarized for AI-agent intake. |
| `evo forget` | Delete the local `.evo` history for a project folder. |
| `evo uninstall [--purge-data]` | Remove shell integration and, optionally, local Evo data. |
| `evo statusline` | Render the EvoPet portion of the statusline from JSON on stdin (used internally). |

## How it works

The Python statusline script is invoked by Claude Code on every render — no polling, no background process. It reads the JSON Claude Code passes on stdin plus, when a developer is running through the in-repo proxy, an optional `~/.claude/.evo-live.json` live-state file.

- **When the proxy is active**, EvoPet reflects real session signals: a per-session turn counter, detected loops, prompt-quality scores, and the current mood.
- **When it isn't** (the default npm path), the statusline self-tracks call counts in `~/.claude/.evo-self-state.json` and rotates through the whole tip library — a curated set plus every tip auto-synced from Anthropic's public Claude Code docs — using a tier-weighted round-robin (core / default / niche, weighted 5 : 2 : 1).

The turn counter is scoped to the current Claude Code session ID, so sub-agent dispatches and parallel sessions in the same directory don't inflate or clobber each other's numbers. Since v3.4.0, per-session state lives in `<cwd>/.evo/sessions/<sessionId>.json` and files older than 7 days are pruned automatically.

## Documentation

A full map of everything under `docs/` lives in **[docs/README.md](./docs/README.md)**. Highlights:

| Doc | What's inside |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | Release history and per-version behavior changes. |
| [docs/VERSIONING.md](./docs/VERSIONING.md) | Semantic-versioning policy and release-line layout. |
| [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) | Commit style, labels, and the PR checklist. |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Planned work and shared-risk areas. |
| [docs/ai/](./docs/ai/) | Agent workflow, decision logs, project map, review playbook, and Windows/Zellij notes. |

## Configuration

The deployed statusline (`base_statusline.py`) needs no configuration and reads no environment variables of its own. These variables affect the **`evo` CLI** — specifically its built-in `evo statusline` renderer and its update check:

| Variable | Default | Effect |
|---|---|---|
| `EVO_NO_UPDATE_CHECK` | unset | When `1`, disables the `evo` CLI's npm-registry update check and its `⚠ update:` notice. |
| `EVO_HOME` | `~` | Overrides where the update-check cache lives (`<EVO_HOME>/.evo/update-check.json`). |

When the statusline is rendered through the `evo` CLI (`evo statusline`), it performs a lightweight update check: with no fresh cache it fires one non-blocking GET to `registry.npmjs.org` (stale-while-revalidate) and, when a newer version is published, appends an `⚠ update: <current> → <latest>` notice. The Python statusline that `evo install-statusline` deploys does not do this.

<details>
<summary><b>Developer-mode environment variables</b> (only apply when running the <code>evo</code> Node CLI itself)</summary>

| Variable | Default | Effect |
|---|---|---|
| `EVO_CONFIG` | `<cwd>/.evo/config.json` | Which config the `evo` CLI reads (set by the shell shims). |
| `EVO_LOG_LEVEL` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG`. `DEBUG` also mirrors to stderr. |
| `EVO_LOG_DIR` | `<cwd>` | Base dir for logs (`<EVO_LOG_DIR>/.evo/logs/session-YYYYMMDD.log`). |
| `EVO_LOG_DISABLE` | `0` | When `1`, all log emission is a no-op. |
| `EVO_PROXY_ACTIVE` | unset | Set to `1` by the proxy when spawning the real `claude`, used for re-entry detection. |
| `EVO_FORCE_NORMAL` | unset | Force full (non-lightweight) tracking regardless of cwd heuristics. Wins over `EVO_FORCE_LIGHT`. |
| `EVO_FORCE_LIGHT` | unset | Force lightweight tracking regardless of cwd heuristics. |

</details>

## Privacy / Data at rest

Evo scores your collaboration **locally**. Nothing is sent anywhere — the only network call is the optional npm update check (disable with `EVO_NO_UPDATE_CHECK=1`).

**What is stored.** Per turn, a **capped preview of the input** you sent the wrapped CLI (at most 500 characters), a **sha256 hash and length** of the full input (so repeated prompts can be recognized without keeping the text), a short **output preview** (~160 characters), plus derived metrics (detected file paths, token counts, friction/complexity scores).

**Where.** Under `<project>/.evo/` — the SQLite database `.evo/evolutionary.db`, redacted logs in `.evo/logs/`, and per-session counters in `.evo/sessions/`. A small live-status file is also written to `~/.claude/.evo-live.json` for the statusline.

**Retention.** Logs older than 7 days are pruned automatically; the database is compacted on a size/age policy (`evo storage` shows the footprint, `evo compact` archives old raw episodes into rollups).

**How to disable prompt-text capture.** Set `capture.promptText` to `false` in `<project>/.evo/config.json`. Evo then stores **only** the sha256 hash and length of your input — no input text and no previews.

```json
{ "capture": { "promptText": false } }
```

**How to purge.** `evo forget` deletes the local `.evo/` history for the current project; `evo uninstall --purge-data` removes the shell integration and deletes the project's `.evo/` data.

## The Pet

EvoPet is what makes this a *companion* and not just another linter. It has an identity that reacts to how you drive Claude Code.

**Ten species** to choose from — the pet starts as 🐣 `chick`, and you can switch anytime with `evo pet choose <id>`:

🐣 chick · 🐱 cat · 🐶 dog · 🦊 fox · 🐰 rabbit · 🐻 bear · 🐼 panda · 🐨 koala · 🐯 tiger · 🐧 penguin

**Five evolution stages.** Crucially, the stage is driven by the **Ideal State Gauge (ISG)** — a rolling measure of *sustained prompt quality* — not by cumulative experience. Keep writing clear, structured prompts and your pet climbs; let quality slip and it can drop back down. That's the whole point.

| Stage | Rank | ISG band |
|---|---|---|
| 🥚 egg | Beginner | `< 25` |
| 🌱 sprout | Apprentice | `25 – 45` |
| 🐾 buddy | Practitioner | `45 – 65` |
| 🧙 wizard | Skilled | `65 – 82` |
| 👑 legend | Master | `82+` |

**Five moods** that shift with the session: `chill` when idle, `good` on a clean first pass, `fired up` when a nudge could save real tokens, `worried` when it spots an edit- or search-loop, and `proud` when your prompt structure is genuinely dialed in.

**Combos and the growth gauge.** A "good" prompt — structured, first-pass green, no loops — extends a combo streak, with celebrations at 3, 5, 10, and 20 in a row. The growth gauge you see (育成度) *is* the Ideal State Gauge: it only pins near 100% when recent prompt quality is high **and** your last few episodes were loop-free.

Under the hood, a signal detector watches for patterns like `prompt_too_vague`, `same_function_revisit`, `scope_creep`, `no_success_criteria`, and `approval_fatigue`, then turns the top one into a single, concrete suggestion — often with a before/after rewrite of your own request.

## Contributing

Contributions are welcome. In short:

- Daily development happens on `main`; stable lines live on `release/vX`.
- One issue = one branch (`codex/<issue-or-topic>`) = one PR. Keep docs and implementation in the same PR and don't widen scope mid-branch.
- Before touching shared-risk areas (`src/proxyRuntime.ts`, `src/index.ts`, `src/scoring.ts`, `src/db.ts`, `scripts/setup.mjs`), leave a note in the issue or [docs/ROADMAP.md](./docs/ROADMAP.md).
- All docs are UTF-8.

Build and test from a clone:

```bash
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run build      # tsc → dist/
npm test           # vitest
```

`npm run setup` additionally deploys the shell shims and statusline for full developer mode; `evo undo-shell` or `evo uninstall` reverts it. Full guidelines: [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).

## License

[ISC](./LICENSE) © 1-10maru
