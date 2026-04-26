import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration test: `evo uninstall --cwd <tmp>`.
//
// EVO_TEST_MODE=1 short-circuits removeFromUserPath and other registry ops
// (see src/shellIntegration.ts:116) so this test never touches the
// developer's real Windows User PATH.
//
// We set up a fake project with a bin/ shim folder, then assert:
//   - the command exits 0
//   - the bin/ directory is removed
//   - the local .evo data is preserved (no --purge-data flag)
// And separately, that --purge-data also nukes .evo.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedFakeInstall(cwd: string): { binDir: string; evoDir: string } {
  const binDir = path.join(cwd, "bin");
  const evoDir = path.join(cwd, ".evo");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude.cmd"), "@echo off\nrem fake shim\n");
  fs.writeFileSync(path.join(binDir, "codex.cmd"), "@echo off\nrem fake shim\n");
  fs.mkdirSync(evoDir, { recursive: true });
  fs.writeFileSync(path.join(evoDir, "marker.txt"), "keep me unless --purge-data");
  return { binDir, evoDir };
}

beforeAll(() => {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(
      `dist/index.js missing at ${CLI_ENTRY}. Run \`npm run build\` first.`,
    );
  }
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("integration: evo uninstall", () => {
  it("removes the bin shim directory and prints a summary", () => {
    const cwd = makeTempDir("evo-uninstall-");
    const { binDir, evoDir } = seedFakeInstall(cwd);
    expect(fs.existsSync(binDir)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "uninstall", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toMatch(/Local shims removed/);
    // bin dir gone.
    expect(fs.existsSync(binDir)).toBe(false);
    // .evo preserved without --purge-data.
    expect(fs.existsSync(evoDir)).toBe(true);
    expect(fs.existsSync(path.join(evoDir, "marker.txt"))).toBe(true);
  }, 60_000);

  it("with --purge-data also deletes the local .evo directory", () => {
    const cwd = makeTempDir("evo-uninstall-purge-");
    const { binDir, evoDir } = seedFakeInstall(cwd);
    expect(fs.existsSync(binDir)).toBe(true);
    expect(fs.existsSync(evoDir)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "uninstall", "--cwd", cwd, "--purge-data"],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toMatch(/Local Evo data deleted/);
    expect(fs.existsSync(binDir)).toBe(false);
    expect(fs.existsSync(evoDir)).toBe(false);
  }, 60_000);
});
