// sessionOwnership — per-session owner registry for the JSONL watcher.
//
// Problem (B1): with multiple Claude Code windows open in the same cwd, several
// evo proxies watch the same `~/.claude/projects/<cwd>/*.jsonl` directory. Each
// proxy must bind to exactly the session it launched and never steal another
// live proxy's session. The owner registry is the coordination point.
//
// Each proxy claims ownership of a Claude Code sessionId by writing a small
// marker file at `<cwd>/.evo/sessions/.owners/<sessionId>` containing its pid.
// Before binding to a session, a proxy checks the registry: a session already
// owned by another *live* pid is skipped; a marker left behind by a dead pid is
// reclaimable (stale) and gets overwritten.
//
// All operations are best-effort and fail-open: any filesystem or parse error
// degrades to "not owned / claimable" rather than throwing, so a broken
// registry never blocks a session from being tracked (it only weakens the
// multi-window guarantee, matching pre-B1 behaviour).

import fs from "node:fs";
import path from "node:path";
import { getLogger } from "../logger";
import { sessionsDir } from "./liveState";

const ownershipLog = getLogger().child("proxy.session.ownership");

/**
 * A marker whose backing file is older than this is treated as stale and
 * reclaimable regardless of pid liveness. This is a defensive backstop against
 * pid reuse: an OS can recycle a long-dead proxy's pid onto an unrelated
 * process, which would otherwise make `isPidAlive` report the session as still
 * owned forever. 24h is far longer than any real interactive session, so this
 * never reclaims a session that is genuinely in use.
 */
const OWNER_STALE_MS = 24 * 60 * 60 * 1000;

function normalizeErr(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code };
  }
  return { message: String(err) };
}

/** `<cwd>/.evo/sessions/.owners` — the owner-marker directory. */
export function ownersDir(cwd: string): string {
  return path.join(sessionsDir(cwd), ".owners");
}

/**
 * Path of the owner marker for a sessionId. The sessionId is sanitized to a
 * safe basename (path separators / traversal stripped) as defense-in-depth,
 * even though Claude Code session ids are UUIDs.
 */
export function ownerFilePath(cwd: string, sessionId: string): string {
  // Drop "." too (not just separators) so pure "." / ".." can never survive as
  // a traversal segment. Claude session ids are UUIDs (hex + hyphens), so this
  // never alters a real id.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
  return path.join(ownersDir(cwd), safe);
}

/**
 * Cross-platform liveness probe. `process.kill(pid, 0)` sends no signal but
 * performs the permission/existence check:
 *   - success        → process exists and is signalable → alive
 *   - EPERM          → process exists but we lack permission → alive
 *   - ESRCH / other  → no such process → dead
 * On Windows, Node maps this onto OpenProcess with the same error semantics.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const n = normalizeErr(err);
    return n.code === "EPERM";
  }
}

interface OwnerRecord {
  pid: number;
  cwd: string;
  claimedAt: string;
}

function readOwnerRecord(file: string): OwnerRecord | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    return {
      pid,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      claimedAt: typeof parsed.claimedAt === "string" ? parsed.claimedAt : "",
    };
  } catch {
    return undefined;
  }
}

function markerIsStaleByAge(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return Date.now() - st.mtimeMs > OWNER_STALE_MS;
  } catch {
    return false;
  }
}

interface OwnerWriteResult {
  ok: boolean;
  /** errno of a failed write; "EEXIST" for the expected exclusive-create clash. */
  code?: string;
}

function writeOwnerMarker(file: string, pid: number, cwd: string, flag: "wx" | "w"): OwnerWriteResult {
  const payload = JSON.stringify({ pid, cwd, claimedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, { flag });
    return { ok: true };
  } catch (err) {
    const n = normalizeErr(err);
    // EEXIST from the exclusive ("wx") create is an expected, non-error outcome
    // (another proxy won the race); the caller inspects the existing marker.
    // Any other errno is a genuine write failure (read-only fs / ENOSPC /
    // EACCES / ENOTDIR) and MUST be distinguishable so the caller can fail
    // OPEN — a registry we cannot write to must never block session tracking.
    if (!(flag === "wx" && n.code === "EEXIST")) {
      ownershipLog.debug("owner marker write failed (non-fatal)", {
        file,
        flag,
        errno: n.code,
        message: n.message,
      });
    }
    return { ok: false, code: n.code };
  }
}

/**
 * Attempt to claim ownership of `sessionId` for `pid`. Returns true if this
 * process may bind the session (freshly claimed, reclaimed from a stale marker,
 * already ours, OR the registry is unwritable — fail-open). Returns false ONLY
 * when a **confirmed live, different** process owns the marker.
 *
 * Fail-open is load-bearing: if `.evo/sessions/.owners` cannot be written
 * (read-only fs, disk full, permission denied), the owner registry degrades to
 * pre-B1 behaviour (binding proceeds) instead of silently stopping evo
 * tracking. The wrapped `claude` is unaffected either way — only evo's
 * bookkeeping relaxes.
 *
 * Concurrency: the first claim uses an exclusive create ("wx") so that two
 * proxies racing on the same brand-new sessionId cannot both win — exactly one
 * create succeeds; the loser reads the winner's marker and backs off. The
 * stale-reclaim path (overwriting a dead pid's marker) is last-writer-wins,
 * which is acceptable: the only way two proxies reclaim the same stale marker
 * simultaneously is if both intend to own that session, which never happens for
 * distinct live sessions.
 */
export function claimOwnership(cwd: string, sessionId: string, pid: number): boolean {
  const file = ownerFilePath(cwd, sessionId);

  // Fast path: exclusive create. Wins if no marker exists.
  const first = writeOwnerMarker(file, pid, cwd, "wx");
  if (first.ok) return true;
  if (first.code !== "EEXIST") {
    // Genuine write failure (unwritable registry) → fail OPEN so tracking never
    // stops. This is NOT a live-owner conflict.
    ownershipLog.warn("owner registry unwritable; allowing bind (fail-open)", {
      file,
      errno: first.code,
    });
    return true;
  }

  // A marker already exists (EEXIST): decide by its owner.
  const existing = readOwnerRecord(file);
  if (existing && existing.pid === pid) return true; // idempotent: already ours
  if (existing && isPidAlive(existing.pid) && !markerIsStaleByAge(file)) {
    // The ONLY case we refuse: a confirmed live, different owner.
    return false;
  }

  // Corrupt/unreadable, dead pid, or aged-out marker → reclaim. If the reclaim
  // write itself fails (unwritable registry), still fail OPEN (allow bind).
  ownershipLog.debug("reclaiming owner marker", {
    file,
    stalePid: existing?.pid,
    newPid: pid,
  });
  const reclaimed = writeOwnerMarker(file, pid, cwd, "w");
  if (!reclaimed.ok) {
    ownershipLog.warn("owner marker reclaim failed; allowing bind (fail-open)", {
      file,
      errno: reclaimed.code,
    });
  }
  return true;
}

/**
 * Release ownership of `sessionId` if (and only if) this `pid` currently owns
 * it. Best-effort; never throws. Called on proxy teardown so a cleanly-exiting
 * proxy leaves no marker behind.
 */
export function releaseOwnership(cwd: string, sessionId: string, pid: number): void {
  const file = ownerFilePath(cwd, sessionId);
  const existing = readOwnerRecord(file);
  if (existing && existing.pid !== pid) return; // not ours — leave it alone
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    const n = normalizeErr(err);
    ownershipLog.debug("owner marker release failed (non-fatal)", {
      file,
      errno: n.code,
      message: n.message,
    });
  }
}

/**
 * Best-effort sweep of owner markers left by dead pids (or aged-out markers).
 * Safe to call opportunistically at proxy startup. Never throws.
 */
export function gcStaleOwners(cwd: string): void {
  const dir = ownersDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // no registry yet — nothing to sweep
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const rec = readOwnerRecord(file);
    const dead = !rec || (!isPidAlive(rec.pid) || markerIsStaleByAge(file));
    if (!dead) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * A stateful gate wrapping the owner registry for a single proxy instance.
 * Tracks the one sessionId this proxy has claimed, so repeated `canBind` calls
 * (from the watcher's poll loop) are cheap and idempotent, and so teardown can
 * release exactly what was claimed.
 */
export interface SessionOwnershipGate {
  /**
   * Returns true if this proxy may bind to `sessionId`. On the first approved
   * session it records the claim; thereafter it only approves that same
   * session (bind-first-stick-hard at the ownership layer).
   */
  canBind(sessionId: string): boolean;
  /** The sessionId this gate has claimed, if any. */
  claimedSessionId(): string | undefined;
  /** Release the claimed ownership marker (best-effort, idempotent). */
  release(): void;
}

export function createSessionOwnershipGate(opts: { cwd: string; pid?: number }): SessionOwnershipGate {
  const { cwd } = opts;
  const pid = opts.pid ?? process.pid;
  let claimed: string | undefined;

  return {
    canBind(sessionId: string): boolean {
      if (!sessionId) return false;
      if (claimed !== undefined) return sessionId === claimed;
      if (claimOwnership(cwd, sessionId, pid)) {
        claimed = sessionId;
        ownershipLog.info("session ownership claimed", { cwd, sessionId, pid });
        return true;
      }
      return false;
    },
    claimedSessionId(): string | undefined {
      return claimed;
    },
    release(): void {
      if (claimed === undefined) return;
      releaseOwnership(cwd, claimed, pid);
      ownershipLog.info("session ownership released", { cwd, sessionId: claimed, pid });
      claimed = undefined;
    },
  };
}
