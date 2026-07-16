import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import { EvoDatabase } from "../src/db";
import { extractPromptProfile } from "../src/promptProfile";
import type { TurnRecord } from "../src/types";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeCwd(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(cwd);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"demo"}');
  return cwd;
}

function makeTurn(inputText: string): TurnRecord {
  return {
    turnIndex: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    promptProfile: extractPromptProfile(inputText),
    inputText,
    outputPreview: "output preview",
    events: [],
  };
}

function readTurn(db: EvoDatabase, episodeId: number): {
  input_text: string;
  input_text_sha256: string;
  input_text_length: number;
  prompt_preview: string;
  output_preview: string;
} {
  return db.db
    .prepare(
      "SELECT input_text, input_text_sha256, input_text_length, prompt_preview, output_preview FROM turns WHERE episode_id = ? AND turn_index = 0",
    )
    .get(episodeId) as never;
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("prompt-capture privacy", () => {
  it("caps stored input_text at 500 chars and stores the full-text sha256 + length", () => {
    const cwd = makeCwd("evo-priv-cap-");
    const db = new EvoDatabase(cwd);
    const episodeId = db.createEpisode({
      cwd,
      cli: "claude",
      command: ["echo", "hi"],
      startedAt: new Date().toISOString(),
      promptProfile: extractPromptProfile("hello"),
    });
    const full = "x".repeat(2000);
    db.saveTurns(episodeId, [makeTurn(full)], []);

    const row = readTurn(db, episodeId);
    expect(row.input_text.length).toBe(500);
    expect(row.input_text).toBe(full.slice(0, 500));
    expect(row.input_text_length).toBe(2000);
    expect(row.input_text_sha256).toBe(sha(full));
    db.close();
  });

  it("stores no text (only hash + length) when capture.promptText is false", () => {
    const cwd = makeCwd("evo-priv-off-");
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, { ...config, capture: { ...config.capture, promptText: false } });

    const db = new EvoDatabase(cwd);
    const episodeId = db.createEpisode({
      cwd,
      cli: "claude",
      command: ["echo", "hi"],
      startedAt: new Date().toISOString(),
      promptProfile: extractPromptProfile("a secret prompt"),
    });
    const secret = "a secret prompt with sensitive content";
    db.saveTurns(episodeId, [makeTurn(secret)], []);

    const row = readTurn(db, episodeId);
    expect(row.input_text).toBe("");
    expect(row.prompt_preview).toBe("");
    // The output preview is covered by the promise too (CLI output can echo
    // the input back).
    expect(row.output_preview).toBe("");
    // Hash + length of the full input are still retained.
    expect(row.input_text_length).toBe(secret.length);
    expect(row.input_text_sha256).toBe(sha(secret));

    // The episode-level preview is blanked too.
    const ep = db.db.prepare("SELECT prompt_preview FROM episodes WHERE id = ?").get(episodeId) as {
      prompt_preview: string;
    };
    expect(ep.prompt_preview).toBe("");
    db.close();
  });
});
