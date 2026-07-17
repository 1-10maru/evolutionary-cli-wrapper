# Release Process

evopet uses a two-channel release process: `next` (release-candidate) and `latest` (stable). Both channels are driven by a single workflow, `.github/workflows/release.yml`, which publishes to npm via **OIDC Trusted Publishing** (no long-lived `NPM_TOKEN`).

> **Prerequisite**: the `evo doctor` command must exist in the published package for the smoke gate to pass. It was added in v3.5.0+ (see PR-1.2). Do not push a release tag (RC or stable) until at least v3.5.0 has been published to npm via the legacy `publish-on-merge.yml` flow, OR PR-1.2 has been merged and this workflow has produced its first release. Pushing a tag before then will fail the smoke step with `evo: command not found` or `unknown command 'doctor'`.

## Trusted publishing setup (one-time, on npmjs.com)

npm allows only **one** trusted publisher per package, keyed by workflow filename — which is why RC and stable both live in `release.yml`. On <https://www.npmjs.com> → the `evolutionary-cli-wrapper` package → **Settings → Trusted Publisher**, register a GitHub Actions publisher with:

| Field | Value |
| --- | --- |
| Organization or user | `1-10maru` |
| Repository | `evolutionary-cli-wrapper` |
| Workflow filename | `release.yml` (filename only, not a path) |
| Environment name | *(leave blank — the workflow does not use a GitHub Environment)* |
| Allowed actions | `npm publish` |

Requirements the workflow already satisfies: `permissions: id-token: write` on the publish job, npm CLI ≥ 11.5.1 (the job runs `npm install -g npm@latest`), and no `NODE_AUTH_TOKEN` on the publish step (setting it would force the legacy token path). Once trusted publishing works, delete the repository's `NPM_TOKEN` secret and revoke the token on npmjs.com.

## RC (`next` channel)

Push a tag matching `v<MAJOR>.<MINOR>.<PATCH>-rc.<N>`:

```bash
git tag v3.6.0-rc.1
git push origin v3.6.0-rc.1
```

This triggers `.github/workflows/release.yml` (RC path):

1. **Setup**: resolves the version from the tag and verifies it matches `package.json`
2. **Build + test** on Ubuntu 22.04 / Windows 2022 / macOS 14, Node 22
3. **Smoke**: install the packed tarball globally, run `evo --version` and `evo doctor --json`, parse the JSON output and verify it contains a `versions` key
4. **Publish** via OIDC trusted publishing: `npm publish --tag next --provenance --access public` (no `NODE_AUTH_TOKEN`)
5. Create GitHub Release with `--prerelease`

Users install the RC with:

```bash
npm install -g evolutionary-cli-wrapper@next
```

### CHANGELOG for RC

The workflow **hard-fails** if there is no `## v<version>` heading matching the tag (there is no silent fallback to `## Unreleased`). Add a `## vX.Y.Z-rc.N (YYYY-MM-DD)` section before pushing the tag.

---

## Stable (`latest` channel)

Run the **Release** workflow manually via `workflow_dispatch`:

1. Go to **Actions** tab → **Release** → **Run workflow**
2. Enter the version string (without `v` prefix, e.g. `3.6.0`)
3. Click **Run workflow**

### Prerequisites

Before running the workflow:

1. `package.json` `version` field matches the version you are about to release
2. `CHANGELOG.md` has a `## v<version>` section with meaningful notes
3. Tag `v<version>` does **not** yet exist in the repository
4. At least one RC (`v<version>-rc.N`) has been published to `@next` and validated
5. **The interactive behavioral matrix below has been run on the exact commit being promoted and every row PASSED** (see the next section — this is a hard gate, not a suggestion)

### Pre-promotion gate: interactive behavioral matrix (MANDATORY)

CI build+test and the tarball smoke test are necessary but **not sufficient** to
promote to `latest`. They do not exercise the interactive terminal behaviors that
the wrapper exists to manage, and where past regressions have actually shipped:
the wrapper is a real-time passthrough for an interactive TTY child, and several
failure modes (console rendering corruption, teardown hangs, orphaned child
processes) are invisible to a non-interactive `--version` / `doctor --json` smoke.

> **Origin (2026-07-17):** the `claude` wrapper broke — and later a console-display
> symptom appeared — with **zero automated detection**, because nothing exercised
> the interactive path before promotion. This gate exists so that never happens
> silently again.

**Do not run the stable `workflow_dispatch` until you have run the full matrix
below against the exact commit you are about to promote and recorded a PASS for
every row.** Run it by launching the real `claude` through the freshly built
wrapper (on the promotion commit), not a mock — with `EVO_PROXY_ACTIVE` unset so
the wrapper actually proxies:

- POSIX / Git Bash: `env -u EVO_PROXY_ACTIVE bin/claude …`
- PowerShell: `$env:EVO_PROXY_ACTIVE=$null; .\bin\claude …`
- cmd.exe: `set "EVO_PROXY_ACTIVE=" && bin\claude …`

| # | Behavior | How to check | PASS criteria |
|---|---|---|---|
| 1 | Rendering / streaming parity | Run an interactive `claude` session through the wrapper; type a prompt, watch a streamed reply | Output is byte-for-byte what raw `claude` renders — no doubled/missing lines, no corrupted ANSI, no swallowed characters |
| 2 | Large-burst output | Drive ~2 MB of child stdout through the wrapper and watch resource use while it streams. Interactive: ask `claude` for a long reply (e.g. "print 3000 numbered lines"). Deterministic: temporarily point the resolved command at a bursting stub — set `shellIntegration.originalCommandMap.claude` in `.evo/config.json` to a script running `node -e "process.stdout.write('x'.repeat(2000000)+'\n')"`, then run `node dist/evo.bundle.cjs proxy --cli claude --`. Monitor with `Get-Process node` (PowerShell) / `top` (POSIX). | Delivered intact, no truncation, no CPU peg / stream stall |
| 3 | `Ctrl+C` interrupt | Start an interactive `claude` session through the wrapper, press `Ctrl+C` mid-response (a second time if the child keeps running), exit, then check for leftovers: `Get-Process claude,node -ErrorAction SilentlyContinue` (PowerShell) / `tasklist \| findstr /i "claude node"` (cmd) / `pgrep -fl claude` (POSIX). | The child handles the first interrupt; a forced second signal tears down the whole child tree with **0 orphaned processes** left from the session |
| 4 | `/exit` (clean exit) | Exit `claude` normally | Wrapper propagates the child's exit code and returns promptly — **no hang** on lingering handles |
| 5 | `/logout` (re-invoke) | Trigger a `/logout` (claude re-invokes `claude` by name) | The nested invocation passes straight through (no nested proxy), no freeze |
| 6 | Update passthrough | `claude update` / `claude --update` | Bypasses the proxy entirely; the native updater owns its own children |
| 7 | Statusline strictness | Inspect the statusline during a session | Exactly one session-bound EvoPet block, deterministic, within the hard size cap |
| 8 | Multi-window isolation | Launch concurrent sessions in the same directory | No `SQLITE_BUSY` crashes, no cross-session statusline bleed |
| 9 | `EVO_PROXY_ACTIVE=1` bypass | Run `EVO_PROXY_ACTIVE=1 claude --version` | Byte-exact with raw `claude`; Evo adds nothing |
| 10 | Launch fallback | Simulate a missing native dep / bundle (sandbox copy) | Wrapper prints one clear warning line and runs the real `claude` directly — never a bare `ERR_MODULE_NOT_FOUND` |

Record the matrix result (date, commit SHA, PASS/FAIL per row) in the release PR
or the promotion notes. A single FAIL blocks promotion until fixed and re-run.

### Running the matrix

Most rows are automated by the copy-based behavioral harness in
[`scripts/qa/`](../scripts/qa/README.md). Provision a sandbox from the exact
promotion commit and run every suite in one command:

```bash
node scripts/qa/run-all.mjs --work <sandbox-dir> --ref <promotion-sha>
```

The row → suite/check-id mapping is in [`scripts/qa/README.md`](../scripts/qa/README.md):
rows 1–4 → `harness-render.mjs` (A/B/C); rows 5–6 → `harness-render.mjs` (D);
row 7 → `harness-concurrency.mjs` (E); row 8 → `harness-concurrency.mjs` (G);
row 9 → `harness-render.mjs` (F); row 10 → `harness-selfcheck.mjs` +
`harness-selfcheck-py.mjs` (H). The harness is copy-only and sandboxed (never
touches the real repo `node_modules`, `~/.claude`, or the live `dist/`).

`evo doctor --quick`, run on the promotion commit, is a fast non-interactive first
pass for the load-time preconditions — but it does **not** replace the harness.

### What the workflow does

1. **Setup**: validates that the tag does not exist and that `package.json` version matches the input — fails fast if either check fails
2. **Build + test** on Ubuntu 22.04 / Windows 2022 / macOS 14, Node 22
3. **Smoke**: install the packed tarball globally and verify `evo doctor --json` exits 0 with parseable JSON
4. **Tag**: creates and pushes `v<version>` tag via `github-actions[bot]`
5. **Publish** via OIDC trusted publishing: `npm publish --tag latest --provenance --access public` (no `NODE_AUTH_TOKEN`)
6. **GitHub Release**: creates the release with `--latest` and notes extracted from `CHANGELOG.md`

---

## CHANGELOG conventions

Follow these conventions so the CHANGELOG extraction awk script works correctly.

### Section heading format

```
## Unreleased

## v3.6.0 (YYYY-MM-DD)

## v3.5.0 (YYYY-MM-DD)
```

- Each version heading must start at column 0 with exactly `## v` followed by the version
- The `## Unreleased` section sits above all versioned sections
- When cutting a release, rename `## Unreleased` to `## vX.Y.Z (YYYY-MM-DD)` and add a fresh `## Unreleased` block above it

### Extraction logic

The workflow extracts release notes with (anchored so `v3.4.4` does not match `v3.4.40`, stopping at the next `## v` or `## Unreleased` boundary):

```bash
awk -v ver_anchor="^## v${VER}([[:space:]]|$)" '
  $0 ~ ver_anchor { flag=1; next }
  flag && /^## (v|Unreleased)/ { exit }
  flag { print }
' CHANGELOG.md
```

If no matching section is found the workflow **hard-fails** — there is no fallback to `## Unreleased`, for either channel. Add the `## v<version>` section before releasing.

---

## Rollback

See `docs/runbooks/rollback-bad-release.md`.

---

## Why no `main`-push auto-publish?

The previous workflow (`publish-on-merge.yml`, removed 2026-05-12) auto-published on every merge to `main` that touched source files. This caused:

1. Every merged PR became a release — no gate, no RC channel, no smoke test
2. CHANGELOG extraction pulled wrong sections under common naming patterns
3. No provenance / SLSA signing

The new workflows restore explicit human intent as the release trigger: a pushed tag for RC, a manual `workflow_dispatch` for stable.
