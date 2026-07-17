import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../../src/config";
import { killProcessTree } from "../../src/proxy/spawnCommand";
import { disposeNodeAsClaude, nodeAsClaude } from "../fixtures/nodeAsClaude";

afterAll(() => disposeNodeAsClaude());

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
        // A `claude`-named launcher that IS Node — a bare node.exe is now
        // rejected as a claude mapping by resolveOriginalCommand.
        claude: nodeAsClaude(),
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

// Low-level spawn of the built CLI `proxy` action. `proxyArgs` are the tokens
// after `-- ` (the wrapped-CLI argv). Leaves the wrapper's stdin OPEN (never
// end()) to reproduce the open-stdin hang condition.
function spawnWrapper(opts: {
  cwd: string;
  proxyArgs: string[];
  extraEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Which event marks "the wrapper returned". Default "close" (fires after the
  // process exits AND its stdio streams end, so full stdout is captured). Use
  // "exit" when a lingering grandchild holds a stdio pipe open on Windows: the
  // process itself has exited (the thing under test) but `close` would be
  // delayed by the leaked handle, unrelated to the wrapper's own lifecycle.
  resolveOn?: "close" | "exit";
  // Optional file the inner fake CLI writes right before exiting. On timeout
  // the diagnostics report whether it exists: PRESENT means the inner CLI ran
  // and exited (a stall above it = genuine interpreter/stdin wedge); ABSENT
  // means the chain never reached the inner CLI (cold-start/contention).
  markerPath?: string;
}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const resolveOn = opts.resolveOn ?? "close";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVO_TEST_MODE: "1",
    EVO_TEST_WHERE_STDOUT: "",
    EVO_HOME: opts.cwd,
    EVO_LIVE_TRACKING: "0",
    EVO_NO_UPDATE_CHECK: "1",
    EVO_NO_INSTALL_PROMPT: "1",
    ...opts.extraEnv,
  };

  const args = [CLI_PATH, "proxy", "--cli", "claude", "--cwd", opts.cwd, "--", ...opts.proxyArgs];

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
      // Self-identifying diagnostics, gathered BEFORE killing the wrapper, so
      // a CI failure distinguishes "genuine wedge" from "starved runner":
      //   marker PRESENT + interpreters alive + wrapper alive  => real wedge
      //   marker ABSENT / nothing alive                        => cold-start/contention
      const wrapperState =
        child.exitCode !== null || child.signalCode !== null
          ? `already exited (code=${child.exitCode} signal=${child.signalCode}; only stdio close was pending)`
          : "still running";
      let markerState = "n/a (no markerPath)";
      if (opts.markerPath) {
        markerState = fs.existsSync(opts.markerPath)
          ? "PRESENT (inner CLI ran and exited)"
          : "ABSENT (chain never reached the inner CLI)";
      }
      let procSnapshot = "unavailable";
      try {
        const out = execFileSync(
          "tasklist",
          ["/fo", "csv", "/nh"],
          { encoding: "utf8", timeout: 5_000, windowsHide: true },
        );
        const interesting = out
          .split(/\r?\n/)
          .filter((l) => /^"(pwsh|powershell|cmd|node)\.exe"/i.test(l))
          .slice(0, 20);
        procSnapshot = interesting.length > 0 ? interesting.join("\n") : "(none of pwsh/powershell/cmd/node alive)";
      } catch {
        // best-effort; non-Windows or tasklist unavailable
      }
      const tail = (s: string): string => (s.length > 1000 ? `…${s.slice(-1000)}` : s);
      child.kill("SIGKILL");
      reject(
        new Error(
          [
            `wrapper did not exit within ${timeoutMs}ms (regression of the /exit hang).`,
            `wrapper process: ${wrapperState}`,
            `inner-CLI marker: ${markerState}`,
            `live processes at timeout:\n${procSnapshot}`,
            `stdout tail:\n${tail(stdout)}`,
            `stderr tail:\n${tail(stderr)}`,
          ].join("\n"),
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release our ends of the pipes so the test's own event loop can drain,
      // even if a leaked grandchild handle keeps the write ends open.
      try {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // best-effort
      }
      child.unref?.();
      resolve({ code, signal, stdout, stderr });
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (resolveOn === "exit") {
      child.on("exit", (code, signal) => settle(code, signal));
    } else {
      child.on("close", (code, signal) => settle(code, signal));
    }

    // IMPORTANT: leave child.stdin OPEN (never call end()) to reproduce the
    // open-stdin condition under which the wrapper previously hung.
  });
}

function runBuiltCli(opts: {
  cwd: string;
  jsonlOut: string;
  exitCode: number;
  forceAttachStdin?: boolean;
  timeoutMs?: number;
}): Promise<RunResult> {
  return spawnWrapper({
    cwd: opts.cwd,
    proxyArgs: [FIXTURE_PATH, "--out", opts.jsonlOut, "--exit-code", String(opts.exitCode), "--turns", "3"],
    extraEnv: opts.forceAttachStdin ? { EVO_FORCE_STDIN_ATTACH: "1" } : undefined,
    timeoutMs: opts.timeoutMs,
  });
}

// An Evo episode is recorded only by the proxied path (which opens the SQLite
// db and prints a run summary). A transparent passthrough opens neither.
function expectNoEpisodeArtifacts(cwd: string, stdout: string): void {
  expect(fs.existsSync(path.join(cwd, ".evo", "evolutionary.db"))).toBe(false);
  expect(stdout).not.toContain("Episode #");
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

describe("nesting guard: EVO_PROXY_ACTIVE=1 passes through with no nested episode", () => {
  it("exits promptly with the child's code and records no episode when already inside a proxy", async () => {
    const cwd = makeProjectDir("evo-life-nested-");
    const jsonl = path.join(cwd, "session.jsonl");
    const result = await spawnWrapper({
      cwd,
      proxyArgs: [FIXTURE_PATH, "--out", jsonl, "--exit-code", "3", "--turns", "3"],
      extraEnv: { EVO_PROXY_ACTIVE: "1" },
    });
    expect(result.code).toBe(3);
    // The wrapped child still ran (its stdout was forwarded)...
    expect(result.stdout).toContain("Read src/index.ts");
    // ...but no nested proxy session/episode was opened.
    expectNoEpisodeArtifacts(cwd, result.stdout);
  }, 30_000);
});

describe("update passthrough: update ops are never proxied", () => {
  it("passes the top-level --update flag through and records no episode", async () => {
    const cwd = makeProjectDir("evo-life-update-flag-");
    const jsonl = path.join(cwd, "session.jsonl");
    const result = await spawnWrapper({
      cwd,
      // --update anywhere in the args marks this an update op; the fixture
      // ignores the unknown flag and exits with the requested code.
      proxyArgs: [FIXTURE_PATH, "--out", jsonl, "--exit-code", "4", "--turns", "3", "--update"],
    });
    expect(result.code).toBe(4);
    expectNoEpisodeArtifacts(cwd, result.stdout);
  }, 30_000);

  it("passes the `update` subcommand through and records no episode", async () => {
    const cwd = makeProjectDir("evo-life-update-sub-");
    // The resolved original command is Node (mapped by makeProjectDir), so a
    // leading `update` runs ./update from cwd. Give it a trivial script that
    // exits with a known code — proving the subcommand bypasses the proxy.
    fs.writeFileSync(path.join(cwd, "update"), "process.exit(9);\n");
    const result = await spawnWrapper({ cwd, proxyArgs: ["update"] });
    expect(result.code).toBe(9);
    expectNoEpisodeArtifacts(cwd, result.stdout);
  }, 30_000);
});

describe("exit watchdog: child exit with lingering stdio does not trap the wrapper", () => {
  it("returns within the watchdog window when a grandchild holds the stdout pipe open", async () => {
    const cwd = makeProjectDir("evo-life-watchdog-");
    const jsonl = path.join(cwd, "session.jsonl");
    // The mock exits (exit-code 6) but leaves a detached grandchild holding its
    // stdout for 10s, so the wrapper's child `close` event is delayed well past
    // `exit`. With a 400ms watchdog the wrapper must still return promptly; the
    // 6000ms test timeout is far below the 10s stdio-hold, so a regression
    // (waiting for `close`) would fail here.
    const result = await spawnWrapper({
      cwd,
      proxyArgs: [
        FIXTURE_PATH,
        "--out",
        jsonl,
        "--exit-code",
        "6",
        "--turns",
        "3",
        "--hold-stdout-ms",
        "10000",
      ],
      extraEnv: { EVO_EXIT_WATCHDOG_MS: "400" },
      timeoutMs: 6000,
      // The wrapper PROCESS exits promptly (via the watchdog); its stdout
      // `close` is delayed by the grandchild that still holds the pipe, so we
      // key on the process `exit` event — the thing the watchdog controls.
      resolveOn: "exit",
    });
    expect(result.code).toBe(6);
  }, 30_000);
});

// Windows-only: reproduces npm's PowerShell interpreter shim, which pipes a
// redirected stdin (`$input | & <exe>`) that blocks PowerShell forever unless
// stdin reaches EOF — even after the real CLI has exited. Guards FIX B (the
// wrapper closes the non-attach child's stdin) end-to-end. On main this HANGS.
const itWin = process.platform === "win32" ? it : it.skip;
describe("interpreter-shim stdin wedge (Windows)", () => {
  itWin(
    "does not hang when the resolved command is a PowerShell shim that pipes stdin",
    async () => {
      const cwd = makeProjectDir("evo-ps1-wedge-");
      // A fast-exit-1 fake CLI the shim invokes. A .cmd stands in for the real
      // .exe (we can't mint a PE here); the wedge is in PowerShell's stdin
      // handling and is independent of what the inner command is. It drops a
      // marker file just before exiting so the timeout diagnostics can tell
      // "inner CLI ran" (wedge above it) from "never got there" (cold start).
      const markerPath = path.join(cwd, ".fake-claude-exited");
      fs.writeFileSync(
        path.join(cwd, "fake-claude.cmd"),
        '@echo off\r\necho.>"%~dp0.fake-claude-exited"\r\nexit /b 1\r\n',
      );
      // Mirror npm's shim. The target is NOT under node_modules, so FIX A's
      // shim-follow-through deliberately does not apply here — this isolates the
      // stdin-EOF fix (FIX B) with the PowerShell layer actually in place.
      const ps1 = path.join(cwd, "claude.ps1");
      fs.writeFileSync(
        ps1,
        [
          "if ($MyInvocation.ExpectingInput) {",
          '  $input | & "$PSScriptRoot\\fake-claude.cmd" $args',
          "} else {",
          '  & "$PSScriptRoot\\fake-claude.cmd" $args',
          "}",
          "exit $LASTEXITCODE",
          "",
        ].join("\r\n"),
      );
      const config = ensureEvoConfig(cwd);
      updateEvoConfig(cwd, {
        ...config,
        shellIntegration: {
          ...config.shellIntegration,
          originalCommandMap: { ...config.shellIntegration.originalCommandMap, claude: ps1 },
        },
      });

      // spawnWrapper leaves the wrapper's own stdin OPEN, and the wrapper runs
      // non-attach (non-TTY) so it must close the PowerShell child's stdin.
      // 25s budget: hosted-runner pwsh/cmd cold starts + suite contention were
      // measured to stack past the old 15s on bad runs (local worst under a
      // spawn-storm: 2.8s; CI cold-start estimates add 6-12s). A genuine wedge
      // still fails — and the timeout diagnostics say which case it was.
      const result = await spawnWrapper({
        cwd,
        proxyArgs: ["--bad-flag-xyz"],
        timeoutMs: 25_000,
        markerPath,
      });
      expect(result.code).toBe(1);
    },
    40_000,
  );
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
