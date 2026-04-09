import {
  CounterfactualProfileKind,
  EpisodeComplexity,
  EpisodeEvent,
  EpisodeSummary,
  ExpectedCostEstimate,
  InterventionDecision,
  LoopSignals,
  PredictiveNudge,
  PromptProfile,
  RenderedAdviceMessage,
  ScoreBreakdown,
  TurnSummary,
} from "./types";
import { createCounterfactualPromptProfile } from "./promptProfile";
import { dim, formatPanel } from "./terminalUi";

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

  if (input.loopSignals.editLoop || input.loopSignals.searchLoop) {
    reasonCodes.push("loop_signal");
    score += 0.8;
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
  loopSignals: LoopSignals;
  complexity: EpisodeComplexity;
  decision: InterventionDecision;
  firstPassGreen: boolean;
  recentMessageKeys: string[];
  minConfidenceForPercent: number;
  maxLines: number;
}): RenderedAdviceMessage[] {
  if (input.decision.mode !== "active") return [];

  const messages: RenderedAdviceMessage[] = [];
  const bestNudge = [...input.nudges].sort((left, right) => {
    if (right.predictedSavingRate !== left.predictedSavingRate) {
      return right.predictedSavingRate - left.predictedSavingRate;
    }
    return right.confidence - left.confidence;
  })[0];

  const pushIfFresh = (message: RenderedAdviceMessage): void => {
    if (messages.length >= input.maxLines) return;
    if (input.recentMessageKeys.includes(message.key)) return;
    if (messages.some((item) => item.key === message.key)) return;
    messages.push(message);
  };

  const evidenceText = (nudge: PredictiveNudge): string => {
    const evidenceLabel =
      nudge.supportSampleSize >= 10
        ? `あなたの類似履歴 ${nudge.supportSampleSize} 件`
        : nudge.supportSampleSize >= 4
          ? `最近の近い履歴 ${nudge.supportSampleSize} 件`
          : nudge.bucketLevel === "global"
            ? "履歴がまだ少ないので暫定予測"
            : "履歴が薄いので軽めの予測";
    return `${evidenceLabel} | 信頼度 ${Math.round(nudge.confidence * 100)}%`;
  };

  const savingHeadline = (nudge: PredictiveNudge): string => {
    const percent = Math.max(0, Math.round(nudge.predictedSavingRate * 100));
    if (percent >= 30) return `次の一手で ${percent}% 近い節約が見込めます`;
    if (percent >= 15) return `次の一手で ${percent}% 前後の節約が見込めます`;
    return "次の一手で無駄ラリーをかなり減らせそうです";
  };

  const pushPanel = (message: Omit<RenderedAdviceMessage, "text"> & {
    title: string;
    panelTone: "info" | "success" | "warning" | "danger" | "accent";
    lines: string[];
  }): void => {
    pushIfFresh({
      ...message,
      text: formatPanel({
        title: message.title,
        tone: message.panelTone,
        lines: message.lines,
      }),
    });
  };

  if (input.loopSignals.editLoop) {
    pushPanel({
      key: "recovery-edit-loop",
      category: "recovery",
      severity: "high",
      tone: "corrective",
      surface: "end_of_turn",
      title: "Evo Rescue",
      panelTone: "danger",
      lines: [
        "同じ修正点を回り始めています。",
        "次は 現状 / 期待結果 / 失敗条件 を3行で渡すと抜けやすいです。",
        dim("迷路脱出モード: まず要件を固定してから再実行"),
      ],
      lineBudget: 1,
    });
  }

  if (input.loopSignals.searchLoop) {
    pushPanel({
      key: "exploration-loop",
      category: "exploration_focus",
      severity: "high",
      tone: "corrective",
      surface: "end_of_turn",
      title: "Evo Focus",
      panelTone: "warning",
      lines: [
        "探索範囲が広がりすぎています。",
        "次は対象ファイルを 1 つに絞ると、かなり収束しやすいです。",
        dim("おすすめ: ファイル名 + 直したい動作 を1行で指定"),
      ],
      lineBudget: 1,
    });
  }

  if (bestNudge && bestNudge.predictedSavingRate > 0) {
    const includePercent = bestNudge.confidence >= input.minConfidenceForPercent;
    const actionByCategory: Record<PredictiveNudge["category"], string> = {
      specificity: pickVariant(input.promptProfile.promptHash, [
        "次は 関数名 か 対象ファイル名 を 1 個足す",
        "次は どこを直すか を 1 行だけ具体化する",
        "次は 対象シンボル を 1 つ名指しする",
      ]),
      structure: pickVariant(input.promptProfile.promptHash, [
        "次は 箇条書き + 完了条件 を 2 行足す",
        "次は やること と 終了条件 を分けて渡す",
        "次は 制約 と ゴール を別行で置く",
      ]),
      verification: pickVariant(input.promptProfile.promptHash, [
        "次は 成功条件 を 1 行足す",
        "次は 何が通れば完了か を先に書く",
        "次は テスト意図 を短く添える",
      ]),
      scope_control: "次は変更対象を一段小さく区切る",
      recovery: "次は 現状 / 期待 / NG 条件 に分け直す",
      exploration_focus: "次は最初に見るファイルを 1 つだけ指定する",
      praise: "今の進め方をそのまま続ける",
    };
    const rewardLine =
      includePercent
        ? `予測節約ボーナス: ${savingHeadline(bestNudge)}`
        : "予測節約ボーナス: 次の往復を短くしやすい形です";
    pushPanel({
      key: `nudge-${bestNudge.category}`,
      category: bestNudge.category,
      severity: bestNudge.predictedSavingRate >= 0.25 ? "medium" : "low",
      tone: "encouraging",
      surface: "end_of_turn",
      title: "Evo Bonus",
      panelTone: bestNudge.predictedSavingRate >= 0.25 ? "accent" : "info",
      lines: [
        rewardLine,
        `次にやると刺さりやすいこと: ${actionByCategory[bestNudge.category]}`,
        `${evidenceText(bestNudge)} | 刺さると +50 EXP ルート`,
      ],
      lineBudget: 1,
      predictedSavingRate: bestNudge.predictedSavingRate,
    });
  }

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
            "構造化がかなり効いています。いまの頼み方は強いです。",
            "要件の切り方がきれいです。かなり無駄なく進めています。",
            "指示の骨組みが良く、手戻りを抑えられています。",
          ])
        : praiseKey === "praise-converged"
          ? pickVariant(input.promptProfile.promptHash, [
              "探索の絞り込みがきれいです。この進め方はかなり強いです。",
              "見る場所の寄せ方が上手く、収束が速いです。",
              "散らずに詰められています。この形は再現性があります。",
            ])
          : pickVariant(input.promptProfile.promptHash, [
              "きれいに通っています。今の頼み方はかなり素直です。",
              "今回の依頼は通りが良く、かなりスマートです。",
              "無駄な往復が少なく、いいテンポで進んでいます。",
            ]);
    pushPanel({
      key: praiseKey,
      category: "praise",
      severity: "low",
      tone: "encouraging",
      surface: "end_of_turn",
      title: "Evo Combo",
      panelTone: "success",
      lines: [
        praiseText,
        `今回のごほうび: +50 EXP 候補 | 探索モード ${input.complexity.explorationMode}`,
      ],
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
  const predictedLossRate =
    input.promptProfile.promptLength < 15 && input.changedFilesCount > 2
      ? clamp(Math.max(...input.nudges.map((nudge) => nudge.predictedSavingRate), 0), 0, 0.8)
      : null;
  const niceGuidanceAwarded = input.promptProfile.structureScore >= 3 && input.firstPassGreen;
  const expAwarded =
    (niceGuidanceAwarded ? 50 : 15) +
    (input.loopSignals.editLoop ? 0 : 10) +
    (input.loopSignals.searchLoop ? 0 : 5) +
    Math.round(input.currentEstimate.confidence * 10);

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
    fixLoopOccurred: input.loopSignals.editLoop,
    searchLoopOccurred: input.loopSignals.searchLoop,
    niceGuidanceAwarded,
    predictedLossRate: predictedLossRate !== null ? round(predictedLossRate) : null,
    expAwarded,
    turnCount: input.turns?.length ?? 0,
    interventionMode: input.turns?.[input.turns.length - 1]?.intervention.mode ?? "quiet",
  };
}

export function collectAttentionPathsFromEvents(events: EpisodeEvent[]): string[] {
  return collectAttentionPaths(events);
}
