import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { detectCli, extractEventsFromLine, parseUsageObservation } from "./adapters";
import { createFrictionCaptureAdapter } from "./capture";
import { diffSymbolSnapshots } from "./ast";
import { ensureEvoConfig } from "./config";
import { EvoDatabase } from "./db";
import {
  loadMascotProfile,
  renderMascotLevelUp,
  renderMascotSpecialEvent,
  renderMascotStartupLine,
  renderMascotTurnLine,
  updateMascotAfterEpisode,
} from "./mascot";
import { extractPromptProfile } from "./promptProfile";
import {
  buildEpisodeComplexity,
  buildEpisodeSummary,
  buildTurnSummary,
  collectAttentionPathsFromEvents,
  computeLoopSignals,
  computePredictiveNudges,
  computeScoreBreakdown,
} from "./scoring";
import { resolveOriginalCommand } from "./shellIntegration";
import { diffSnapshots, snapshotWorkspace } from "./snapshot";
import {
  EpisodeArtifacts,
  EpisodeEvent,
  ProxyRunOptions,
  TurnRecord,
  TurnSummary,
  UsageObservation,
  WorkspaceSnapshot,
} from "./types";

interface ProxyTurnState {
  startedAt: string;
  inputText: string;
  outputText: string;
  events: EpisodeEvent[];
  firstOutputAt?: number;
  lastActivityAt: number;
}

const TURN_NOISE_PATTERNS = [
  /no stdin data received in \d+s/i,
  /input must be provided either through stdin or as a prompt argument/i,
];

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

function createEmptyTurn(): ProxyTurnState {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    inputText: "",
    outputText: "",
    events: [],
    lastActivityAt: Date.now(),
  };
}

function normalizeTurnOutput(outputText: string): string {
  return outputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function shouldSuppressTurnFeedback(turnState: ProxyTurnState): boolean {
  const normalizedOutput = normalizeTurnOutput(turnState.outputText);
  if (!normalizedOutput) return false;

  const outputLines = normalizedOutput.split("\n");
  const hasOnlyNoiseOutput = outputLines.every((line) =>
    TURN_NOISE_PATTERNS.some((pattern) => pattern.test(line)),
  );
  const hasMeaningfulInput = turnState.inputText.trim().length > 0;

  return hasOnlyNoiseOutput && !hasMeaningfulInput;
}

function hasProjectMarkers(cwd: string): boolean {
  const markers = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
  ];
  return markers.some((marker) => fs.existsSync(path.join(cwd, marker)));
}

export function shouldUseLightweightTracking(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  if (resolved === path.resolve(os.homedir())) return true;
  if (hasProjectMarkers(resolved)) return false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return true;
  }

  const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
  const directoryCount = visibleEntries.filter((entry) => entry.isDirectory()).length;
  const fileCount = visibleEntries.filter((entry) => entry.isFile()).length;

  if (directoryCount >= 8) return true;
  if (directoryCount >= 5 && visibleEntries.length >= 15 && fileCount <= 6) return true;
  return false;
}

function createEmptySnapshot(): WorkspaceSnapshot {
  return {
    files: [],
    byRelativePath: new Map(),
  };
}

function spawnInteractiveCommand(
  commandPath: string,
  args: string[],
  cwd: string,
): ReturnType<typeof spawn> {
  const extension = path.extname(commandPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const quotedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    return spawn(`"${commandPath}" ${quotedArgs}`.trim(), {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EVO_PROXY_ACTIVE: "1",
        EVO_PROXY_DISABLED: "0",
      },
    });
  }

  if (extension === ".ps1") {
    return spawn("powershell", ["-NoLogo", "-NoProfile", "-File", commandPath, ...args], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EVO_PROXY_ACTIVE: "1",
        EVO_PROXY_DISABLED: "0",
      },
    });
  }

  return spawn(commandPath, args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EVO_PROXY_ACTIVE: "1",
      EVO_PROXY_DISABLED: "0",
    },
  });
}

export async function runProxySession(options: ProxyRunOptions): Promise<{
  episodeId: number;
  artifacts: EpisodeArtifacts;
}> {
  const cwd = path.resolve(options.cwd);
  const config = ensureEvoConfig(cwd);
  const cli = detectCli(options.cli, options.cli);
  const db = new EvoDatabase(cwd);
  let mascotProfile = loadMascotProfile(cwd);
  const lightweightTracking = shouldUseLightweightTracking(cwd);
  const promptProfile = extractPromptProfile(options.args.join(" "));
  const startedAt = new Date().toISOString();
  const episodeId = db.createEpisode({
    cwd,
    cli,
    command: [cli, ...options.args],
    startedAt,
    promptProfile,
  });

  const originalCommand = resolveOriginalCommand(cwd, cli);
  if (!originalCommand) {
    db.close();
    throw new Error(`Could not resolve the original ${cli} command. Run npm run setup again.`);
  }

  process.stderr.write(
    `Evo tracking ON | cli=${cli} | dir=${cwd} | mode=${config.proxy.defaultMode}${lightweightTracking ? " | light" : ""}\n`,
  );

  const beforeSnapshotPromise = lightweightTracking
    ? Promise.resolve(createEmptySnapshot())
    : snapshotWorkspace(cwd);
  const events: EpisodeEvent[] = [];
  const usageObservations: UsageObservation[] = [];
  const watcherPaths = new Set<string>();
  const turnRecords: TurnRecord[] = [];
  const turnSummaries: TurnSummary[] = [];
  const recentMessageKeys: string[] = [];
  const frictionAdapter = createFrictionCaptureAdapter(cli);
  let turnState = createEmptyTurn();
  let turnIndex = 0;

  const watcher = lightweightTracking
    ? null
    : chokidar.watch(cwd, {
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

  const pushTurnEvent = (event: EpisodeEvent): void => {
    events.push(event);
    turnState.events.push(event);
  };

  watcher?.on("all", (eventName, absolutePath) => {
    const relativePath = path.relative(cwd, absolutePath);
    if (!relativePath || relativePath.startsWith(".evo")) return;
    watcherPaths.add(relativePath);
    pushTurnEvent(
      createEvent("patch_applied", "watcher", {
        watcherEvent: eventName,
        path: relativePath,
      }),
    );
  });
  watcher?.on("error", () => {
    // Skip permission-denied watcher paths and keep the session alive.
  });

  const child = spawnInteractiveCommand(originalCommand, options.args, cwd);

  const stdinListener = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    turnState.inputText += text;
    turnState.lastActivityAt = Date.now();
    for (const event of frictionAdapter.consumeInputChunk(text)) {
      pushTurnEvent(event);
    }
    child.stdin?.write(chunk);
  };
  const attachStdin = Boolean(process.stdin.isTTY);
  if (attachStdin) {
    process.stdin.resume();
    process.stdin.on("data", stdinListener);
  }

  const idleMs = config.proxy.turnIdleMs;
  let idleTimer: NodeJS.Timeout | null = null;
  let startupNoticeTimer: NodeJS.Timeout | null = null;
  let startupNoticeShown = false;

  const showStartupNotice = (): void => {
    if (startupNoticeShown || !process.stderr.isTTY) return;
    startupNoticeShown = true;
    process.stdout.write(`\r\n${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\r\n`);
  };

  if (process.stderr.isTTY) {
    startupNoticeTimer = setTimeout(() => {
      showStartupNotice();
    }, attachStdin ? 2200 : 1200);
  }

  const finalizeTurn = (): void => {
    if (!turnState.inputText.trim() && !turnState.outputText.trim() && turnState.events.length === 0) {
      turnState = createEmptyTurn();
      return;
    }

    if (shouldSuppressTurnFeedback(turnState)) {
      turnState = createEmptyTurn();
      return;
    }

    turnIndex += 1;
    const turnPromptProfile = extractPromptProfile(turnState.inputText.trim() || options.args.join(" "));
    const attentionPaths = collectAttentionPathsFromEvents(turnState.events);
    const complexity = buildEpisodeComplexity({
      changedFilesCount: watcherPaths.size,
      changedSymbolsCount: 0,
      changedLinesCount: 0,
      languages: [],
      testsPresent: turnState.events.some(
        (event) => event.type === "test_run" || event.type === "build_run",
      ),
      filesRead: turnState.events.filter((event) => event.type === "file_read").length,
      searchCount: turnState.events.filter((event) => event.type === "search").length,
      attentionPaths,
    });
    const responseLatencyMs =
      turnState.firstOutputAt !== undefined
        ? Math.max(0, turnState.firstOutputAt - new Date(turnState.startedAt).getTime())
        : 0;
    const summary = buildTurnSummary({
      turnIndex,
      promptProfile: turnPromptProfile,
      events: turnState.events,
      complexity,
      touchedStableSymbolIds: [],
      stats: db,
      failedVerifications: turnState.events.filter((event) => event.type === "build_run" || event.type === "test_run").length > 0 ? 0 : 0,
      firstPassGreen: !turnState.events.some((event) => event.type === "clarification_prompt"),
      responseLatencyMs,
      turnRetryDepth: Math.max(0, turnSummaries.length),
      recentMessageKeys,
      mode: options.mode,
      minConfidenceForPercent: config.nudge.minConfidenceForPercent,
      maxLines: config.nudge.maxInlineLines,
    });

    turnRecords.push({
      turnIndex,
      startedAt: turnState.startedAt,
      finishedAt: new Date().toISOString(),
      promptProfile: turnPromptProfile,
      inputText: turnState.inputText.trim(),
      outputPreview: turnState.outputText.trim().slice(-300),
      events: [...turnState.events],
    });
    turnSummaries.push(summary);
    const leadMessage = summary.adviceMessages[0];
    if (leadMessage) {
      recentMessageKeys.push(leadMessage.key);
      if (recentMessageKeys.length > 12) recentMessageKeys.shift();
      const strongestSaving = Math.max(...summary.nudges.map((item) => item.predictedSavingRate), 0);
      const special =
        leadMessage.category === "recovery" ||
        leadMessage.category === "exploration_focus" ||
        strongestSaving >= 0.35;
      const rendered = special
        ? renderMascotSpecialEvent(mascotProfile, {
            message: leadMessage,
            summary,
          })
        : renderMascotTurnLine(mascotProfile, summary);
      process.stdout.write(`\r\n${rendered}\r\n`);
    } else {
      process.stdout.write(`\r\n${renderMascotTurnLine(mascotProfile, summary)}\r\n`);
    }
    pushTurnEvent(
      createEvent("turn_closed", "proxy", {
        turnIndex,
        interventionMode: summary.intervention.mode,
        adviceCount: summary.adviceMessages.length,
      }),
    );
    turnState = createEmptyTurn();
  };

  const restartIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      finalizeTurn();
    }, idleMs);
  };

  const lineBuffer = { stdout: "", stderr: "" };
  const consumeStream = (source: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    if (source === "stdout") process.stdout.write(chunk);
    else process.stderr.write(chunk);

    if (turnState.firstOutputAt === undefined) {
      turnState.firstOutputAt = Date.now();
    }
    turnState.outputText += text;
    turnState.lastActivityAt = Date.now();
    lineBuffer[source] += text;
    const segments = lineBuffer[source].split(/\r?\n/);
    lineBuffer[source] = segments.pop() ?? "";

    for (const line of segments) {
      const usage = parseUsageObservation(cli, source, line);
      if (usage) {
        usageObservations.push({ ...usage, turnIndex: turnIndex + 1 });
        finalizeTurn();
      }
      const extracted = extractEventsFromLine(line);
      for (const event of extracted) pushTurnEvent(event);
      for (const event of frictionAdapter.consumeOutputLine(source, line)) pushTurnEvent(event);
    }

    restartIdleTimer();
  };

  child.stdout?.on("data", (chunk: Buffer) => consumeStream("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => consumeStream("stderr", chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  if (idleTimer) clearTimeout(idleTimer);
  if (startupNoticeTimer) clearTimeout(startupNoticeTimer);
  if (attachStdin) {
    process.stdin.off("data", stdinListener);
  }

  for (const [source, trailing] of [
    ["stdout", lineBuffer.stdout] as const,
    ["stderr", lineBuffer.stderr] as const,
  ]) {
    if (!trailing.trim()) continue;
    const usage = parseUsageObservation(cli, source, trailing);
    if (usage) usageObservations.push({ ...usage, turnIndex: turnIndex + 1 });
    const extracted = extractEventsFromLine(trailing);
    for (const event of extracted) pushTurnEvent(event);
    for (const event of frictionAdapter.consumeOutputLine(source, trailing)) pushTurnEvent(event);
  }

  finalizeTurn();
  events.push(createEvent("episode_closed", "proxy", { exitCode }));
  await watcher?.close();

  const afterSnapshot = lightweightTracking ? createEmptySnapshot() : await snapshotWorkspace(cwd);
  const beforeSnapshot = await beforeSnapshotPromise;
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
    testsPresent: events.some((event) => event.type === "test_run" || event.type === "build_run"),
    filesRead: events.filter((event) => event.type === "file_read").length,
    searchCount: events.filter((event) => event.type === "search").length,
    attentionPaths,
  });
  const firstPassGreen = exitCode === 0;
  const score = computeScoreBreakdown({
    events,
    complexity,
    touchedStableSymbolIds,
    stats: db,
    failedVerifications: 0,
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
    turns: turnSummaries,
  });
  const mascotUpdate = updateMascotAfterEpisode(cwd, summary);
  mascotProfile = loadMascotProfile(cwd);

  db.saveTurns(episodeId, turnRecords, turnSummaries);
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

  if (config.retention.compactOnRun) {
    db.compactRawEpisodes();
  }

  db.close();

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
      mascot: mascotUpdate,
      tokenEstimate,
      usageObservations,
      events,
      turns: turnSummaries,
    },
  };
}
