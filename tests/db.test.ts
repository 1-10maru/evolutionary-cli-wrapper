import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import { EvoDatabase } from "../src/db";
import { extractPromptProfile } from "../src/promptProfile";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("database retention", () => {
  it("compacts old raw episodes into archived summaries", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-db-"));
    tempDirs.push(cwd);
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      retention: {
        ...config.retention,
        keepRecentRawEpisodes: 1,
        compactOnRun: false,
      },
    });

    const db = new EvoDatabase(cwd);
    for (let index = 0; index < 3; index += 1) {
      const promptProfile = extractPromptProfile(`- update file${index}.ts\n- done when tests pass`);
      const episodeId = db.createEpisode({
        cwd,
        cli: "claude",
        command: ["echo", "hello"],
        startedAt: new Date(2026, 0, index + 1).toISOString(),
        promptProfile,
      });
      db.finishEpisode(episodeId, {
        finishedAt: new Date(2026, 0, index + 1, 0, 0, 5).toISOString(),
        exitCode: 0,
        terminationReason: "completed",
        summary: {
          surrogateCost: 1 + index,
          filesRead: 1,
          linesReadNorm: 1,
          symbolRevisits: 0,
          retryCount: 0,
          failedVerifications: 0,
          crossFileSpread: 0,
          noChangeTurns: 0,
          changedFilesCount: 1,
          changedSymbolsCount: 1,
          changedLinesCount: 1,
          firstPassGreen: true,
          promptLengthBucket: "40-79",
          structureScore: 4,
          scopeBucket: "1|1|1-20",
          explorationMode: "balanced",
          attentionEntropy: 0.2,
          attentionCompression: 0.1,
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
          predictedLossRate: null,
          expAwarded: 50,
        },
      });
    }

    const result = db.compactRawEpisodes();
    const overview = db.getStatsOverview();

    expect(result.compactedEpisodes).toBe(2);
    expect(overview.activeEpisodeCount).toBe(1);
    expect(overview.archivedEpisodeCount).toBe(2);
    expect(overview.totalEpisodes).toBe(3);
    expect(overview.totalExp).toBe(150);
    db.close();
  });

  it("exports and imports learned knowledge bundles", () => {
    const sourceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-export-src-"));
    const targetCwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-export-dst-"));
    tempDirs.push(sourceCwd, targetCwd);

    const sourceDb = new EvoDatabase(sourceCwd);
    const promptProfile = extractPromptProfile("- update src/index.ts\n- done when tests pass");
    const episodeId = sourceDb.createEpisode({
      cwd: sourceCwd,
      cli: "claude",
      command: ["echo", "hello"],
      startedAt: new Date(2026, 0, 1).toISOString(),
      promptProfile,
    });
    sourceDb.finishEpisode(episodeId, {
      finishedAt: new Date(2026, 0, 1, 0, 0, 5).toISOString(),
      exitCode: 0,
      terminationReason: "completed",
      summary: {
        surrogateCost: 2,
        filesRead: 1,
        linesReadNorm: 1,
        symbolRevisits: 0,
        retryCount: 0,
        failedVerifications: 0,
        crossFileSpread: 0,
        noChangeTurns: 0,
        changedFilesCount: 1,
        changedSymbolsCount: 1,
        changedLinesCount: 1,
        firstPassGreen: true,
        promptLengthBucket: "40-79",
        structureScore: 4,
        scopeBucket: "1|1|1-20",
        explorationMode: "balanced",
        attentionEntropy: 0.15,
        attentionCompression: 0.05,
        noveltyRatio: 0.9,
        expectedCostConfidence: 0.6,
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
        predictedLossRate: null,
        expAwarded: 50,
      },
    });
    const exportPath = path.join(sourceCwd, "knowledge.json");
    sourceDb.exportKnowledgeBundle(exportPath);
    sourceDb.close();

    const targetDb = new EvoDatabase(targetCwd);
    const result = targetDb.importKnowledgeBundle(exportPath);
    const overview = targetDb.getStatsOverview();

    expect(result.importedBuckets).toBeGreaterThan(0);
    expect(overview.totalEpisodes).toBe(0);
    expect(targetDb.lookupExpectedCost(promptProfile, {
      changedFilesCount: 1,
      changedFilesBucket: "1",
      changedSymbolsCount: 1,
      changedSymbolsBucket: "1",
      changedLinesCount: 1,
      changedLinesBucket: "1-20",
      testsPresent: true,
      languages: ["typescript"],
      explorationHeavy: false,
      explorationMode: "balanced",
      attentionEntropy: 0.1,
      attentionCompression: 0.1,
      noveltyRatio: 0.9,
      repeatedAttentionRatio: 0.1,
      scopeBucket: "1|1|1-20",
    }).sampleSize).toBeGreaterThan(0);
    targetDb.close();
  });
});
