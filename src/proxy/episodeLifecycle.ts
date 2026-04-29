// episodeLifecycle — turn finalization, episode finalization, signal evaluation,
// and DB persistence. Pure refactor of inline closures previously defined in
// runProxySession.
//
// Each exported function takes an explicit context object so the orchestrator
// can wire shared mutable state (turnState, events, mascot profile, db, etc.)
// without losing the closure-shaped behaviour. All log keys, log levels,
// stdout/stderr writes, and DB calls are preserved verbatim.

import type { EvoDatabase } from "../db";
import { getLogger } from "../logger";
import {
  loadMascotProfile,
  renderMascotSpecialEvent,
  renderMascotState,
  renderMascotTurnLine,
  computeIdealStateGauge,
} from "../mascot";
import { detectLiveSignals, generateTopAdvice, pickTip } from "../signalDetector";
import { computeLiveGrade } from "../sessionGrade";
import { extractPromptProfile } from "../promptProfile";
import {
  buildEpisodeComplexity,
  buildTurnSummary,
  collectAttentionPathsFromEvents,
  computeLoopSignals,
  computePredictiveNudges,
  computeScoreBreakdown,
  buildEpisodeSummary,
} from "../scoring";
import type {
  EpisodeEvent,
  EvoConfig,
  MascotProfile,
  ProxyRunOptions,
  TurnRecord,
  TurnSummary,
} from "../types";

const proxyEpisodeLog = getLogger().child("proxy.episode");

function normalizeErr(err: unknown): { message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code, stack: e.stack };
  }
  return { message: String(err) };
}

// ── Live state shape (mirrored from proxyRuntime; kept narrow on purpose) ──

export interface ProxyTurnState {
  startedAt: string;
  inputText: string;
  outputText: string;
  events: EpisodeEvent[];
  firstOutputAt?: number;
  lastActivityAt: number;
}

export interface ProxyLiveState {
  turns: number;
  userMessages: number;
  toolCalls: number;
  lastTool: string;
  lastFile: string;
  sessionStartMs: number;
  advice: string;
  adviceDetail: string;
  signalKind: string;
  beforeExample: string;
  afterExample: string;
  sessionGrade: string;
  promptScore: number;
  efficiencyScore: number;
  comboCount: number;
  filePatchCounts: Map<string, number>;
  symbolTouchCounts: Map<string, number>;
  lastPromptLength: number;
  lastHasFileRefs: boolean;
  lastHasSymbolRefs: boolean;
  lastHasAcceptanceRef: boolean;
  lastHasTestRef: boolean;
  lastStructureScore: number;
  lastFirstPassGreen: boolean;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastExitAt: number | null;
  lastSubcommand: string | null;
}

const TURN_NOISE_PATTERNS = [
  /no stdin data received in \d+s/i,
  /input must be provided either through stdin or as a prompt argument/i,
];

export function createEmptyTurn(): ProxyTurnState {
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

export function shouldSuppressTurnFeedback(turnState: ProxyTurnState): boolean {
  const normalizedOutput = normalizeTurnOutput(turnState.outputText);
  if (!normalizedOutput) return false;

  const outputLines = normalizedOutput.split("\n");
  const hasOnlyNoiseOutput = outputLines.every((line) =>
    TURN_NOISE_PATTERNS.some((pattern) => pattern.test(line)),
  );
  const hasMeaningfulInput = turnState.inputText.trim().length > 0;

  return hasOnlyNoiseOutput && !hasMeaningfulInput;
}

export function createEvent(
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

// ── Live-state advice/grade refresh (signal evaluation) ──

export function refreshLiveAdvice(
  liveState: ProxyLiveState,
  config: EvoConfig,
): void {
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
  // Avoid contradiction between cumulative grade and recent-turn signal kind
  // (e.g. grade='D' co-occurring with signal='first_pass_success'): when the
  // current top-advice signal is positive, boost the cumulative score.
  const POSITIVE_SIGNAL_KINDS = new Set([
    "first_pass_success",
    "good_structure",
    "improving_trend",
  ]);
  const recentPositiveSignal = !!topAdvice && POSITIVE_SIGNAL_KINDS.has(topAdvice.signal.kind);
  const gradeResult = computeLiveGrade({
    promptScore: liveState.promptScore,
    turns: liveState.turns,
    toolCalls: liveState.toolCalls,
    firstPassGreen: liveState.lastFirstPassGreen,
    comboCount: liveState.comboCount,
    recentPositiveSignal,
  });
  liveState.sessionGrade = gradeResult.grade;
  liveState.promptScore = gradeResult.promptScore;
  liveState.efficiencyScore = gradeResult.efficiencyScore;
}

// ── Live-state payload builder (used by both event-driven writes and teardown) ──

export function buildLiveStatePayload(
  liveState: ProxyLiveState,
  mascotProfile: MascotProfile,
): Record<string, unknown> {
  const state = renderMascotState(mascotProfile);
  return {
    turns: liveState.turns,
    userMessages: liveState.userMessages,
    toolCalls: liveState.toolCalls,
    advice: liveState.advice,
    mood: mascotProfile.mood,
    avatar: state.avatar,
    nickname: mascotProfile.nickname,
    bond: state.progressPercent,
    idealStateGauge: computeIdealStateGauge(mascotProfile),
    updatedAt: Date.now(),
    sessionGrade: liveState.sessionGrade,
    promptScore: liveState.promptScore,
    efficiencyScore: liveState.efficiencyScore,
    comboCount: liveState.comboCount,
    adviceDetail: liveState.adviceDetail,
    signalKind: liveState.signalKind,
    beforeExample: liveState.beforeExample,
    afterExample: liveState.afterExample,
    lastExitCode: liveState.lastExitCode,
    lastExitSignal: liveState.lastExitSignal,
    lastExitAt: liveState.lastExitAt,
    lastSubcommand: liveState.lastSubcommand,
  };
}

// ── JSONL entry → live-state mutation (assistant tool calls + user messages) ──

export interface ProcessJsonlEntryContext {
  liveState: ProxyLiveState;
  config: EvoConfig;
  /** Triggered after meaningful state change so caller can flush live state. */
  onStateChanged: () => void;
}

export function processJsonlEntry(
  entry: { type?: string; message?: { content?: unknown[] } },
  ctx: ProcessJsonlEntryContext,
): void {
  const { liveState, config, onStateChanged } = ctx;
  const wasTurns = liveState.turns;
  const wasUserMessages = liveState.userMessages;
  const wasToolCalls = liveState.toolCalls;
  const wasSignal = liveState.signalKind;
  if (entry.type === "user") {
    liveState.turns += 1;
    // Distinguish "real" user messages from tool_result echoes.
    // Anthropic API wire-formats tool results as user-type entries with
    // a content array of {type:"tool_result", ...} blocks. We treat an
    // entry as a real user message if:
    //   - content is a string (always real), OR
    //   - content is an array AND at least one item has type !== "tool_result"
    // If every item is a tool_result, it is a tool response, not a user message.
    const msgObj = (entry as Record<string, unknown>).message;
    let isRealUserMessage = false;
    if (msgObj && typeof msgObj === "object") {
      const msgContent = (msgObj as Record<string, unknown>).content;
      if (typeof msgContent === "string") {
        isRealUserMessage = true;
      } else if (Array.isArray(msgContent)) {
        isRealUserMessage = msgContent.some((item) => {
          if (!item || typeof item !== "object") return false;
          const t = (item as Record<string, unknown>).type;
          return typeof t === "string" && t !== "tool_result";
        });
      }
    }
    if (isRealUserMessage) {
      liveState.userMessages += 1;
    }
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
    refreshLiveAdvice(liveState, config);
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
  const userMessagesChanged = liveState.userMessages !== wasUserMessages;
  const toolCallsChanged = liveState.toolCalls !== wasToolCalls;
  const signalChanged = liveState.signalKind !== wasSignal;
  if (turnsChanged || userMessagesChanged || toolCallsChanged || signalChanged) {
    onStateChanged();
  }
}

// ── JSONL rotation reset ──

export function resetLiveStateOnRotation(liveState: ProxyLiveState): void {
  liveState.turns = 0;
  liveState.userMessages = 0;
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
}

// ── finalizeTurn ──

export interface FinalizeTurnContext {
  options: ProxyRunOptions;
  config: EvoConfig;
  episodeId: number;
  db: EvoDatabase;
  mascotProfile: MascotProfile;
  events: EpisodeEvent[];
  watcherPaths: Set<string>;
  turnRecords: TurnRecord[];
  turnSummaries: TurnSummary[];
  recentMessageKeys: string[];
  /** Mutable holder so we can swap turnState after each finalize. */
  turnStateRef: { current: ProxyTurnState };
  /** Increment + return the new turn index. */
  bumpTurnIndex: () => number;
  pushTurnEvent: (event: EpisodeEvent) => void;
  /** Whether liveTracking is enabled — controls trailing writeLiveState. */
  liveTrackingEnabled: boolean;
  flushLiveState: () => void;
}

export function finalizeTurn(ctx: FinalizeTurnContext): void {
  const {
    options,
    config,
    episodeId,
    db,
    mascotProfile,
    watcherPaths,
    turnRecords,
    turnSummaries,
    recentMessageKeys,
    turnStateRef,
    bumpTurnIndex,
    pushTurnEvent,
    liveTrackingEnabled,
    flushLiveState,
  } = ctx;
  const turnState = turnStateRef.current;

  if (!turnState.inputText.trim() && !turnState.outputText.trim() && turnState.events.length === 0) {
    turnStateRef.current = createEmptyTurn();
    return;
  }

  if (shouldSuppressTurnFeedback(turnState)) {
    turnStateRef.current = createEmptyTurn();
    return;
  }

  const turnIndex = bumpTurnIndex();
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
  turnStateRef.current = createEmptyTurn();
  // Event-driven live-state refresh: a finalized turn changes nothing in
  // liveState directly, but combo/grade may have shifted via mascot updates
  // elsewhere. Cheap to write — keeps statusline aligned with turn boundaries.
  if (liveTrackingEnabled) {
    flushLiveState();
  }
}

// ── finalizeEpisode (post-spawn DB persistence + summary) ──

import type { WorkspaceSnapshot } from "../types";
import { diffSymbolSnapshots } from "../ast";
import { diffSnapshots } from "../snapshot";
import { updateMascotAfterEpisode } from "../mascot";

export interface FinalizeEpisodeContext {
  cwd: string;
  options: ProxyRunOptions;
  config: EvoConfig;
  episodeId: number;
  db: EvoDatabase;
  cli: ProxyRunOptions["cli"];
  events: EpisodeEvent[];
  usageObservations: import("../types").UsageObservation[];
  exitCode: number;
  exitSignal: string | null;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  promptProfile: ReturnType<typeof extractPromptProfile>;
  turnRecords: TurnRecord[];
  turnSummaries: TurnSummary[];
  liveState: ProxyLiveState;
}

export async function finalizeEpisode(ctx: FinalizeEpisodeContext): Promise<{
  artifacts: import("../types").EpisodeArtifacts;
}> {
  const {
    cwd,
    options: _options,
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
  } = ctx;

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
  const mascotUpdate = updateMascotAfterEpisode(cwd, summary, undefined, {
    promptScore: liveState.promptScore,
    sessionGrade: liveState.sessionGrade,
    signalKind: liveState.signalKind,
  });
  // Caller may want the refreshed mascot profile; reload for symmetry.
  loadMascotProfile(cwd);

  db.saveTurns(episodeId, turnRecords, turnSummaries);
  db.finishEpisode(episodeId, {
    finishedAt: new Date().toISOString(),
    exitCode,
    exitSignal,
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

  return {
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
