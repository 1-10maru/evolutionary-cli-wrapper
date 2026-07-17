// atomicFile — shared atomic write + torn-read-tolerant JSON read helpers.
//
// Concurrent same-cwd proxies were racing on config.json / mascot.json: a plain
// writeFileSync is non-atomic, so a reader could observe a half-written file and
// crash on JSON.parse ("Unexpected end of JSON input"). These helpers centralize
// the tmp-file + rename write (rename is atomic on one filesystem) and a bounded
// retry read so a transient torn read heals instead of crashing.

import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

function errInfo(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    return { message: err.message, code: (err as NodeJS.ErrnoException).code };
  }
  return { message: String(err) };
}

/**
 * Atomically write `data` to `target`: write to a unique tmp file then rename
 * over the target (rename is atomic within a filesystem), so a concurrent
 * reader never sees a partially written file. The tmp name is unique per
 * process + call so parallel writers to the same target don't collide on it.
 * Falls back to a direct write if the rename fails (best-effort, never throws).
 */
export function atomicWriteFileSync(
  target: string,
  data: string,
  logger?: AtomicWriteLogger,
): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    const n = errInfo(err);
    logger?.warn("atomic write rename failed; falling back to direct write", {
      path: target,
      errno: n.code,
      message: n.message,
    });
    // Best-effort cleanup of the stray tmp file, then a direct write.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    try {
      fs.writeFileSync(target, data);
    } catch (writeErr) {
      const wn = errInfo(writeErr);
      logger?.warn("atomic write direct fallback failed", {
        path: target,
        errno: wn.code,
        message: wn.message,
      });
    }
  }
}

/** Synchronous sleep without busy-spinning (config/mascot reads are sync). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — fall back to a short spin.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

export interface ReadJsonRetryOptions {
  /** Total read attempts before giving up (default 3). */
  attempts?: number;
  /** Backoff between attempts, ms (default 25). */
  backoffMs?: number;
}

/**
 * Read + JSON.parse `filePath`, retrying a TRANSIENT torn read (a concurrent
 * writer mid-rename can, on some platforms, surface a partial/empty read) up to
 * `attempts` times with a short backoff.
 *
 * A missing file (ENOENT) is NOT retried — it is rethrown immediately so the
 * caller can distinguish "genuinely absent" (safe to heal-write defaults) from
 * "present but torn" (do NOT clobber; another process may be mid-write). On a
 * persistent parse failure the last parse error is thrown.
 */
export function readJsonFileWithRetrySync<T>(
  filePath: string,
  opts: ReadJsonRetryOptions = {},
): T {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 25;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Read errors (ENOENT etc.) are not transient torn reads — rethrow now.
    const raw = fs.readFileSync(filePath, "utf8");
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) sleepSync(backoffMs);
    }
  }
  throw lastErr;
}

// ── Stale tmp-file sweep ──────────────────────────────────────────────────
// `atomicWriteFileSync` writes to `<target>.tmp.<pid>.<epochms>.<rand>` then
// renames over the target. If the process dies between the write and the
// rename (crash / SIGKILL), the tmp file is orphaned. A tmp only exists for
// microseconds during a healthy write, so any tmp older than a short window is
// certainly abandoned and safe to remove. This RE is anchored to that exact
// shape so a real file merely containing ".tmp" in its name is never matched.
const ATOMIC_TMP_RE = /\.tmp\.\d+\.\d+\.[a-z0-9]+$/i;

/** True if `name` is an atomic-write tmp file (see atomicWriteFileSync). */
export function isAtomicTmpName(name: string): boolean {
  return ATOMIC_TMP_RE.test(name);
}

/**
 * Best-effort GC of stale atomic-write tmp files in `dir`. Non-recursive.
 * Removes only files matching the atomic tmp shape whose mtime is older than
 * `maxAgeMs` (default 1 hour). Never throws — failures are logged and swallowed
 * so an opportunistic sweep can never crash startup. A missing dir is a no-op.
 */
export function gcStaleAtomicTmps(
  dir: string,
  maxAgeMs: number = 60 * 60 * 1000,
  logger?: AtomicWriteLogger,
): { scanned: number; removed: number } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    const n = errInfo(err);
    if (n.code !== "ENOENT") {
      logger?.warn("atomic tmp GC: readdir failed", { path: dir, errno: n.code, message: n.message });
    }
    return { scanned: 0, removed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let scanned = 0;
  let removed = 0;
  for (const name of entries) {
    if (!isAtomicTmpName(name)) continue;
    scanned += 1;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch (err) {
      const n = errInfo(err);
      // ENOENT: another sweeper/writer already removed it — not an error.
      if (n.code !== "ENOENT") {
        logger?.warn("atomic tmp GC: stat/unlink failed", {
          path: full,
          errno: n.code,
          message: n.message,
        });
      }
    }
  }
  return { scanned, removed };
}
