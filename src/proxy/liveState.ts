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

export function atomicWrite(target: string, json: string): void {
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    const n = normalizeErr(err);
    proxyLiveStateLog.warn("atomic rename failed, falling back to direct write", {
      path: target,
      errno: n.code,
      message: n.message,
    });
    // Best-effort cleanup of stale tmp file
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    try {
      fs.writeFileSync(target, json);
    } catch (writeErr) {
      const wn = normalizeErr(writeErr);
      proxyLiveStateLog.warn("live-state write failed", {
        path: target,
        errno: wn.code,
        message: wn.message,
      });
    }
  }
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
  const json = JSON.stringify(payload);

  let mtimeBefore = 0;
  try {
    mtimeBefore = fs.statSync(homeTarget).mtimeMs;
  } catch {
    // file may not exist yet — that's fine
  }
  proxyLiveStateLog.debug("writing live state", {
    mtimeBefore,
    sessionTarget,
    ...(debugContext ?? {}),
  });

  atomicWrite(cwdTarget, json);
  atomicWrite(homeTarget, json);
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
    atomicWrite(sessionTarget, json);
  }
}

/**
 * v3.4.0: prune `<cwd>/.evo/sessions/*.json` files older than `maxAgeMs`
 * (default 7 days). Best-effort, never throws — failures are logged at warn
 * level and swallowed so a stale session GC pass cannot kill the proxy.
 */
export function gcOldSessionFiles(
  cwd: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): { scanned: number; removed: number } {
  const dir = sessionsDir(cwd);
  let scanned = 0;
  let removed = 0;
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
    return { scanned: 0, removed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    scanned += 1;
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
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
  if (removed > 0) {
    proxyLiveStateLog.info("session GC pruned stale files", { dir, scanned, removed });
  }
  return { scanned, removed };
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
