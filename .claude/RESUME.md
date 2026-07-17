# RESUME — v3.6.0 release: COMPLETED (2026-07-17)

The cross-PC handoff that used to live here is done. Nothing to resume.

## Final state (all GET-verified)
- npm dist-tags: `latest = 3.6.0`, `next = 3.6.0-rc.3`. GitHub Release v3.6.0 (stable) + v3.6.0-rc.3 (prerelease). Tag `v3.6.0` on main.
- Publishing is now **npm OIDC Trusted Publishing** via the single `.github/workflows/release.yml` (RC: push `v*-rc.*` tag; stable: workflow_dispatch with a version input). **No NPM_TOKEN anywhere** — the repo secret was deleted after the migration. Trusted Publisher registered on npmjs.com: user `1-10maru` / repo `evolutionary-cli-wrapper` / workflow `release.yml` / no environment / action `npm publish`.
  - Gotchas learned (do not regress): `actions/setup-node`'s `registry-url` input injects a placeholder NODE_AUTH_TOKEN that silently disables OIDC; npm@12.0.1 failed the exchange (pin `npm@11`); a registry-side 404 on `/-/npm/v1/oidc/token/exchange/...` means the Trusted Publisher registration is missing/mismatched.
- v3.6.0 contents: /logout + /exit + interpreter-shim/stdin-EOF hang fixes, nested-proxy guard, native auto-updater passthrough (exe-lock interference eliminated — verified by an update-parity harness and a real in-the-wild auto-update success), stale-cache/interpreter-denylist resolution hardening, statusline determinism (single session-bound block, meaning-based truncation, provenance tags, hard cap; `setup` deploys a token-only `base_statusline.py`), live 育成度 gauge + advice repeat suppression, ReDoS line cap, atomic config/mascot writes, DB concurrency trio (IMMEDIATE transactions, migration-race guard, WAL-switch retry), lean 50-file tarball, `capture.promptText` privacy flag + README privacy section.
- Verification: two consecutive clean QA rounds (isolated sandbox matrix incl. 25×/25×/15× concurrency hammers), the second against the published npm artifact bytes.

## Known follow-ups (non-blocking backlog; see ~/.claude/plans/evopet/)
- Statusline write-side session binding (arch PR-B: bind-first-stick-hard + owner registry + optional `--session-id`), 3-sink atomicity (PR-C: seq+pid), advice escalation curriculum, tip-library unification, `evo install-statusline` full-renderer deploy consistency, stale-tmp sweep, secret-pattern redaction for stored prompt text, dev-box mystery: something intermittently prunes `node_modules` transitive deps in the main tree.
