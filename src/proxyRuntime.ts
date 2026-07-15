import os from "node:os";
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
  gcOldSessionFiles,
  liveStateTargets,
  sessionLiveStatePath,
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
import { killProcessTree, spawnInteractiveCommand } from "./proxy/spawnCommand";

// Re-export for public API parity (was originally exported from this file).
export const shouldUseLightweightTracking = _shouldUseLightweightTracking;

const proxyResolveLog = getLogger().child("proxy.resolve");
const proxySpawnLog = getLogger().child("proxy.spawn");
const proxySubprocessLog = getLogger().child("proxy.subprocess");

/**
 * How long to wait after the child's `exit` event for its `close` event before
 * proceeding with teardown anyway. `close` fires only once every stdio stream
 * has ended; a grandchild that inherits (and holds) a stdio pipe can keep it
 * open indefinitely after the child itself has exited, which would otherwise
 * trap the wrapper forever. Overridable via EVO_EXIT_WATCHDOG_MS (primarily for
 * tests). Defaults to 2000ms.
 */
function exitWatchdogMs(): number {
  const raw = Number(process.env.EVO_EXIT_WATCHDOG_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

/**
 * Conventional shell exit code for a process terminated by a signal:
 * 128 + the platform's signal number (e.g. SIGINT -> 130). Falls back to 128
 * when the signal number is unknown on this platform.
 */
function signalExitCode(signal: NodeJS.Signals): number {
  const signalNumbers = os.constants.signals as unknown as Record<string, number | undefined>;
  const num = signalNumbers[signal];
  return 128 + (typeof num === "number" ? num : 0);
}

export async function runProxySession(options: ProxyRunOptions): Promise<{
  episodeId: number;
  artifacts: EpisodeArtifacts;
  exitCode: number;
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
  const frictionAdapter = createFrictionCaptureAdapter();
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
    // v3.4.0: write to per-session file `<cwd>/.evo/sessions/<sessionId>.json`
    // when sessionId is known. Until then we only update the legacy dual
    // targets — the per-session file lights up as soon as the JSONL watcher
    // locks and parses the header.
    const sessionTarget =
      typeof liveState.sessionId === "string" && liveState.sessionId.length > 0
        ? sessionLiveStatePath(cwd, liveState.sessionId)
        : undefined;
    writeLiveStateDual({
      cwdTarget: liveStateFile,
      homeTarget: homeLiveStateFile,
      sessionTarget,
      payload,
      debugContext: {
        turns: liveState.turns,
        mood: mascotProfile.mood,
        sessionId: liveState.sessionId,
      },
    });
  };

  // v3.3.0: heartbeat ticker re-flushes live-state.json every 10 s regardless
  // of JSONL activity. Without this, long tool executions or idle pauses let
  // the file's `updatedAt` go stale, causing statusline.py to fall through to
  // the dim/fallback path mid-session. Set EVO_DISABLE_HEARTBEAT=1 to disable.
  let heartbeatHandle: NodeJS.Timeout | null = null;

  const teardownLiveTracking = (): void => {
    if (heartbeatHandle) {
      clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
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
    // v3.4.0: best-effort GC of stale per-session files (>7 days old).
    // Errors are swallowed inside gcOldSessionFiles, but we still wrap the
    // call defensively so a future regression cannot crash proxy startup.
    try {
      gcOldSessionFiles(cwd);
    } catch {
      // intentionally ignored — GC is opportunistic
    }
    jsonlWatcherHandle = setupJsonlWatcher({
      cwd,
      onEntry: (entry) => {
        processJsonlEntry(entry, {
          liveState,
          config,
          onStateChanged: writeLiveState,
        });
      },
      onRotation: (sessionId) => {
        resetLiveStateOnRotation(liveState);
        // Set the new sessionId (or undefined if not yet readable) so the
        // live-state payload reflects the freshly-locked session immediately.
        liveState.sessionId = sessionId;
        // Write a "session changed" snapshot so statusline reflects rotation immediately.
        writeLiveState();
      },
    });
    // Write initial state immediately
    writeLiveState();

    // v3.3.0: 10 s heartbeat keeps live-state.json fresh during long tool
    // executions. .unref() prevents the timer from holding the event loop
    // open after the wrapped CLI exits.
    if (process.env.EVO_DISABLE_HEARTBEAT !== "1") {
      heartbeatHandle = setInterval(() => {
        writeLiveState();
      }, 10_000);
      heartbeatHandle.unref?.();
    }
  }

  // Graceful shutdown: clean up live-state files before the Node.js event loop
  // exits. Signal handling (SIGINT/SIGTERM/SIGHUP) is registered *after* the
  // child spawns so the signal can be forwarded to the child instead of
  // orphaning it — see `onSignal` below.
  const onBeforeExit = (): void => {
    teardownLiveTracking();
  };
  process.on("beforeExit", onBeforeExit);

  proxySpawnLog.info("spawning subprocess", {
    command: originalCommand,
    argvLength: options.args.length,
    cwd,
    envKeyCount: Object.keys(process.env).length,
    interactivePassthrough,
  });
  const child = spawnInteractiveCommand(originalCommand, options.args, cwd, interactivePassthrough);

  // Handle terminal signals without orphaning the child. The previous handler
  // called process.exit(0) here, which left the child running (a zombie/orphan
  // source) and masked its real exit status with 0.
  //
  //  - If the child already exited: finish teardown and exit with the
  //    conventional 128 + signal-number code.
  //  - Interactive passthrough (inherited stdio, shared console/process group):
  //    the terminal already delivered the signal to the child, so let the child
  //    handle it (e.g. cancel the current turn) and drive its own `close` path.
  //    Killing here would preempt that and — on Windows via taskkill /F —
  //    hard-kill an interactive session on the very first Ctrl+C. A SIGHUP
  //    (console closed / terminal hangup) or a repeated signal escalates to a
  //    forced tree-kill so a stuck child can never trap the wrapper.
  //  - Otherwise (non-interactive, or an escalation): forward the signal and,
  //    on Windows where the child is a cmd.exe/pwsh wrapper tree, tear the whole
  //    tree down so nothing is orphaned. The child's `close` path then runs
  //    teardown and propagates the real exit code.
  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (child.exitCode !== null || child.signalCode !== null) {
      teardownLiveTracking();
      process.exit(signalExitCode(signal));
      return;
    }
    const escalate = signal === "SIGHUP" || signalCount >= 2 || child.killed;
    if (interactivePassthrough && !escalate) {
      return;
    }
    killProcessTree(child, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  const stdinListener = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    turnStateRef.current.inputText += text;
    turnStateRef.current.lastActivityAt = Date.now();
    for (const event of frictionAdapter.consumeInputChunk(text)) {
      pushTurnEvent(event);
    }
    child.stdin?.write(chunk);
  };
  // EVO_FORCE_STDIN_ATTACH=1 forces the interactive stdin-forwarding path even
  // when stdin is not a TTY. This exists so a non-TTY environment (CI, vitest)
  // can exercise the stdin resume/teardown lifecycle that otherwise only runs
  // under a real terminal. It never changes behavior unless explicitly set.
  const forceAttachStdin = process.env.EVO_FORCE_STDIN_ATTACH === "1";
  const attachStdin = (Boolean(process.stdin.isTTY) || forceAttachStdin) && !interactivePassthrough;
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
    let settled = false;
    let watchdog: NodeJS.Timeout | null = null;
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      via: "close" | "exit-watchdog",
    ): void => {
      if (settled) return;
      settled = true;
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      const durationMs = Date.now() - subprocessStartMs;
      const ctx = { exitCode: code, signal, durationMs, via };
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
        via,
      });
      resolve(code ?? 1);
    };
    child.on("error", reject);
    // Normal path: `close` fires after the child exited AND every stdio stream
    // ended. Exit-code propagation semantics are unchanged when it arrives.
    child.on("close", (code, signal) => finish(code, signal, "close"));
    // Watchdog: `exit` fires as soon as the child process itself has exited. If
    // a grandchild keeps a stdio pipe open, `close` may never fire — so arm a
    // short timer to proceed with teardown using the child's own exit status.
    // When `close` follows promptly (the common case) it settles first and the
    // watchdog is cleared, so behavior is identical to before.
    child.on("exit", (code, signal) => {
      if (settled || watchdog) return;
      watchdog = setTimeout(() => finish(code, signal, "exit-watchdog"), exitWatchdogMs());
      watchdog.unref?.();
    });
  });

  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  process.off("beforeExit", onBeforeExit);
  teardownLiveTracking();
  if (idleTimer) clearTimeout(idleTimer);
  if (startupNoticeTimer) clearTimeout(startupNoticeTimer);
  if (attachStdin) {
    process.stdin.off("data", stdinListener);
    // Pause and unref the resumed TTY/forced stdin. Without this the resumed
    // stdin keeps the event loop alive, so the wrapper hangs after the child
    // has already exited (the original /exit hang).
    process.stdin.pause();
    process.stdin.unref?.();
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
    exitCode,
  };
}
