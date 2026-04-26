// jsonlWatcher — chokidar setup + fs.watch fallback + 5s safety poll for the
// Claude Code JSONL transcript files at ~/.claude/projects/<encoded-cwd>/*.jsonl.
//
// Pure refactor of the inline startJsonlWatcher() previously defined inside
// runProxySession. Logging keys, parse-failure circuit breaker semantics,
// debounce window (250 ms), poll interval (5 s), session-rotation reset
// behaviour, and chokidar→fs.watch fallback ordering are all preserved.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { getLogger } from "../logger";

const proxyJsonlWatchLog = getLogger().child("proxy.jsonl.watch");
const proxyJsonlStatLog = getLogger().child("proxy.jsonl.stat");

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
}

export interface JsonlWatcherOptions {
  /** The CLI cwd; used to derive the encoded project dir name. */
  cwd: string;
  /** Called once per parsed JSONL entry. */
  onEntry: (entry: { type?: string; message?: { content?: unknown[] } }) => void;
  /** Called when the watcher detects a session rotation (new newest JSONL). */
  onRotation: () => void;
}

export function setupJsonlWatcher(opts: JsonlWatcherOptions): JsonlWatcherHandle | null {
  const { cwd, onEntry, onRotation } = opts;
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

  let newestJsonl = "";
  let newestMtime = 0;
  let jsonlReadOffset = 0;

  let jsonlWatcher: { close: () => unknown; on: (event: string, fn: (...args: unknown[]) => void) => unknown } | null = null;
  let jsonlPollTimer: NodeJS.Timeout | null = null;
  let jsonlDebounceTimer: NodeJS.Timeout | null = null;

  const findNewestJsonl = (): void => {
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
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestJsonl = fullPath;
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
    if (!newestJsonl || parseFailCircuitTripped) return;
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(newestJsonl);
      } catch (err) {
        const n = normalizeErr(err);
        if (n.code === "ENOENT") {
          proxyJsonlStatLog.debug("jsonl stat ENOENT (file rotated/removed)", {
            path: newestJsonl,
            errno: n.code,
          });
        } else {
          proxyJsonlStatLog.warn("jsonl stat failed", {
            path: newestJsonl,
            errno: n.code,
            message: n.message,
          });
        }
        return;
      }
      if (stat.size <= jsonlReadOffset) return;
      const fd = fs.openSync(newestJsonl, "r");
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
              path: newestJsonl,
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
            path: newestJsonl,
            errno: n.code,
            message: n.message,
          });
        }
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("jsonl read failed", {
        path: newestJsonl,
        errno: n.code,
        message: n.message,
      });
    }
  };

  // Rotation handler: when a new JSONL appears (or an existing one bumps mtime
  // ahead of our tracked newest), reset offset + delegate to onRotation so the
  // caller can clear stale liveState. Returns true if rotation happened.
  const handleRotationCandidate = (fullPath: string): boolean => {
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
    if (stat.mtimeMs <= newestMtime) return false;
    const oldPath = newestJsonl;
    newestMtime = stat.mtimeMs;
    newestJsonl = fullPath;
    jsonlReadOffset = 0; // read new file from start
    onRotation();
    proxyJsonlWatchLog.info("jsonl rotated", { oldPath, newPath: fullPath });
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

  findNewestJsonl();
  if (newestJsonl) {
    try {
      jsonlReadOffset = fs.statSync(newestJsonl).size;
    } catch (err) {
      const n = normalizeErr(err);
      if (n.code === "ENOENT") {
        proxyJsonlStatLog.debug("initial jsonl stat ENOENT", {
          path: newestJsonl,
          errno: n.code,
        });
      } else {
        proxyJsonlStatLog.warn("initial jsonl stat failed", {
          path: newestJsonl,
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
      handleRotationCandidate(p);
      scheduleFlush();
    });
    cw.on("change", (p: string) => {
      // A "change" on a file other than newestJsonl with a fresher mtime is
      // also a rotation (e.g. CLI resumed an older session file).
      if (p !== newestJsonl) {
        handleRotationCandidate(p);
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
        if (fullPath !== newestJsonl) {
          handleRotationCandidate(fullPath);
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

  // Safety-net: re-run processNewLines every 5 s regardless. If the watcher
  // missed an event (rare, but happens on some Windows network mounts) this
  // keeps tracking alive. Note: this does NOT call writeLiveState — that is
  // event-driven (see onEntry callback, finalizeTurn, episode end).
  jsonlPollTimer = setInterval(() => {
    findNewestJsonl();
    processNewLines();
  }, 5000);
  if (typeof jsonlPollTimer.unref === "function") jsonlPollTimer.unref();

  return {
    close(): void {
      if (jsonlPollTimer) { clearInterval(jsonlPollTimer); jsonlPollTimer = null; }
      if (jsonlDebounceTimer) { clearTimeout(jsonlDebounceTimer); jsonlDebounceTimer = null; }
      closeWatcherOnly();
    },
  };
}
