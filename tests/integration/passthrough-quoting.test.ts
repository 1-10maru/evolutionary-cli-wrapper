import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../../src/config";

// The passthrough branch (`claude review ...`, update ops, nested) used to build
// a shell string quoting only whitespace args, so cmd metacharacters (& | < >)
// in an argument were interpreted by cmd.exe — command injection / mangling.
// Routing through spawnInteractiveCommand applies quoteArgForCmd, so the args
// reach the child verbatim. This is a Windows-only concern (the .cmd/.bat path
// uses shell:true); on POSIX the args go through an argv array with shell:false.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "index.js");
const ECHO_ARGS = path.resolve(__dirname, "fixtures", "echo-args.js");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
});

const itWin = process.platform === "win32" ? it : it.skip;

describe("passthrough arg quoting (Windows .cmd path)", () => {
  itWin("passes cmd-metacharacter args to the child verbatim (no injection)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-passthru-quote-"));
    tempDirs.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"demo"}');
    // The resolved "claude" is a .cmd that forwards to the echo-args fixture.
    fs.writeFileSync(path.join(cwd, "claude.cmd"), `@echo off\r\nnode "${ECHO_ARGS}" %*\r\n`);
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: { ...config.shellIntegration.originalCommandMap, claude: path.join(cwd, "claude.cmd") },
      },
    });

    // `review` triggers the passthrough branch; the rest are the payload args.
    const special = ["a&b", "a|b", "a>b", "a<b", 'a"b'];
    const args = [CLI_PATH, "proxy", "--cli", "claude", "--cwd", cwd, "--", "review", ...special];
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...process.env,
          EVO_TEST_MODE: "1",
          EVO_TEST_WHERE_STDOUT: "",
          EVO_HOME: cwd,
          EVO_LIVE_TRACKING: "0",
          EVO_NO_UPDATE_CHECK: "1",
          EVO_NO_INSTALL_PROMPT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`timeout\nstderr:\n${stderr}`));
      }, 15_000);
      timer.unref?.();
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    const match = /ARGV:(\[.*\])/.exec(result.stdout);
    expect(match, `no ARGV line in output:\n${result.stdout}\n${result.stderr}`).not.toBeNull();
    const argv = JSON.parse(match![1]) as string[];
    // The `&`/`|`/`<`/`>` args must arrive verbatim as single arguments (if cmd
    // had interpreted them, they would be split/dropped or inject a command).
    for (const s of ["a&b", "a|b", "a>b", "a<b"]) {
      expect(argv).toContain(s);
    }
    // Nothing was split into extra tokens: review + 5 payload args.
    expect(argv.length).toBe(6);
  }, 30_000);
});
