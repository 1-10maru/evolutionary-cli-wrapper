import path from "node:path";
import chokidar from "chokidar";
import { detectCli, extractEventsFromLine, parseUsageObservation } from "./adapters";
import { createFrictionCaptureAdapter } from "./capture";
import { readCurrentMode } from "./cli/display";
import { ensureEvoConfig } from "./config";
import { EvoDatabase } from "./db";
import { getLogger } from "./logger";
import {
  loadMascotProfile,
  renderMascotStartupLine,
} from "./mascot";
import { extractPromptProfile } from "./promptProfile";
import { resolveOriginalCommand } from "./shellIntegration";
import { snapshotWorkspace } from "./snapshot";
import {
  EpisodeArtifacts,
  EpisodeEvent,
  ProxyRunOptions,
  TurnRecord,
  TurnSummary,
  UsageObservation,
} from "./types";
import { emitTrackingHeader } from "./proxy/headerEmitter";
import {
  liveStateTargets,
  teardownLiveStateFiles,
  writeLiveStateDual,
} from "./proxy/liveState";
import { setupJsonlWatcher, type JsonlWatcherHandle } from "./proxy/jsonlWatcher";
import {
  buildLiveStatePayload,
  createEmptyTurn,
  createEvent,
  finalizeEpisode,
  finalizeTurn as finalizeTurnImpl,
  processJsonlEntry,
  resetLiveStateOnRotation,
  type ProxyLiveState,
  type ProxyTurnState,
} from "./proxy/episodeLifecycle";
import {
  createEmptySnapshot,
  formatMissingOriginalCommandMessage,
  shouldUseInteractivePassthrough,
  shouldUseLightweightTracking as _shouldUseLightweightTracking,
} from "./proxy/sessionMode";
import { spawnInteractiveCommand } from "./proxy/spawnCommand";

// Re-export for public API parity (was originally exported from this file).
export const shouldUseLightweightTracking = _shouldUseLightweightTracking;

const proxyResolveLog = getLogger().child("proxy.resolve");
const proxySpawnLog = getLogger().child("proxy.spawn");
const proxySubprocessLog = getLogger().child("proxy.subprocess");

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
    proxyResolveLog.error("original command not found", {
      cli,
      cwd,
      pathHead: process.env.PATH?.slice(0, 200),
    });
    db.close();
    throw new Error(formatMissingOriginalCommandMessage(cli));
  }

  const interactivePassthrough = shouldUseInteractivePassthrough(options.args);
  emitTrackingHeader({
    cli,
    cwd,
    mode: config.proxy.defaultMode,
    lightweightTracking,
    mascotSpecies: mascotProfile.speciesId,
  });

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
  const turnStateRef: { current: ProxyTurnState } = { current: createEmptyTurn() };
  let turnIndex = 0;
  const bumpTurnIndex = (): number => {
    turnIndex += 1;
    return turnIndex;
  };

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
    turnStateRef.current.events.push(event);
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

  if (interactivePassthrough) {
    if (readCurrentMode() === "expansion") {
      process.stdout.write(`${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\n`);
    }
  } else {
    // Non-interactive path: emit a single startup line to stderr unless this is
    // an immediate-exit invocation (--help / --version / -h / -v). This makes
    // EvoPet visible in piped/scripted runs while keeping `--help` clean.
    const immediateExitFlags = new Set(["--help", "-h", "--version", "-v"]);
    const isImmediateExit = options.args.some((arg) => immediateExitFlags.has(arg.toLowerCase()));
    if (!isImmediateExit && readCurrentMode() === "expansion") {
      process.stderr.write(`${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\n`);
    }
  }

  // ── JSONL watcher + live-state file for statusline integration ──
  // No terminal painting or title bar writes — those break Claude Code's TUI
  // and conflict with Zellij pane names. Instead, write state to a file that
  // ~/.claude/statusline.py reads.
  let jsonlWatcherHandle: JsonlWatcherHandle | null = null;
  let liveStateTornDown = false;
  const liveTrackingEnabled =
    interactivePassthrough &&
    (process.stderr.isTTY || process.env.EVO_LIVE_TRACKING_FORCE === "1") &&
    process.env.EVO_LIVE_TRACKING !== "0";
  const { cwdTarget: liveStateFile, homeTarget: homeLiveStateFile } = liveStateTargets(cwd);

  // Live session state tracked via JSONL monitoring
  const liveState: ProxyLiveState = {
    turns: 0,
    userMessages: 0,
    toolCalls: 0,
    lastTool: "",
    lastFile: "",
    sessionStartMs: Date.now(),
    advice: "",
    adviceDetail: "",
    signalKind: "",
    beforeExample: "",
    afterExample: "",
    sessionGrade: "C",
    promptScore: 0,
    efficiencyScore: 0,
    comboCount: mascotProfile.comboCount,
    filePatchCounts: new Map<string, number>(),
    symbolTouchCounts: new Map<string, number>(),
    lastPromptLength: 0,
    lastHasFileRefs: false,
    lastHasSymbolRefs: false,
    lastHasAcceptanceRef: false,
    lastHasTestRef: false,
    lastStructureScore: 0,
    lastFirstPassGreen: true,
    lastExitCode: null,
    lastExitSignal: null,
    lastExitAt: null,
    lastSubcommand: null,
  };

  const writeLiveState = (): void => {
    if (liveStateTornDown) return;
    const payload = buildLiveStatePayload(liveState, mascotProfile);
    writeLiveStateDual({
      cwdTarget: liveStateFile,
      homeTarget: homeLiveStateFile,
      payload,
      debugContext: { turns: liveState.turns, mood: mascotProfile.mood },
    });
  };

  const teardownLiveTracking = (): void => {
    if (jsonlWatcherHandle) {
      try {
        jsonlWatcherHandle.close();
      } catch {
        // best-effort
      }
      jsonlWatcherHandle = null;
    }
    teardownLiveStateFiles(liveStateFile, homeLiveStateFile);
    liveStateTornDown = true;
  };

  if (liveTrackingEnabled) {
    jsonlWatcherHandle = setupJsonlWatcher({
      cwd,
      onEntry: (entry) => {
        processJsonlEntry(entry, {
          liveState,
          config,
          onStateChanged: writeLiveState,
        });
      },
      onRotation: () => {
        resetLiveStateOnRotation(liveState);
        // Write a "session changed" snapshot so statusline reflects rotation immediately.
        writeLiveState();
      },
    });
    // Write initial state immediately
    writeLiveState();
  }

  // Graceful shutdown: ensure live-state cleanup on SIGINT/SIGTERM
  const onProcessExit = (): void => {
    teardownLiveTracking();
    process.exit(0);
  };
  process.on("SIGINT", onProcessExit);
  process.on("SIGTERM", onProcessExit);

  proxySpawnLog.info("spawning subprocess", {
    command: originalCommand,
    argvLength: options.args.length,
    cwd,
    envKeyCount: Object.keys(process.env).length,
    interactivePassthrough,
  });
  const child = spawnInteractiveCommand(originalCommand, options.args, cwd, interactivePassthrough);

  const stdinListener = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    turnStateRef.current.inputText += text;
    turnStateRef.current.lastActivityAt = Date.now();
    for (const event of frictionAdapter.consumeInputChunk(text)) {
      pushTurnEvent(event);
    }
    child.stdin?.write(chunk);
  };
  const attachStdin = Boolean(process.stdin.isTTY) && !interactivePassthrough;
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
    if (readCurrentMode() === "expansion") {
      process.stdout.write(`\r\n${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\r\n`);
    }
  };

  if (process.stderr.isTTY && !interactivePassthrough) {
    startupNoticeTimer = setTimeout(() => {
      showStartupNotice();
    }, attachStdin ? 2200 : 1200);
  }

  const finalizeTurn = (): void => {
    finalizeTurnImpl({
      options,
      config,
      episodeId,
      db,
      mascotProfile,
      events,
      watcherPaths,
      turnRecords,
      turnSummaries,
      recentMessageKeys,
      turnStateRef,
      bumpTurnIndex,
      pushTurnEvent,
      liveTrackingEnabled,
      flushLiveState: writeLiveState,
    });
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

    const turnState = turnStateRef.current;
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

  if (!interactivePassthrough) {
    child.stdout?.on("data", (chunk: Buffer) => consumeStream("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => consumeStream("stderr", chunk));
  }

  const subprocessStartMs = Date.now();
  let exitSignal: string | null = null;
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - subprocessStartMs;
      const ctx = { exitCode: code, signal, durationMs };
      if ((code !== null && code !== 0) || signal !== null) {
        proxySubprocessLog.warn("subprocess exited", ctx);
      } else {
        proxySubprocessLog.info("subprocess exited", ctx);
      }
      // Record exit details into live state and flush so observers
      // (statusline / future analytics) can see how the wrapped CLI ended.
      liveState.lastExitCode = code;
      liveState.lastExitSignal = signal === null ? null : String(signal);
      liveState.lastExitAt = Date.now();
      liveState.lastSubcommand = options.args[0] ?? null;
      exitSignal = liveState.lastExitSignal;
      writeLiveState();
      proxySubprocessLog.info("live state updated with exit code", {
        exitCode: code,
        signal,
        durationMs,
      });
      resolve(code ?? 1);
    });
  });

  process.off("SIGINT", onProcessExit);
  process.off("SIGTERM", onProcessExit);
  teardownLiveTracking();
  if (idleTimer) clearTimeout(idleTimer);
  if (startupNoticeTimer) clearTimeout(startupNoticeTimer);
  if (attachStdin) {
    process.stdin.off("data", stdinListener);
  }

  if (!interactivePassthrough) {
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
  }

  finalizeTurn();
  events.push(createEvent("episode_closed", "proxy", { exitCode }));
  await watcher?.close();

  const afterSnapshot = lightweightTracking ? createEmptySnapshot() : await snapshotWorkspace(cwd);
  const beforeSnapshot = await beforeSnapshotPromise;

  const { artifacts } = await finalizeEpisode({
    cwd,
    options,
    config,
    episodeId,
    db,
    cli,
    events,
    usageObservations,
    exitCode,
    exitSignal,
    beforeSnapshot,
    afterSnapshot,
    promptProfile,
    turnRecords,
    turnSummaries,
    liveState,
  });

  // Mascot reload (matches pre-refactor behaviour: reassigned but unused after).
  mascotProfile = loadMascotProfile(cwd);
  void mascotProfile;

  db.close();

  return {
    episodeId,
    artifacts,
  };
}
