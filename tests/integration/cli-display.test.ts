import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration test: `evo display [mode]` end-to-end via dist/index.js.
//
// Companion to tests/cli-display.test.ts (unit-level via runDisplayCommand
// in-process). This test exercises the actual compiled CLI binary so we
// catch wiring regressions in src/index.ts that the in-process test misses.
//
// EVO_DISPLAY_MODE_FILE redirects the persisted state to an isolated tmp file
// so we never touch the developer's ~/.claude/.evo-display-mode.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function spawnDisplay(modeFile: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    [CLI_ENTRY, "display", ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EVO_TEST_MODE: "1",
        EVO_DISPLAY_MODE_FILE: modeFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

describe("integration: evo display", () => {
  it("toggle / minimum / expansion all persist to the configured mode file", () => {
    const dir = makeTempDir("evo-display-int-");
    const modeFile = path.join(dir, ".evo-display-mode");

    // 1. minimum
    let out = spawnDisplay(modeFile, ["minimum"]);
    expect(out).toMatch(/EvoPet display: minimum/);
    expect(fs.readFileSync(modeFile, "utf8").trim()).toBe("minimum");

    // 2. expansion
    out = spawnDisplay(modeFile, ["expansion"]);
    expect(out).toMatch(/EvoPet display: expansion/);
    expect(fs.readFileSync(modeFile, "utf8").trim()).toBe("expansion");

    // 3. toggle (expansion → minimum)
    out = spawnDisplay(modeFile, ["toggle"]);
    expect(out).toMatch(/EvoPet display: minimum/);
    expect(fs.readFileSync(modeFile, "utf8").trim()).toBe("minimum");

    // 4. toggle again (minimum → expansion)
    out = spawnDisplay(modeFile, ["toggle"]);
    expect(out).toMatch(/EvoPet display: expansion/);
    expect(fs.readFileSync(modeFile, "utf8").trim()).toBe("expansion");
  }, 60_000);
});
