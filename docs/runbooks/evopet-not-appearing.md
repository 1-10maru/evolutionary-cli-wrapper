# Runbook: EvoPet not appearing in the statusline

> **Requires evopet ≥ v3.5.0** (the version that introduces `evo doctor` and `evo logs --bundle`). If you are on an earlier version, run `npm install -g evolutionary-cli-wrapper@latest` first.

If EvoPet is not showing in your Claude Code statusline after install, work through these steps in order.

## Step 0 — Re-run install if you haven't yet

```bash
npm install -g evolutionary-cli-wrapper@latest
evo install-statusline
```

Restart Claude Code (close ALL windows) and check again. About half of "not appearing" reports are resolved here.

## Step 1 — `evo doctor`

```bash
evo doctor
```

Look for these red flags:

- `versions.evo` empty → not installed globally; rerun Step 0
- `files.statusline` MISSING → `statusline.py` not packaged; reinstall
- `files.~/.claude/projects/` MISSING → Claude Code itself has not run yet; open a project in Claude Code first
- `liveState.age` very high (> 5 min) → proxy not writing state; see Step 3

If `evo doctor` exits non-zero, attach the output of `evo doctor --json` to a bug report.

## Step 2 — Verify Claude Code statusline configuration

Open `~/.claude/settings.json` and confirm the `statusLine.command` entry points to the evopet `statusline.py` or `evo-statusline` (depending on version).

If it points somewhere else (or is missing), re-run `evo install-statusline`. This will back up your existing `~/.claude/settings.json` to a `.bak.<timestamp>` file before writing the new `statusLine` configuration. To revert later, use `evo install-statusline --uninstall`, which restores the most recent backup.

## Step 3 — Verify the proxy is intercepting `claude`

```bash
which claude       # macOS / Linux
where.exe claude   # Windows
```

The first hit should be the evo shim:

- `<cwd>/bin/claude` (per-project, Unix) or
- `%APPDATA%\npm\claude.cmd` (Windows)

If the first hit is the original Claude binary, the PATH order is wrong. Re-run:

```bash
evo install-statusline   # also fixes PATH shims as a side effect
```

…and open a NEW shell to pick up the updated PATH.

## Step 4 — Check `live-state.json` freshness

```bash
cat <cwd>/.evo/live-state.json | node -e "let d=''; process.stdin.on('data', c=>d+=c); process.stdin.on('end', ()=>{ const j=JSON.parse(d); console.log('age (sec):', (Date.now()-new Date(j.updatedAt))/1000); })"
```

If age > 5 minutes and you've just sent a Claude prompt:

- The proxy may have stopped tracking. Check the log file for `proxy.livestate` warnings or any `ERROR` lines. The log file is at `$EVO_LOG_DIR/session-<today>.log` if `EVO_LOG_DIR` is set, otherwise at `<EVO_HOME>/.evo/logs/session-<today>.log`.
- Restart Claude Code.

(The freshness window matches `statusline.py`'s `_FRESH_WINDOW_MS` constant of 300,000 ms.)

## Step 5 — Manual cleanup if needed

If you've switched projects often or have leftover session files, you can manually remove them:

```bash
# Remove session files older than 24 hours (Unix)
find <cwd>/.evo/sessions -name '*.json' -mtime +1 -delete
```

```powershell
# Or on Windows PowerShell:
Get-ChildItem <cwd>/.evo/sessions -Filter *.json | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item
```

(`evo cleanup --stale` is planned for a future release; until then this manual fallback works.)

## Step 6 — Bundle and report

If none of the above works:

```bash
evo logs --bundle --out /tmp/evopet-bundle.zip
```

Open a bug report at https://github.com/1-10maru/evolutionary-cli-wrapper/issues with the bundle attached. The bundle is automatically redacted (no tokens, no usernames in paths).

## Known interactions

- **Multiple Claude Code windows in the same folder**: EvoPet binds each proxy to its own session and stays there, so parallel windows no longer misattribute one session's activity to another's statusline (as of v3.6.9). If you still see a window's EvoPet reflecting the wrong session, set `EVO_BIND_SESSION_ID=1` — the proxy then injects a `--session-id` into the `claude` it launches so the tracker binds to that exact session from the start (requires a `claude` that accepts `--session-id`).
- **Conda / Miniconda** on Windows: cmd.exe AutoRun integration was disabled in earlier versions due to a conda_hook conflict. EvoPet still works via PowerShell / bash profile shims.
- **WSL2**: works (treated as a Linux distro). WSL1 is not supported.
- **Cygwin / MSYS**: not officially supported. EvoPet on these may not render correctly due to terminal capability differences.
