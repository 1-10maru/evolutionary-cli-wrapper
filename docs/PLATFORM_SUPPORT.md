# Platform Support

This document defines the supported platforms and Node versions for evopet (`evolutionary-cli-wrapper`).

## Supported Platforms

| OS | Versions | Architecture | Verified in CI |
|---|---|---|---|
| Windows | 10, 11 | x64 | yes (`windows-2022`) |
| macOS | 12+ (Monterey) | arm64 (Apple Silicon) | yes (`macos-14`) |
| macOS | 12+ (Monterey) | x64 | no (best-effort) |
| Linux | glibc ≥ 2.28 | x64 | yes (`ubuntu-22.04`) |
| Linux | glibc ≥ 2.28 | arm64 | no (best-effort) |

## Node.js

| LTS | Status | Verified in CI |
|---|---|---|
| 20 | supported | yes |
| 22 | supported (recommended) | yes |

Versions older than Node 20 are not supported. Node 18 was dropped because a transitive dependency (vitest 4.x) imports `styleText` from `node:util`, which only exists from Node 20.12 onward.

## CI Matrix

CI runs against:

| OS | Node 20 | Node 22 |
|---|---|---|
| `ubuntu-22.04` | yes | yes |
| `windows-2022` | yes | yes |
| `macos-14` (arm64) | yes | yes |

All `build-and-test` gates are blocking. A separate `audit` job runs `npm audit --audit-level=high` on `ubuntu-22.04` only (to avoid duplicate work) and blocks the PR on HIGH-severity vulnerabilities. Moderate-severity findings are warned but do not block.

A `concurrency` block cancels superseded runs on the same ref, so stale PR commits do not waste CI minutes.

## What Is NOT Supported

- Cygwin / MSYS / WSL1 (WSL2 is generally fine — it appears as a Linux distro to Node)
- Node ≤ 18
- Windows 7/8 / Windows Server 2008–2012

## Reporting Platform Issues

If you hit a problem on a supported platform, please attach:
- Output of `evo doctor --json`
- The zip from `evo logs --bundle`

to your bug report so we can reproduce it efficiently. Issues on "best-effort, no CI" rows are accepted but may take longer to reproduce.
