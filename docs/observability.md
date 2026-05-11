# Evo Observability Guide

## Log File Location and Rotation

Evo writes structured log files to `.evo/logs/session-YYYYMMDD.log` relative to the project directory (the `cwd` passed to the wrapped command).

Override the log directory:

```
EVO_LOG_DIR=/path/to/logs evo run claude ...
```

Log files are rotated daily (one file per UTC calendar day). Files older than **30 days** are pruned automatically when the logger initializes. Only files matching `session-YYYYMMDD.log` are pruned; any other files in `.evo/logs/` are left untouched.

Disable all logging (no file created):

```
EVO_LOG_DISABLE=1 evo run claude ...
```

Evo also suppresses log creation automatically when it detects the working directory looks like an aggregate parent (many subdirectories, no project markers like `.git` or `package.json`).

---

## Log Levels

| Level | Meaning |
|-------|---------|
| ERROR | A recoverable or non-recoverable failure |
| WARN  | Unexpected condition; operation continues |
| INFO  | Normal lifecycle events (default level) |
| DEBUG | Verbose developer-facing diagnostics |

Set the minimum log level via environment variable:

```
EVO_LOG_LEVEL=DEBUG evo run claude ...
```

Accepted values: `ERROR`, `WARN`, `INFO`, `DEBUG` (case-insensitive). Unknown values fall back to `INFO`.

---

## DEBUG Conventions

### `EVO_DEBUG=1` — global debug shortcut

Sets log level to `DEBUG` for all components, regardless of `EVO_LOG_LEVEL`:

```
EVO_DEBUG=1 evo run claude ...
```

### `DEBUG=evopet:*` — namespace filter

Enables DEBUG for specific namespaces only (follows the npm `debug` package convention). The format is a comma-separated list of `evopet:<namespace>` patterns:

```
DEBUG=evopet:proxy evo run claude ...
DEBUG=evopet:proxy,evopet:render evo run claude ...
DEBUG=evopet:* evo run claude ...   # all evopet namespaces
```

When `DEBUG=evopet:*` (or a specific evopet namespace) is set, Evo raises the log level to DEBUG globally, but **DEBUG lines from non-matching namespaces are silently dropped**. Non-DEBUG levels (ERROR/WARN/INFO) are never filtered by the namespace matcher.

---

## Structured JSON Log Format

Set `EVO_LOG_FORMAT=json` to emit one JSON object per line instead of text:

```
EVO_LOG_FORMAT=json evo run claude ...
```

### JSON line schema

```json
{
  "ts":    "2026-05-12T10:00:00.000Z",   // ISO 8601 UTC timestamp
  "level": "INFO",                        // trimmed level string
  "ns":    "proxy.session",              // component / namespace
  "msg":   "session started",            // message text
  // ...any additional context fields from the log call
}
```

Additional fields from the `ctx` argument to the log call are merged at the top level of the JSON object.

Default format remains text (`YYYY-MM-DDTHH:MM:SS.mmmZ LEVEL [component] message [ctx]`).

---

## `evo doctor` — Health Report

Prints a one-page diagnostic summary. Run it any time Evo behaves unexpectedly.

```
evo doctor
```

### Sections

| Section | What it checks |
|---------|---------------|
| Versions | `evo`, `node`, `npm`, `python`, OS, arch |
| EVO_* Environment | All `EVO_*` env vars; sensitive ones (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`) are masked |
| File Checks | `.evo/` home dir, statusline.py, `~/.claude/projects/`, evo shim on PATH, `.evo/logs/` |
| Error Summary (last 24h) | Count of ERROR and WARN events across all rotated logs |
| Recent WARN+ | Last up to 10 WARN/ERROR lines from today's log |
| Live State | `updatedAt` and age of `.evo/live-state.json`; "no" if no active proxy session |
| ⚠ Critical Issues | Only shown if evo appears uninstalled (shim + statusline + .evo all missing) |

Exit code: **1** if any critical issue is detected; **0** otherwise.

### Machine-readable output

```
evo doctor --json | jq .versions
```

The `--json` flag emits a single pretty-printed JSON object. This is the format Claude sessions use to check project health without parsing prose.

---

## `evo logs --bundle` — Bug Report Bundle

Packages the last 7 days of logs plus diagnostic data into a zip file:

```
evo logs --bundle
evo logs --bundle --out ~/Desktop/evo-report.zip
```

Default output path: `<cwd>/evo-bundle-<timestamp>.zip`

### Bundle contents

| File | Description |
|------|-------------|
| `logs/session-YYYYMMDD.log` | Last 7 days of log files (one per day present) |
| `doctor.json` | JSON output of `evo doctor` at bundle time |
| `config.json` | Redacted copy of `<EVO_HOME>/.evo/config.json` |

### What gets redacted

Before bundling, Evo applies the following masks to all log content:

- **Lines containing `originalCmdAutoRun`** — dropped entirely (Windows registry paths)
- **Inline `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD` values** — replaced with `[REDACTED]`
- **Windows usernames in paths** — `C:\Users\<name>\...` → `C:\Users\<sha1(name)[0:10]>\...`
- **`config.json` sensitive keys** — same `*_TOKEN`/`*_KEY`/`*_SECRET`/`*_PASSWORD` masking; `originalCmdAutoRun` values replaced with `[REDACTED]`

The zip uses DEFLATE compression via Node's built-in `zlib` (no external dependencies).

---

## Quick Reference

```
# Raise level to DEBUG
EVO_DEBUG=1 evo run claude ...

# Verbose only for proxy namespace
DEBUG=evopet:proxy evo run claude ...

# JSON log output
EVO_LOG_FORMAT=json evo run claude ...

# Health check
evo doctor
evo doctor --json | jq .errorSummary

# Bundle logs for a bug report
evo logs --bundle --out ~/evo-report.zip

# Tail recent logs
evo logs
evo logs --tail 100
evo logs --since 2h
```
