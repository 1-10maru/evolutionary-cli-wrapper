import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EvoDatabase } from "../../src/db";

// ---------------------------------------------------------------------------
// Integration test: `evo stats` end-to-end via dist/index.js.
//
// Seeds 3 fake episodes via raw SQL into the EvoDatabase schema, then spawns
// the compiled CLI and asserts the README-claimed labels appear in stdout.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function seedEpisode(
  db: import("better-sqlite3").Database,
  opts: {
    id: number;
    cli: string;
    surrogateCost: number;
    expAwarded: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO episodes (id, cwd, cli, command, started_at, finished_at, exit_code, prompt_hash, prompt_preview, termination_reason)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'completed')
  `).run(opts.id, "/tmp/seed", opts.cli, "demo", now, now, `hash-${opts.id}`, "preview");

  db.prepare(`
    INSERT INTO prompt_profiles (
      episode_id, prompt_hash, prompt_length, prompt_length_bucket, structure_score,
      has_bullets, has_file_refs, has_symbol_refs, has_constraint_ref,
      has_acceptance_ref, has_test_ref, target_specificity_score, preview
    ) VALUES (?, ?, 100, 'medium', 4, 1, 1, 1, 1, 1, 1, 4, 'preview')
  `).run(opts.id, `hash-${opts.id}`);

  db.prepare(`
    INSERT INTO episode_summaries (
      episode_id, surrogate_cost, files_read, lines_read_norm, symbol_revisits,
      retry_count, failed_verifications, cross_file_spread, no_change_turns,
      changed_files_count, changed_symbols_count, changed_lines_count,
      first_pass_green, prompt_length_bucket, structure_score, scope_bucket,
      exploration_mode, fix_loop_occurred, search_loop_occurred,
      nice_guidance_awarded, exp_awarded, turn_count, intervention_mode
    ) VALUES (?, ?, 1, 1, 0, 0, 0, 1, 0, 1, 1, 5, 1, 'medium', 4, 'narrow', 'focused', 0, 0, 0, ?, 1, 'quiet')
  `).run(opts.id, opts.surrogateCost, opts.expAwarded);
}

beforeAll(() => {
  // Ensure dist/index.js exists; the harness sets up dist via npm run build at
  // the top of the run, but if a developer runs this file standalone and dist
  // is missing, fail fast with a clear error.
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
        // EBUSY on Windows due to sqlite handles is acceptable.
      }
    }
  }
});

describe("integration: evo stats", () => {
  it("prints episode count, average surrogate cost, and total EXP", () => {
    const cwd = makeTempDir("evo-stats-");
    // Initialize the DB schema, seed, and close before spawning the CLI.
    const db = new EvoDatabase(cwd);
    const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
    seedEpisode(raw, { id: 1, cli: "claude", surrogateCost: 12.5, expAwarded: 30 });
    seedEpisode(raw, { id: 2, cli: "claude",  surrogateCost: 18.0, expAwarded: 40 });
    seedEpisode(raw, { id: 3, cli: "claude", surrogateCost: 6.0,  expAwarded: 50 });
    db.close();

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "stats", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toMatch(/Episodes:/);
    expect(output).toMatch(/Average Surrogate Cost:/);
    expect(output).toMatch(/Total EXP:/);
    // 30+40+50 = 120 → must show 120
    expect(output).toMatch(/Total EXP:\s*120/);
    // 3 episodes total
    expect(output).toMatch(/Episodes:\s*3/);
  }, 60_000);
});
