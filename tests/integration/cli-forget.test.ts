import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration test: `evo forget --cwd <tmp>` removes <tmp>/.evo/.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

describe("integration: evo forget", () => {
  it("removes the project's .evo directory", () => {
    const cwd = makeTempDir("evo-forget-");
    const evoDir = path.join(cwd, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(path.join(evoDir, "marker.txt"), "delete me");
    expect(fs.existsSync(evoDir)).toBe(true);

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "forget", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toMatch(/Deleted local Evo data/);
    expect(fs.existsSync(evoDir)).toBe(false);
  }, 60_000);

  it("succeeds even when .evo does not exist (idempotent)", () => {
    const cwd = makeTempDir("evo-forget-empty-");
    const evoDir = path.join(cwd, ".evo");
    expect(fs.existsSync(evoDir)).toBe(false);

    // Should not throw.
    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "forget", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toMatch(/Deleted local Evo data/);
    expect(fs.existsSync(evoDir)).toBe(false);
  }, 60_000);
});
