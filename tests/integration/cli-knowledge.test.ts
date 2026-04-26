import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EvoDatabase } from "../../src/db";

// ---------------------------------------------------------------------------
// Integration test: `evo export-knowledge` then `evo import-knowledge` round-trip.
//
// 1. Seed cwdA with 2 stats_buckets rows.
// 2. Run `evo export-knowledge --cwd cwdA --output bundle.json`.
// 3. Run `evo import-knowledge --cwd cwdB --input bundle.json` against an
//    empty DB.
// 4. Assert cwdB now has the same 2 buckets.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedBucket(
  db: import("better-sqlite3").Database,
  bucketLevel: string,
  bucketKey: string,
  meanCost: number,
  sampleSize: number,
): void {
  db.prepare(`
    INSERT INTO stats_buckets (
      bucket_level, bucket_key, sample_size, mean_cost, ema_cost, m2_cost,
      fix_loop_rate, retry_rate, last_updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0.1, 0.05, ?)
  `).run(bucketLevel, bucketKey, sampleSize, meanCost, meanCost, new Date().toISOString());
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

describe("integration: evo export-knowledge / import-knowledge", () => {
  it("round-trips stats_buckets rows from one project to another", () => {
    const cwdA = makeTempDir("evo-knowA-");
    const cwdB = makeTempDir("evo-knowB-");
    const bundleHost = makeTempDir("evo-bundle-");
    const bundlePath = path.join(bundleHost, "k.json");

    // Seed cwdA.
    const dbA = new EvoDatabase(cwdA);
    const rawA = (dbA as unknown as { db: import("better-sqlite3").Database }).db;
    seedBucket(rawA, "global", "all", 12.5, 30);
    seedBucket(rawA, "cli", "claude", 10.0, 20);
    dbA.close();

    // Initialize empty DB for cwdB so its schema exists.
    const dbB0 = new EvoDatabase(cwdB);
    dbB0.close();

    // Export.
    const exportOut = execFileSync(
      process.execPath,
      [CLI_ENTRY, "export-knowledge", "--cwd", cwdA, "--output", bundlePath],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwdA },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(exportOut).toMatch(/Exported knowledge bundle/);
    expect(fs.existsSync(bundlePath)).toBe(true);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as {
      statsBuckets: Array<{ bucket_level: string; bucket_key: string }>;
    };
    expect(bundle.statsBuckets.length).toBe(2);

    // Import into cwdB.
    const importOut = execFileSync(
      process.execPath,
      [CLI_ENTRY, "import-knowledge", "--cwd", cwdB, "--input", bundlePath],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwdB },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(importOut).toMatch(/Imported \d+ learned bucket\(s\)/);

    // Verify rows landed in cwdB.
    const dbB = new EvoDatabase(cwdB);
    const rawB = (dbB as unknown as { db: import("better-sqlite3").Database }).db;
    const rows = rawB
      .prepare(`SELECT bucket_level, bucket_key, mean_cost FROM stats_buckets ORDER BY bucket_level, bucket_key`)
      .all() as Array<{ bucket_level: string; bucket_key: string; mean_cost: number }>;
    dbB.close();
    expect(rows.length).toBe(2);
    const keys = rows.map((r) => `${r.bucket_level}:${r.bucket_key}`).sort();
    expect(keys).toContain("cli:claude");
    expect(keys).toContain("global:all");
  }, 60_000);
});
