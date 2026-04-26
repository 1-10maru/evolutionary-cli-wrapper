import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar";
import { ensureEvoConfig } from "./config";
import { getLogger } from "./logger";
import { detectCli, extractEventsFromLine, parseUsageObservation } from "./adapters";

const log = getLogger().child("episode");
import { diffSymbolSnapshots } from "./ast";
import { EvoDatabase } from "./db";
import { extractPromptProfile } from "./promptProfile";
import {
  buildEpisodeComplexity,
  buildEpisodeSummary,
  collectAttentionPathsFromEvents,
  computeLoopSignals,
  computePredictiveNudges,
  computeScoreBreakdown,
} from "./scoring";
import { diffSnapshots, snapshotWorkspace } from "./snapshot";
import { EpisodeArtifacts, EpisodeEvent, RunOptions, UsageObservation } from "./types";

function createEvent(
  type: EpisodeEvent["type"],
  source: EpisodeEvent["source"],
  details: Record<string, unknown>,
): EpisodeEvent {
  return {
    type,
    source,
    timestamp: new Date().toISOString(),
    details,
  };
}

function collectPromptText(options: RunOptions): string {
  if (options.promptText) return options.promptText;
  if (options.promptFile) {
    return fs.readFileSync(path.resolve(options.cwd, options.promptFile), "utf8");
  }
  return options.command.join(" ");
}

async function runShellCommand(
  cwd: string,
  command: string,
  eventType: "test_run" | "build_run",
): Promise<{ exitCode: number; event: EpisodeEvent }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        event: createEvent(eventType, "verification", {
          command,
          exitCode: exitCode ?? 1,
          stdoutPreview: stdout.slice(-400),
          stderrPreview: stderr.slice(-400),
        }),
      });
    });
  });
}

export async function runEpisode(options: RunOptions): Promise<{
  episodeId: number;
  artifacts: EpisodeArtifacts;
}> {
  const cwd = path.resolve(options.cwd);
  const cli = detectCli(options.command[0], options.cliOverride);
  const promptText = collectPromptText(options);
  const promptProfile = extractPromptProfile(promptText);
  const db = new EvoDatabase(cwd);
  const startedAt = new Date().toISOString();
  const episodeStartMs = Date.now();
  const episodeId = db.createEpisode({
    cwd,
    cli,
    command: options.command,
    startedAt,
    promptProfile,
  });
  log.info("episode started", { episodeId, cwd, cli });

  const events: EpisodeEvent[] = [
    createEvent("prompt_submitted", "wrapper", {
      promptHash: promptProfile.promptHash,
      promptLength: promptProfile.promptLength,
      promptPreview: promptProfile.preview,
    }),
  ];
  const usageObservations: UsageObservation[] = [];

  const beforeSnapshot = await snapshotWorkspace(cwd);

  const watcher = chokidar.watch(cwd, {
    ignored: [
      /(^|[\\/])\.git([\\/]|$)/,
      /(^|[\\/])\.evo([\\/]|$)/,
      /(^|[\\/])node_modules([\\/]|$)/,
      /(^|[\\/])dist([\\/]|$)/,
      /(^|[\\/])coverage([\\/]|$)/,
      /(^|[\\/])AppData([\\/]|$)/,
    ],
    ignoreInitial: true,
    persistent: true,
    ignorePermissionErrors: true,
  });

  watcher.on("all", (eventName, absolutePath) => {
    const relativePath = path.relative(cwd, absolutePath);
    if (!relativePath || relativePath.startsWith(".evo")) return;
    events.push(
      createEvent("patch_applied", "watcher", {
        watcherEvent: eventName,
        path: relativePath,
      }),
    );
  });
  watcher.on("error", () => {
    // Ignore permission-denied paths so the tracked command can continue.
  });

  const child = spawn(options.command[0], options.command.slice(1), {
    cwd,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
  });

  const lineBuffer = { stdout: "", stderr: "" };

  const consumeStream = (source: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (source === "stdout") process.stdout.write(chunk);
    else process.stderr.write(chunk);

    lineBuffer[source] += text;
    const segments = lineBuffer[source].split(/\r?\n/);
    lineBuffer[source] = segments.pop() ?? "";
    for (const line of segments) {
      const usage = parseUsageObservation(cli, source, line);
      if (usage) usageObservations.push(usage);
      events.push(...extractEventsFromLine(line));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => consumeStream("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => consumeStream("stderr", chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  for (const [source, trailing] of [
    ["stdout", lineBuffer.stdout] as const,
    ["stderr", lineBuffer.stderr] as const,
  ]) {
    if (!trailing.trim()) continue;
    const usage = parseUsageObservation(cli, source, trailing);
    if (usage) usageObservations.push(usage);
    events.push(...extractEventsFromLine(trailing));
  }

  const verificationEvents: EpisodeEvent[] = [];
  const verificationExitCodes: number[] = [];
  for (const command of options.testCommands) {
    const eventType =
      /\b(build|compile|tsc|vite build|cargo build)\b/i.test(command) ? "build_run" : "test_run";
    const result = await runShellCommand(cwd, command, eventType);
    verificationExitCodes.push(result.exitCode);
    verificationEvents.push(result.event);
  }

  events.push(...verificationEvents);
  events.push(createEvent("episode_closed", "wrapper", { exitCode }));

  await watcher.close();

  const afterSnapshot = await snapshotWorkspace(cwd);
  db.appendEvents(episodeId, events);
  db.saveUsageObservations(episodeId, usageObservations);

  const changedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
  db.saveWorkspaceSnapshot(episodeId, "before", {
    files: changedFiles
      .map((file) => file.before)
      .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    byRelativePath: new Map(
      changedFiles
        .map((file) => file.before)
        .filter((file): file is NonNullable<typeof file> => Boolean(file))
        .map((file) => [file.relativePath, file]),
    ),
  });
  db.saveWorkspaceSnapshot(episodeId, "after", {
    files: changedFiles
      .map((file) => file.after)
      .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    byRelativePath: new Map(
      changedFiles
        .map((file) => file.after)
        .filter((file): file is NonNullable<typeof file> => Boolean(file))
        .map((file) => [file.relativePath, file]),
    ),
  });
  const symbolDiff = diffSymbolSnapshots(changedFiles);
  db.saveSymbolSnapshots(episodeId, "before", symbolDiff.before);
  db.saveSymbolSnapshots(episodeId, "after", symbolDiff.after);
  db.saveSymbolChanges(episodeId, symbolDiff.changes);

  const changedLinesCount = changedFiles.reduce((sum, file) => sum + file.changedLines, 0);
  const changedFilesCount = changedFiles.length;
  const touchedStableSymbolIds = [...new Set(symbolDiff.changes.map((change) => change.stableSymbolId))];
  const languages = [...new Set(symbolDiff.changes.map((change) => change.language))];
  const attentionPaths = collectAttentionPathsFromEvents(events);
  const complexity = buildEpisodeComplexity({
    changedFilesCount,
    changedSymbolsCount: touchedStableSymbolIds.length,
    changedLinesCount,
    languages,
    testsPresent: options.testCommands.length > 0,
    filesRead: events.filter((event) => event.type === "file_read").length,
    searchCount: events.filter((event) => event.type === "search").length,
    attentionPaths,
  });

  const firstPassGreen = options.testCommands.length === 0
    ? exitCode === 0
    : verificationExitCodes.every((code) => code === 0);

  const score = computeScoreBreakdown({
    events,
    complexity,
    touchedStableSymbolIds,
    stats: db,
    failedVerifications: verificationExitCodes.filter((code) => code !== 0).length,
  });
  const loopSignals = computeLoopSignals({
    touchedStableSymbolIds,
    changedFiles: changedFiles.map((file) => file.relativePath),
    events,
    stats: db,
    firstPassGreen,
  });
  const currentEstimate = db.lookupExpectedCost(promptProfile, complexity);
  const nudges = computePredictiveNudges(promptProfile, complexity, db);
  const summary = buildEpisodeSummary({
    score,
    promptProfile,
    complexity,
    firstPassGreen,
    loopSignals,
    nudges,
    currentEstimate,
    changedFilesCount,
    changedSymbolsCount: touchedStableSymbolIds.length,
    changedLinesCount,
  });

  db.finishEpisode(episodeId, {
    finishedAt: new Date().toISOString(),
    exitCode,
    terminationReason: exitCode === 0 ? "completed" : "child_exit_non_zero",
    summary,
    observedTotalTokens: usageObservations[usageObservations.length - 1]?.totalTokens ?? null,
    cli,
  });

  const calibration = db.getTokenCalibration(cli);
  const tokenEstimate = calibration
    ? {
        cli,
        predictedTotalTokens: Math.max(
          0,
          Math.round((calibration.slope * summary.surrogateCost) + calibration.intercept),
        ),
        confidence: Number(
          Math.min(0.95, Math.max(0.1, calibration.sampleSize / (calibration.sampleSize + 10))).toFixed(3),
        ),
        sampleSize: calibration.sampleSize,
      }
    : null;

  const config = ensureEvoConfig(cwd);
  if (config.retention.compactOnRun) {
    db.compactRawEpisodes();
  }

  db.close();

  log.info("episode finished", {
    episodeId,
    durationMs: Date.now() - episodeStartMs,
    turns: 0,
    exitCode,
  });

  return {
    episodeId,
    artifacts: {
      promptProfile,
      beforeSnapshot,
      afterSnapshot,
      changedFiles,
      symbolSnapshotsBefore: symbolDiff.before,
      symbolSnapshotsAfter: symbolDiff.after,
      symbolChanges: symbolDiff.changes,
      complexity,
      score,
      nudges,
      loopSignals,
      summary,
      tokenEstimate,
      usageObservations,
      events,
    },
  };
}
