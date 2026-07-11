# RESUME — evopet v3.6.0 release handoff (written 2026-07-12)

## State (all verified)
- All 3 feature/fix PRs merged to main: #63 wrapper-lifecycle fixes (474d1f0), #64 model-aware prompting tips (ffe609f), #62 README/branding (9089f83).
- RC prep PR #66 merged (squash 451fd75): package.json = 3.6.0-rc.1; CHANGELOG has `## v3.6.0-rc.1 (2026-07-11)` section.
- Tag v3.6.0-rc.1 pushed at 451fd75. release-rc.yml run 29148522962: build+smoke green on all OS, npm publish FAILED — repo secret NPM_TOKEN is dead (E404-masked 403 on PUT). NOTHING published: npm latest=3.5.1, no `next` dist-tag, version 3.6.0 NOT burned.
- PR #65 (chore/release-3.6.0: version flip to 3.6.0 + Unreleased promotion) is OPEN and HELD. DO NOT MERGE #65 until the RC is published and user-validated.

## Critical trap (why order matters)
release-rc.yml publishes WHATEVER version package.json holds at the tagged commit (no tag-driven versioning) and hard-fails notes extraction without an exact `## v<tag>` CHANGELOG heading. If #65 (3.6.0) merges before the RC publish, a rc tag would publish "3.6.0" to npm and permanently block the stable release (npm cannot republish a version).

## Next steps, in order
1. Fix npm auth (THIS PC has the npm login for the sole maintainer account `1-10maru`):
   a. PREFERRED: create an npm Automation token (or Granular with publish to evolutionary-cli-wrapper) at npmjs.com → update repo secret NPM_TOKEN at github.com/1-10maru/evolutionary-cli-wrapper/settings/secrets/actions → then `gh run rerun 29148522962 --failed` (reruns only publish + github-release; tag stays put).
   b. Fallback (loses provenance + skips the GitHub prerelease job): checkout tag v3.6.0-rc.1, npm ci && npm run build && npm publish --tag next.
2. Verify RC: `npm view evolutionary-cli-wrapper dist-tags` → next=3.6.0-rc.1, latest=3.5.1. If via workflow: `gh release view v3.6.0-rc.1` (prerelease with notes).
3. USER validates the RC on a real terminal: `npm i -g evolutionary-cli-wrapper@next`, then run the wrapped claude interactively and `/exit` — must return to the shell WITHOUT Ctrl+C. Also check print mode (`-p`) returns promptly and propagates non-zero exit codes.
4. Only after user OK: update #65 onto latest main (flip 3.6.0-rc.1→3.6.0, keep the v3.6.0 CHANGELOG section + fresh empty Unreleased), have an INDEPENDENT agent review it (implementer ≠ reviewer; reviewer uses gh CLI only), admin-merge (--squash --admin --delete-branch), wait CI green, then `gh workflow run release-stable.yml -f version=3.6.0`. Verify: tag v3.6.0, npm latest=3.6.0, GitHub Release v3.6.0 with notes, `npm view evolutionary-cli-wrapper@3.6.0 files engines`.
5. Follow-ups (separate PRs, registered as tasks in the original session): fix release-rc.yml version trap (`npm version ${TAG#v} --no-git-tag-version --allow-same-version` before publish + Unreleased notes fallback + reconcile RELEASE_PROCESS.md); fix hand-quoted shell:true passthrough spawn in src/index.ts (~L184-190); harden flaky Windows spawn test (tests/proxy/spawnCommand.test.ts, windows-2022+Node22).

## Process rules for the resuming session
Coordinator delegates; implementer ≠ reviewer; reviewer is gh-CLI-only; subagent prompts in English; run `bash ~/.claude/scripts/git-account-switch.sh` in the repo (company account 1-10maru); never `gh pr review --approve` (use --comment + admin merge).
