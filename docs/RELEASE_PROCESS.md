# Release Process

evopet uses a two-channel release process: `next` (release-candidate) and `latest` (stable).

> **Prerequisite**: the `evo doctor` command must exist in the published package for the smoke gate to pass. It was added in v3.5.0+ (see PR-1.2). Do not push a release tag (RC or stable) until at least v3.5.0 has been published to npm via the legacy `publish-on-merge.yml` flow, OR PR-1.2 has been merged and this RC workflow has produced its first release. Pushing a tag before then will fail the smoke step with `evo: command not found` or `unknown command 'doctor'`.

## RC (`next` channel)

Push a tag matching `v<MAJOR>.<MINOR>.<PATCH>-rc.<N>`:

```bash
git tag v3.6.0-rc.1
git push origin v3.6.0-rc.1
```

This triggers `.github/workflows/release-rc.yml`:

1. **Build + test** on Ubuntu 22.04 / Windows 2022 / macOS 14, Node 22
2. **Smoke**: install the packed tarball globally, run `evo --version` and `evo doctor --json`, parse the JSON output and verify it contains a `versions` key
3. `npm publish --tag next --provenance --access public`
4. Create GitHub Release with `--prerelease`

Users install the RC with:

```bash
npm install -g evolutionary-cli-wrapper@next
```

### CHANGELOG for RC

RC tags do not require a dedicated CHANGELOG section. The workflow falls back to the `## Unreleased` section if no `## vX.Y.Z-rc.N` heading is found.

---

## Stable (`latest` channel)

Run the **Release Stable** workflow manually via `workflow_dispatch`:

1. Go to **Actions** tab → **Release Stable** → **Run workflow**
2. Enter the version string (without `v` prefix, e.g. `3.6.0`)
3. Click **Run workflow**

### Prerequisites

Before running the workflow:

1. `package.json` `version` field matches the version you are about to release
2. `CHANGELOG.md` has a `## v<version>` section with meaningful notes
3. Tag `v<version>` does **not** yet exist in the repository
4. At least one RC (`v<version>-rc.N`) has been validated in production by a real user

### What the workflow does

1. **Preflight**: validates that the tag does not exist and that `package.json` version matches the input — fails fast if either check fails
2. **Build + test** on Ubuntu 22.04 / Windows 2022 / macOS 14, Node 22
3. **Smoke**: install the packed tarball globally and verify `evo doctor --json` exits 0 with parseable JSON
4. **Tag**: creates and pushes `v<version>` tag via `github-actions[bot]`
5. **Publish**: `npm publish --tag latest --provenance --access public`
6. **GitHub Release**: creates the release with notes extracted from `CHANGELOG.md`

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

The workflows extract release notes with:

```bash
awk -v ver="## v$VERSION" '
  $0 == ver { flag=1; next }   # exact match on heading line
  flag && /^## v/ { exit }     # stop at next version heading
  flag { print }
' CHANGELOG.md
```

If the exact heading is not found, the RC workflow falls back to the `## Unreleased` block.

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
