import {
  ActionableAdvice,
  CounterfactualProfileKind,
  EpisodeComplexity,
  EpisodeEvent,
  EpisodeSummary,
  ExpectedCostEstimate,
  FrictionSummary,
  InterventionDecision,
  LoopSignals,
  PredictiveNudge,
  PromptProfile,
  RenderedAdviceMessage,
  ScoreBreakdown,
  StopAndReframeDecision,
  TurnSummary,
} from "./types";
import { buildStopAndReframeDecision, findBestStopTurn, summarizeFrictionEvents } from "./capture/frictionCore";
import { createCounterfactualPromptProfile } from "./promptProfile";
import { detectSignals, generateTopAdvice, type SignalDetectionInput } from "./signalDetector";

export const SCORE_WEIGHTS = {
  filesRead: 1.2,
  linesReadNorm: 0.8,
  symbolRevisits: 1.6,
  retryCount: 1.7,
  failedVerifications: 2.2,
  crossFileSpread: 1.1,
  noChangeTurns: 1.9,
  explorationPenalty: 2.4,
  convergenceBonus: 1.6,
} as const;

export interface StatsLookup {
  lookupExpectedCost(
    promptProfile: PromptProfile,
    complexity: EpisodeComplexity,
  ): ExpectedCostEstimate;
  getRecentSymbolTouchCount(stableSymbolId: string): number;
  getRecentSearchLoopOverlap(attentionPaths: string[]): number;
  getRecentNudgeEffectiveness?(): number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function pickVariant(seed: string, variants: string[]): string {
  const value = Number.parseInt(seed.slice(0, 6), 16);
  return variants[Math.abs(value) % variants.length];
}

function compareBucketStrength(level: ExpectedCostEstimate["bucketLevel"]): number {
  switch (level) {
    case "exact":
      return 4;
    case "backoff1":
      return 3;
    case "backoff2":
      return 2;
    case "global":
      return 1;
  }
}

function collectAttentionPaths(events: EpisodeEvent[]): string[] {
  const collected: string[] = [];
  for (const event of events) {
    const pathValue = event.details.path;
    if (typeof pathValue === "string" && pathValue.length > 0) {
      collected.push(pathValue);
    }
  }
  return collected;
}

function normalizedEntropyOf(items: string[]): number {
  if (items.length <= 1) return 0;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  if (counts.size <= 1) return 0;

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / items.length;
    entropy += -probability * Math.log2(probability);
  }

  return entropy / Math.log2(counts.size);
}

function computeAttentionMetrics(paths: string[]): {
  attentionEntropy: number;
  attentionCompression: number;
  noveltyRatio: number;
  repeatedAttentionRatio: number;
} {
  if (paths.length === 0) {
    return {
      attentionEntropy: 0,
      attentionCompression: 0,
      noveltyRatio: 1,
      repeatedAttentionRatio: 0,
    };
  }

  const counts = new Map<string, number>();
  for (const item of paths) counts.set(item, (counts.get(item) ?? 0) + 1);
  const midpoint = Math.max(1, Math.floor(paths.length / 2));
  const earlyEntropy = normalizedEntropyOf(paths.slice(0, midpoint));
  const lateEntropy = normalizedEntropyOf(paths.slice(midpoint));

  return {
    attentionEntropy: round(clamp(normalizedEntropyOf(paths), 0, 1)),
    attentionCompression: round(clamp(earlyEntropy - lateEntropy, -1, 1)),
    noveltyRatio: round(clamp(counts.size / paths.length, 0, 1)),
    repeatedAttentionRatio: round(clamp(1 - (counts.size / paths.length), 0, 1)),
  };
}

function deriveExplorationMode(input: {
  searchCount: number;
  filesRead: number;
  changedFilesCount: number;
  changedSymbolsCount: number;
  attentionEntropy: number;
  attentionCompression: number;
  repeatedAttentionRatio: number;
}): EpisodeComplexity["explorationMode"] {
  const explorationVolume = input.searchCount + input.filesRead;
  if (explorationVolume === 0) return "direct";
  if (input.repeatedAttentionRatio >= 0.6) return "loop-prone";
  if (input.attentionEntropy >= 0.78 && input.attentionCompression <= 0) return "scattered";
  if (explorationVolume > input.changedFilesCount + input.changedSymbolsCount + 2) {
    return "exploration-heavy";
  }
  return "balanced";
}

function categorizeCounterfactual(counterfactual: CounterfactualProfileKind): PredictiveNudge["category"] {
  switch (counterfactual) {
    case "structured_baseline":
      return "structure";
    case "plus_10_chars_specificity":
      return "specificity";
    case "with_test_intent":
      return "verification";
  }
}

function latencyBucket(responseLatencyMs: number): string {
  if (responseLatencyMs < 4000) return "fast";
  if (responseLatencyMs < 12000) return "steady";
  return "slow";
}

export function buildEpisodeComplexity(input: {
  changedFilesCount: number;
  changedSymbolsCount: number;
  changedLinesCount: number;
  languages: string[];
  testsPresent: boolean;
  filesRead: number;
  searchCount: number;
  attentionPaths: string[];
}): EpisodeComplexity {
  const changedFilesBucket =
    input.changedFilesCount <= 1 ? "1" : input.changedFilesCount <= 2 ? "2" : input.changedFilesCount <= 4 ? "3-4" : "5+";
  const changedSymbolsBucket =
    input.changedSymbolsCount <= 1 ? "1" : input.changedSymbolsCount <= 3 ? "2-3" : "4+";
  const changedLinesBucket =
    input.changedLinesCount <= 20 ? "1-20" : input.changedLinesCount <= 100 ? "21-100" : "101+";
  const attentionMetrics = computeAttentionMetrics(input.attentionPaths);
  const explorationMode = deriveExplorationMode({
    searchCount: input.searchCount,
    filesRead: input.filesRead,
    changedFilesCount: input.changedFilesCount,
    changedSymbolsCount: input.changedSymbolsCount,
    attentionEntropy: attentionMetrics.attentionEntropy,
    attentionCompression: attentionMetrics.attentionCompression,
    repeatedAttentionRatio: attentionMetrics.repeatedAttentionRatio,
  });

  return {
    changedFilesCount: input.changedFilesCount,
    changedFilesBucket,
    changedSymbolsCount: input.changedSymbolsCount,
    changedSymbolsBucket,
    changedLinesCount: input.changedLinesCount,
    changedLinesBucket,
    testsPresent: input.testsPresent,
    languages: [...new Set(input.languages)].sort(),
    explorationHeavy: explorationMode === "exploration-heavy" || explorationMode === "scattered",
    explorationMode,
    attentionEntropy: attentionMetrics.attentionEntropy,
    attentionCompression: attentionMetrics.attentionCompression,
    noveltyRatio: attentionMetrics.noveltyRatio,
    repeatedAttentionRatio: attentionMetrics.repeatedAttentionRatio,
    scopeBucket: `${changedFilesBucket}|${changedSymbolsBucket}|${changedLinesBucket}`,
  };
}

export function computeScoreBreakdown(input: {
  events: EpisodeEvent[];
  complexity: EpisodeComplexity;
  touchedStableSymbolIds: string[];
  stats: StatsLookup;
  failedVerifications: number;
}): ScoreBreakdown {
  const filesRead = input.events.filter((event) => event.type === "file_read").length;
  const linesReadNorm = Math.max(1, Math.ceil(filesRead * 0.8));
  const noChangeTurns = input.events.filter((event) => event.type === "no_code_change_response").length;
  const clarificationCount = input.events.filter((event) => event.type === "clarification_prompt").length;
  const verificationRuns = input.events.filter(
    (event) => event.type === "test_run" || event.type === "build_run",
  ).length;
  const retryCount = Math.max(0, verificationRuns - 1) + clarificationCount;
  const symbolRevisits = input.touchedStableSymbolIds.reduce(
    (total, stableSymbolId) => total + Number(input.stats.getRecentSymbolTouchCount(stableSymbolId) > 0),
    0,
  );
  const crossFileSpread = Math.max(0, input.complexity.changedFilesCount - 1);
  const explorationPenalty = round(
    clamp(
      (input.complexity.attentionEntropy * 0.7) +
        (input.complexity.repeatedAttentionRatio * 0.9) +
        (input.complexity.explorationMode === "scattered" ? 0.35 : 0) +
        (input.complexity.explorationMode === "loop-prone" ? 0.45 : 0),
      0,
      2.5,
    ),
  );
  const convergenceBonus = round(
    clamp(
      (Math.max(input.complexity.attentionCompression, 0) * 0.9) +
        (input.complexity.noveltyRatio < 0.7 ? 0.2 : 0),
      0,
      1.4,
    ),
  );

  const surrogateCost =
    SCORE_WEIGHTS.filesRead * filesRead +
    SCORE_WEIGHTS.linesReadNorm * linesReadNorm +
    SCORE_WEIGHTS.symbolRevisits * symbolRevisits +
    SCORE_WEIGHTS.retryCount * retryCount +
    SCORE_WEIGHTS.failedVerifications * input.failedVerifications +
    SCORE_WEIGHTS.crossFileSpread * crossFileSpread +
    SCORE_WEIGHTS.noChangeTurns * noChangeTurns +
    SCORE_WEIGHTS.explorationPenalty * explorationPenalty -
    SCORE_WEIGHTS.convergenceBonus * convergenceBonus;

  return {
    filesRead,
    linesReadNorm,
    symbolRevisits,
    retryCount,
    failedVerifications: input.failedVerifications,
    crossFileSpread,
    noChangeTurns,
    attentionEntropy: input.complexity.attentionEntropy,
    attentionCompression: input.complexity.attentionCompression,
    noveltyRatio: input.complexity.noveltyRatio,
    repeatedAttentionRatio: input.complexity.repeatedAttentionRatio,
    explorationPenalty,
    convergenceBonus,
    surrogateCost: round(surrogateCost, 2),
  };
}

export function computePredictiveNudges(
  promptProfile: PromptProfile,
  complexity: EpisodeComplexity,
  stats: StatsLookup,
): PredictiveNudge[] {
  const currentEstimate = stats.lookupExpectedCost(promptProfile, complexity);
  const counterfactuals: CounterfactualProfileKind[] = [
    "structured_baseline",
    "plus_10_chars_specificity",
    "with_test_intent",
  ];

  return counterfactuals.map((counterfactual) => {
    const nextProfile = createCounterfactualPromptProfile(promptProfile, counterfactual);
    const estimate = stats.lookupExpectedCost(nextProfile, complexity);
    const predictedSavingRate = clamp(
      1 - estimate.expectedCost / Math.max(currentEstimate.expectedCost, 0.0001),
      -0.25,
      0.8,
    );
    const confidence = round(Math.min(currentEstimate.confidence, estimate.confidence));
    const explanation =
      counterfactual === "structured_baseline"
        ? "箇条書きと完了条件を足すと、やり直しを減らしやすくなります。"
        : counterfactual === "plus_10_chars_specificity"
          ? "対象ファイルや関数を少し具体化すると、探索の寄り道を減らしやすくなります。"
          : "成功条件やテスト意図を1行入れると、収束までの迷いを減らしやすくなります。";

    return {
      counterfactual,
      currentCost: currentEstimate.expectedCost,
      counterfactualCost: estimate.expectedCost,
      predictedSavingRate: round(predictedSavingRate),
      confidence,
      explanation,
      category: categorizeCounterfactual(counterfactual),
      supportSampleSize: Math.max(0, Math.min(currentEstimate.sampleSize, estimate.sampleSize)),
      bucketLevel:
        compareBucketStrength(currentEstimate.bucketLevel) <= compareBucketStrength(estimate.bucketLevel)
          ? currentEstimate.bucketLevel
          : estimate.bucketLevel,
    };
  });
}

export function computeLoopSignals(input: {
  touchedStableSymbolIds: string[];
  changedFiles: string[];
  events: EpisodeEvent[];
  stats: StatsLookup;
  firstPassGreen: boolean;
}): LoopSignals {
  const editLoop =
    !input.firstPassGreen &&
    input.touchedStableSymbolIds.some(
      (stableSymbolId) => input.stats.getRecentSymbolTouchCount(stableSymbolId) >= 2,
    );
  const attentionPaths = [...new Set(collectAttentionPaths(input.events))];
  const searchLoop =
    !input.firstPassGreen &&
    input.touchedStableSymbolIds.length === 0 &&
    attentionPaths.length > 0 &&
    input.stats.getRecentSearchLoopOverlap(attentionPaths) >= 0.6;

  return {
    editLoop,
    searchLoop,
    touchedStableSymbolIds: input.touchedStableSymbolIds,
  };
}

export function computeInterventionDecision(input: {
  nudges: PredictiveNudge[];
  loopSignals: LoopSignals;
  complexity: EpisodeComplexity;
  friction: FrictionSummary;
  stopAndReframe: StopAndReframeDecision;
  confidence: number;
  assistantReaskRate: number;
  turnRetryDepth: number;
  recentNudgeEffectiveness: number;
  mode: "auto" | "active" | "quiet";
}): InterventionDecision {
  if (input.mode === "active") {
    return {
      mode: "active",
      reasonCodes: ["manual_override"],
      confidence: 1,
      displayBudgetLines: 2,
    };
  }
  if (input.mode === "quiet") {
    return {
      mode: "quiet",
      reasonCodes: ["manual_override"],
      confidence: 1,
      displayBudgetLines: 0,
    };
  }

  const bestSaving = Math.max(...input.nudges.map((nudge) => nudge.predictedSavingRate), 0);
  const noveltyDrop = clamp(1 - input.complexity.noveltyRatio, 0, 1);
  const reasonCodes: string[] = [];
  let score = 0;

  if (input.stopAndReframe.stopAndReframeSignal) {
    reasonCodes.push(...input.stopAndReframe.reasonCodes);
    score += 0.9;
  }
  if (input.loopSignals.editLoop || input.loopSignals.searchLoop) {
    reasonCodes.push("loop_signal");
    score += 0.8;
  }
  if (input.friction.frictionScore >= 1.6) {
    reasonCodes.push("friction_pressure");
    score += 0.4;
  }
  if (input.complexity.explorationMode === "scattered" || input.complexity.explorationMode === "loop-prone") {
    reasonCodes.push("exploration_scatter");
    score += 0.35;
  }
  if (input.turnRetryDepth >= 2 || input.assistantReaskRate >= 0.25) {
    reasonCodes.push("retry_pressure");
    score += 0.3;
  }
  if (bestSaving >= 0.18 && input.confidence >= 0.55) {
    reasonCodes.push("high_saving_headroom");
    score += 0.35;
  }
  if (noveltyDrop >= 0.45) {
    reasonCodes.push("novelty_drop");
    score += 0.25;
  }
  if (input.recentNudgeEffectiveness < 0.2 && reasonCodes.length === 0) {
    reasonCodes.push("steady_progress");
    score -= 0.2;
  }

  if (score >= 0.75) {
    return {
      mode: "active",
      reasonCodes,
      confidence: round(clamp(input.confidence + 0.15, 0, 1)),
      displayBudgetLines: input.loopSignals.editLoop || input.loopSignals.searchLoop ? 3 : 2,
    };
  }

  if (score <= 0.1 && input.turnRetryDepth === 0 && input.assistantReaskRate === 0) {
    return {
      mode: "silent",
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["trivial_turn"],
      confidence: round(clamp(input.confidence, 0, 1)),
      displayBudgetLines: 0,
    };
  }

  return {
    mode: "quiet",
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["low_headroom"],
    confidence: round(clamp(input.confidence, 0, 1)),
    displayBudgetLines: 0,
  };
}

export function renderAdviceMessages(input: {
  promptProfile: PromptProfile;
  nudges: PredictiveNudge[];
  friction: FrictionSummary;
  stopAndReframe: StopAndReframeDecision;
  loopSignals: LoopSignals;
  complexity: EpisodeComplexity;
  decision: InterventionDecision;
  firstPassGreen: boolean;
  recentMessageKeys: string[];
  minConfidenceForPercent: number;
  maxLines: number;
  recentStructureScores?: number[];
  adviceConfig?: import("./types").AdviceConfig;
}): RenderedAdviceMessage[] {
  if (input.decision.mode !== "active") return [];

  const messages: RenderedAdviceMessage[] = [];

  const pushIfFresh = (message: RenderedAdviceMessage): void => {
    if (messages.length >= input.maxLines) return;
    if (input.recentMessageKeys.includes(message.key)) return;
    if (messages.some((item) => item.key === message.key)) return;
    messages.push(message);
  };

  // v3.0: Signal-based advice with before/after examples
  const adviceConfig = input.adviceConfig ?? {
    vaguePromptThreshold: 30,
    sameFileRevisitThreshold: 3,
    scopeCreepFileThreshold: 5,
    scopeCreepEntropyThreshold: 0.85,
    showBeforeAfterExamples: true,
  };

  const signalInput: SignalDetectionInput = {
    promptProfile: input.promptProfile,
    complexity: input.complexity,
    loopSignals: input.loopSignals,
    friction: input.friction,
    firstPassGreen: input.firstPassGreen,
    retryCount: input.nudges.length > 0 ? Math.round(input.nudges[0].currentCost) : 0,
    turnIndex: 0,
    recentStructureScores: input.recentStructureScores ?? [],
    config: adviceConfig,
  };

  const signals = detectSignals(signalInput);
  const topAdvice = generateTopAdvice(signals);

  // Use signal-based advice as primary message source
  if (topAdvice) {
    const beforeAfterSuffix =
      adviceConfig.showBeforeAfterExamples && topAdvice.beforeExample && topAdvice.afterExample
        ? ` / 例: "${topAdvice.beforeExample}" → "${topAdvice.afterExample}"`
        : "";
    pushIfFresh({
      key: `signal-${topAdvice.signal.kind}`,
      category: topAdvice.category,
      severity: topAdvice.signal.severity,
      tone: topAdvice.category === "praise" ? "encouraging" : topAdvice.signal.severity === "high" ? "corrective" : "concise",
      surface: "end_of_turn",
      text: `${topAdvice.headline} / ${topAdvice.detail}${beforeAfterSuffix}`,
      lineBudget: topAdvice.signal.severity === "high" ? 2 : 1,
    });
  }

  // Fall back to friction-based stop-and-reframe if no signal matched
  if (messages.length === 0 && input.stopAndReframe.stopAndReframeSignal) {
    const stopLead =
      input.stopAndReframe.category === "approval_storm"
        ? "承認が連続しています。allowlistか指示を1つにまとめると楽になります。"
        : input.stopAndReframe.category === "error_spiral"
          ? "エラーが連続しています。同じ方法を繰り返すより、問題を分解して切り直しましょう。"
          : input.stopAndReframe.category === "retry_loop"
            ? "リトライが続いています。「現状 / 期待 / NG条件」で切り直すと抜けやすくなります。"
            : "ここで整理すると、次の往復が軽くなります。";
    pushIfFresh({
      key: `friction-${input.stopAndReframe.category}`,
      category: "recovery",
      severity: input.friction.frictionScore >= 2 ? "high" : "medium",
      tone: "corrective",
      surface: "end_of_turn",
      text: `${stopLead} / ${input.stopAndReframe.suggestedReframe} / ${input.stopAndReframe.avoidableCostLabel}`,
      lineBudget: input.friction.frictionScore >= 2 ? 2 : 1,
    });
  }

  // Fall back to predictive nudges with savings estimates
  const bestNudge = [...input.nudges].sort((left, right) => {
    if (right.predictedSavingRate !== left.predictedSavingRate) {
      return right.predictedSavingRate - left.predictedSavingRate;
    }
    return right.confidence - left.confidence;
  })[0];

  if (messages.length === 0 && bestNudge && bestNudge.predictedSavingRate > 0) {
    const includePercent = bestNudge.confidence >= input.minConfidenceForPercent;
    const percent = Math.max(0, Math.round(bestNudge.predictedSavingRate * 100));
    const savingText = includePercent && percent >= 15
      ? `次の一手で ${percent}% 前後、軽くできそう`
      : "次の往復を短くしやすい流れだよ";

    const evidenceLabel =
      bestNudge.supportSampleSize >= 10
        ? `あなたの類似履歴 ${bestNudge.supportSampleSize} 件`
        : bestNudge.supportSampleSize >= 4
          ? `最近の近い履歴 ${bestNudge.supportSampleSize} 件`
          : "暫定予測";

    pushIfFresh({
      key: `nudge-${bestNudge.category}`,
      category: bestNudge.category,
      severity: bestNudge.predictedSavingRate >= 0.25 ? "medium" : "low",
      tone: "encouraging",
      surface: "end_of_turn",
      text: `${savingText} / ${bestNudge.explanation} / ${evidenceLabel}`,
      lineBudget: 1,
      predictedSavingRate: bestNudge.predictedSavingRate,
    });
  }

  // Praise for first-pass-green when nothing else triggered
  if (messages.length === 0 && input.firstPassGreen) {
    const praiseKey =
      input.promptProfile.structureScore >= 4
        ? "praise-structured"
        : input.complexity.attentionCompression > 0.1
          ? "praise-converged"
          : "praise-clean";
    const praiseText =
      praiseKey === "praise-structured"
        ? pickVariant(input.promptProfile.promptHash, [
            "構造化された指示が一発で通った! 箇条書き+完了条件がうまく機能してる。",
            "その切り方、かなりEXPおいしいやつ。ムダ往復をちゃんと抑えられてる。",
            "今回の頼み方、きれいに刺さってる。この形をテンプレにしよう!",
          ])
        : praiseKey === "praise-converged"
          ? pickVariant(input.promptProfile.promptHash, [
              "探索の寄せ方がじょうず。対象を絞って効率的に収束できてる。",
              "見る場所の絞り方がきれい。ロス少なめで進められてる。",
              "散らずに詰められてるね。この流れ、かなり効率的。",
            ])
          : pickVariant(input.promptProfile.promptHash, [
              "一発で通った! ムダ往復も少なめ。いいプロンプト。",
              "今回の依頼、きれいにハマってる。この調子!",
              "いい流れ! そのまま前へ進めそう。",
            ]);
    pushIfFresh({
      key: praiseKey,
      category: "praise",
      severity: "low",
      tone: "encouraging",
      surface: "end_of_turn",
      text: `${praiseText} / 探索モード: ${input.complexity.explorationMode}`,
      lineBudget: 1,
    });
  }

  return messages.slice(0, input.decision.displayBudgetLines);
}

export function buildTurnSummary(input: {
  turnIndex: number;
  promptProfile: PromptProfile;
  events: EpisodeEvent[];
  complexity: EpisodeComplexity;
  touchedStableSymbolIds: string[];
  stats: StatsLookup;
  failedVerifications: number;
  firstPassGreen: boolean;
  responseLatencyMs: number;
  turnRetryDepth: number;
  recentMessageKeys: string[];
  mode: "auto" | "active" | "quiet";
  minConfidenceForPercent: number;
  maxLines: number;
}): TurnSummary {
  const score = computeScoreBreakdown({
    events: input.events,
    complexity: input.complexity,
    touchedStableSymbolIds: input.touchedStableSymbolIds,
    stats: input.stats,
    failedVerifications: input.failedVerifications,
  });
  const loopSignals = computeLoopSignals({
    touchedStableSymbolIds: input.touchedStableSymbolIds,
    changedFiles: collectAttentionPaths(input.events),
    events: input.events,
    stats: input.stats,
    firstPassGreen: input.firstPassGreen,
  });
  const friction = summarizeFrictionEvents(input.events);
  const stopAndReframe = buildStopAndReframeDecision({
    friction,
    events: input.events,
  });
  const nudges = computePredictiveNudges(input.promptProfile, input.complexity, input.stats);
  const clarificationCount = input.events.filter((event) => event.type === "clarification_prompt").length;
  const assistantReaskRate = input.events.length === 0 ? 0 : clarificationCount / input.events.length;
  const recentNudgeEffectiveness = round(
    clamp(input.stats.getRecentNudgeEffectiveness?.() ?? 0.5, 0, 1),
  );
  const confidence = round(
    nudges.length === 0
      ? 0.3
      : nudges.reduce((sum, nudge) => sum + nudge.confidence, 0) / nudges.length,
  );
  const decision = computeInterventionDecision({
    nudges,
    loopSignals,
    complexity: input.complexity,
    friction,
    stopAndReframe,
    confidence,
    assistantReaskRate: round(assistantReaskRate),
    turnRetryDepth: input.turnRetryDepth,
    recentNudgeEffectiveness,
    mode: input.mode,
  });
  if (
    decision.mode === "silent" &&
    input.firstPassGreen &&
    (input.promptProfile.structureScore >= 4 || input.complexity.attentionCompression > 0.1)
  ) {
    decision.mode = "active";
    decision.reasonCodes = [...decision.reasonCodes, "praise_opportunity"];
    decision.displayBudgetLines = 1;
  }
  const adviceMessages = renderAdviceMessages({
    promptProfile: input.promptProfile,
    nudges,
    friction,
    stopAndReframe,
    loopSignals,
    complexity: input.complexity,
    decision,
    firstPassGreen: input.firstPassGreen,
    recentMessageKeys: input.recentMessageKeys,
    minConfidenceForPercent: input.minConfidenceForPercent,
    maxLines: input.maxLines,
  });

  return {
    turnIndex: input.turnIndex,
    promptProfile: input.promptProfile,
    score,
    complexity: input.complexity,
    friction,
    stopAndReframe,
    loopSignals,
    nudges,
    intervention: decision,
    adviceMessages,
    responseLatencyMs: input.responseLatencyMs,
    assistantReaskRate: round(assistantReaskRate),
    turnRetryDepth: input.turnRetryDepth,
    responseLatencyBucket: latencyBucket(input.responseLatencyMs),
    midEpisodeNoveltyDrop: round(clamp(1 - input.complexity.noveltyRatio, 0, 1)),
    recentNudgeEffectiveness,
  };
}

export function buildEpisodeSummary(input: {
  score: ScoreBreakdown;
  promptProfile: PromptProfile;
  complexity: EpisodeComplexity;
  firstPassGreen: boolean;
  loopSignals: LoopSignals;
  nudges: PredictiveNudge[];
  currentEstimate: ExpectedCostEstimate;
  changedFilesCount: number;
  changedSymbolsCount: number;
  changedLinesCount: number;
  turns?: TurnSummary[];
}): EpisodeSummary {
  const lastTurn = input.turns?.[input.turns.length - 1];
  const bestStopTurn = input.turns ? findBestStopTurn(input.turns) : null;
  const episodeFriction = summarizeFrictionEvents(
    (input.turns ?? []).flatMap((turn) => {
      return [];
    }),
  );
  const frictionFromTurns =
    input.turns && input.turns.length > 0
      ? {
          approvalCount: input.turns.reduce((sum, turn) => sum + turn.friction.approvalCount, 0),
          approvalBurst: Math.max(...input.turns.map((turn) => turn.friction.approvalBurst), 0),
          toolErrorCount: input.turns.reduce((sum, turn) => sum + turn.friction.toolErrorCount, 0),
          toolRetryCount: input.turns.reduce((sum, turn) => sum + turn.friction.toolRetryCount, 0),
          toolFailureStreak: Math.max(...input.turns.map((turn) => turn.friction.toolFailureStreak), 0),
          editFailureCount: input.turns.reduce((sum, turn) => sum + turn.friction.editFailureCount, 0),
          recoveryAttempts: input.turns.reduce((sum, turn) => sum + turn.friction.recoveryAttempts, 0),
          humanConfirmationBurst: Math.max(...input.turns.map((turn) => turn.friction.humanConfirmationBurst), 0),
          frictionScore: round(
            input.turns.reduce((sum, turn) => sum + turn.friction.frictionScore, 0) /
              Math.max(1, input.turns.length),
          ),
          stopAndReframeSignal: input.turns.some((turn) => turn.stopAndReframe.stopAndReframeSignal),
          dominantSignal: lastTurn?.friction.dominantSignal ?? "none",
          confidence: round(
            input.turns.reduce((sum, turn) => sum + turn.friction.confidence, 0) / Math.max(1, input.turns.length),
          ),
        }
      : episodeFriction;
  const predictedLossRate =
    input.promptProfile.promptLength < 15 && input.changedFilesCount > 2
      ? clamp(Math.max(...input.nudges.map((nudge) => nudge.predictedSavingRate), 0), 0, 0.8)
      : null;
  const niceGuidanceAwarded = input.promptProfile.structureScore >= 3 && input.firstPassGreen;
  // No EXP for empty sessions (no turns, no file changes, no events)
  const hasActivity = (input.turns?.length ?? 0) > 0 ||
    input.changedFilesCount > 0 ||
    input.score.filesRead > 0;
  const expAwarded = hasActivity
    ? (niceGuidanceAwarded ? 50 : 15) +
      (input.loopSignals.editLoop ? 0 : 10) +
      (input.loopSignals.searchLoop ? 0 : 5) +
      Math.round(input.currentEstimate.confidence * 10)
    : 0;

  return {
    surrogateCost: input.score.surrogateCost,
    filesRead: input.score.filesRead,
    linesReadNorm: input.score.linesReadNorm,
    symbolRevisits: input.score.symbolRevisits,
    retryCount: input.score.retryCount,
    failedVerifications: input.score.failedVerifications,
    crossFileSpread: input.score.crossFileSpread,
    noChangeTurns: input.score.noChangeTurns,
    changedFilesCount: input.changedFilesCount,
    changedSymbolsCount: input.changedSymbolsCount,
    changedLinesCount: input.changedLinesCount,
    firstPassGreen: input.firstPassGreen,
    promptLengthBucket: input.promptProfile.promptLengthBucket,
    structureScore: input.promptProfile.structureScore,
    scopeBucket: input.complexity.scopeBucket,
    explorationMode: input.complexity.explorationMode,
    attentionEntropy: input.score.attentionEntropy,
    attentionCompression: input.score.attentionCompression,
    noveltyRatio: input.score.noveltyRatio,
    expectedCostConfidence: input.currentEstimate.confidence,
    approvalCount: frictionFromTurns.approvalCount,
    approvalBurst: frictionFromTurns.approvalBurst,
    toolErrorCount: frictionFromTurns.toolErrorCount,
    toolRetryCount: frictionFromTurns.toolRetryCount,
    toolFailureStreak: frictionFromTurns.toolFailureStreak,
    editFailureCount: frictionFromTurns.editFailureCount,
    recoveryAttempts: frictionFromTurns.recoveryAttempts,
    humanConfirmationBurst: frictionFromTurns.humanConfirmationBurst,
    frictionScore: frictionFromTurns.frictionScore,
    stopAndReframeSignal: frictionFromTurns.stopAndReframeSignal,
    bestStopTurn,
    suggestedReframe:
      bestStopTurn !== null ? input.turns?.find((turn) => turn.turnIndex === bestStopTurn)?.stopAndReframe.suggestedReframe ?? null : null,
    fixLoopOccurred: input.loopSignals.editLoop,
    searchLoopOccurred: input.loopSignals.searchLoop,
    niceGuidanceAwarded,
    predictedLossRate: predictedLossRate !== null ? round(predictedLossRate) : null,
    expAwarded,
    turnCount: input.turns?.length ?? 0,
    interventionMode: lastTurn?.intervention.mode ?? "quiet",
  };
}

export function collectAttentionPathsFromEvents(events: EpisodeEvent[]): string[] {
  return collectAttentionPaths(events);
}
