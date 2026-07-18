// liveState — atomic dual-target writer for the live-state JSON sink.
//
// Pure refactor of the inline atomicWrite/writeLiveState helpers previously
// defined inside runProxySession. The dual-target write (cwd .evo/live-state.json
// + ~/.claude/.evo-live.json) and tmp-file fallback semantics are preserved
// byte-for-byte.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLogger } from "../logger";
import { atomicWriteFileSync } from "../utils/atomicFile";
// NOTE: sessionOwnership imports `sessionsDir` from this module. The cycle is
// benign because BOTH modules only reference each other's exports inside
// function bodies (never at module-evaluation time) and `sessionsDir` is a
// hoisted function declaration. Do not add module-scope usages on either side.
import { hasLiveOwner } from "./sessionOwnership";

const proxyLiveStateLog = getLogger().child("proxy.livestate");

function normalizeErr(err: unknown): { message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code, stack: e.stack };
  }
  return { message: String(err) };
}

export function liveStateTargets(cwd: string): { cwdTarget: string; homeTarget: string } {
  return {
    cwdTarget: path.join(cwd, ".evo", "live-state.json"),
    homeTarget: path.join(os.homedir(), ".claude", ".evo-live.json"),
  };
}

/**
 * v3.4.0: per-session live-state directory.
 *
 * Each proxy writes to `<cwd>/.evo/sessions/<sessionId>.json` so that parallel
 * Claude Code sessions in the same cwd cannot shadow each other. The legacy
 * `<cwd>/.evo/live-state.json` is still written alongside for back-compat with
 * older statusline.py deploys that don't know about per-session files.
 */
export function sessionsDir(cwd: string): string {
  return path.join(cwd, ".evo", "sessions");
}

export function sessionLiveStatePath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

/**
 * Atomic tmp-file + rename write. Thin wrapper over the shared
 * `atomicWriteFileSync` helper (extracted so config.json / mascot.json share
 * one implementation); the shared helper additionally uses a per-process-unique
 * tmp name so parallel writers to the same target don't collide on it.
 */
export function atomicWrite(target: string, json: string): void {
  atomicWriteFileSync(target, json, proxyLiveStateLog);
}

// ── B2: seq+pid writer-identity protocol ──────────────────────────────────
//
// `writeLiveStateDual` fans the SAME payload out to up to three sinks with
// three independent atomic writes. Atomicity is per-file, not per-generation:
// a reader sampling more than one sink can observe generation N in one file
// and N-1 in another. To let readers reason about that, every generation is
// stamped with:
//
//   seq       — monotonic per-writer counter (1, 2, 3, …). Authoritative
//               ordering WITHIN one writer process; wall-clock steps
//               (NTP/DST/suspend) cannot reorder it.
//   writerPid — the writing proxy's pid. Lets readers (a) scope seq
//               comparisons to a single writer and (b) prefer payloads whose
//               writer is still alive.
//   writtenAt — wall-clock epoch ms at stamp time. Cross-writer tiebreaker
//               and staleness signal.
//
// Backward compatible: fields are additive, and existing readers
// (statusline.py / statusline.ts) ignore unknown keys. Torn-read integrity is
// provided by tmp+rename atomicity plus JSON.parse failure on the rare
// direct-write fallback path — a truncated JSON object always fails to parse
// (unclosed braces), so no separate checksum field is needed; readers treat
// unparsable files as absent (see liveStateReader.ts).

let liveStateSeq = 0;

/** Next per-writer live-state sequence number (monotonic within the process). */
export function nextLiveStateSeq(): number {
  liveStateSeq += 1;
  return liveStateSeq;
}

/** Test-only: reset the per-writer seq counter. */
export function __resetLiveStateSeqForTests(): void {
  liveStateSeq = 0;
}

export interface WriteLiveStateOptions {
  cwdTarget: string;
  homeTarget: string;
  payload: Record<string, unknown>;
  /**
   * v3.4.0: per-session sink path under `<cwd>/.evo/sessions/<sessionId>.json`.
   * When omitted (sessionId not yet known), only `cwdTarget` + `homeTarget`
   * receive the write. When provided, all three targets receive the same JSON.
   */
  sessionTarget?: string;
  /** Optional: extra context for the debug log line. */
  debugContext?: Record<string, unknown>;
}

export function writeLiveStateDual(options: WriteLiveStateOptions): void {
  const { cwdTarget, homeTarget, sessionTarget, payload, debugContext } = options;
  // B2: stamp writer identity + generation. Spread-last so the protocol fields
  // can never be shadowed by a stale copy carried inside `payload`. Single
  // stringify per generation — all sinks receive byte-identical JSON.
  const seq = nextLiveStateSeq();
  const json = JSON.stringify({
    ...payload,
    seq,
    writerPid: process.pid,
    writtenAt: Date.now(),
  });

  let mtimeBefore = 0;
  try {
    mtimeBefore = fs.statSync(homeTarget).mtimeMs;
  } catch {
    // file may not exist yet — that's fine
  }
  proxyLiveStateLog.debug("writing live state", {
    mtimeBefore,
    seq,
    sessionTarget,
    ...(debugContext ?? {}),
  });

  // Sink isolation: `atomicWrite` is already best-effort (never throws), but a
  // future regression in it must not let one failing sink starve the others —
  // each write is additionally guarded so all three are always attempted.
  const guardedWrite = (target: string): void => {
    try {
      atomicWrite(target, json);
    } catch (err) {
      const n = normalizeErr(err);
      proxyLiveStateLog.warn("live-state sink write failed (isolated)", {
        path: target,
        errno: n.code,
        message: n.message,
      });
    }
  };

  guardedWrite(cwdTarget);
  guardedWrite(homeTarget);
  if (sessionTarget) {
    // Ensure the per-session directory exists. Best-effort — atomicWrite has
    // its own fallback path if the rename fails for any reason.
    try {
      fs.mkdirSync(path.dirname(sessionTarget), { recursive: true });
    } catch (err) {
      const n = normalizeErr(err);
      proxyLiveStateLog.warn("failed to ensure sessions dir", {
        path: path.dirname(sessionTarget),
        errno: n.code,
        message: n.message,
      });
    }
    guardedWrite(sessionTarget);
  }
}

/**
 * v3.4.0: prune `<cwd>/.evo/sessions/*.json` files older than `maxAgeMs`
 * (default 7 days). Best-effort, never throws — failures are logged at warn
 * level and swallowed so a stale session GC pass cannot kill the proxy.
 *
 * B2: mtime alone is NOT sufficient to declare a session file dead — after an
 * OS sleep or clock step, a file a live proxy still writes can look ancient.
 * Before unlinking, the B1 owner registry (`.evo/sessions/.owners/<sid>`) is
 * consulted via `hasLiveOwner`: a file whose owner pid is CONFIRMED alive is
 * always skipped. Files with no owner marker, a dead owner, or an aged-out
 * marker remain reclaimable by mtime as before.
 *
 * Note on the real registry's uncertainty handling: `hasLiveOwner` never
 * throws — internally an unreadable/corrupt marker resolves to `false`
 * ("not confirmably live → reclaimable"), so a transient marker read failure
 * on an mtime-expired file WILL reclaim it. That is safe and self-healing:
 * a live proxy recreates its `sessionTarget` on its very next
 * `writeLiveStateDual`, so at worst one stale generation is dropped and
 * immediately rewritten. The `hasLiveOwnerFn` seam is injectable for tests;
 * if a caller passes a probe that DOES throw, this function keeps the file
 * that pass (a skipped delete is always safe).
 */
export function gcOldSessionFiles(
  cwd: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  hasLiveOwnerFn: (cwd: string, sessionId: string) => boolean = hasLiveOwner,
): { scanned: number; removed: number; skippedLive: number } {
  const dir = sessionsDir(cwd);
  let scanned = 0;
  let removed = 0;
  let skippedLive = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const n = normalizeErr(err);
    if (n.code !== "ENOENT") {
      proxyLiveStateLog.warn("session GC: readdir failed", {
        path: dir,
        errno: n.code,
        message: n.message,
      });
    }
    return { scanned: 0, removed: 0, skippedLive: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    const sessionId = name.slice(0, -".json".length);
    scanned += 1;
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        // B2: never unlink a file whose owner is a confirmed live pid. On any
        // probe error, err on the side of keeping the file (fail-open GC).
        let ownedByLivePid = true;
        try {
          ownedByLivePid = hasLiveOwnerFn(cwd, sessionId);
        } catch {
          ownedByLivePid = true; // conservative: keep the file this pass
        }
        if (ownedByLivePid) {
          skippedLive += 1;
          continue;
        }
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyLiveStateLog.warn("session GC: stat/unlink failed", {
        path: full,
        errno: n.code,
        message: n.message,
      });
    }
  }
  if (removed > 0 || skippedLive > 0) {
    proxyLiveStateLog.info("session GC pruned stale files", { dir, scanned, removed, skippedLive });
  }
  return { scanned, removed, skippedLive };
}

/**
 * Best-effort cleanup of both live-state targets and any leftover .tmp files.
 * ENOENT is suppressed (expected if no live-state was ever written).
 */
export function teardownLiveStateFiles(cwdTarget: string, homeTarget: string): void {
  for (const p of [cwdTarget, homeTarget]) {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      const n = normalizeErr(err);
      // ENOENT is expected when no live-state was ever written; skip noise.
      if (n.code !== "ENOENT") {
        proxyLiveStateLog.warn("live-state cleanup failed", {
          path: p,
          errno: n.code,
          message: n.message,
        });
      }
    }
    // Also clean up any leftover atomic-write tmp file
    try {
      fs.unlinkSync(`${p}.tmp`);
    } catch {
      // ENOENT or perm — ignore
    }
  }
}
