# Platform Support

This document defines the supported platforms and Node versions for evopet (`evolutionary-cli-wrapper`).

## Supported Platforms

| OS | Versions | Architecture |
|---|---|---|
| Windows | 10, 11 | x64 |
| macOS | 12+ (Monterey) | arm64 (Apple Silicon), x64 |
| Linux | glibc ≥ 2.28 | x64, arm64 |

## Node.js

| LTS | Status |
|---|---|
| 18 | supported (until April 2025 EOL) |
| 20 | supported |
| 22 | supported (recommended) |

Versions older than Node 18 are not supported.

## CI Matrix

CI runs against:

| OS | Node versions |
|---|---|
| `ubuntu-22.04` | 18, 20, 22 |
| `windows-2022` | 18, 20, 22 |
| `macos-14` (arm64) | 20, 22 |

Node 18 on `macos-14` is excluded to keep the matrix lean; macOS arm64 + Node 18 is rarely a primary target.

All `build-and-test` gates are blocking. A separate `audit` job runs `npm audit --audit-level=high` on `ubuntu-22.04` only (to avoid duplicate work) and blocks the PR on HIGH-severity vulnerabilities. Moderate-severity findings are warned but do not block.

A `concurrency` block cancels superseded runs on the same ref, so stale PR commits do not waste CI minutes.

## What Is NOT Supported

- Cygwin / MSYS / WSL1 (WSL2 is generally fine — it appears as a Linux distro to Node)
- Node ≤ 16
- Windows 7/8 / Windows Server 2008–2012

## Reporting Platform Issues

If you hit a problem on a supported platform, please attach:
- Output of `evo doctor --json`
- The zip from `evo logs --bundle`

to your bug report so we can reproduce it efficiently.
