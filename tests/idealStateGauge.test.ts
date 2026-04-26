import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeIdealStateGauge,
  loadMascotProfile,
  saveMascotProfile,
  updateMascotAfterEpisode,
} from "../src/mascot";
import { EpisodeSummary, MascotProfile, RecentEpisodeRecord } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EVO_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSummary(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    surrogateCost: 3,
    filesRead: 1,
    linesReadNorm: 1,
    symbolRevisits: 0,
    retryCount: 0,
    failedVerifications: 0,
    crossFileSpread: 0,
    noChangeTurns: 0,
    changedFilesCount: 1,
    changedSymbolsCount: 0,
    changedLinesCount: 0,
    firstPassGreen: true,
    promptLengthBucket: "15-39",
    structureScore: 4,
    scopeBucket: "1|1|1-20",
    explorationMode: "balanced",
    attentionEntropy: 0.2,
    attentionCompression: 0.4,
    noveltyRatio: 0.8,
    expectedCostConfidence: 0.7,
    approvalCount: 0,
    approvalBurst: 0,
    toolErrorCount: 0,
    toolRetryCount: 0,
    toolFailureStreak: 0,
    editFailureCount: 0,
    recoveryAttempts: 0,
    humanConfirmationBurst: 0,
    frictionScore: 0,
    stopAndReframeSignal: false,
    bestStopTurn: null,
    suggestedReframe: null,
    fixLoopOccurred: false,
    searchLoopOccurred: false,
    niceGuidanceAwarded: true,
    predictedLossRate: 0.1,
    expAwarded: 50,
    turnCount: 1,
    interventionMode: "active",
    ...overrides,
  };
}

function buildProfile(records: RecentEpisodeRecord[]): MascotProfile {
  return {
    speciesId: "chick",
    nickname: "EvoPet",
    stage: "egg",
    totalBondExp: 0,
    mood: "sleepy",
    streakDays: 0,
    lastSeenAt: null,
    favoriteHintStyle: "none",
    lastMessages: [],
    comboCount: 0,
    bestCombo: 0,
    recentEpisodes: records,
  };
}

function record(overrides: Partial<RecentEpisodeRecord> = {}): RecentEpisodeRecord {
  return {
    promptScore: 70,
    structureScore: 3,
    grade: "B",
    hadFixLoop: false,
    hadSearchLoop: false,
    signalKind: "",
    ts: Date.now(),
    ...overrides,
  };
}

describe("computeIdealStateGauge", () => {
  it("returns -1 when no episodes recorded yet", () => {
    expect(computeIdealStateGauge(buildProfile([]))).toBe(-1);
  });

  it("reaches 100 only when all gate conditions are met", () => {
    const records = Array.from({ length: 20 }, () =>
      record({ promptScore: 95, structureScore: 5, grade: "A", signalKind: "" }),
    );
    const isg = computeIdealStateGauge(buildProfile(records));
    expect(isg).toBe(100);
  });

  it("caps at 90 when avg promptScore is below 90 even without loops", () => {
    const records = Array.from({ length: 20 }, () =>
      record({ promptScore: 85, structureScore: 5, grade: "A" }),
    );
    const isg = computeIdealStateGauge(buildProfile(records));
    expect(isg).toBeLessThanOrEqual(90);
    expect(isg).toBeGreaterThanOrEqual(80);
  });

  it("drops sharply when fixLoop incidents exist", () => {
    const records: RecentEpisodeRecord[] = [
      record({ promptScore: 95, structureScore: 5, grade: "A", hadFixLoop: true }),
      ...Array.from({ length: 9 }, () =>
        record({ promptScore: 95, structureScore: 5, grade: "A" }),
      ),
    ];
    const isg = computeIdealStateGauge(buildProfile(records));
    // 1/10 loop_rate = 10% → penalty 10. avg_prompt = 95 → base 95.
    // Gate fails (last 5 includes the loop), so capped at 90.
    expect(isg).toBeLessThanOrEqual(90);
  });

  it("rewards consecutive A-grade streak with bonus", () => {
    const baseRecords = Array.from({ length: 20 }, () =>
      record({ promptScore: 80, structureScore: 4, grade: "B" }),
    );
    const noStreakIsg = computeIdealStateGauge(buildProfile(baseRecords));

    const streakRecords = [
      ...Array.from({ length: 5 }, () =>
        record({ promptScore: 80, structureScore: 4, grade: "A" }),
      ),
      ...baseRecords.slice(5),
    ];
    const streakIsg = computeIdealStateGauge(buildProfile(streakRecords));

    expect(streakIsg).toBeGreaterThan(noStreakIsg);
  });

  it("persists recentEpisodes via updateMascotAfterEpisode and feeds ISG", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-isg-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-isg-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    for (let i = 0; i < 3; i++) {
      updateMascotAfterEpisode(project, makeSummary(), 0, {
        promptScore: 92,
        sessionGrade: "A",
        signalKind: "",
      });
    }
    const profile = loadMascotProfile(project);
    expect(profile.recentEpisodes?.length).toBe(3);
    expect(profile.recentEpisodes?.[0].promptScore).toBe(92);
    expect(profile.recentEpisodes?.[0].grade).toBe("A");
  });

  it("respects the rolling window cap of 20", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-cap-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-cap-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    for (let i = 0; i < 25; i++) {
      updateMascotAfterEpisode(project, makeSummary(), 0, {
        promptScore: 50 + i,
        sessionGrade: "B",
        signalKind: "",
      });
    }
    const profile = loadMascotProfile(project);
    expect(profile.recentEpisodes?.length).toBe(20);
    // Newest first
    expect(profile.recentEpisodes?.[0].promptScore).toBe(74);
  });

  it("does not append when qualityMetrics is omitted (back-compat)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-bc-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-bc-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    updateMascotAfterEpisode(project, makeSummary());
    const profile = loadMascotProfile(project);
    expect(profile.recentEpisodes?.length ?? 0).toBe(0);
  });
});

// Ensure saveMascotProfile is exercised (not part of public surface guarantee — kept for clarity)
void saveMascotProfile;
