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

/**
 * Compare freshness of two candidates of EQUAL liveness rank. Positive means
 * `a` is fresher. Same-writer pairs use seq (authoritative within one
 * writer); cross-writer pairs use writtenAt with seq as final tiebreaker.
 */
function freshnessDelta(a: LiveStateCandidate, b: LiveStateCandidate): number {
  const sameWriter =
    a.writerPid !== undefined && b.writerPid !== undefined && a.writerPid === b.writerPid;
  if (sameWriter && a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  const at = a.writtenAt ?? -Infinity;
  const bt = b.writtenAt ?? -Infinity;
  if (at !== bt) return at - bt;
  return (a.seq ?? -Infinity) - (b.seq ?? -Infinity);
}

/**
 * Read every path in `candidatePaths`, drop the unusable ones, and return the
 * freshest candidate per the module-level selection rules (live-pid preference
 * first, then seq/writtenAt freshness). Earlier paths win exact ties, so
 * callers should list their preferred sink first (e.g. the per-session file
 * before the shared legacy sinks). Returns undefined when no candidate is
 * usable. Never throws.
 */
export function readFreshestLiveState(
  candidatePaths: string[],
  options: ReadFreshestOptions = {},
): LiveStateCandidate | undefined {
  const isPidAliveFn = options.isPidAliveFn ?? isPidAlive;
  let best: LiveStateCandidate | undefined;
  let bestRank = -1;
  for (const p of candidatePaths) {
    const candidate = parseLiveStateCandidate(p);
    if (!candidate) continue;
    const rank = livenessRank(candidate, isPidAliveFn);
    if (
      best === undefined ||
      rank > bestRank ||
      (rank === bestRank && freshnessDelta(candidate, best) > 0)
    ) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}
