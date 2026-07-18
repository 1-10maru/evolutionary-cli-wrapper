import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStatusData,
  renderStatus,
  stageLabelJa,
  StatusData,
} from "../src/cli/status";
import { MascotProfile, RecentEpisodeRecord } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EVO_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A stub health check so tests never load tree-sitter natives. */
const healthyStub = () => ({
  ok: true,
  checks: [
    { name: "bundle", ok: true },
    { name: "native-deps", ok: true },
    { name: "native-load", ok: true },
  ],
});

function goodEpisodeRecord(overrides: Partial<RecentEpisodeRecord> = {}): RecentEpisodeRecord {
  return {
    promptScore: 95,
    structureScore: 5,
    grade: "A",
    hadFixLoop: false,
    hadSearchLoop: false,
    signalKind: "",
    ts: Date.now(),
    ...overrides,
  };
}

function writeMascot(home: string, profile: Partial<MascotProfile>): void {
  const dir = path.join(home, ".evo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mascot.json"), JSON.stringify(profile));
}

describe("evo status — collectStatusData", () => {
  it("is fully read-only: creates no files or directories on a fresh dir", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;

    const data = collectStatusData(project, { health: healthyStub });

    // Nothing was created anywhere.
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(project)).toEqual([]);
    // Sections degrade to "no data" rather than throwing.
    expect(data.pet.present).toBe(false);
    expect(data.pet.gauge).toBe(-1);
    expect(data.session.present).toBe(false);
    expect(data.episodes.available).toBe(false);
  });

  it("reads mascot identity, gauge and streak from mascot.json", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    writeMascot(home, {
      speciesId: "fox",
      nickname: "Kitsune",
      stage: "buddy",
      totalBondExp: 777,
      mood: "happy",
      streakDays: 4,
      comboCount: 2,
      bestCombo: 6,
      recentEpisodes: Array.from({ length: 20 }, () => goodEpisodeRecord()),
    });

    const data = collectStatusData(project, { health: healthyStub });

    expect(data.pet.present).toBe(true);
    expect(data.pet.nickname).toBe("Kitsune");
    expect(data.pet.avatar).toBe("🦊");
    expect(data.pet.stage).toBe("buddy");
    expect(data.pet.stageLabel).toBe("実践者");
    // 20 sustained A-grade loop-free episodes at 95 → gauge hits 100.
    expect(data.pet.gauge).toBe(100);
    expect(data.pet.streakDays).toBe(4);
    expect(data.pet.lastGrade).toBe("A");
    expect(data.pet.totalBondExp).toBe(777);
    // Still no writes: the mascot file is untouched, nothing else created.
    expect(fs.readdirSync(path.join(home, ".evo"))).toEqual(["mascot.json"]);
  });

  it("tolerates a corrupt mascot.json (falls back to defaults, no crash, no write)", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const dir = path.join(home, ".evo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mascot.json"), "{not json");

    const data = collectStatusData(project, { health: healthyStub });
    expect(data.pet.present).toBe(false);
    expect(data.pet.nickname).toBe("EvoPet");
    expect(fs.readFileSync(path.join(dir, "mascot.json"), "utf8")).toBe("{not json");
  });

  it("picks the freshest live-state file (per-session beats stale legacy sink)", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const now = 1_800_000_000_000;
    const evoDir = path.join(project, ".evo");
    const sessionsDir = path.join(evoDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Stale legacy sink.
    fs.writeFileSync(
      path.join(evoDir, "live-state.json"),
      JSON.stringify({ updatedAt: now - 120_000, sessionGrade: "C", turns: 1 }),
    );
    // Fresh per-session file.
    fs.writeFileSync(
      path.join(sessionsDir, "abc.json"),
      JSON.stringify({
        updatedAt: now - 3_000,
        sessionGrade: "A",
        promptScore: 88,
        turns: 12,
        userMessages: 7,
        idealStateGauge: 64,
      }),
    );

    const data = collectStatusData(project, { health: healthyStub, now: () => now });

    expect(data.session.present).toBe(true);
    expect(data.session.fresh).toBe(true);
    expect(data.session.sessionGrade).toBe("A");
    expect(data.session.promptScore).toBe(88);
    expect(data.session.turns).toBe(12);
    expect(data.session.userMessages).toBe(7);
    expect(data.session.idealStateGauge).toBe(64);
    expect(data.session.source).toContain("abc.json");
  });

  it("marks an old live-state as present but not fresh", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const now = 1_800_000_000_000;
    const evoDir = path.join(project, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(
      path.join(evoDir, "live-state.json"),
      JSON.stringify({ updatedAt: now - 60_000, sessionGrade: "B", lastExitCode: 0 }),
    );

    const data = collectStatusData(project, { health: healthyStub, now: () => now });
    expect(data.session.present).toBe(true);
    expect(data.session.fresh).toBe(false);
    expect(data.session.lastExitCode).toBe(0);
  });

  it("tolerates a corrupt live-state file", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const evoDir = path.join(project, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(path.join(evoDir, "live-state.json"), "garbage{{");

    const data = collectStatusData(project, { health: healthyStub });
    expect(data.session.present).toBe(false);
  });

  it("reads episode count and last timestamp from an existing DB (readonly)", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const evoDir = path.join(project, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    // Build a minimal episodes DB directly (no EvoDatabase — that would also
    // create config.json and run the full schema).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(path.join(evoDir, "evolutionary.db"));
    db.exec(`
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL, cli TEXT NOT NULL, command TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER,
        prompt_hash TEXT NOT NULL, prompt_preview TEXT NOT NULL, termination_reason TEXT
      );
      CREATE TABLE archived_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_episode_id INTEGER NOT NULL UNIQUE,
        cli TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
      );
    `);
    const insert = db.prepare(
      "INSERT INTO episodes (cwd, cli, command, started_at, prompt_hash, prompt_preview) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(project, "claude", "claude", "2026-07-17T10:00:00.000Z", "h1", "");
    insert.run(project, "claude", "claude", "2026-07-18T02:30:00.000Z", "h2", "");
    db.prepare(
      "INSERT INTO archived_episodes (original_episode_id, cli, started_at) VALUES (?, ?, ?)",
    ).run(99, "claude", "2026-07-01T00:00:00.000Z");
    db.close();

    const data = collectStatusData(project, { health: healthyStub });
    expect(data.episodes.available).toBe(true);
    expect(data.episodes.episodeCount).toBe(3); // 2 active + 1 archived
    expect(data.episodes.archivedCount).toBe(1);
    expect(data.episodes.lastStartedAt).toBe("2026-07-18T02:30:00.000Z");
  });

  it("degrades gracefully when the DB file is corrupt", () => {
    const home = mkTemp("evo-status-home-");
    const project = mkTemp("evo-status-project-");
    process.env.EVO_HOME = home;
    const evoDir = path.join(project, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    fs.writeFileSync(path.join(evoDir, "evolutionary.db"), "this is not a sqlite file at all");

    const data = collectStatusData(project, { health: healthyStub });
    expect(data.episodes.available).toBe(false);
    expect(data.episodes.detail).toContain("DB読み取り不可");
  });
});

describe("evo status — renderStatus", () => {
  function baseData(overrides: Partial<StatusData> = {}): StatusData {
    return {
      cwd: "/tmp/project",
      generatedAt: Date.now(),
      pet: {
        present: true,
        avatar: "🐣",
        nickname: "EvoPet",
        speciesId: "chick",
        stage: "sprout",
        stageLabel: "見習い",
        gauge: 42,
        mood: "happy",
        streakDays: 2,
        comboCount: 1,
        bestCombo: 3,
        totalBondExp: 120,
        lastGrade: "B",
        windowSize: 8,
      },
      session: {
        present: true,
        source: "/tmp/project/.evo/sessions/abc.json",
        ageMs: 4_000,
        fresh: true,
        sessionGrade: "A",
        promptScore: 91,
        turns: 10,
        userMessages: 5,
        idealStateGauge: 66,
        lastExitCode: null,
      },
      doctor: {
        ok: true,
        checks: [
          { name: "bundle", ok: true },
          { name: "native-deps", ok: true },
          { name: "native-load", ok: true },
        ],
      },
      episodes: {
        available: true,
        detail: null,
        episodeCount: 12,
        archivedCount: 2,
        lastStartedAt: "2026-07-18T02:30:00.000Z",
      },
      ...overrides,
    };
  }

  it("renders all five information groups with Japanese labels", () => {
    const out = renderStatus(baseData());
    expect(out).toContain("EvoPet ステータス");
    expect(out).toContain("見習い");
    expect(out).toContain("育成度 42%");
    expect(out).toContain("連続いい指示 2日");
    expect(out).toContain("セッション");
    expect(out).toContain("稼働中");
    expect(out).toContain("グレード A");
    expect(out).toContain("指示の質 91");
    expect(out).toContain("クイック診断");
    expect(out).toContain("エピソード履歴");
    expect(out).toContain("記録 12件");
    expect(out).toContain("2026-07-18");
  });

  it("renders 測定中 for a -1 gauge and no-data lines for empty sections", () => {
    const data = baseData({
      pet: {
        present: false,
        avatar: "🐣",
        nickname: "EvoPet",
        speciesId: "chick",
        stage: "egg",
        stageLabel: "初心者",
        gauge: -1,
        mood: "sleepy",
        streakDays: 0,
        comboCount: 0,
        bestCombo: 0,
        totalBondExp: 0,
        lastGrade: null,
        windowSize: 0,
      },
      session: {
        present: false,
        source: null,
        ageMs: null,
        fresh: false,
        sessionGrade: null,
        promptScore: null,
        turns: null,
        userMessages: null,
        idealStateGauge: null,
        lastExitCode: null,
      },
      episodes: {
        available: false,
        detail: "まだ記録がありません (.evo/evolutionary.db なし)",
        episodeCount: 0,
        archivedCount: 0,
        lastStartedAt: null,
      },
    });
    const out = renderStatus(data);
    expect(out).toContain("育成度 測定中");
    expect(out).toContain("ライブセッションはありません");
    expect(out).toContain("まだ記録がありません");
  });

  it("surfaces failing doctor checks with their detail", () => {
    const data = baseData({
      doctor: {
        ok: false,
        checks: [
          { name: "bundle", ok: true },
          { name: "native-load", ok: false, detail: "tree-sitter: build failed" },
        ],
      },
    });
    const out = renderStatus(data);
    expect(out).toContain("native-load");
    expect(out).toContain("tree-sitter: build failed");
    expect(out).toContain("evo doctor");
  });

  it("stageLabelJa maps every stage", () => {
    expect(stageLabelJa("egg")).toBe("初心者");
    expect(stageLabelJa("sprout")).toBe("見習い");
    expect(stageLabelJa("buddy")).toBe("実践者");
    expect(stageLabelJa("wizard")).toBe("熟練者");
    expect(stageLabelJa("legend")).toBe("達人");
  });
});
