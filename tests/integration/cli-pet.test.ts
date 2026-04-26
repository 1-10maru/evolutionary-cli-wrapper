import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Integration test: `evo pet list` and `evo pet choose <species>`.
//
// Pet state lives in <EVO_HOME>/.evo/mascot.json (see src/config.ts
// getGlobalEvoDir + src/mascot.ts mascotPath). We override EVO_HOME so the
// test cannot mutate the developer's real ~/.evo/mascot.json.
//
// Species roster pinned by src/mascot.ts MASCOT_SPECIES (10 entries).
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

describe("integration: evo pet", () => {
  it("lists all 10 species including chick, cat, dog, fox", () => {
    const cwd = makeTempDir("evo-pet-list-");
    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "pet", "list"],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const id of [
      "chick", "cat", "dog", "fox", "rabbit",
      "bear", "panda", "koala", "tiger", "penguin",
    ]) {
      expect(output).toContain(id);
    }
    // Sanity: 10 lines (one per species).
    const speciesLines = output.split("\n").filter((l) => /^[\u{1F300}-\u{1FAFF}]/u.test(l) || /\(.+\)$/.test(l));
    expect(speciesLines.length).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it("'choose fox' updates <EVO_HOME>/.evo/mascot.json with speciesId=fox", () => {
    const cwd = makeTempDir("evo-pet-choose-");
    const mascotFile = path.join(cwd, ".evo", "mascot.json");
    expect(fs.existsSync(mascotFile)).toBe(false);

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "pet", "choose", "fox", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output).toMatch(/EvoPet is now fox/);
    expect(fs.existsSync(mascotFile)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(mascotFile, "utf8")) as {
      speciesId: string;
    };
    expect(persisted.speciesId).toBe("fox");
  }, 60_000);

  it("'choose' with an unknown species id surfaces an error and non-zero exit", () => {
    const cwd = makeTempDir("evo-pet-choose-bad-");
    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [CLI_ENTRY, "pet", "choose", "dragon", "--cwd", cwd],
        {
          encoding: "utf8",
          env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      const e = err as { status?: number; stderr?: string | Buffer };
      exitCode = e.status ?? 0;
      stderr = typeof e.stderr === "string" ? e.stderr : Buffer.from(e.stderr ?? "").toString("utf8");
    }
    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  }, 60_000);
});
