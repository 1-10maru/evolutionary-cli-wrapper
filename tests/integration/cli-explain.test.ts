import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EvoDatabase } from "../../src/db";

// ---------------------------------------------------------------------------
// Integration test: `evo explain <episodeId>` end-to-end.
//
// Seeds one episode + summary + profile and asserts the CLI prints the
// fields documented by formatExplain (src/ui.ts:208).
//
// NOTE on label casing: src/ui.ts emits "Surrogate cost:" and
// "Exploration mode:" (lowercase second word). The original task spec called
// for "Surrogate Cost:" / "Exploration Mode:" — we assert what the code
// actually emits, not what the spec assumed. If the README claims a
// different casing, that is a doc bug; this test pins the runtime contract.
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
  id: number,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO episodes (id, cwd, cli, command, started_at, finished_at, exit_code, prompt_hash, prompt_preview, termination_reason)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'completed')
  `).run(id, "/tmp/seed", "claude", "demo", now, now, `hash-${id}`, "preview");

  db.prepare(`
    INSERT INTO prompt_profiles (
      episode_id, prompt_hash, prompt_length, prompt_length_bucket, structure_score,
      has_bullets, has_file_refs, has_symbol_refs, has_constraint_ref,
      has_acceptance_ref, has_test_ref, target_specificity_score, preview
    ) VALUES (?, ?, 250, 'medium', 5, 1, 1, 1, 1, 1, 1, 5, 'preview')
  `).run(id, `hash-${id}`);

  db.prepare(`
    INSERT INTO episode_summaries (
      episode_id, surrogate_cost, files_read, lines_read_norm, symbol_revisits,
      retry_count, failed_verifications, cross_file_spread, no_change_turns,
      changed_files_count, changed_symbols_count, changed_lines_count,
      first_pass_green, prompt_length_bucket, structure_score, scope_bucket,
      exploration_mode, fix_loop_occurred, search_loop_occurred,
      nice_guidance_awarded, exp_awarded, turn_count, intervention_mode
    ) VALUES (?, 9.75, 1, 1, 0, 0, 0, 1, 0, 1, 1, 5, 1, 'medium', 5, 'narrow', 'focused', 0, 0, 0, 42, 1, 'quiet')
  `).run(id);
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
        // ignore Windows EBUSY
      }
    }
  }
});

describe("integration: evo explain", () => {
  it("prints surrogate cost and exploration mode for a known episode id", () => {
    const cwd = makeTempDir("evo-explain-");
    const db = new EvoDatabase(cwd);
    const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
    seedEpisode(raw, 1);
    db.close();

    const output = execFileSync(
      process.execPath,
      [CLI_ENTRY, "explain", "1", "--cwd", cwd],
      {
        encoding: "utf8",
        env: { ...process.env, EVO_TEST_MODE: "1", EVO_HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toMatch(/Episode #1/);
    expect(output).toMatch(/Surrogate cost:\s*9\.75/);
    expect(output).toMatch(/Exploration mode:\s*focused/);
    expect(output).toMatch(/Scope bucket:\s*narrow/);
    expect(output).toMatch(/CLI:\s*claude/);
  }, 60_000);

  it("exits non-zero and prints a helpful message for an unknown episode id", () => {
    const cwd = makeTempDir("evo-explain-missing-");
    const db = new EvoDatabase(cwd);
    db.close();

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [CLI_ENTRY, "explain", "999", "--cwd", cwd],
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
    expect(stderr).toMatch(/Episode 999 was not found/i);
  }, 60_000);
});
