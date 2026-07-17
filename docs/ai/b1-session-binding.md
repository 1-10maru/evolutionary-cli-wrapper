# B1 — Recording-side session binding

Status: implemented (branch `ai/2026-07-18-b1-session-binding`) · Risk tier: **Tier 3**
Design frozen: 2026-07-15 architecture review · Implemented: 2026-07-18

## Problem / failure mode

The evo proxy tracks a Claude Code session by watching its JSONL transcript at
`~/.claude/projects/<encoded-cwd>/*.jsonl` and binding to "the freshest
post-startup JSONL in this cwd". With **multiple Claude Code windows open in the
same cwd**, several proxies watch the same directory. When a second window
writes a newer transcript, the pre-B1 watcher would **migrate** its lock to that
newer file (`乗り移り`), so one proxy starts attributing another session's turns,
tool calls and grade to the wrong EvoPet — corrupting both the live-state
display and the recorded episode.

A display-side mitigation (#73) already exists. B1 is the **root fix on the
recording side**: make binding sticky and mutually exclusive across proxies.

## Design (three elements)

### 1. bind-first-stick-hard (`src/proxy/jsonlWatcher.ts`)

Once the watcher locks onto a session's JSONL, it **never re-binds to a
different file in the same cwd**. A newer transcript appearing (another window)
is ignored. The only in-place change still honoured is the same-file
filename-reuse guard (a single JSONL whose header `sessionId` changes, e.g.
`claude -c` reusing one file) — that rotates in place and is still subject to
the binding gate below.

- The initial scan and the 5 s safety poll now iterate **all** fresh candidates
  (newest first) and lock the first *bindable* one, instead of only ever
  considering the single freshest file. This matters for multi-window: if the
  freshest file belongs to another proxy, we fall through to our own
  (older-by-mtime) session rather than failing to bind.
- Escape hatch: `EVO_DISABLE_STICK_HARD=1` reverts to the pre-B1 migrating
  behaviour (ops-visible safety valve; no release required to disable).

### 2. Owner registry (`src/proxy/sessionOwnership.ts`)

Each proxy claims ownership of a sessionId by writing a marker file at
`<cwd>/.evo/sessions/.owners/<sessionId>` containing `{ pid, cwd, claimedAt }`.

- **Before binding** a candidate whose sessionId is known, the watcher asks the
  ownership gate `canBind(sid)`. A session owned by **another live pid** is
  skipped; the watcher moves to the next candidate.
- **Claim** uses an exclusive create (`wx`): two proxies racing on the same
  brand-new sessionId cannot both win — exactly one create succeeds, the loser
  reads the winner's marker and backs off.
- **Stale reclaim**: a marker whose pid is dead (`process.kill(pid, 0)` →
  `ESRCH`) is reclaimable and overwritten. As a defensive backstop against pid
  reuse, a marker whose backing file is older than 24h (`OWNER_STALE_MS`) is
  also reclaimable regardless of pid liveness (far longer than any real
  interactive session).
- **Release** on teardown removes the marker iff this pid still owns it.
- **GC**: `gcStaleOwners(cwd)` sweeps dead/aged markers opportunistically at
  proxy startup (alongside the existing session-file and atomic-tmp GC).
- The gate is **stateful per proxy**: it claims exactly one sessionId and then
  only ever approves that one (bind-first-stick-hard at the ownership layer).

### 3. Opt-in session-id injection (`src/proxy/sessionIdInjection.ts`)

When `EVO_BIND_SESSION_ID` is enabled (opt-in), the proxy generates a UUID and
injects `--session-id <uuid>` into the spawned `claude` command. The session id
is then known **before the child starts writing**, so the proxy pre-claims
ownership and the watcher binds to **exactly** the JSONL whose header
`sessionId` matches (`expectedSessionId`), ignoring every other transcript in
the cwd. This is the strongest, ambiguity-free binding path.

## Compatibility / fallback story

Injection is **strictly opt-in and safe** — it returns the args untouched (and
the proxy falls back to ownership-gated binding) in every one of these cases:

| Condition | Behaviour |
|---|---|
| `EVO_BIND_SESSION_ID` unset/false | no injection (default) |
| CLI is not `claude` (e.g. `codex`) | no injection |
| user already passed `--session-id[=...]` | no injection (respect user) |
| resume/continue (`-c`/`--continue`/`-r`/`--resume`) | no injection (would conflict) |
| immediate-exit (`--help`/`--version`) | no injection |
| generated id is not a valid UUID | no injection |
| live tracking off (non-interactive) | no injection |

When injection is off, binding still improves via **bind-first-stick-hard +
owner registry** (no session id needed — the gate uses the JSONL header id).
When both are off (`EVO_DISABLE_STICK_HARD=1` and no injection), behaviour is
identical to pre-B1.

All owner-registry operations are **best-effort / fail-open**: any filesystem or
parse error degrades to "not owned / claimable" rather than throwing, so a
broken registry never blocks a session from being tracked — it only weakens the
multi-window guarantee back to pre-B1 strength.

Injection support in the installed `claude` (`--session-id` availability) is
verified on real machines by a **separate QA gate**; this change unit-tests the
decision/gating logic only.

## Wiring (`src/proxyRuntime.ts`)

1. Compute `injection = maybeInjectSessionId(...)` (only when live tracking is
   on); spawn the child with `injection.args`.
2. Create `ownershipGate = createSessionOwnershipGate({ cwd })`; if a session id
   was injected, pre-claim it (`gate.canBind(injection.sessionId)`).
3. Pass `expectedSessionId: injection.sessionId` and
   `canBindSession: gate.canBind` to `setupJsonlWatcher`.
4. `gcStaleOwners(cwd)` in the startup GC block; `gate.release()` in teardown.

## Risk notes for review / QA

- **pid reuse (Windows):** a dead pid recycled onto an unrelated process makes
  `isPidAlive` report a session as still owned. Mitigated by the 24h marker-age
  backstop and startup GC, but a shorter reuse-within-24h window could transiently
  skip a session. QA should confirm binding still succeeds after killing and
  relaunching windows rapidly.
- **stale-reclaim race:** reclaiming a dead pid's marker is last-writer-wins
  (not exclusive). Two proxies can only reclaim the same marker if both intend
  to own that exact session, which does not happen for distinct live sessions.
- **provisional lock avoidance:** in the ownership-gated path we defer locking
  until the header sessionId is readable, eliminating the "locked before id
  known, then owned-by-other discovered" race.
- **injection real-machine support:** if the installed `claude` rejects
  `--session-id`, the child errors — this is an opt-in risk the user accepts by
  setting `EVO_BIND_SESSION_ID`. Verify against the pinned claude version.
- **JSONL header timing:** binding in the gated path requires the first JSONL
  line (with `sessionId`) to be flushed; there is a ≤5 s poll fallback.
