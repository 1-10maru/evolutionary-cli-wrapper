# B2 — 3-sink live-state consistency (seq+pid protocol)

Status: implemented (writer + GC + reader helper). Statusline readers are
wired in a separate lane; this change only provides and tests the helper.

## Problem

`writeLiveStateDual()` fans one payload out to up to three sinks —
`<cwd>/.evo/live-state.json`, `~/.claude/.evo-live.json`, and
`<cwd>/.evo/sessions/<sessionId>.json` — via three independent tmp+rename
atomic writes. Consequences before B2:

- **Mixed generations**: atomicity is per-file, so a reader sampling several
  sinks could see generation N in one file and N-1 in another, with no way to
  tell which is newer (wall clock alone is unreliable across clock steps).
- **No writer identity**: with parallel sessions in one cwd, the two shared
  sinks interleave payloads from different proxies; readers could not tell
  writers apart or prefer a still-running one.
- **GC race**: `gcOldSessionFiles` unlinked purely by mtime; after an OS
  sleep / clock skew a file a live proxy still writes could look ancient and
  get deleted out from under it.

## Protocol fields (writer side, `writeLiveStateDual`)

Every generation is stamped at write time (spread-last, so payload copies can
never shadow them), then stringified **once** and written byte-identically to
all sinks:

| Field       | Meaning |
|-------------|---------|
| `seq`       | Monotonic per-writer counter (1, 2, …). Authoritative ordering *within* one writer pid; immune to wall-clock steps. |
| `writerPid` | Pid of the writing proxy. Scopes `seq` comparisons and enables live-pid preference. |
| `writtenAt` | Wall-clock epoch ms at stamp time. Cross-writer tiebreaker / staleness signal. |

Compatibility: fields are additive. Existing readers (`statusline.py`,
`src/cli/statusline.ts`) parse the JSON and read known keys, so they ignore
these. Legacy payloads (no `seq`/`writerPid`) remain readable — the reader
falls back to the pre-existing `updatedAt` field for freshness.

## Torn-read integrity

Writes are tmp+rename atomic (`atomicWriteFileSync`); the only non-atomic
path is its direct-write *fallback* after a failed rename. A truncated JSON
object cannot parse (unclosed braces), so `JSON.parse` failure is the
integrity check — no checksum field is needed. Readers treat unparsable files
as absent. Additionally each sink write in `writeLiveStateDual` is guarded so
a failure on one sink can never prevent the remaining sinks from being
written (belt-and-braces on top of the never-throwing atomic writer).

## GC vs live writer

`gcOldSessionFiles(cwd, maxAgeMs, hasLiveOwnerFn?)` now consults the B1 owner
registry (`.evo/sessions/.owners/<sid>`, `sessionOwnership.hasLiveOwner`)
before unlinking an mtime-expired session file:

- owner marker present + pid **alive** (and marker not aged out) → **skip**
  (`skippedLive` counter);
- no marker / dead pid / aged-out marker → reclaim by mtime as before;
- `hasLiveOwner` never throws: an unreadable/corrupt marker resolves to
  "not confirmably live → reclaimable". Reclaiming on a transient marker-read
  failure is safe and **self-healing** — a live proxy recreates its
  `sessionTarget` on its next `writeLiveStateDual`, so at most one stale
  generation is dropped and immediately rewritten. (The injectable
  `hasLiveOwnerFn` seam is only for tests; if a caller *did* pass a throwing
  probe, GC keeps the file that pass.) GC itself still never throws.

## Reader rules (`src/proxy/liveStateReader.ts`)

`readFreshestLiveState(candidatePaths, { isPidAliveFn? })`:

1. **Parse tolerance** — missing / unreadable / corrupt / non-object
   candidates are skipped; if none survive, returns `undefined`.
2. **Live-pid preference** — only candidates of the highest liveness rank
   present survive: confirmed-live `writerPid` (rank 2) beats legacy/pid-less
   payloads (rank 1) beats confirmed-dead writers (rank 0).
3. **Two-level freshness reduction (total, order-independent)** — group the
   survivors by `writerPid`; reduce each same-writer group to its highest
   `seq` member (transitive within a writer, clock-step-proof). Legacy
   (pid-less) candidates are each their own singleton. Then compare the group
   representatives cross-writer by `writtenAt` (→ `seq` → earliest index).

   Why two levels and not one hybrid pairwise comparator: a comparator that
   used `seq` for same-writer pairs and `writtenAt` for cross-writer pairs is
   **non-transitive** under a backward clock step (gen N has an older wall
   clock than gen N-1 of the same writer). A naive max-scan over a
   non-transitive relation is order-dependent, which would let selection flap
   between reads and let two consumers with different sink orderings disagree
   — violating the module contract. Reducing per writer first eliminates the
   intransitive pairs before any cross-writer comparison.
4. **Tie** — the earlier path in `candidatePaths` wins only as the final
   deterministic tiebreak; it does not otherwise affect the result. Callers
   still list their preferred sink first (per-session file, then cwd, then
   home).

The statusline lane will wire this helper into `statusline.py` /
`src/cli/statusline.ts`; those files are intentionally untouched here.
