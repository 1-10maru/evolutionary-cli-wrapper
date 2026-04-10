import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseMascotSpecies,
  listMascotSpecies,
  loadMascotProfile,
  renderMascotTurnLine,
  updateMascotAfterEpisode,
} from "../src/mascot";
import { EpisodeSummary, TurnSummary } from "../src/types";

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

  it("levels up the mascot with accumulated EXP", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(home, project);
    process.env.EVO_HOME = home;

    loadMascotProfile(project);
    // Skill-based EXP: structured + first-pass-green + balanced = ~110 per episode
    // sprout threshold is 120, so 2 good episodes should level up
    updateMascotAfterEpisode(project, createSummary());
    const update = updateMascotAfterEpisode(project, createSummary());

    expect(update.leveledUp).toBe(true);
    expect(update.nextStage).toBe("sprout");
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
});
