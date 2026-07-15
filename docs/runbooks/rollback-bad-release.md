# Rollback: bad release published

Use this runbook if a published version is broken in a way that materially harms users (data loss, security regression, broken install, broken `evo doctor`).

---

## 1. Deprecate the bad version on npm

```bash
npm deprecate evolutionary-cli-wrapper@<bad-version> "Reason: <one-line>; use <good-version>"
```

This adds a warning visible on `npm install` without removing the package. Existing installs are not affected — this is intentional. Users on the bad version will see the warning on their next `npm install`.

Verify:

```bash
npm view evolutionary-cli-wrapper@<bad-version> deprecated
```

---

## 2. Cut a fix patch (or minor)

Open a PR with the fix on a `fix/` or `hotfix/` branch. Land it. Then:

**For a patch fix:**

1. Bump `package.json` version to the next patch (e.g. `3.5.0` → `3.5.1`)
2. Add a CHANGELOG entry under `## Unreleased` describing the fix
3. Rename `## Unreleased` to `## v3.5.1 (YYYY-MM-DD)`
4. Add a fresh `## Unreleased` above it
5. Push a `v3.5.1-rc.1` tag; let the `Release` workflow (RC path) validate
6. When confident, run the `Release` workflow (`workflow_dispatch`) with version `3.5.1`

---

## 3. Communicate

- Open a GitHub Issue titled `v<bad-version> is deprecated — use v<good-version>` and pin it
- Add a brief note to the README `## Known issues` section if the breakage is likely to confuse new users installing the bad version from cache
- Post in any relevant Slack / Discord channels

---

## 4. Update the GitHub Release for the bad version

Edit the release notes to prepend a deprecation banner so users searching GitHub see the rationale.

Set the shell variables for the bad and good versions, then run the commands:

```bash
# Substitute with the actual versions
BAD=v3.5.7
GOOD=v3.5.8

EXISTING_BODY=$(gh release view "$BAD" --json body --jq .body)
NEW_BODY="$(printf '> **DEPRECATED**: see %s for the fix.\n\n%s' "$GOOD" "$EXISTING_BODY")"
gh release edit "$BAD" --notes "$NEW_BODY"
```

---

## What NOT to do

**Do NOT `npm unpublish`** — npm allows unpublish only within 72 hours of initial publish, and only when no other packages depend on the version. Even when technically possible, unpublishing breaks installs for anyone whose lockfile pins the version. Use `npm deprecate` instead.

**Do NOT delete the GitHub Release** — leave the deprecation banner in place. Deleting it removes the audit trail and confuses users who pinned the old tag.

**Do NOT force-push `main`** — by the time you are executing this runbook the bad commit has already been tagged and propagated. Force-pushing `main` will not unpublish the npm artifact and will create inconsistency between the tag and the branch history.

**Do NOT skip the RC for the fix** — even a one-line fix should go through at least one RC to exercise the smoke gate. The whole point of the new workflow is that every stable release has been smoke-tested.

---

## Escalation

If the bad version is a **security regression** (e.g. command injection, credential leak):

1. Immediately run Step 1 (deprecate)
2. Open a GitHub Security Advisory (repo → Security → Advisories → New)
3. Follow `docs/RELEASE_PROCESS.md` for the fix release, but abbreviate the RC cycle if needed — smoke gate must still pass
