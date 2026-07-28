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
  /**
   * Test-only / diagnostic hook: synchronously re-run the scan+flush that the
   * 5 s safety poll performs. Lets tests drive the stick-hard/binding logic
   * deterministically without waiting on chokidar events or the interval.
   */
  rescan?: () => void;
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
  /**
   * B1 exact-binding: when set (via opt-in `--session-id` injection), the
   * watcher binds ONLY to the JSONL whose header `sessionId` equals this value,
   * ignoring every other transcript in the same cwd. This removes all binding
   * ambiguity in a multi-window cwd. When unset, binding falls back to the
   * ownership-gated freshest-file heuristic below.
   */
  expectedSessionId?: string;
  /**
   * B1 owner registry gate. Before locking a candidate whose sessionId is
   * known, the watcher asks this callback whether it may bind. The callback
   * (backed by the `.evo/sessions/.owners` registry) returns false when the
   * session is owned by another live proxy, so parallel windows never steal
   * each other's session. Only consulted when `expectedSessionId` is unset.
   */
  canBindSession?: (sessionId: string) => boolean;
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

/**
 * B1 escape hatch: setting EVO_DISABLE_STICK_HARD=1 reverts to the pre-B1
 * migrating behaviour (bind to the freshest post-start JSONL, re-binding to a
 * newer file in the same cwd). Left as an ops-visible safety valve in case the
 * stick-hard policy ever needs to be turned off in the field without a release.
 */
function stickHardDisabled(): boolean {
  return process.env.EVO_DISABLE_STICK_HARD === "1";
}

export function setupJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcherHandle | null {
  const { cwd, onEntry, onRotation, proxyStartTimeOverride, expectedSessionId, canBindSession } = opts;
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
  const listFreshPostStartJsonls = (): Array<{ path: string; mtime: number }> => {
    const fresh: Array<{ path: string; mtime: number }> = [];
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
        fresh.push({ path: fullPath, mtime: stat.mtimeMs });
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("readdir failed for project dir", {
        path: projectDir,
        errno: n.code,
        message: n.message,
      });
    }
    // Newest first: the freshest candidate is tried first, but — critically for
    // the multi-window case — if it is owned by another proxy we fall through to
    // the next one instead of giving up (a single freshest-only scan would
    // otherwise leave us unable to bind our own, older-by-mtime session).
    fresh.sort((a, b) => b.mtime - a.mtime);
    return fresh;
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
   * B1 binding gate: decide whether a candidate sessionId may be locked.
   *   - exact-binding (`expectedSessionId` set): only the injected session id.
   *   - ownership gate (`canBindSession` set): a readable, claimable id.
   *   - neither (legacy/tests): always allowed.
   */
  const sessionIsBindable = (candidateSid: string | undefined): boolean => {
    if (expectedSessionId !== undefined) {
      // Exact binding: require the header id to match our injected id. An
      // unreadable id (undefined) is deferred until it becomes readable.
      return candidateSid === expectedSessionId;
    }
    if (canBindSession) {
      // Ownership gate: we must know the id to claim it; defer if unknown.
      if (!candidateSid) return false;
      return canBindSession(candidateSid);
    }
    return true;
  };

  /**
   * Decide whether the given JSONL path should become (or replace) the locked
   * target.
   *
   * B1 bind-first-stick-hard: once locked to a session's JSONL, the watcher
   * NEVER migrates to a different file in the same cwd (which previously caused
   * the "乗り移り" attribution bug when a second Claude window wrote a newer
   * transcript). The only in-place change we still honour is the same-file
   * filename-reuse guard (a `claude -c` reusing one JSONL across sessions).
   * The pre-B1 migrating behaviour remains available via EVO_DISABLE_STICK_HARD.
   *
   * Returns true if the locked target was (re)set.
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

    if (lockedJsonlPath) {
      if (fullPath === lockedJsonlPath) {
        // Same file. Resolve a late-arriving sessionId (file was empty at lock
        // time) or handle same-file filename reuse (id changed under one name).
        const sid = readSessionIdFromJsonl(fullPath);
        if (sid && !lockedSessionId) {
          lockedSessionId = sid;
          proxyJsonlWatchLog.info("jsonl sessionId resolved", {
            path: fullPath,
            sessionId: sid,
          });
        } else if (sid && lockedSessionId && sid !== lockedSessionId) {
          // Same file, new session id (filename reuse). Only rotate in place if
          // the new id is still bindable (exact/ownership gate).
          if (!sessionIsBindable(sid)) {
            if (stat.mtimeMs > lockedMtime) lockedMtime = stat.mtimeMs;
            return false;
          }
          const oldSessionId = lockedSessionId;
          lockedSessionId = sid;
          lockedMtime = stat.mtimeMs;
          jsonlReadOffset = 0; // re-read from the start of the reused file
          onRotation(sid);
          proxyJsonlWatchLog.info("jsonl locked", {
            oldPath: fullPath,
            newPath: fullPath,
            oldSessionId,
            newSessionId: sid,
            reason: "same_file_session_id_changed",
          });
          return true;
        }
        // Update mtime tracker so future non-rotating updates don't churn logs.
        if (stat.mtimeMs > lockedMtime) lockedMtime = stat.mtimeMs;
        return false;
      }
      // Different file while already locked.
      if (!stickHardDisabled()) {
        // bind-first-stick-hard: never migrate to another session's file.
        proxyJsonlWatchLog.debug("stick-hard: ignoring newer JSONL in same cwd", {
          lockedPath: lockedJsonlPath,
          candidate: fullPath,
        });
        return false;
      }
      // Legacy escape-hatch: only migrate to a strictly newer file.
      if (stat.mtimeMs <= lockedMtime) return false;
    }

    // Not locked yet (or legacy migration): read the candidate id and gate it.
    const candidateSid = readSessionIdFromJsonl(fullPath);
    if (!sessionIsBindable(candidateSid)) {
      if (expectedSessionId === undefined && canBindSession && candidateSid) {
        proxyJsonlWatchLog.debug("owner-registry: session owned elsewhere, skipping", {
          candidate: fullPath,
          sessionId: candidateSid,
        });
      }
      return false;
    }

    const oldPath = lockedJsonlPath;
    const oldSessionId = lockedSessionId;
    lockedJsonlPath = fullPath;
    lockedSessionId = candidateSid;
    lockedMtime = stat.mtimeMs;
    jsonlReadOffset = 0; // read new file from start
    onRotation(candidateSid);
    proxyJsonlWatchLog.info("jsonl locked", {
      oldPath,
      newPath: fullPath,
      oldSessionId,
      newSessionId: candidateSid,
      reason: oldPath ? "migrated" : "initial_lock",
    });
    return true;
  };

  /**
   * Scan the project dir and lock onto the first bindable fresh JSONL. Once
   * locked, stick-hard makes this a no-op (we never migrate). Used by the
   * initial scan and the 5 s safety poll; per-file watcher events call
   * considerLockCandidate directly.
   */
  const tryLockFromScan = (): void => {
    if (lockedJsonlPath && !stickHardDisabled()) return; // already bound; stick hard
    for (const cand of listFreshPostStartJsonls()) {
      if (considerLockCandidate(cand.path)) break;
    }
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
  tryLockFromScan();
  if (lockedJsonlPath) {
    // Skip past existing content — we don't want to re-emit a session's
    // own startup events that landed slightly before our scan.
    try {
      jsonlReadOffset = fs.statSync(lockedJsonlPath).size;
    } catch (err) {
      const n = normalizeErr(err);
      if (n.code !== "ENOENT") {
        proxyJsonlStatLog.warn("initial jsonl stat failed", {
          path: lockedJsonlPath,
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
      // Windows surfaces asynchronous watcher failures (ReadDirectoryChangesW
      // giving UV_UNKNOWN, i.e. errno -4094) as an 'error' event long after a
      // successful init, so the try/catch around this block cannot catch them.
      // Without a listener Node treats it as an unhandled 'error' event and
      // terminates the whole proxy process, killing the user's live session.
      // The 5 s safety-net poll below keeps lock tracking alive, so degrading
      // to a warning is safe.
      (fw as unknown as { on: (ev: string, cb: (err: unknown) => void) => void }).on(
        "error",
        (watchErr: unknown) => {
          const w = normalizeErr(watchErr);
          proxyJsonlWatchLog.warn("fs.watch watcher error", {
            path: projectDir,
            errno: w.code,
            message: w.message,
          });
        },
      );
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
    tryLockFromScan();
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
    rescan(): void {
      tryLockFromScan();
      processNewLines();
    },
  };
}
