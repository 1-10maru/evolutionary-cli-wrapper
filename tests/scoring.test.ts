import { describe, expect, it } from "vitest";
import {
  buildEpisodeComplexity,
  buildEpisodeSummary,
  buildTurnSummary,
  computeLoopSignals,
  computePredictiveNudges,
  computeScoreBreakdown,
  computeInterventionDecision,
  StatsLookup,
} from "../src/scoring";
import { extractPromptProfile } from "../src/promptProfile";
import { EpisodeEvent } from "../src/types";

const statsStub: StatsLookup = {
  lookupExpectedCost(promptProfile) {
    return {
      bucketLevel: "global",
      bucketKey: "global",
      sampleSize: 10,
      baseCost: Math.max(3, 12 - promptProfile.structureScore * 2),
      recencyPenalty: 0.2,
      uncertaintyPenalty: 0.4,
      explorationPenalty: 0.1,
      structureBonus: 0.5,
      verificationBonus: 0.2,
      expectedCost: Math.max(3, 12 - promptProfile.structureScore * 2),
      confidence: 0.7,
    };
  },
  getRecentSymbolTouchCount(stableSymbolId) {
    return stableSymbolId === "hot-path" ? 2 : 0;
  },
  getRecentSearchLoopOverlap() {
    return 0.8;
  },
};

describe("scoring", () => {
  it("computes surrogate cost from event pressure", () => {
    const events: EpisodeEvent[] = [
      { type: "file_read", source: "adapter", timestamp: "2026-01-01T00:00:00.000Z", details: { path: "src/a.ts" } },
      { type: "file_read", source: "adapter", timestamp: "2026-01-01T00:00:01.000Z", details: { path: "src/b.ts" } },
      { type: "clarification_prompt", source: "adapter", timestamp: "2026-01-01T00:00:02.000Z", details: {} },
      { type: "test_run", source: "verification", timestamp: "2026-01-01T00:00:03.000Z", details: {} },
      { type: "test_run", source: "verification", timestamp: "2026-01-01T00:00:04.000Z", details: {} },
    ];
    const complexity = buildEpisodeComplexity({
      changedFilesCount: 2,
      changedSymbolsCount: 1,
      changedLinesCount: 30,
      languages: ["typescript"],
      testsPresent: true,
      filesRead: 2,
      searchCount: 0,
      attentionPaths: ["src/a.ts", "src/b.ts", "src/a.ts"],
    });

    const score = computeScoreBreakdown({
      events,
      complexity,
      touchedStableSymbolIds: ["hot-path"],
      stats: statsStub,
      failedVerifications: 1,
    });

    expect(score.filesRead).toBe(2);
    expect(score.retryCount).toBe(2);
    expect(score.symbolRevisits).toBe(1);
    expect(score.attentionEntropy).toBeGreaterThanOrEqual(0);
    expect(score.surrogateCost).toBeGreaterThan(0);
  });

  it("creates positive predictive nudges for stronger prompts", () => {
    const profile = extractPromptProfile("fix it");
    const complexity = buildEpisodeComplexity({
      changedFilesCount: 3,
      changedSymbolsCount: 2,
      changedLinesCount: 40,
      languages: ["typescript"],
      testsPresent: true,
      filesRead: 0,
      searchCount: 0,
      attentionPaths: [],
    });

    const nudges = computePredictiveNudges(profile, complexity, statsStub);

    expect(nudges).toHaveLength(3);
    expect(nudges.some((item) => item.predictedSavingRate > 0)).toBe(true);
    expect(nudges.every((item) => item.confidence > 0)).toBe(true);
  });

  it("detects edit and search loops from history signals", () => {
    const events: EpisodeEvent[] = [
      { type: "file_read", source: "adapter", timestamp: "2026-01-01T00:00:00.000Z", details: { path: "src/a.ts" } },
    ];

    const loops = computeLoopSignals({
      touchedStableSymbolIds: ["hot-path"],
      changedFiles: ["src/a.ts"],
      events,
      stats: statsStub,
      firstPassGreen: false,
    });

    expect(loops.editLoop).toBe(true);
  });

  it("awards nice guidance when structure and first-pass green align", () => {
    const promptProfile = extractPromptProfile(`
- update src/index.ts
- keep formatMessage()
done when tests pass
    `);
    const complexity = buildEpisodeComplexity({
      changedFilesCount: 1,
      changedSymbolsCount: 1,
      changedLinesCount: 10,
      languages: ["typescript"],
      testsPresent: true,
      filesRead: 1,
      searchCount: 0,
      attentionPaths: ["src/index.ts"],
    });
    const score = computeScoreBreakdown({
      events: [],
      complexity,
      touchedStableSymbolIds: [],
      stats: statsStub,
      failedVerifications: 0,
    });
    const nudges = computePredictiveNudges(promptProfile, complexity, statsStub);
    const summary = buildEpisodeSummary({
      score,
      promptProfile,
      complexity,
      firstPassGreen: true,
      loopSignals: { editLoop: false, searchLoop: false, touchedStableSymbolIds: [] },
      nudges,
      currentEstimate: statsStub.lookupExpectedCost(promptProfile, complexity),
      changedFilesCount: 1,
      changedSymbolsCount: 1,
      changedLinesCount: 10,
    });

    expect(summary.niceGuidanceAwarded).toBe(true);
    expect(summary.expAwarded).toBeGreaterThanOrEqual(50);
    expect(summary.expectedCostConfidence).toBeGreaterThan(0);
  });

  it("switches to active intervention when loop and saving headroom are both strong", () => {
    const profile = extractPromptProfile("fix it");
    const complexity = buildEpisodeComplexity({
      changedFilesCount: 3,
      changedSymbolsCount: 0,
      changedLinesCount: 0,
      languages: [],
      testsPresent: false,
      filesRead: 4,
      searchCount: 3,
      attentionPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"],
    });
    const nudges = computePredictiveNudges(profile, complexity, statsStub);
    const intervention = computeInterventionDecision({
      nudges,
      loopSignals: { editLoop: false, searchLoop: true, touchedStableSymbolIds: [] },
      complexity,
      confidence: 0.8,
      assistantReaskRate: 0.3,
      turnRetryDepth: 2,
      recentNudgeEffectiveness: 0.1,
      mode: "auto",
    });

    expect(intervention.mode).toBe("active");
    expect(intervention.displayBudgetLines).toBeGreaterThan(0);
  });

  it("renders advice messages for turn summaries without repeating stale guidance", () => {
    const promptProfile = extractPromptProfile("fix it");
    const turn = buildTurnSummary({
      turnIndex: 1,
      promptProfile,
      events: [
        { type: "file_read", source: "adapter", timestamp: "2026-01-01T00:00:00.000Z", details: { path: "src/a.ts" } },
        { type: "search", source: "adapter", timestamp: "2026-01-01T00:00:01.000Z", details: { path: "src/a.ts" } },
      ],
      complexity: buildEpisodeComplexity({
        changedFilesCount: 2,
        changedSymbolsCount: 0,
        changedLinesCount: 0,
        languages: [],
        testsPresent: false,
        filesRead: 1,
        searchCount: 1,
        attentionPaths: ["src/a.ts", "src/a.ts", "src/b.ts"],
      }),
      touchedStableSymbolIds: [],
      stats: statsStub,
      failedVerifications: 0,
      firstPassGreen: true,
      responseLatencyMs: 8000,
      turnRetryDepth: 1,
      recentMessageKeys: [],
      mode: "active",
      minConfidenceForPercent: 0.5,
      maxLines: 2,
    });

    expect(turn.intervention.mode).toBe("active");
    expect(turn.adviceMessages.length).toBeGreaterThan(0);
  });
});
