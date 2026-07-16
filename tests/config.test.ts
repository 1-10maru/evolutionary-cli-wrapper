import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, getConfigPath, getEvoDir, updateEvoConfig } from "../src/config";

const REPO_ROOT = path.resolve(__dirname, "..");

// Session-mode env overrides leak in when the test runner itself is launched
// from inside an evo-wrapped session (EVO_FORCE_NORMAL=1 defeats the
// lightweight short-circuit these tests assert). Sanitize per test.
const SESSION_MODE_ENV = ["EVO_FORCE_NORMAL", "EVO_FORCE_LIGHT"] as const;
const savedSessionModeEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of SESSION_MODE_ENV) {
    savedSessionModeEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SESSION_MODE_ENV) {
    if (savedSessionModeEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedSessionModeEnv[key];
  }
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeAggregateDir(): string {
  // Create a dir that looks like an aggregate parent (>=8 subdirs, no project markers).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-aggregate-"));
  tempDirs.push(root);
  for (let i = 0; i < 10; i += 1) {
    fs.mkdirSync(path.join(root, `sub${i}`));
  }
  return root;
}

function makeProjectDir(): string {
  // Create a dir with a project marker (.git) so lightweight tracking is OFF.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return root;
}

describe("ensureEvoConfig lightweight short-circuit", () => {
  it("does NOT create .evo/ in lightweight (aggregate parent) directories", () => {
    const cwd = makeAggregateDir();
    const evoDir = getEvoDir(cwd);
    expect(fs.existsSync(evoDir)).toBe(false);

    const config = ensureEvoConfig(cwd);

    expect(config).toBeDefined();
    expect(config.formatVersion).toBe(2);
    // Critical assertion: the directory must not have been created.
    expect(fs.existsSync(evoDir)).toBe(false);
  });

  it("creates .evo/ in directories with project markers", () => {
    const cwd = makeProjectDir();
    const evoDir = getEvoDir(cwd);
    expect(fs.existsSync(evoDir)).toBe(false);

    const config = ensureEvoConfig(cwd);

    expect(config).toBeDefined();
    expect(fs.existsSync(evoDir)).toBe(true);
    expect(fs.existsSync(path.join(evoDir, "config.json"))).toBe(true);
  });

  it("returns defaults populated with cwd-derived paths in lightweight mode", () => {
    const cwd = makeAggregateDir();
    const config = ensureEvoConfig(cwd);
    expect(config.shellIntegration.binDir).toContain("bin");
    // No .evo/ should have been created as a side effect of computing paths.
    expect(fs.existsSync(getEvoDir(cwd))).toBe(false);
  });
});

describe("ensureEvoConfig concurrent-write resilience", () => {
  it("does not crash or clobber when config.json is torn/corrupt (returns defaults, file intact)", () => {
    const cwd = makeProjectDir();
    const evoDir = getEvoDir(cwd);
    fs.mkdirSync(evoDir, { recursive: true });
    const configPath = getConfigPath(cwd);
    // A truncated file simulates a torn read from a concurrent writer.
    const corrupt = '{"proxy": {"defaultMode": "auto"';
    fs.writeFileSync(configPath, corrupt);

    const config = ensureEvoConfig(cwd);
    // Never throws; a valid config is returned...
    expect(config.formatVersion).toBe(2);
    // ...and the file is NOT clobbered with defaults (another process may have
    // a valid config mid-write; only genuinely-absent files are heal-written).
    expect(fs.readFileSync(configPath, "utf8")).toBe(corrupt);
  }, 10_000);

  it("N parallel processes never crash and leave a valid config.json", async () => {
    const cwd = makeProjectDir();
    // Seed the file so every worker reads+writes an EXISTING file (max torn-read
    // window). Without atomic writes + guarded reads this crashes ~1/3 of runs.
    ensureEvoConfig(cwd);

    const distConfig = path.join(REPO_ROOT, "dist", "config.js");
    const child =
      "const {ensureEvoConfig,updateEvoConfig}=require(process.argv[1]);" +
      "const cwd=process.argv[2];" +
      "for(let i=0;i<80;i++){const c=ensureEvoConfig(cwd);updateEvoConfig(cwd,c);}";
    const N = 6;
    const runs = Array.from({ length: N }, () =>
      new Promise<{ code: number; err: string }>((resolve) => {
        const p = spawn(process.execPath, ["-e", child, distConfig, cwd], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        p.stderr!.on("data", (d) => {
          err += d.toString();
        });
        p.on("close", (code) => resolve({ code: code ?? 1, err }));
      }),
    );
    const results = await Promise.all(runs);
    const crashed = results.filter((r) => r.code !== 0);
    // Surface any child stderr in the failure message.
    expect(crashed.map((r) => r.err).join("\n---\n")).toBe("");
    expect(crashed.length).toBe(0);
    // The final config.json must be valid JSON (no torn tail left on disk).
    const finalRaw = fs.readFileSync(getConfigPath(cwd), "utf8");
    expect(() => JSON.parse(finalRaw)).not.toThrow();
  }, 30_000);
});
