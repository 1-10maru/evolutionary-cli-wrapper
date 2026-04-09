# Evolutionary CLI Wrapper

Token-independent scoring and guidance for CLI-based LLM workflows.

## Clone and Setup

```powershell
git clone https://github.com/1-10maru/evolutionary-cli-wrapper.git
cd evolutionary-cli-wrapper
npm install
npm run setup
```

After setup, open a new PowerShell session and use `codex` or `claude` as usual.

If you want the shortest Japanese guide, read [START_HERE_JA.md](./START_HERE_JA.md).

## What This Does

- Tracks `codex` and `claude` sessions locally
- Scores collaboration efficiency without relying on token APIs
- Stores prompt features instead of full raw prompt text by default
- Detects edit loops and search loops
- Gives predictive nudges and praise based on local history

## What Gets Stored

- Prompt features only, not the full raw prompt body
- Episode summaries and learned stats buckets
- Adapter-detected events
- Changed-file snapshots only
- Symbol-level diffs for TS/JS/Python
- Optional token usage lines if the wrapped CLI prints them

The database lives in `.evo/evolutionary.db`.

## Storage Model

Two layers are kept separate:

- Raw layer: recent episodes with events, changed-file snapshots, symbol diffs
- Knowledge layer: `stats_buckets` plus `archived_episodes`

This lets old raw episodes be compacted while learned local rules remain available for scoring and nudges.

## Useful Commands

```powershell
evo shell status --cwd <project>
evo shell on --cwd <project>
evo shell off --cwd <project>
evo mode auto --cwd <project>
evo storage --cwd <project>
evo compact --cwd <project>
evo export-knowledge --cwd <project> --output evo-knowledge.json
evo import-knowledge --cwd <project> --input evo-knowledge.json
evo stats --cwd <project>
evo explain <episodeId> --cwd <project>
```

## Retention Defaults

The default `.evo/config.json` keeps:

- `keepRecentRawEpisodes = 200`
- `maxDatabaseBytes = 67108864`
- `compactOnRun = true`
- `vacuumOnCompact = true`

When compaction runs, old raw episodes are archived into `archived_episodes` and then removed from the raw tables. Learned buckets stay intact.

## Easy Migration

The simplest transfer path is file-based:

1. Copy the project folder
2. Copy the `.evo` folder with it
3. On the new machine run `npm install`
4. Run `npm run setup`

Because the local knowledge is stored in SQLite plus JSON config, no extra export step is required for a normal handoff.

If you only want the knowledge state, copy just:

- `.evo/evolutionary.db`
- `.evo/config.json`

For a lighter-weight handoff, export only the learned bucket knowledge:

```powershell
evo export-knowledge --cwd <project> --output evo-knowledge.json
evo import-knowledge --cwd <project> --input evo-knowledge.json
```

## Notes

- TS/JS/Python get symbol-level tracking; other languages fall back to file-level diffs.
- Current adapter event extraction is heuristic and intentionally best-effort.
- Auto-proxy is currently implemented for Windows PowerShell and `codex` / `claude`.
- Predictive nudges include confidence and use recency, uncertainty, exploration entropy, and novelty ratio in addition to bucket means.
