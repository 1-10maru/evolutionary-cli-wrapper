import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// env-vars.test.ts
//
// Exercises the README "Environment variables" table end-to-end against the
// built CLI (dist/index.js). One assertion per env var. Each test invokes
// `node dist/index.js <subcmd>` with explicit env overrides so we never leak
// into the developer's real environment.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const INSTALLER = path.join(REPO_ROOT, "install", "evopet-install.sh");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runEvo(
  args: string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): { stdout: string; stderr: string; status: number } {
  // Build a clean env: start from PATH/SystemRoot only so leaked test-runner
  // env vars don't pollute the assertion. Then apply caller-provided values.
  const baseEnv: Record<string, string> = {};
  if (process.env.PATH) baseEnv.PATH = process.env.PATH;
  if (process.env.Path) baseEnv.Path = process.env.Path;
  if (process.env.SystemRoot) baseEnv.SystemRoot = process.env.SystemRoot;
  if (process.env.HOME) baseEnv.HOME = process.env.HOME;
  if (process.env.USERPROFILE) baseEnv.USERPROFILE = process.env.USERPROFILE;
  if (process.env.APPDATA) baseEnv.APPDATA = process.env.APPDATA;
  if (process.env.LOCALAPPDATA) baseEnv.LOCALAPPDATA = process.env.LOCALAPPDATA;
  if (process.env.TEMP) baseEnv.TEMP = process.env.TEMP;
  if (process.env.TMP) baseEnv.TMP = process.env.TMP;

  const merged: Record<string, string> = { ...baseEnv };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }

  const opts: ExecFileSyncOptions = {
    env: merged,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (cwd) opts.cwd = cwd;

  try {
    const stdout = execFileSync(process.execPath, [DIST_INDEX, ...args], opts) as string;
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? ""),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? ""),
      status: e.status ?? 1,
    };
  }
}

function todayUtcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

function logFilePath(baseDir: string): string {
  return path.join(baseDir, ".evo", "logs", `session-${todayUtcStamp()}.log`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore — Windows handles
      }
    }
  }
});

describe("README env vars: EVO_LOG_LEVEL", () => {
  it("DEBUG includes DEBUG-level lines in the session log", () => {
    const dir = makeTempDir("evo-env-debug-");
    const result = runEvo(["init", "--cwd", dir], {
      EVO_LOG_LEVEL: "DEBUG",
      EVO_LOG_DIR: dir,
    });
    expect(result.status).toBe(0);
    const content = fs.readFileSync(logFilePath(dir), "utf8");
    expect(content).toMatch(/ DEBUG \[/);
  });

  it("ERROR suppresses INFO and DEBUG lines (only ERROR allowed)", () => {
    const dir = makeTempDir("evo-env-error-");
    const result = runEvo(["init", "--cwd", dir], {
      EVO_LOG_LEVEL: "ERROR",
      EVO_LOG_DIR: dir,
    });
    expect(result.status).toBe(0);
    const file = logFilePath(dir);
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/ INFO {2}\[/);
      expect(content).not.toMatch(/ DEBUG \[/);
    } else {
      // Acceptable: no ERROR-level events fired during `evo init` so the
      // file may not be created. The contract — INFO/DEBUG suppressed —
      // still holds.
      expect(fs.existsSync(file)).toBe(false);
    }
  });
});

describe("README env vars: EVO_LOG_DIR", () => {
  it("redirects the log file to the provided directory", () => {
    const dir = makeTempDir("evo-env-logdir-");
    // Use DEBUG so `evo init` (which only logs at debug) actually emits.
    const result = runEvo(["init", "--cwd", dir], {
      EVO_LOG_LEVEL: "DEBUG",
      EVO_LOG_DIR: dir,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(logFilePath(dir))).toBe(true);
  });
});

describe("README env vars: EVO_LOG_DISABLE", () => {
  it("EVO_LOG_DISABLE=1 prevents any log file from being created", () => {
    const dir = makeTempDir("evo-env-disable-");
    const result = runEvo(["init", "--cwd", dir], {
      EVO_LOG_LEVEL: "DEBUG",
      EVO_LOG_DIR: dir,
      EVO_LOG_DISABLE: "1",
    });
    expect(result.status).toBe(0);
    const logsDir = path.join(dir, ".evo", "logs");
    // No logs directory should exist — logger short-circuits on disable.
    const exists = fs.existsSync(logsDir);
    expect(exists).toBe(false);
  });
});

describe("README env vars: EVO_HOME", () => {
  it("places mascot.json at $EVO_HOME/.evo/mascot.json", () => {
    const evoHome = makeTempDir("evo-env-home-");
    const projectCwd = makeTempDir("evo-env-home-cwd-");
    const result = runEvo(
      ["pet", "choose", "fox", "--cwd", projectCwd],
      {
        EVO_HOME: evoHome,
        EVO_LOG_DISABLE: "1",
      },
    );
    expect(result.status).toBe(0);
    const mascotPath = path.join(evoHome, ".evo", "mascot.json");
    expect(fs.existsSync(mascotPath)).toBe(true);
  });
});

describe("README env vars: EVOPET_ENABLED / DISABLE_OPTIONAL_PROJECTS shim behavior", () => {
  it("EVOPET_ENABLED=0 keeps the shim a PATH no-op", () => {
    const home = makeTempDir("evo-shim-disabled-");
    // Install so the shim file exists.
    execFileSync("bash", [INSTALLER], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const shim = path.join(home, ".claude", "local", "optional-projects.sh");
    expect(fs.existsSync(shim)).toBe(true);

    // Source the shim with EVOPET_ENABLED=0 and read PATH back.
    const probe = `export EVOPET_ENABLED=0; export PATH="ORIG"; . "${shim.replace(/\\/g, "/")}"; printf "%s" "$PATH"`;
    const out = execFileSync("bash", ["-c", probe], { encoding: "utf8" }).toString();
    expect(out).toBe("ORIG");
  });

  it("DISABLE_OPTIONAL_PROJECTS=1 makes the shim early-return without touching PATH", () => {
    const home = makeTempDir("evo-shim-master-off-");
    execFileSync("bash", [INSTALLER], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const shim = path.join(home, ".claude", "local", "optional-projects.sh");
    const probe = `export DISABLE_OPTIONAL_PROJECTS=1; export PATH="ORIG"; . "${shim.replace(/\\/g, "/")}"; printf "%s" "$PATH"`;
    const out = execFileSync("bash", ["-c", probe], { encoding: "utf8" }).toString();
    expect(out).toBe("ORIG");
  });
});
