import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// FIX B unit guard: on the non-attach path (no TTY, no force-attach) the proxy
// must deliver EOF to the wrapped child by closing its stdin. Without it, an
// interpreter layer left in front of the real CLI (npm's PowerShell shim runs
// `$input | & claude.exe`) blocks on a never-EOF stdin pipe forever.
//
// We mock spawnInteractiveCommand to hand back a fake child whose stdin.end is a
// spy, and whose exit/close fire on the next tick so runProxySession finishes.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  return { child: null as unknown as EventEmitter & Record<string, unknown>, stdinEnd: null as unknown as ReturnType<typeof vi.fn> };
});

vi.mock("../../src/proxy/spawnCommand", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    killProcessTree: () => {},
    spawnInteractiveCommand: () => {
      const child = h.child;
      // Resolve the wrapped run: emit exit then close on the next tick, after
      // runProxySession has attached its listeners (all synchronous up to the
      // exit promise).
      setImmediate(() => {
        (child as Record<string, unknown>).exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    },
  };
});

import { ensureEvoConfig, updateEvoConfig } from "../../src/config";
import { runProxySession } from "../../src/proxyRuntime";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // EBUSY on Windows is acceptable; the OS reclaims it.
      }
    }
  }
  for (const k of ["EVO_TEST_MODE", "EVO_TEST_WHERE_STDOUT", "EVO_HOME", "EVO_LIVE_TRACKING", "EVO_FORCE_STDIN_ATTACH"]) {
    delete process.env[k];
  }
});

function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-stdin-eof-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
  const config = ensureEvoConfig(dir);
  updateEvoConfig(dir, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      // Any resolvable original — spawnInteractiveCommand is mocked anyway.
      originalCommandMap: { ...config.shellIntegration.originalCommandMap, claude: process.execPath },
    },
    proxy: { ...config.proxy, turnIdleMs: 50, defaultMode: "active" },
  });
  return dir;
}

function installFakeChild(): ReturnType<typeof vi.fn> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdinEnd = vi.fn();
  child.stdin = { end: stdinEnd, write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.pid = 4242;
  child.kill = () => true;
  h.child = child;
  h.stdinEnd = stdinEnd;
  return stdinEnd;
}

describe("FIX B — non-attach path delivers stdin EOF to the child", () => {
  it("calls child.stdin.end() when stdin is not attached (non-TTY, no force-attach)", async () => {
    process.env.EVO_TEST_MODE = "1";
    process.env.EVO_TEST_WHERE_STDOUT = "";
    process.env.EVO_LIVE_TRACKING = "0";
    const cwd = makeCwd();
    process.env.EVO_HOME = cwd;
    const stdinEnd = installFakeChild();

    await runProxySession({ cwd, cli: "claude", args: ["--whatever"], mode: "active" });

    expect(stdinEnd).toHaveBeenCalledTimes(1);
  }, 30_000);
});
