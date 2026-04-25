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
import { getLogger } from "./logger";
import {
  comboMilestoneMessage,
  loadMascotProfile,
  renderMascotLevelUp,
  renderMascotSpecialEvent,
  renderMascotStartupLine,
  renderMascotState,
  renderMascotTurnLine,
  updateMascotAfterEpisode,
} from "./mascot";
import { detectLiveSignals, generateTopAdvice, pickTip } from "./signalDetector";
import { computeLiveGrade } from "./sessionGrade";
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
  SupportedCli,
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

const NON_INTERACTIVE_FLAGS = new Set([
  "--print",
  "-p",
  "--version",
  "-v",
  "--help",
  "-h",
  "--json",
]);

const proxyModeLog = getLogger().child("proxy.mode");
const proxyResolveLog = getLogger().child("proxy.resolve");
const proxyStartupLog = getLogger().child("proxy.startup");
const proxySpawnLog = getLogger().child("proxy.spawn");
const proxyLiveStateLog = getLogger().child("proxy.livestate");
const proxyJsonlWatchLog = getLogger().child("proxy.jsonl.watch");
const proxyJsonlStatLog = getLogger().child("proxy.jsonl.stat");
const proxyEpisodeLog = getLogger().child("proxy.episode");
const proxySubprocessLog = getLogger().child("proxy.subprocess");

// Module-level ring buffer for JSONL parse failure rate limiting.
// More than 5 parse failures within 10 seconds escalates to ERROR and
// disables the watcher for the remainder of the session.
const PARSE_FAIL_WINDOW_MS = 10_000;
const PARSE_FAIL_THRESHOLD = 5;
let parseFailTimestamps: number[] = [];
let parseFailCircuitTripped = false;

function normalizeErr(err: unknown): { message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code, stack: e.stack };
  }
  return { message: String(err) };
}

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

function shouldUseInteractivePassthrough(args: string[]): boolean {
  let result: boolean;
  let reason: string;
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    result = false;
    reason = "non-tty std streams";
  } else if (args.length === 0) {
    result = true;
    reason = "tty stdin/stdout/stderr with no args";
  } else {
    const flagged = args.find((arg) => NON_INTERACTIVE_FLAGS.has(arg.toLowerCase()));
    if (flagged) {
      result = false;
      reason = `non-interactive flag detected: ${flagged.toLowerCase()}`;
    } else {
      result = true;
      reason = "tty std streams; no non-interactive flag in args";
    }
  }
  proxyModeLog.info("interactive passthrough decision", {
    interactivePassthrough: result,
    reason,
  });
  return result;
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
  let result: boolean;
  let reason: string;
  if (resolved === path.resolve(os.homedir())) {
    result = true;
    reason = "cwd is user home directory";
  } else if (hasProjectMarkers(resolved)) {
    result = false;
    reason = "project marker file present";
  } else {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      proxyModeLog.info("lightweight tracking decision", {
        lightweight: true,
        reason: "readdir failed; assuming non-project",
      });
      return true;
    }

    const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
    const directoryCount = visibleEntries.filter((entry) => entry.isDirectory()).length;
    const fileCount = visibleEntries.filter((entry) => entry.isFile()).length;

    if (directoryCount >= 8) {
      result = true;
      reason = `directoryCount=${directoryCount} >= 8 (looks like aggregate parent dir)`;
    } else if (directoryCount >= 5 && visibleEntries.length >= 15 && fileCount <= 6) {
      result = true;
      reason = `dirs=${directoryCount}, total=${visibleEntries.length}, files=${fileCount} (sparse aggregate)`;
    } else {
      result = false;
      reason = `dirs=${directoryCount}, total=${visibleEntries.length}, files=${fileCount} (looks like project)`;
    }
  }
  proxyModeLog.info("lightweight tracking decision", { lightweight: result, reason });
  return result;
}

function formatMissingOriginalCommandMessage(cli: SupportedCli): string {
  return `Could not resolve the original ${cli} command. Evo checked PATH after excluding its own shim, but no live ${cli} install was found. Reinstall the upstream ${cli} CLI, then run npm run setup again if needed.`;
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
  inheritStdio = false,
): ReturnType<typeof spawn> {
  const extension = path.extname(commandPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const quotedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    return spawn(`"${commandPath}" ${quotedArgs}`.trim(), {
      cwd,
      shell: true,
      stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
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
      stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
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
    stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
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
    proxyResolveLog.error("original command not found", {
      cli,
      cwd,
      pathHead: process.env.PATH?.slice(0, 200),
    });
    db.close();
    throw new Error(formatMissingOriginalCommandMessage(cli));
  }

  const interactivePassthrough = shouldUseInteractivePassthrough(options.args);
  const mode = `${config.proxy.defaultMode}${lightweightTracking ? " | light" : ""}`;
  process.stderr.write(
    `Evo tracking ON | cli=${cli} | dir=${cwd} | mode=${config.proxy.defaultMode}${lightweightTracking ? " | light" : ""}\n`,
  );
  proxyStartupLog.info("session header emitted", {
    cli,
    mode,
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

  if (interactivePassthrough) {
    process.stdout.write(`${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\n`);
  }

  // ── JSONL watcher + live-state file for statusline integration ──
  // No terminal painting or title bar writes — those break Claude Code's TUI
  // and conflict with Zellij pane names. Instead, write state to a file that
  // ~/.claude/statusline.py reads.
  // jsonlWatcher is a chokidar FSWatcher (not node:fs.FSWatcher). Typed loosely
  // because we only need close() and on(event, handler).
  let jsonlWatcher: { close: () => unknown; on: (event: string, fn: (...args: unknown[]) => void) => unknown } | null = null;
  let jsonlPollTimer: NodeJS.Timeout | null = null;
  let jsonlDebounceTimer: NodeJS.Timeout | null = null;
  let liveStateTornDown = false;
  const liveTrackingEnabled =
    interactivePassthrough &&
    process.stderr.isTTY &&
    process.env.EVO_LIVE_TRACKING !== "0";
  const liveStateFile = path.join(cwd, ".evo", "live-state.json");
  const homeLiveStateFile = path.join(os.homedir(), ".claude", ".evo-live.json");

  // Live session state tracked via JSONL monitoring
  const liveState = {
    turns: 0,
    toolCalls: 0,
    lastTool: "",
    lastFile: "",
    sessionStartMs: Date.now(),
    advice: "",
    adviceDetail: "",
    signalKind: "" as string,
    beforeExample: "",
    afterExample: "",
    sessionGrade: "C" as string,
    promptScore: 0,
    efficiencyScore: 0,
    comboCount: mascotProfile.comboCount,
    // Tracking maps for signal detection
    filePatchCounts: new Map<string, number>(),
    symbolTouchCounts: new Map<string, number>(),
    lastPromptLength: 0,
    lastHasFileRefs: false,
    lastHasSymbolRefs: false,
    lastHasAcceptanceRef: false,
    lastHasTestRef: false,
    lastStructureScore: 0,
    lastFirstPassGreen: true,
  };

  const atomicWrite = (target: string, json: string): void => {
    const tmp = `${target}.tmp`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, target);
    } catch (err) {
      const n = normalizeErr(err);
      proxyLiveStateLog.warn("atomic rename failed, falling back to direct write", {
        path: target,
        errno: n.code,
        message: n.message,
      });
      // Best-effort cleanup of stale tmp file
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      try {
        fs.writeFileSync(target, json);
      } catch (writeErr) {
        const wn = normalizeErr(writeErr);
        proxyLiveStateLog.warn("live-state write failed", {
          path: target,
          errno: wn.code,
          message: wn.message,
        });
      }
    }
  };

  const writeLiveState = (): void => {
    if (liveStateTornDown) return;
    const state = renderMascotState(mascotProfile);
    const payload = {
      turns: liveState.turns,
      toolCalls: liveState.toolCalls,
      advice: liveState.advice,
      mood: mascotProfile.mood,
      avatar: state.avatar,
      nickname: mascotProfile.nickname,
      bond: state.progressPercent,
      updatedAt: Date.now(),
      sessionGrade: liveState.sessionGrade,
      promptScore: liveState.promptScore,
      efficiencyScore: liveState.efficiencyScore,
      comboCount: liveState.comboCount,
      adviceDetail: liveState.adviceDetail,
      signalKind: liveState.signalKind,
      beforeExample: liveState.beforeExample,
      afterExample: liveState.afterExample,
    };
    const json = JSON.stringify(payload);

    let mtimeBefore = 0;
    try {
      mtimeBefore = fs.statSync(homeLiveStateFile).mtimeMs;
    } catch {
      // file may not exist yet — that's fine
    }
    proxyLiveStateLog.debug("writing live state", {
      mtimeBefore,
      turns: liveState.turns,
      mood: mascotProfile.mood,
    });

    atomicWrite(liveStateFile, json);
    atomicWrite(homeLiveStateFile, json);
  };

  const teardownLiveTracking = (): void => {
    if (jsonlPollTimer) { clearInterval(jsonlPollTimer); jsonlPollTimer = null; }
    if (jsonlDebounceTimer) { clearTimeout(jsonlDebounceTimer); jsonlDebounceTimer = null; }
    if (jsonlWatcher) {
      try {
        const closeResult = (jsonlWatcher as unknown as { close: () => unknown }).close();
        // chokidar's close() returns a Promise; swallow rejections so teardown stays sync-safe
        if (closeResult && typeof (closeResult as Promise<unknown>).then === "function") {
          (closeResult as Promise<unknown>).catch(() => { /* best-effort */ });
        }
      } catch {
        // best-effort close
      }
      jsonlWatcher = null;
    }
    for (const p of [liveStateFile, homeLiveStateFile]) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        const n = normalizeErr(err);
        // ENOENT is expected when no live-state was ever written; skip noise.
        if (n.code !== "ENOENT") {
          proxyLiveStateLog.warn("live-state cleanup failed", {
            path: p,
            errno: n.code,
            message: n.message,
          });
        }
      }
      // Also clean up any leftover atomic-write tmp file
      try {
        fs.unlinkSync(`${p}.tmp`);
      } catch {
        // ENOENT or perm — ignore
      }
    }
    liveStateTornDown = true;
  };

  // ── JSONL transcript watcher ──
  const startJsonlWatcher = (): void => {
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(claudeProjectsDir)) return;

    const encodedCwd = cwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
    let projectDir = "";
    try {
      for (const entry of fs.readdirSync(claudeProjectsDir)) {
        if (entry.toLowerCase() === encodedCwd.toLowerCase()) {
          projectDir = path.join(claudeProjectsDir, entry);
          break;
        }
      }
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("readdir failed for claude projects dir", {
        path: claudeProjectsDir,
        errno: n.code,
        message: n.message,
      });
    }
    if (!projectDir || !fs.existsSync(projectDir)) return;

    let newestJsonl = "";
    let newestMtime = 0;
    let jsonlReadOffset = 0;

    const findNewestJsonl = (): void => {
      try {
        for (const entry of fs.readdirSync(projectDir)) {
          if (!entry.endsWith(".jsonl")) continue;
          const fullPath = path.join(projectDir, entry);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch (err) {
            const n = normalizeErr(err);
            if (n.code === "ENOENT") {
              proxyJsonlStatLog.debug("jsonl stat ENOENT (transient)", {
                path: fullPath,
                errno: n.code,
              });
            } else {
              proxyJsonlStatLog.warn("jsonl stat failed", {
                path: fullPath,
                errno: n.code,
                message: n.message,
              });
            }
            continue;
          }
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestJsonl = fullPath;
          }
        }
      } catch (err) {
        const n = normalizeErr(err);
        proxyJsonlWatchLog.warn("readdir failed for project dir", {
          path: projectDir,
          errno: n.code,
          message: n.message,
        });
      }
    };

    const processNewLines = (): void => {
      if (!newestJsonl || parseFailCircuitTripped) return;
      try {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(newestJsonl);
        } catch (err) {
          const n = normalizeErr(err);
          if (n.code === "ENOENT") {
            proxyJsonlStatLog.debug("jsonl stat ENOENT (file rotated/removed)", {
              path: newestJsonl,
              errno: n.code,
            });
          } else {
            proxyJsonlStatLog.warn("jsonl stat failed", {
              path: newestJsonl,
              errno: n.code,
              message: n.message,
            });
          }
          return;
        }
        if (stat.size <= jsonlReadOffset) return;
        const fd = fs.openSync(newestJsonl, "r");
        const buf = Buffer.alloc(Math.min(stat.size - jsonlReadOffset, 64 * 1024));
        fs.readSync(fd, buf, 0, buf.length, jsonlReadOffset);
        fs.closeSync(fd);
        jsonlReadOffset += buf.length;
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            processJsonlEntry(JSON.parse(line));
          } catch (err) {
            const n = normalizeErr(err);
            const now = Date.now();
            parseFailTimestamps.push(now);
            // prune timestamps older than the window
            parseFailTimestamps = parseFailTimestamps.filter(
              (t) => now - t <= PARSE_FAIL_WINDOW_MS,
            );
            if (parseFailTimestamps.length > PARSE_FAIL_THRESHOLD) {
              parseFailCircuitTripped = true;
              proxyJsonlWatchLog.error("excessive parse failures, disabling watcher", {
                path: newestJsonl,
                failuresInWindow: parseFailTimestamps.length,
                windowMs: PARSE_FAIL_WINDOW_MS,
                lastErrno: n.code,
                lastMessage: n.message,
              });
              if (jsonlPollTimer) {
                clearInterval(jsonlPollTimer);
                jsonlPollTimer = null;
              }
              if (jsonlDebounceTimer) {
                clearTimeout(jsonlDebounceTimer);
                jsonlDebounceTimer = null;
              }
              if (jsonlWatcher) {
                try {
                  const closeResult = jsonlWatcher.close();
                  if (closeResult && typeof (closeResult as Promise<unknown>).then === "function") {
                    (closeResult as Promise<unknown>).catch(() => { /* best-effort */ });
                  }
                } catch {
                  // best-effort close
                }
                jsonlWatcher = null;
              }
              return;
            }
            proxyJsonlWatchLog.warn("jsonl parse failed", {
              path: newestJsonl,
              errno: n.code,
              message: n.message,
            });
          }
        }
      } catch (err) {
        const n = normalizeErr(err);
        proxyJsonlWatchLog.warn("jsonl read failed", {
          path: newestJsonl,
          errno: n.code,
          message: n.message,
        });
      }
    };

    const processJsonlEntry = (entry: { type?: string; message?: { content?: unknown[] } }): void => {
      const wasTurns = liveState.turns;
      const wasToolCalls = liveState.toolCalls;
      const wasSignal = liveState.signalKind;
      if (entry.type === "user") {
        liveState.turns += 1;
        // Extract prompt features for signal detection
        const content = (entry as Record<string, unknown>).message;
        if (content && typeof content === "object") {
          const msgContent = (content as Record<string, unknown>).content;
          if (typeof msgContent === "string") {
            liveState.lastPromptLength = msgContent.length;
            liveState.lastHasFileRefs = /\.[a-z]{1,5}\b/i.test(msgContent) || /\//g.test(msgContent);
            liveState.lastHasSymbolRefs = /[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]+|\(\)/.test(msgContent);
            liveState.lastHasAcceptanceRef = /完了|done|accept|pass|通[れる]|OK/.test(msgContent);
            liveState.lastHasTestRef = /test|テスト|spec|assert/.test(msgContent);
            // Simple structure score: count bullets, numbered items, section markers
            const bullets = (msgContent.match(/^[-*•]\s/gm) ?? []).length;
            const numbered = (msgContent.match(/^\d+\.\s/gm) ?? []).length;
            liveState.lastStructureScore = Math.min(5, bullets + numbered + (liveState.lastHasAcceptanceRef ? 1 : 0) + (liveState.lastHasFileRefs ? 1 : 0));
            // Update prompt score for grade
            const structurePart = Math.min(40, (liveState.lastStructureScore / 5) * 40);
            const specificityPart = (liveState.lastHasFileRefs || liveState.lastHasSymbolRefs) ? 30 : 0;
            const verificationPart = (liveState.lastHasAcceptanceRef || liveState.lastHasTestRef) ? 30 : 0;
            liveState.promptScore = Math.round(structurePart + specificityPart + verificationPart);
          }
        }
        updateAdvice();
      } else if (entry.type === "assistant") {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_use") {
              liveState.toolCalls += 1;
              liveState.lastTool = String(b.name ?? "");
              // Track file edits for same_file_revisit detection
              if (liveState.lastTool === "Edit" || liveState.lastTool === "Write") {
                const input = b.input as Record<string, unknown> | undefined;
                const filePath = typeof input?.file_path === "string" ? input.file_path : "";
                if (filePath) {
                  liveState.lastFile = filePath;
                  liveState.filePatchCounts.set(filePath, (liveState.filePatchCounts.get(filePath) ?? 0) + 1);
                }
              }
            }
          }
        }
      }
      // Event-driven live-state write: trigger only when meaningful change occurs.
      const turnsChanged = liveState.turns !== wasTurns;
      const toolCallsChanged = liveState.toolCalls !== wasToolCalls;
      const signalChanged = liveState.signalKind !== wasSignal;
      if (turnsChanged || toolCallsChanged || signalChanged) {
        writeLiveState();
      }
    };

    const updateAdvice = (): void => {
      const adviceConfig = config.advice ?? {
        vaguePromptThreshold: 30,
        sameFileRevisitThreshold: 3,
        scopeCreepFileThreshold: 5,
        scopeCreepEntropyThreshold: 0.85,
        showBeforeAfterExamples: true,
      };

      const signals = detectLiveSignals({
        turns: liveState.turns,
        toolCalls: liveState.toolCalls,
        sessionStartMs: liveState.sessionStartMs,
        lastTool: liveState.lastTool,
        lastFile: liveState.lastFile,
        filePatchCounts: liveState.filePatchCounts,
        symbolTouchCounts: liveState.symbolTouchCounts,
        promptLength: liveState.lastPromptLength,
        hasFileRefs: liveState.lastHasFileRefs,
        hasSymbolRefs: liveState.lastHasSymbolRefs,
        hasAcceptanceRef: liveState.lastHasAcceptanceRef,
        hasTestRef: liveState.lastHasTestRef,
        structureScore: liveState.lastStructureScore,
        firstPassGreen: liveState.lastFirstPassGreen,
        config: adviceConfig,
      });

      const topAdvice = generateTopAdvice(signals);
      if (topAdvice) {
        liveState.advice = topAdvice.headline;
        liveState.adviceDetail = topAdvice.detail;
        liveState.signalKind = topAdvice.signal.kind;
        liveState.beforeExample = topAdvice.beforeExample ?? "";
        liveState.afterExample = topAdvice.afterExample ?? "";
      } else {
        // No signal fired — show a rotating tip from the tips library
        const tip = pickTip(liveState.turns);
        liveState.advice = tip.headline;
        liveState.adviceDetail = tip.detail;
        liveState.signalKind = "tip";
        liveState.beforeExample = tip.beforeExample ?? "";
        liveState.afterExample = tip.afterExample ?? "";
      }

      // Update session grade
      const gradeResult = computeLiveGrade({
        promptScore: liveState.promptScore,
        turns: liveState.turns,
        toolCalls: liveState.toolCalls,
        firstPassGreen: liveState.lastFirstPassGreen,
        comboCount: liveState.comboCount,
      });
      liveState.sessionGrade = gradeResult.grade;
      liveState.promptScore = gradeResult.promptScore;
      liveState.efficiencyScore = gradeResult.efficiencyScore;
    };

    findNewestJsonl();
    if (newestJsonl) {
      try {
        jsonlReadOffset = fs.statSync(newestJsonl).size;
      } catch (err) {
        const n = normalizeErr(err);
        if (n.code === "ENOENT") {
          proxyJsonlStatLog.debug("initial jsonl stat ENOENT", {
            path: newestJsonl,
            errno: n.code,
          });
        } else {
          proxyJsonlStatLog.warn("initial jsonl stat failed", {
            path: newestJsonl,
            errno: n.code,
            message: n.message,
          });
        }
      }
    }

    // Rotation handler: when a new JSONL appears (or an existing one bumps mtime
    // ahead of our tracked newest), reset offset + live state so the new session
    // starts clean. Returns true if rotation happened.
    const handleRotationCandidate = (fullPath: string): boolean => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (err) {
        const n = normalizeErr(err);
        if (n.code === "ENOENT") {
          proxyJsonlStatLog.debug("rotation stat ENOENT", {
            path: fullPath,
            errno: n.code,
          });
        } else {
          proxyJsonlStatLog.warn("rotation stat failed", {
            path: fullPath,
            errno: n.code,
            message: n.message,
          });
        }
        return false;
      }
      if (stat.mtimeMs <= newestMtime) return false;
      const oldPath = newestJsonl;
      newestMtime = stat.mtimeMs;
      newestJsonl = fullPath;
      jsonlReadOffset = 0; // read new file from start
      // Session reset: clear stale live state
      liveState.turns = 0;
      liveState.toolCalls = 0;
      liveState.lastTool = "";
      liveState.lastFile = "";
      liveState.promptScore = 0;
      liveState.efficiencyScore = 0;
      liveState.sessionGrade = "C";
      liveState.signalKind = "";
      liveState.advice = "";
      liveState.adviceDetail = "";
      liveState.beforeExample = "";
      liveState.afterExample = "";
      liveState.sessionStartMs = Date.now();
      liveState.filePatchCounts.clear();
      liveState.symbolTouchCounts.clear();
      liveState.lastPromptLength = 0;
      liveState.lastHasFileRefs = false;
      liveState.lastHasSymbolRefs = false;
      liveState.lastHasAcceptanceRef = false;
      liveState.lastHasTestRef = false;
      liveState.lastStructureScore = 0;
      liveState.lastFirstPassGreen = true;
      proxyJsonlWatchLog.info("jsonl rotated", { oldPath, newPath: fullPath });
      // Write a "session changed" snapshot so statusline reflects rotation immediately.
      writeLiveState();
      return true;
    };

    // Debounced flush: collapses rapid bursts of writes from the wrapped CLI.
    const scheduleFlush = (): void => {
      if (jsonlDebounceTimer) return; // already pending; let the existing timer fire
      jsonlDebounceTimer = setTimeout(() => {
        jsonlDebounceTimer = null;
        try {
          processNewLines();
        } catch (err) {
          const n = normalizeErr(err);
          proxyJsonlWatchLog.warn("debounced flush failed", {
            errno: n.code,
            message: n.message,
          });
        }
      }, 250);
      if (typeof jsonlDebounceTimer.unref === "function") jsonlDebounceTimer.unref();
    };

    let watcherMode: "fs.watch" | "chokidar" = "chokidar";
    try {
      const cw = chokidar.watch(path.join(projectDir, "*.jsonl"), {
        ignoreInitial: false,
        persistent: false,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      });
      cw.on("add", (p: string) => {
        handleRotationCandidate(p);
        scheduleFlush();
      });
      cw.on("change", (p: string) => {
        // A "change" on a file other than newestJsonl with a fresher mtime is
        // also a rotation (e.g. CLI resumed an older session file).
        if (p !== newestJsonl) {
          handleRotationCandidate(p);
        }
        scheduleFlush();
      });
      cw.on("error", (err: unknown) => {
        const n = normalizeErr(err);
        proxyJsonlWatchLog.warn("chokidar watcher error", {
          path: projectDir,
          errno: n.code,
          message: n.message,
        });
      });
      jsonlWatcher = cw as unknown as typeof jsonlWatcher;
      proxyJsonlWatchLog.info("watcher started", {
        path: projectDir,
        mode: watcherMode,
      });
    } catch (err) {
      const n = normalizeErr(err);
      proxyJsonlWatchLog.warn("chokidar init failed, falling back to fs.watch", {
        path: projectDir,
        errno: n.code,
        message: n.message,
      });
      watcherMode = "fs.watch";
      try {
        const fw = fs.watch(projectDir, { persistent: false }, (_ev, filename) => {
          if (!filename) return;
          const name = String(filename);
          if (!name.endsWith(".jsonl")) return;
          const fullPath = path.join(projectDir, name);
          if (fullPath !== newestJsonl) {
            handleRotationCandidate(fullPath);
          }
          scheduleFlush();
        });
        if (typeof (fw as unknown as { unref?: () => void }).unref === "function") {
          (fw as unknown as { unref: () => void }).unref();
        }
        jsonlWatcher = fw as unknown as typeof jsonlWatcher;
        proxyJsonlWatchLog.info("watcher started", {
          path: projectDir,
          mode: watcherMode,
        });
      } catch (innerErr) {
        const inner = normalizeErr(innerErr);
        proxyJsonlWatchLog.warn("fs.watch init failed", {
          path: projectDir,
          errno: inner.code,
          message: inner.message,
        });
      }
    }

    // Safety-net: re-run processNewLines every 5 s regardless. If the watcher
    // missed an event (rare, but happens on some Windows network mounts) this
    // keeps tracking alive. Note: this does NOT call writeLiveState — that is
    // event-driven (see processJsonlEntry, finalizeTurn, episode end).
    jsonlPollTimer = setInterval(() => {
      findNewestJsonl();
      processNewLines();
    }, 5000);
    if (typeof jsonlPollTimer.unref === "function") jsonlPollTimer.unref();
  };

  if (liveTrackingEnabled) {
    startJsonlWatcher();
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
    turnState.inputText += text;
    turnState.lastActivityAt = Date.now();
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
    process.stdout.write(`\r\n${renderMascotStartupLine(mascotProfile, cli, lightweightTracking)}\r\n`);
  };

  if (process.stderr.isTTY && !interactivePassthrough) {
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

    try {
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
      proxyEpisodeLog.info("turn summary written", { episodeId, turnIndex });
    } catch (err) {
      const n = normalizeErr(err);
      proxyEpisodeLog.warn("turn summary write failed", {
        episodeId,
        turnIndex,
        errno: n.code,
        message: n.message,
      });
    }
    turnState = createEmptyTurn();
    // Event-driven live-state refresh: a finalized turn changes nothing in
    // liveState directly, but combo/grade may have shifted via mascot updates
    // elsewhere. Cheap to write — keeps statusline aligned with turn boundaries.
    if (liveTrackingEnabled) {
      writeLiveState();
    }
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

  if (!interactivePassthrough) {
    child.stdout?.on("data", (chunk: Buffer) => consumeStream("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => consumeStream("stderr", chunk));
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const ctx = { exitCode: code, signal };
      if ((code !== null && code !== 0) || signal !== null) {
        proxySubprocessLog.warn("subprocess exited", ctx);
      } else {
        proxySubprocessLog.info("subprocess exited", ctx);
      }
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
