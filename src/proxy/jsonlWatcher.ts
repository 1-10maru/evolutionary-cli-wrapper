// jsonlWatcher — chokidar setup + fs.watch fallback + 5s safety poll for the
// Claude Code JSONL transcript files at ~/.claude/projects/<encoded-cwd>/*.jsonl.
//
// Pure refactor of the inline startJsonlWatcher() previously defined inside
// runProxySession. Logging keys, parse-failure circuit breaker semantics,
// debounce window (250 ms), poll interval (5 s), session-rotation reset
// behaviour, and chokidar→fs.watch fallback ordering are all preserved.
//
// v3.2.0: counter is now session-scoped instead of cwd-scoped. The watcher
// only binds to JSONL files modified at or after proxy startup (with a small
// grace window for clock skew) so an old session's JSONL retaining a recent
// mtime can no longer leak its count into a freshly-started session. The
// first line of each locked JSONL is parsed for `sessionId`; rotation
// detection now triggers on either filename change OR sessionId change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { getLogger } from "../logger";

const proxyJsonlWatchLog = getLogger().child("proxy.jsonl.watch");
const proxyJsonlStatLog = getLogger().child("proxy.jsonl.stat");

/**
 * Grace window applied to the proxy-start mtime filter. JSONL files whose
 * mtime is at most this many milliseconds older than proxyStartTime are
 * still considered fresh, accommodating clock skew between the JSONL
 * writer process and the proxy process.
 */
const PROXY_START_MTIME_GRACE_MS = 5_000;

function normalizeErr(err: unknown): { message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code, stack: e.stack };
  }
  return { message: String(err) };
}

// Module-level ring buffer for JSONL parse failure rate limiting.
// More than 5 parse failures within 10 seconds escalates to ERROR and
// disables the watcher for the remainder of the session.
const PARSE_FAIL_WINDOW_MS = 10_000;
const PARSE_FAIL_THRESHOLD = 5;
let parseFailTimestamps: number[] = [];
let parseFailCircuitTripped = false;

/** Test-only hook: reset the circuit breaker between tests. */
export function __resetJsonlWatcherCircuitForTests(): void {
  parseFailTimestamps = [];
  parseFailCircuitTripped = false;
}

export interface JsonlWatcherHandle {
  close: () => void;
  /** Test-only / diagnostic accessor: returns the currently-locked sessionId, if any. */
  getSessionId?: () => string | undefined;
  /** Test-only / diagnostic accessor: returns the currently-locked JSONL path, "" if none. */
  getLockedJsonlPath?: () => string;
}

export interface JsonlWatcherOptions {
  /** The CLI cwd; used to derive the encoded project dir name. */
  cwd: string;
  /** Called once per parsed JSONL entry. */
  onEntry: (entry: { type?: string; message?: { content?: unknown[] } }) => void;
  /** Called when the watcher detects a session rotation (new newest JSONL or new sessionId). */
  onRotation: (sessionId?: string) => void;
  /**
   * Test-only override for the proxy start time. Production code should leave
   * this undefined; tests use it to deterministically simulate the
   * "JSONL was modified before proxy startup" condition without sleeping.
   */
  proxyStartTimeOverride?: number;
}

/**
 * Read the first non-empty line of a JSONL file and extract the `sessionId`
 * field, if present and a string. Best-effort: any I/O or parse error
 * returns undefined silently.
 */
function readSessionIdFromJsonl(jsonlPath: string): string | undefined {
  try {
    // First-line read: bound the read to a reasonable header chunk so we
    // don't slurp huge files just to find the sessionId on the first line.
    const fd = fs.openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(8 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const headerText = buf.slice(0, bytesRead).toString("utf8");
      const newlineIdx = headerText.indexOf("\n");
      const firstLine = newlineIdx >= 0 ? headerText.slice(0, newlineIdx) : headerText;
      if (!firstLine.trim()) return undefined;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      const sid = parsed.sessionId;
      return typeof sid === "string" && sid.length > 0 ? sid : undefined;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch (err) {
    const n = normalizeErr(err);
    proxyJsonlWatchLog.debug("sessionId extract failed (non-fatal)", {
      path: jsonlPath,
      errno: n.code,
      message: n.message,
    });
    return undefined;
  }
}

export function setupJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcherHandle | null {
  const { cwd, onEntry, onRotation, proxyStartTimeOverride } = opts;
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return null;

  const encodedCwd = cwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
  let projectDir = "";
  try {
    for (const entry of fs.readdirSync(claudeProjectsDir)) {
      if (entry.toLowerCase() === encodedCwd.toLowerCase()) {
        projectDir = path.join(claudeProjectsDir, entry);
        break;
      }
    }
  } catch (err) {
    const n = normalizeErr(err);
    proxyJsonlWatchLog.warn("readdir failed for claude projects dir", {
      path: claudeProjectsDir,
      errno: n.code,
      message: n.message,
    });
  }
  if (!projectDir || !fs.existsSync(projectDir)) return null;

  // Record proxy start time so we can filter out JSONL files written by
  // prior sessions in the same cwd. PROXY_START_MTIME_GRACE_MS gives a
  // small clock-skew tolerance (some Claude Code writes occur slightly
  // before the proxy boot completes if invoked rapidly).
  const proxyStartTime = proxyStartTimeOverride ?? Date.now();
  const mtimeFloor = proxyStartTime - PROXY_START_MTIME_GRACE_MS;

  let lockedJsonlPath = "";
  let lockedSessionId: string | undefined;
  let lockedMtime = 0;
  let jsonlReadOffset = 0;

  let jsonlWatcher: { close: () => unknown; on: (event: string, fn: (...args: unknown[]) => void) => unknown } | null = null;
  let jsonlPollTimer: NodeJS.Timeout | null = null;
  let jsonlDebounceTimer: NodeJS.Timeout | null = null;

  /**
   * Scan the project dir for JSONL candidates that were modified at or
   * after proxyStartTime (minus grace window). Returns the freshest
   * candidate, or null if no fresh JSONL exists yet. Old JSONL files
   * (prior sessions) are intentionally skipped — this is what makes the
   * userMessages counter session-scoped instead of cwd-scoped.
   */
  const findFreshestPostStartJsonl = (): { path: string; mtime: number } | null => {
    let best: { path: string; mtime: number } | null = null;
    try {
      for (const entry of fs.readdirSync(projectDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        const fullPath = path.join(projectDir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          const n = normalizeErr(err);
          if (n.code === "ENOENT") {
            proxyJsonlStatLog.debug("jsonl stat ENOENT (transient)", {
              path: fullPath,
              errno: n.code,
            });
          } else {
            proxyJsonlStatLog.warn("jsonl stat failed", {
              path: fullPath,
              errno: n.code,
              message: n.message,
            });
          }
          continue;
        }
        // Skip files written before the proxy started (prior session leftovers).
        if (stat.mtimeMs < mtimeFloor) continue;
        if (!best || stat.mtimeMs > best.mtime) {
          best = { path: fullPath, mtime: stat.mtimeMs };
        }
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("readdir failed for project dir", {
        path: projectDir,
        errno: n.code,
        message: n.message,
      });
    }
    return best;
  };

  const closeWatcherOnly = (): void => {
    if (jsonlWatcher) {
      try {
        const closeResult = jsonlWatcher.close();
        if (closeResult && typeof (closeResult as Promise<unknown>).then === "function") {
          (closeResult as Promise<unknown>).catch(() => { /* best-effort */ });
        }
      } catch {
        // best-effort close
      }
      jsonlWatcher = null;
    }
  };

  const processNewLines = (): void => {
    if (!lockedJsonlPath || parseFailCircuitTripped) return;
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(lockedJsonlPath);
      } catch (err) {
        const n = normalizeErr(err);
        if (n.code === "ENOENT") {
          proxyJsonlStatLog.debug("jsonl stat ENOENT (file rotated/removed)", {
            path: lockedJsonlPath,
            errno: n.code,
          });
        } else {
          proxyJsonlStatLog.warn("jsonl stat failed", {
            path: lockedJsonlPath,
            errno: n.code,
            message: n.message,
          });
        }
        return;
      }
      if (stat.size <= jsonlReadOffset) return;
      const fd = fs.openSync(lockedJsonlPath, "r");
      const buf = Buffer.alloc(Math.min(stat.size - jsonlReadOffset, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, jsonlReadOffset);
      fs.closeSync(fd);
      jsonlReadOffset += buf.length;
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          onEntry(JSON.parse(line));
        } catch (err) {
          const n = normalizeErr(err);
          const now = Date.now();
          parseFailTimestamps.push(now);
          // prune timestamps older than the window
          parseFailTimestamps = parseFailTimestamps.filter(
            (t) => now - t <= PARSE_FAIL_WINDOW_MS,
          );
          if (parseFailTimestamps.length > PARSE_FAIL_THRESHOLD) {
            parseFailCircuitTripped = true;
            proxyJsonlWatchLog.error("excessive parse failures, disabling watcher", {
              path: lockedJsonlPath,
              failuresInWindow: parseFailTimestamps.length,
              windowMs: PARSE_FAIL_WINDOW_MS,
              lastErrno: n.code,
              lastMessage: n.message,
            });
            if (jsonlPollTimer) {
              clearInterval(jsonlPollTimer);
              jsonlPollTimer = null;
            }
            if (jsonlDebounceTimer) {
              clearTimeout(jsonlDebounceTimer);
              jsonlDebounceTimer = null;
            }
            closeWatcherOnly();
            return;
          }
          proxyJsonlWatchLog.warn("jsonl parse failed", {
            path: lockedJsonlPath,
            errno: n.code,
            message: n.message,
          });
        }
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("jsonl read failed", {
        path: lockedJsonlPath,
        errno: n.code,
        message: n.message,
      });
    }
  };

  /**
   * Decide whether the given JSONL path should become (or replace) the
   * locked target. Rotation triggers on:
   *   - first lock (no prior locked path), OR
   *   - candidate path differs from locked path, OR
   *   - candidate sessionId differs from locked sessionId (defensive: catches
   *     `claude -c` reusing the same JSONL filename across sessions, which
   *     shouldn't happen in normal Claude Code operation but we guard anyway).
   *
   * Returns true if the locked target was changed.
   */
  const considerLockCandidate = (fullPath: string): boolean => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch (err) {
      const n = normalizeErr(err);
      if (n.code === "ENOENT") {
        proxyJsonlStatLog.debug("rotation stat ENOENT", {
          path: fullPath,
          errno: n.code,
        });
      } else {
        proxyJsonlStatLog.warn("rotation stat failed", {
          path: fullPath,
          errno: n.code,
          message: n.message,
        });
      }
      return false;
    }
    // Reject pre-startup files outright.
    if (stat.mtimeMs < mtimeFloor) return false;

    // If we already have a lock, only consider replacement when:
    //   (a) it's a different file with newer mtime, OR
    //   (b) same file but its sessionId changed (filename reuse guard)
    if (lockedJsonlPath) {
      if (fullPath === lockedJsonlPath) {
        // Same file. Re-extract sessionId only if we don't already have one
        // (covers the case where the file existed at lock time but was empty).
        if (!lockedSessionId) {
          const sid = readSessionIdFromJsonl(fullPath);
          if (sid && sid !== lockedSessionId) {
            // Late-arriving sessionId — this is initial population, not a rotation.
            lockedSessionId = sid;
            proxyJsonlWatchLog.info("jsonl sessionId resolved", {
              path: fullPath,
              sessionId: sid,
            });
          }
        }
        // Update mtime tracker so future non-rotating updates don't churn logs.
        if (stat.mtimeMs > lockedMtime) lockedMtime = stat.mtimeMs;
        return false;
      }
      if (stat.mtimeMs <= lockedMtime) return false;
    }

    const newSessionId = readSessionIdFromJsonl(fullPath);
    const sessionIdChanged =
      lockedSessionId !== undefined &&
      newSessionId !== undefined &&
      newSessionId !== lockedSessionId;
    const pathChanged = fullPath !== lockedJsonlPath;
    if (lockedJsonlPath && !pathChanged && !sessionIdChanged) return false;

    const oldPath = lockedJsonlPath;
    const oldSessionId = lockedSessionId;
    lockedJsonlPath = fullPath;
    lockedSessionId = newSessionId;
    lockedMtime = stat.mtimeMs;
    jsonlReadOffset = 0; // read new file from start
    onRotation(newSessionId);
    proxyJsonlWatchLog.info("jsonl locked", {
      oldPath,
      newPath: fullPath,
      oldSessionId,
      newSessionId,
      reason: oldPath ? (sessionIdChanged ? "session_id_changed" : "path_changed") : "initial_lock",
    });
    return true;
  };

  // Debounced flush: collapses rapid bursts of writes from the wrapped CLI.
  const scheduleFlush = (): void => {
    if (jsonlDebounceTimer) return; // already pending; let the existing timer fire
    jsonlDebounceTimer = setTimeout(() => {
      jsonlDebounceTimer = null;
      try {
        processNewLines();
      } catch (err) {
        const n = normalizeErr(err);
        proxyJsonlWatchLog.warn("debounced flush failed", {
          errno: n.code,
          message: n.message,
        });
      }
    }, 250);
    if (typeof jsonlDebounceTimer.unref === "function") jsonlDebounceTimer.unref();
  };

  // Initial scan: only lock if a fresh post-startup JSONL already exists
  // (e.g. CLI already started writing before our watcher attached). If
  // nothing fresh is present, leave lockedJsonlPath empty — we'll lock
  // when the new JSONL appears via the chokidar add/change events or
  // the 5s safety poll below. This is the key behavior change: we never
  // bind to a stale prior-session JSONL just because it has the newest
  // mtime in the project dir.
  const initial = findFreshestPostStartJsonl();
  if (initial) {
    considerLockCandidate(initial.path);
    // Skip past existing content — we don't want to re-emit a session's
    // own startup events that landed slightly before our scan.
    try {
      jsonlReadOffset = fs.statSync(initial.path).size;
    } catch (err) {
      const n = normalizeErr(err);
      if (n.code !== "ENOENT") {
        proxyJsonlStatLog.warn("initial jsonl stat failed", {
          path: initial.path,
          errno: n.code,
          message: n.message,
        });
      }
    }
  }

  let watcherMode: "fs.watch" | "chokidar" = "chokidar";
  try {
    const cw = chokidar.watch(path.join(projectDir, "*.jsonl"), {
      ignoreInitial: false,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });
    cw.on("add", (p: string) => {
      considerLockCandidate(p);
      scheduleFlush();
    });
    cw.on("change", (p: string) => {
      // A "change" on a file other than lockedJsonlPath that meets the
      // freshness floor triggers a rotation evaluation (path change or
      // sessionId change).
      if (p !== lockedJsonlPath) {
        considerLockCandidate(p);
      }
      scheduleFlush();
    });
    cw.on("error", (err: unknown) => {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("chokidar watcher error", {
        path: projectDir,
        errno: n.code,
        message: n.message,
      });
    });
    jsonlWatcher = cw as unknown as typeof jsonlWatcher;
    proxyJsonlWatchLog.info("watcher started", {
      path: projectDir,
      mode: watcherMode,
      proxyStartTime,
    });
  } catch (err) {
    const n = normalizeErr(err);
    proxyJsonlWatchLog.warn("chokidar init failed, falling back to fs.watch", {
      path: projectDir,
      errno: n.code,
      message: n.message,
    });
    watcherMode = "fs.watch";
    try {
      const fw = fs.watch(projectDir, { persistent: false }, (_ev, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (!name.endsWith(".jsonl")) return;
        const fullPath = path.join(projectDir, name);
        if (fullPath !== lockedJsonlPath) {
          considerLockCandidate(fullPath);
        }
        scheduleFlush();
      });
      if (typeof (fw as unknown as { unref?: () => void }).unref === "function") {
        (fw as unknown as { unref: () => void }).unref();
      }
      jsonlWatcher = fw as unknown as typeof jsonlWatcher;
      proxyJsonlWatchLog.info("watcher started", {
        path: projectDir,
        mode: watcherMode,
        proxyStartTime,
      });
    } catch (innerErr) {
      const inner = normalizeErr(innerErr);
      proxyJsonlWatchLog.warn("fs.watch init failed", {
        path: projectDir,
        errno: inner.code,
        message: inner.message,
      });
    }
  }

  // Safety-net: re-evaluate lock candidates and flush every 5 s. If the
  // watcher missed an event (rare, but happens on some Windows network
  // mounts) this keeps tracking alive. Note: this does NOT call
  // writeLiveState — that is event-driven (see onEntry callback,
  // finalizeTurn, episode end).
  jsonlPollTimer = setInterval(() => {
    const fresh = findFreshestPostStartJsonl();
    if (fresh) considerLockCandidate(fresh.path);
    processNewLines();
  }, 5000);
  if (typeof jsonlPollTimer.unref === "function") jsonlPollTimer.unref();

  return {
    close(): void {
      if (jsonlPollTimer) { clearInterval(jsonlPollTimer); jsonlPollTimer = null; }
      if (jsonlDebounceTimer) { clearTimeout(jsonlDebounceTimer); jsonlDebounceTimer = null; }
      closeWatcherOnly();
    },
    getSessionId(): string | undefined {
      return lockedSessionId;
    },
    getLockedJsonlPath(): string {
      return lockedJsonlPath;
    },
  };
}
