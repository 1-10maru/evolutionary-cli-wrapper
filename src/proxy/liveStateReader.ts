// liveStateReader — freshest-generation selection across the live-state sinks.
//
// B2: `writeLiveStateDual` fans the same payload out to up to three sinks
// (cwd `.evo/live-state.json`, `~/.claude/.evo-live.json`,
// `.evo/sessions/<sid>.json`) with three INDEPENDENT atomic writes. A reader
// that samples more than one sink can therefore observe generation N in one
// file and N-1 in another, and — with parallel sessions in one cwd — payloads
// from DIFFERENT writers in the shared sinks. This module implements the
// documented selection rules so every consumer resolves that ambiguity the
// same way.
//
// Selection rules (in order):
//   1. Parse tolerance — missing files, unreadable files, unparsable JSON,
//      and non-object payloads are silently skipped. Torn reads surface as
//      JSON.parse failures (writes are tmp+rename atomic; a truncated JSON
//      object never parses) and are treated as "sink absent".
//   2. Live-pid preference — candidates whose `writerPid` is a confirmed live
//      process outrank ALL candidates whose writer is dead. Candidates with
//      no `writerPid` (legacy pre-B2 payloads) rank between the two: a live
//      writer beats them, but they beat a confirmed-dead writer.
//   3. Freshness — within the same rank, candidates from the SAME writer pid
//      are ordered by `seq` (monotonic per writer; immune to clock steps);
//      candidates from different (or unknown) writers are ordered by
//      `writtenAt` (falling back to the legacy `updatedAt` field), with `seq`
//      as the final tiebreaker.
//
// This module deliberately has NO dependency on the statusline renderers —
// they are wired to it separately. It is safe to require from both CLI and
// proxy contexts (pure fs + sessionOwnership.isPidAlive).

import fs from "node:fs";
import { isPidAlive } from "./sessionOwnership";

/** A successfully parsed live-state candidate. */
export interface LiveStateCandidate {
  /** File the payload was read from. */
  path: string;
  /** The parsed payload (protocol fields included). */
  payload: Record<string, unknown>;
  /** B2 per-writer generation counter, if present and valid. */
  seq?: number;
  /** B2 writer pid, if present and valid. */
  writerPid?: number;
  /**
   * B2 wall-clock stamp (epoch ms). Falls back to the legacy `updatedAt`
   * payload field for pre-B2 writers; undefined when neither is usable.
   */
  writtenAt?: number;
}

export interface ReadFreshestOptions {
  /** Liveness probe override (default: sessionOwnership.isPidAlive). */
  isPidAliveFn?: (pid: number) => boolean;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asPid(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse a single candidate file. Returns undefined for missing, unreadable,
 * unparsable, or non-object content — the caller just skips it.
 */
export function parseLiveStateCandidate(filePath: string): LiveStateCandidate | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined; // ENOENT / EACCES / … — sink absent
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // torn or corrupt — treat as absent
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const payload = parsed as Record<string, unknown>;
  const seq = asFiniteNumber(payload.seq);
  const writerPid = asPid(payload.writerPid);
  const writtenAt = asFiniteNumber(payload.writtenAt) ?? asFiniteNumber(payload.updatedAt);
  return { path: filePath, payload, seq, writerPid, writtenAt };
}

/** Rank: 2 = confirmed-live writer, 1 = unknown writer (legacy), 0 = dead. */
function livenessRank(
  candidate: LiveStateCandidate,
  isPidAliveFn: (pid: number) => boolean,
): number {
  if (candidate.writerPid === undefined) return 1;
  try {
    return isPidAliveFn(candidate.writerPid) ? 2 : 0;
  } catch {
    return 1; // probe failure — treat as unknown, not dead
  }
}

/** Candidate paired with its original index (final deterministic tiebreak). */
interface RankedCandidate {
  candidate: LiveStateCandidate;
  index: number;
}

/**
 * Cross-writer comparison of two group representatives. Positive means `a`
 * wins. Order: writtenAt (wall clock, the only meaningful cross-process
 * signal), then seq, then the smaller original index (earlier candidatePath).
 * This is a TOTAL order — it never mixes the same-writer seq rule in, so it is
 * transitive across the whole rank group (see readFreshestLiveState).
 */
function representativeWins(a: RankedCandidate, b: RankedCandidate): boolean {
  const at = a.candidate.writtenAt ?? -Infinity;
  const bt = b.candidate.writtenAt ?? -Infinity;
  if (at !== bt) return at > bt;
  const as = a.candidate.seq ?? -Infinity;
  const bs = b.candidate.seq ?? -Infinity;
  if (as !== bs) return as > bs;
  return a.index < b.index;
}

/**
 * Within one writer group, the representative is the highest-seq member
 * (authoritative and transitive within a single writer pid, immune to
 * wall-clock steps). Ties break by writtenAt, then earliest index.
 */
function sameWriterWins(a: RankedCandidate, b: RankedCandidate): boolean {
  const as = a.candidate.seq ?? -Infinity;
  const bs = b.candidate.seq ?? -Infinity;
  if (as !== bs) return as > bs;
  const at = a.candidate.writtenAt ?? -Infinity;
  const bt = b.candidate.writtenAt ?? -Infinity;
  if (at !== bt) return at > bt;
  return a.index < b.index;
}

/**
 * Read every path in `candidatePaths`, drop the unusable ones, and return the
 * freshest candidate per the module-level selection rules. Returns undefined
 * when no candidate is usable. Never throws.
 *
 * Selection is a TOTAL, order-independent function of the candidate SET (the
 * only role `candidatePaths` order plays is the final exact-tie break):
 *   1. Keep only candidates of the highest liveness rank present
 *      (2 live > 1 legacy-pidless > 0 dead).
 *   2. Two-level reduction — group survivors by writerPid; reduce each
 *      same-writer group to its highest-seq member (`sameWriterWins`, which is
 *      transitive within a writer and clock-step-proof). Legacy (pid-less)
 *      candidates are each their own singleton group.
 *   3. Compare the group representatives cross-writer by writtenAt → seq →
 *      earliest index (`representativeWins`, a total order that never mixes in
 *      the same-writer seq rule).
 *
 * The two-level split is deliberate: a single hybrid pairwise comparator that
 * used seq for same-writer pairs and writtenAt for cross-writer pairs would be
 * NON-transitive under a backward clock step (gen N older wall-clock than gen
 * N-1 of the same writer), making a naive max-scan order-dependent. Reducing
 * per writer first removes the intransitive pairs before any cross-writer
 * comparison happens.
 */
export function readFreshestLiveState(
  candidatePaths: string[],
  options: ReadFreshestOptions = {},
): LiveStateCandidate | undefined {
  const isPidAliveFn = options.isPidAliveFn ?? isPidAlive;

  // Parse + rank, keeping original index.
  const ranked: { rc: RankedCandidate; rank: number }[] = [];
  candidatePaths.forEach((p, index) => {
    const candidate = parseLiveStateCandidate(p);
    if (!candidate) return;
    ranked.push({ rc: { candidate, index }, rank: livenessRank(candidate, isPidAliveFn) });
  });
  if (ranked.length === 0) return undefined;

  // 1. Highest liveness rank wins outright.
  const maxRank = Math.max(...ranked.map((r) => r.rank));
  const top = ranked.filter((r) => r.rank === maxRank).map((r) => r.rc);

  // 2. Reduce each writer group to its highest-seq representative. Pid-less
  //    (legacy) candidates each form their own singleton keyed by index so
  //    they are never merged with one another.
  const reps = new Map<string, RankedCandidate>();
  for (const rc of top) {
    const key =
      rc.candidate.writerPid !== undefined ? `pid:${rc.candidate.writerPid}` : `legacy:${rc.index}`;
    const existing = reps.get(key);
    if (!existing || sameWriterWins(rc, existing)) reps.set(key, rc);
  }

  // 3. Pick the freshest representative cross-writer (total order).
  let best: RankedCandidate | undefined;
  for (const rep of reps.values()) {
    if (!best || representativeWins(rep, best)) best = rep;
  }
  return best?.candidate;
}
