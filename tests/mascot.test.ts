import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseMascotSpecies,
  listMascotSpecies,
  loadMascotProfile,
  renderMascotState,
  renderMascotTurnLine,
  updateMascotAfterEpisode,
} from "../src/mascot";
import { EpisodeSummary, MascotProfile, RecentEpisodeRecord, TurnSummary } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EVO_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createSummary(overrides: Partial<EpisodeSummary> = {}): EpisodeSummary {
  return {
    surrogateCost: 3.2,
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
    predictedLossRate: 0.22,
    expAwarded: 50,
    turnCount: 1,
    interventionMode: "active",
    ...overrides,
  };
}

describe("mascot", () => {
  it("stores a single global mascot profile under EVO_HOME", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    const profile = loadMascotProfile(project);

    expect(profile.nickname).toBe("EvoPet");
    expect(fs.existsSync(path.join(home, ".evo", "mascot.json"))).toBe(true);
  });

  it("supports choosing from a built-in emoji species list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    const species = listMascotSpecies();
    const chosen = chooseMascotSpecies(project, "fox");

    expect(species.length).toBeGreaterThanOrEqual(10);
    expect(chosen.speciesId).toBe("fox");
  });

  it("levels up the mascot when ISG-based stage threshold is crossed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    // v3.1: stage now ISG-driven. Feed high-quality episodes with prompt
    // metrics that compute to ISG >= 25 (sprout threshold).
    const highQuality = { promptScore: 90, sessionGrade: "A", signalKind: "" };
    let lastUpdate = updateMascotAfterEpisode(project, createSummary(), 4, highQuality);
    for (let i = 0; i < 5; i++) {
      lastUpdate = updateMascotAfterEpisode(project, createSummary(), 4, highQuality);
    }

    // Stage should advance past egg as ISG climbs out of the egg band.
    expect(lastUpdate.nextStage).not.toBe("egg");
  });

  it("renders a compact one-line turn message", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    const profile = loadMascotProfile(project);
    const summary: TurnSummary = {
      turnIndex: 1,
      promptProfile: {
        promptHash: "abc123",
        promptLength: 20,
        promptLengthBucket: "15-39",
        structureScore: 2,
        hasBullets: false,
        hasFileRefs: false,
        hasSymbolRefs: false,
        hasConstraintRef: false,
        hasAcceptanceRef: false,
        hasTestRef: false,
        targetSpecificityScore: 1,
        preview: "fix login",
      },
      score: {
        filesRead: 1,
        linesReadNorm: 1,
        symbolRevisits: 0,
        retryCount: 0,
        failedVerifications: 0,
        crossFileSpread: 0,
        noChangeTurns: 0,
        attentionEntropy: 0.2,
        attentionCompression: 0.3,
        noveltyRatio: 0.8,
        repeatedAttentionRatio: 0.1,
        explorationPenalty: 0.1,
        convergenceBonus: 0.2,
        surrogateCost: 2.3,
      },
      complexity: {
        changedFilesCount: 1,
        changedFilesBucket: "1",
        changedSymbolsCount: 0,
        changedSymbolsBucket: "1",
        changedLinesCount: 0,
        changedLinesBucket: "1-20",
        testsPresent: false,
        languages: [],
        explorationHeavy: false,
        explorationMode: "balanced",
        attentionEntropy: 0.2,
        attentionCompression: 0.3,
        noveltyRatio: 0.8,
        repeatedAttentionRatio: 0.1,
        scopeBucket: "1|1|1-20",
      },
      friction: {
        approvalCount: 0,
        approvalBurst: 0,
        toolErrorCount: 0,
        toolRetryCount: 0,
        toolFailureStreak: 0,
        editFailureCount: 0,
        recoveryAttempts: 0,
        humanConfirmationBurst: 0,
        frictionScore: 0.1,
        stopAndReframeSignal: false,
        dominantSignal: "none",
        confidence: 0.3,
      },
      stopAndReframe: {
        stopAndReframeSignal: false,
        category: "none",
        confidence: 0.3,
        reasonCodes: [],
        suggestedReframe: "",
        avoidableCostLabel: "",
      },
      loopSignals: {
        editLoop: false,
        searchLoop: false,
        touchedStableSymbolIds: [],
      },
      nudges: [
        {
          counterfactual: "plus_10_chars_specificity",
          currentCost: 6,
          counterfactualCost: 5,
          predictedSavingRate: 0.18,
          confidence: 0.66,
          explanation: "next",
          category: "specificity",
          supportSampleSize: 8,
          bucketLevel: "backoff1",
        },
      ],
      intervention: {
        mode: "active",
        reasonCodes: ["high_saving_headroom"],
        confidence: 0.66,
        displayBudgetLines: 1,
      },
      adviceMessages: [
        {
          key: "nudge-specificity",
          category: "specificity",
          severity: "medium",
          tone: "encouraging",
          surface: "end_of_turn",
          text: "test",
          lineBudget: 1,
          predictedSavingRate: 0.18,
        },
      ],
      responseLatencyMs: 500,
      assistantReaskRate: 0,
      turnRetryDepth: 0,
      responseLatencyBucket: "fast",
      midEpisodeNoveltyDrop: 0.2,
      recentNudgeEffectiveness: 0.5,
    };

    const line = renderMascotTurnLine(profile, summary);

    expect(line).toContain("EvoPet");
    expect(line.includes("\n")).toBe(false);
  });

  it("progressPercent reflects ISG (not stage progress) — empty episodes returns -1", () => {
    const profile: MascotProfile = {
      speciesId: "chick",
      nickname: "EvoPet",
      stage: "legend",
      totalBondExp: 99999,
      mood: "sleepy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 0,
      recentEpisodes: [],
    };
    const state = renderMascotState(profile);
    // Used to lock at 100 on legend stage; now it should signal "no data" (-1).
    expect(state.progressPercent).toBe(-1);
  });

  it("progressPercent on legend stage varies with ISG (not pinned to 100)", () => {
    const baseRecord: RecentEpisodeRecord = {
      promptScore: 60,
      structureScore: 2,
      grade: "C",
      hadFixLoop: true,
      hadSearchLoop: false,
      signalKind: "no_success_criteria",
      ts: Date.now(),
    };
    const profile: MascotProfile = {
      speciesId: "chick",
      nickname: "EvoPet",
      stage: "legend",
      totalBondExp: 99999,
      mood: "sleepy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 0,
      recentEpisodes: Array.from({ length: 10 }, () => ({ ...baseRecord })),
    };
    const state = renderMascotState(profile);
    // Bad-quality history must NOT yield 100 even on legend stage.
    expect(state.progressPercent).toBeLessThan(100);
    expect(state.progressPercent).toBeGreaterThanOrEqual(0);
  });

  it("stageForIsg returns egg for empty/low-quality history", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    // promptScore=0 -> ISG ~ 0 -> egg
    const lowQuality = { promptScore: 0, sessionGrade: "C", signalKind: "" };
    let update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);
    for (let i = 0; i < 5; i++) {
      update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);
    }
    expect(update.nextStage).toBe("egg");
  });

  it("stageForIsg reaches sprout band at promptScore ~30%", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    // promptScore=30 -> ISG just above 25 (sprout). No fix loops -> no penalty.
    const midQuality = { promptScore: 30, sessionGrade: "B", signalKind: "" };
    let update = updateMascotAfterEpisode(project, createSummary({ fixLoopOccurred: false }), 4, midQuality);
    for (let i = 0; i < 6; i++) {
      update = updateMascotAfterEpisode(project, createSummary({ fixLoopOccurred: false }), 4, midQuality);
    }
    // Should be sprout (>=25) or higher, never "egg".
    expect(update.nextStage).not.toBe("egg");
  });

  it("stageForIsg reaches legend band at sustained promptScore ~85%+", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    const highQuality = { promptScore: 95, sessionGrade: "A", signalKind: "" };
    let update = updateMascotAfterEpisode(
      project,
      createSummary({ structureScore: 5, fixLoopOccurred: false, searchLoopOccurred: false }),
      5,
      highQuality,
    );
    for (let i = 0; i < 12; i++) {
      update = updateMascotAfterEpisode(
        project,
        createSummary({ structureScore: 5, fixLoopOccurred: false, searchLoopOccurred: false }),
        5,
        highQuality,
      );
    }
    expect(update.nextStage).toBe("legend");
  });

  it("legend stage with bad recent episodes is demoted under ISG", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    // Seed a "stuck on legend" profile manually (mimics the v3.0 bug).
    const seedProfile: MascotProfile = {
      speciesId: "fox",
      nickname: "EvoPet",
      stage: "legend",
      totalBondExp: 9135,
      mood: "happy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 1,
      recentEpisodes: Array.from({ length: 10 }, () => ({
        promptScore: 0,
        structureScore: 0,
        grade: "C",
        hadFixLoop: false,
        hadSearchLoop: false,
        signalKind: "",
        ts: Date.now(),
      })),
    };
    fs.mkdirSync(path.join(home, ".evo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".evo", "mascot.json"), JSON.stringify(seedProfile));

    // Run an episode through the new logic.
    const lowQuality = { promptScore: 0, sessionGrade: "C", signalKind: "" };
    const update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);

    // Must not remain on legend with this quality history.
    expect(update.nextStage).not.toBe("legend");
    expect(update.nextStage).toBe("egg");
  });

  it("stage level index follows the canonical egg→legend ladder", () => {
    // stageIndex now derives from the ISG curve (single authoritative curve);
    // the visible level (index+1) must stay 1..5 in ladder order.
    const stages: Array<[MascotProfile["stage"], number]> = [
      ["egg", 1],
      ["sprout", 2],
      ["buddy", 3],
      ["wizard", 4],
      ["legend", 5],
    ];
    for (const [stage, level] of stages) {
      const profile: MascotProfile = {
        speciesId: "chick",
        nickname: "EvoPet",
        stage,
        totalBondExp: 0,
        mood: "sleepy",
        streakDays: 0,
        lastSeenAt: null,
        favoriteHintStyle: "none",
        lastMessages: [],
        comboCount: 0,
        bestCombo: 0,
        recentEpisodes: [],
      };
      expect(renderMascotState(profile).level).toBe(level);
    }
  });

  it("progressPercent rises with high-quality episodes on egg stage", () => {
    const goodRecord: RecentEpisodeRecord = {
      promptScore: 95,
      structureScore: 5,
      grade: "A",
      hadFixLoop: false,
      hadSearchLoop: false,
      signalKind: "",
      ts: Date.now(),
    };
    const profile: MascotProfile = {
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
      recentEpisodes: Array.from({ length: 20 }, () => ({ ...goodRecord })),
    };
    const state = renderMascotState(profile);
    // ISG should reach 100 when gate met, regardless of being on egg stage.
    expect(state.progressPercent).toBe(100);
  });
});

// B6 regression suite: the legacy cumulative-EXP curve is retired; ISG is the
// single authoritative growth curve. Existing data written by pre-v3.1
// versions (EXP-derived stage, high totalBondExp, no recentEpisodes field)
// must keep loading and updating without crashes or stage corruption, and
// totalBondExp must keep accumulating (it is display-only, not a stage driver).
describe("mascot — legacy EXP-curve data compatibility", () => {
  function seedProfile(home: string, profile: Record<string, unknown>): void {
    fs.mkdirSync(path.join(home, ".evo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".evo", "mascot.json"), JSON.stringify(profile));
  }

  function setup(): { home: string; project: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;
    return { home, project };
  }

  it("loads a pre-v3.1 profile (EXP-era stage, no recentEpisodes) without crashing", () => {
    const { home, project } = setup();
    // Shape written by the EXP-curve era: stage promoted by EXP thresholds
    // (>=1400 EXP → legend), and no recentEpisodes field at all.
    seedProfile(home, {
      speciesId: "cat",
      nickname: "EvoPet",
      stage: "legend",
      totalBondExp: 2000,
      mood: "happy",
      streakDays: 7,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 4,
    });

    const profile = loadMascotProfile(project);
    expect(profile.stage).toBe("legend"); // kept on load — no silent rewrite
    expect(profile.totalBondExp).toBe(2000); // EXP preserved
    expect(profile.recentEpisodes).toEqual([]); // defaulted, not undefined

    const state = renderMascotState(profile);
    expect(state.level).toBe(5); // legend still renders as level 5
    expect(state.progressPercent).toBe(-1); // no quality data yet → 測定中
  });

  it("keeps accumulating totalBondExp while stage is re-derived from ISG only", () => {
    const { home, project } = setup();
    seedProfile(home, {
      speciesId: "dog",
      nickname: "EvoPet",
      stage: "wizard", // EXP-era stage (>=720 EXP)
      totalBondExp: 800,
      mood: "sleepy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 0,
    });

    const lowQuality = { promptScore: 0, sessionGrade: "C", signalKind: "" };
    const update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);

    // EXP keeps growing from the legacy total (display-only bookkeeping)...
    expect(update.totalBondExp).toBeGreaterThan(800);
    // ...but stage came from ISG, not from the 800+ EXP (which under the
    // retired curve would have kept wizard/legend).
    expect(update.nextStage).toBe("egg");
    expect(update.previousStage).toBe("wizard");
  });

  it("high legacy EXP alone can never promote the stage", () => {
    const { home, project } = setup();
    // Absurdly high EXP, zero-quality history — the retired curve would say
    // legend; the authoritative ISG curve must say egg.
    seedProfile(home, {
      speciesId: "chick",
      nickname: "EvoPet",
      stage: "egg",
      totalBondExp: 999999,
      mood: "sleepy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 0,
    });

    const lowQuality = { promptScore: 10, sessionGrade: "C", signalKind: "" };
    let update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);
    for (let i = 0; i < 3; i++) {
      update = updateMascotAfterEpisode(project, createSummary(), 0, lowQuality);
    }
    expect(update.nextStage).toBe("egg");
    expect(update.totalBondExp).toBeGreaterThan(999999);
  });

  it("legacy profile still promotes normally once quality is sustained (ISG path)", () => {
    const { home, project } = setup();
    seedProfile(home, {
      speciesId: "fox",
      nickname: "EvoPet",
      stage: "egg",
      totalBondExp: 1500, // legacy EXP total — must not interfere either way
      mood: "sleepy",
      streakDays: 0,
      lastSeenAt: null,
      favoriteHintStyle: "none",
      lastMessages: [],
      comboCount: 0,
      bestCombo: 0,
    });

    const highQuality = { promptScore: 95, sessionGrade: "A", signalKind: "" };
    let update = updateMascotAfterEpisode(
      project,
      createSummary({ structureScore: 5 }),
      5,
      highQuality,
    );
    let everLeveledUp = update.leveledUp;
    for (let i = 0; i < 12; i++) {
      update = updateMascotAfterEpisode(
        project,
        createSummary({ structureScore: 5 }),
        5,
        highQuality,
      );
      everLeveledUp = everLeveledUp || update.leveledUp;
    }
    expect(update.nextStage).toBe("legend");
    expect(everLeveledUp).toBe(true);
  });
});
