import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../../src/config";
import { killProcessTree } from "../../src/proxy/spawnCommand";

// ---------------------------------------------------------------------------
// Wrapper lifecycle regression tests (defects C1 + C2).
//
// These spawn the BUILT CLI (dist/index.js) — not the in-process
// runProxySession — because the exit-code propagation and the process.exit()
// that guarantees the wrapper terminates both live in the `proxy` action in
// src/index.ts, which only runs when the compiled entrypoint is executed.
//
// Bugs being guarded against:
//   C2: runProxySession returned only { episodeId, artifacts }; the proxy
//       action never set an exit code, so the wrapper ALWAYS exited 0 and,
//       lacking a process.exit(), could hang on any lingering handle.
//   C1: attachStdin (stdin.isTTY && !interactivePassthrough) called
//       process.stdin.resume(); teardown removed the data listener but never
//       paused/unref'd stdin, so a resumed stdin kept the event loop alive and
//       the wrapper hung after the child had already exited.
//
// CI is non-TTY, so attachStdin is naturally false there. The exit-path is
// still exercised meaningfully: we leave the wrapper's stdin pipe OPEN and
// assert both prompt termination and correct exit-code propagation. The final
// test forces the interactive stdin branch via EVO_FORCE_STDIN_ATTACH=1 so the
// resume/teardown lifecycle runs even without a real terminal.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "index.js");
const FIXTURE_PATH = path.resolve(__dirname, "fixtures", "mock-claude.js");

const tempDirs: string[] = [];

beforeAll(() => {
  // CI runs `npm run build` before `npm test`, so dist/ normally exists. Build
  // on demand only when it is missing so a bare local `npm test` still works.
  if (!fs.existsSync(CLI_PATH)) {
    const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
}, 120_000);

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // EBUSY on Windows (sqlite/chokidar handles) is acceptable; the OS
        // reclaims the temp dir eventually.
      }
    }
  }
});

function makeProjectDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  // Point the "claude" original command at Node itself so the wrapper spawns
  // `node <mock-claude.js> ...` as its child (same trick the proxy-pipeline
  // integration test uses).
  const config = ensureEvoConfig(dir);
  updateEvoConfig(dir, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      originalCommandMap: {
        ...config.shellIntegration.originalCommandMap,
        claude: process.execPath,
      },
    },
    proxy: {
      ...config.proxy,
      turnIdleMs: 50,
      defaultMode: "active",
    },
  });
  return dir;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBuiltCli(opts: {
  cwd: string;
  jsonlOut: string;
  exitCode: number;
  forceAttachStdin?: boolean;
  timeoutMs?: number;
}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVO_TEST_MODE: "1",
    EVO_TEST_WHERE_STDOUT: "",
    EVO_HOME: opts.cwd,
    EVO_LIVE_TRACKING: "0",
    EVO_NO_UPDATE_CHECK: "1",
    EVO_NO_INSTALL_PROMPT: "1",
  };
  if (opts.forceAttachStdin) env.EVO_FORCE_STDIN_ATTACH = "1";

  const args = [
    CLI_PATH,
    "proxy",
    "--cli",
    "claude",
    "--cwd",
    opts.cwd,
    "--",
    FIXTURE_PATH,
    "--out",
    opts.jsonlOut,
    "--exit-code",
    String(opts.exitCode),
    "--turns",
    "3",
  ];

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `wrapper did not exit within ${timeoutMs}ms (regression of the /exit hang).\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Release our end of the pipe so the test's own event loop can drain.
      child.stdin?.destroy();
      resolve({ code, signal, stdout, stderr });
    });

    // IMPORTANT: leave child.stdin OPEN (never call end()) to reproduce the
    // open-stdin condition under which the wrapper previously hung.
  });
}

describe("wrapper lifecycle: exit-code propagation + no hang on open stdin", () => {
  it("propagates a non-zero child exit code and exits promptly with an open stdin pipe", async () => {
    const cwd = makeProjectDir("evo-life-nonzero-");
    const jsonl = path.join(cwd, "session.jsonl");
    const result = await runBuiltCli({ cwd, jsonlOut: jsonl, exitCode: 3 });
    expect(result.code).toBe(3);
  }, 30_000);

  it("propagates a clean (zero) child exit code", async () => {
    const cwd = makeProjectDir("evo-life-zero-");
    const jsonl = path.join(cwd, "session.jsonl");
    const result = await runBuiltCli({ cwd, jsonlOut: jsonl, exitCode: 0 });
    expect(result.code).toBe(0);
  }, 30_000);

  it("exits promptly and propagates the code even when stdin is forcibly attached and left open (C1)", async () => {
    const cwd = makeProjectDir("evo-life-stdin-");
    const jsonl = path.join(cwd, "session.jsonl");
    const result = await runBuiltCli({
      cwd,
      jsonlOut: jsonl,
      exitCode: 5,
      forceAttachStdin: true,
    });
    expect(result.code).toBe(5);
  }, 30_000);
});

describe("killProcessTree", () => {
  it("terminates a long-running child within a timeout", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("child was not terminated by killProcessTree within the timeout"));
        }, 10_000);
        t.unref?.();
        child.on("close", (code, signal) => {
          clearTimeout(t);
          resolve({ code, signal });
        });
        child.on("error", reject);
      },
    );

    // Give the child a moment to start before tearing it down.
    await new Promise((r) => setTimeout(r, 200));
    killProcessTree(child, "SIGTERM");

    const { code, signal } = await closed;
    // POSIX: killed by signal -> signal set, code null.
    // win32: taskkill /F -> non-zero exit code, signal null.
    expect(signal !== null || (code !== null && code !== 0)).toBe(true);
  }, 20_000);
});
