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
4. At least one RC (`v<version>-rc.N`) has been validated in production by a real user

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
