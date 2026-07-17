# Behavioral QA harness

> **Windows-only.** The suites use Windows-specific process tooling
> (`taskkill`, PowerShell `Win32_Process` for orphan detection, and `System32`
> on the sandbox `PATH`). Run the promotion matrix from a Windows box, or port
> the process helpers first. `provision.mjs` (copy + build) is portable, but the
> harnesses that assert signal/teardown behavior are not yet cross-platform.

Copy-based, sandboxed behavioral tests for the `claude` wrapper. These exercise
the **real interactive proxy path** (rendering/streaming, signals, teardown,
`/exit`, nested relaunch, `EVO_PROXY_ACTIVE=1` bypass, multi-window isolation,
statusline strictness, and the startup self-check with its fallback) that the
unit tests (vitest) do not — and that the release runbook's promotion gate
requires (see `docs/RELEASE_PROCESS.md` → *Pre-promotion gate: interactive
behavioral matrix*).

They drive real child processes and are therefore **excluded from vitest/CI**
(`vitest.config.ts` excludes `scripts/qa/**`). Run them manually against the
exact commit you intend to promote.

## Quick start

Everything is parameterized by a `--work <dir>` **sandbox** (never the repo):

```bash
# provision a sandbox from the current HEAD and run every suite:
node scripts/qa/run-all.mjs --work /path/to/sandbox

# or a specific commit:
node scripts/qa/run-all.mjs --work /path/to/sandbox --ref <git-sha>
```

Run one suite at a time (provision once, then re-run any suite):

```bash
node scripts/qa/provision.mjs          --work <sandbox> [--ref <sha>]
node scripts/qa/harness-render.mjs     --work <sandbox> [A|B|D|F|all]
node scripts/qa/harness-concurrency.mjs --work <sandbox>
node scripts/qa/harness-selfcheck.mjs  --work <sandbox>
node scripts/qa/harness-selfcheck-py.mjs --work <sandbox>
node scripts/qa/harness-h7ext.mjs      --work <sandbox>
node scripts/qa/harness-h7run.mjs      --work <sandbox>
node scripts/qa/latency.mjs            --work <sandbox> [--baseline <old/dist/evo.bundle.cjs>]
```

The work dir may also be given via `EVO_QA_WORK`. Each suite exits non-zero on
any `FAIL`; per-check output and `*-results.json` land in `<sandbox>/results/`.

## What `provision.mjs` builds (copy-only)

Under `<sandbox>/`:

- `build/` — a **copy** of the wrapper: source from `git archive <ref>` (committed
  bytes only, never the live working tree), `node_modules` **copied** from the
  real repo, then `npm run build` inside the copy.
- `broken/` — `build` with tree-sitter's native `.node` removed → the self-check's
  `native-load` fails.
- `broken-py/` — `build` with **only** the Python grammar's `.node` removed (its
  dir and the js/ts grammars intact) → proves the all-grammar self-check catches a
  broken Python binding a file-existence check cannot see.

Provisioning ends with a **leak-audit**: it counts the real repo's `node_modules`
top-level entries before and after and fails if they differ (the count is derived
at runtime — **not** a hardcoded number).

## Matrix rows → suites

The `docs/RELEASE_PROCESS.md` interactive matrix maps to these checks:

| Matrix behavior | Suite | Check ids |
|---|---|---|
| Rendering / streaming parity | `harness-render.mjs` | `A1_continuous_stream`, `A2_byte_parity_stdout`, `A2_stderr_forwarded` |
| Large-burst output | `harness-render.mjs` | `A3_large_burst_integrity`, `A4_stdin_attach_no_hang` |
| `Ctrl+C` interrupt / tree-kill | `harness-render.mjs` | `B1_taskkill_tree_T_F` (+ B2/B3 informational) |
| `/exit` (clean exit, no hang) | `harness-render.mjs` | `C_no_exit_hang`, `C_db_usable_after_kill` |
| `/logout` + update passthrough | `harness-render.mjs` | `D1_nested_relaunch_passthrough` |
| `EVO_PROXY_ACTIVE=1` bypass | `harness-render.mjs` | `F1_bypass_version_parity` |
| Multi-window isolation | `harness-concurrency.mjs` | `G1_both_record`, `G2_no_crosstalk` |
| Statusline strictness | `harness-concurrency.mjs` | `E1_...`, `E2_foreign_session_silent` |
| Launch fallback + self-check | `harness-selfcheck.mjs` | `H1`..`H4d` |
| Broken-parser (all-grammar) | `harness-selfcheck-py.mjs` | `H5a`..`H5d` |
| Secret-masking (all persisted sites) | `harness-h7ext.mjs` | `H7ext_*` (turns/episodes/prompt_profiles/episode_events) |
| Secret-masking (`evo run` path) | `harness-h7run.mjs` | `H7run_*` (prompt_submitted event) |
| Startup latency | `latency.mjs` | median/mean first-byte, optional delta |

## Safety rules (enforced by the harness; do not bypass)

- **Copy-only provisioning.** Source via `git archive`; `node_modules` is copied.
  **No junctions/symlinks.** The real repo's `node_modules` is never mutated
  (leak-audit guards it).
- **Never build the real repo's `dist/` for QA.** All builds happen in the
  sandbox copy. (Rebuilding the real `dist/` on a feature branch would swap the
  user's live `claude`; see the live-tree rule in the repo `CLAUDE.md`.)
- **Isolated execution.** Each run gets its own cwd, its own `.evo` config + bin
  shims, and `HOME`/`USERPROFILE`/`EVO_HOME` redirected into the sandbox. Tests
  assert the real `~/.claude/.evo-selfcheck.json` is untouched (leak checks).
- **Mock `claude` only.** The wrapped CLI is `fixtures/mock-claude.mjs`, resolved
  via a sandbox-only `PATH`. No real network, no real auto-update is ever run.
- **No Temp/scratchpad resolution targets baked in.** Nothing here hardcodes a
  session path; the mock shims are relative and the real-home path is derived
  from `os.homedir()`.
