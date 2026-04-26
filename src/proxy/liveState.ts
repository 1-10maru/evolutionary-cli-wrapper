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
  /** Optional: extra context for the debug log line. */
  debugContext?: Record<string, unknown>;
}

export function writeLiveStateDual(options: WriteLiveStateOptions): void {
  const { cwdTarget, homeTarget, payload, debugContext } = options;
  const json = JSON.stringify(payload);

  let mtimeBefore = 0;
  try {
    mtimeBefore = fs.statSync(homeTarget).mtimeMs;
  } catch {
    // file may not exist yet — that's fine
  }
  proxyLiveStateLog.debug("writing live state", {
    mtimeBefore,
    ...(debugContext ?? {}),
  });

  atomicWrite(cwdTarget, json);
  atomicWrite(homeTarget, json);
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
