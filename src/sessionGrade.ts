import {
  EpisodeComplexity,
  PromptProfile,
  ScoreBreakdown,
  SessionGradeLetter,
  SessionGradeResult,
  TurnSummary,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

export function computePromptScore(profile: PromptProfile): number {
  const structurePart = clamp((profile.structureScore / 5) * 40, 0, 40);
  const specificityPart = clamp((profile.targetSpecificityScore / 3) * 30, 0, 30);
  const verificationPart = (profile.hasAcceptanceRef || profile.hasTestRef) ? 30 : 0;
  return round(structurePart + specificityPart + verificationPart);
}

export function computeEfficiencyScore(input: {
  firstPassRate: number;
  retryRate: number;
  repeatedAttentionRatio: number;
  convergenceBonus: number;
}): number {
  const firstPassPart = clamp(input.firstPassRate * 40, 0, 40);
  const retryPart = clamp((1 - input.retryRate) * 30, 0, 30);
  const explorationPart = clamp((1 - input.repeatedAttentionRatio) * 20, 0, 20);
  const convergencePart = clamp(input.convergenceBonus * 10, 0, 10);
  return round(firstPassPart + retryPart + explorationPart + convergencePart);
}

function gradeFromScore(score: number): SessionGradeLetter {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  return "D";
}

export function computeSessionGrade(input: {
  promptProfiles: PromptProfile[];
  turns: TurnSummary[];
  score: ScoreBreakdown;
  complexity: EpisodeComplexity;
  firstPassGreen: boolean;
  retryCount: number;
}): SessionGradeResult {
  // Prompt score: average across all turns' prompt profiles
  const promptScores = input.promptProfiles.map(computePromptScore);
  const avgPromptScore = promptScores.length > 0
    ? promptScores.reduce((s, v) => s + v, 0) / promptScores.length
    : 0;

  // Efficiency components
  const totalTurns = Math.max(input.turns.length, 1);
  const firstPassTurns = input.turns.filter(
    (t) => t.score.retryCount === 0 && !t.loopSignals.editLoop && !t.loopSignals.searchLoop,
  ).length;
  const firstPassRate = firstPassTurns / totalTurns;
  const retryRate = clamp(input.retryCount / Math.max(totalTurns, 1), 0, 1);

  const effScore = computeEfficiencyScore({
    firstPassRate,
    retryRate,
    repeatedAttentionRatio: input.complexity.repeatedAttentionRatio,
    convergenceBonus: input.score.convergenceBonus,
  });

  const promptScore = round(avgPromptScore);
  const efficiencyScore = round(effScore);
  const overallScore = round(promptScore * 0.5 + efficiencyScore * 0.5);

  return {
    grade: gradeFromScore(overallScore),
    promptScore,
    efficiencyScore,
    overallScore,
  };
}

// Lightweight grade for live tracking (fewer inputs available)
export function computeLiveGrade(input: {
  promptScore: number;
  turns: number;
  toolCalls: number;
  firstPassGreen: boolean;
  comboCount: number;
  /**
   * When true, the most recent advice signal is positive (e.g. first_pass_success,
   * good_structure, improving_trend). Adds a boost to the overall score so the
   * cumulative letter grade does not contradict the recent-turn signal kind.
   * Picked to move a borderline grade up by ~1 letter (thresholds: D<45, C<60, B<75, A<90, S>=90).
   */
  recentPositiveSignal?: boolean;
}): SessionGradeResult {
  const promptScore = clamp(input.promptScore, 0, 100);

  // Simplified efficiency from available data
  const toolRatio = input.turns > 0 ? input.toolCalls / input.turns : 0;
  const toolEfficiency = clamp(100 - (toolRatio - 3) * 10, 0, 100);
  const firstPassBonus = input.firstPassGreen ? 20 : 0;
  const comboBonus = clamp(input.comboCount * 5, 0, 30);
  const efficiencyScore = round(clamp(
    toolEfficiency * 0.5 + firstPassBonus + comboBonus,
    0,
    100,
  ));

  const baseOverall = promptScore * 0.5 + efficiencyScore * 0.5;
  const positiveSignalBoost = input.recentPositiveSignal ? 18 : 0;
  // Cap boost to single-letter improvement to avoid 2-tier jumps
  // (e.g. D 42 + 18 = 60 → B; intent was ~1 letter D → C).
  // Map base letter → max score = top edge of next band (next band threshold - 1).
  // Letter order: D < C < B < A < S. Thresholds: D<45, C<60, B<75, A<90, S>=90.
  const boostedRaw = clamp(baseOverall + positiveSignalBoost, 0, 100);
  let overallScore: number;
  if (positiveSignalBoost > 0) {
    const baseLetter = gradeFromScore(Math.round(baseOverall));
    const maxByBaseLetter: Record<SessionGradeLetter, number> = {
      D: 59, // top of C → cap improvement at C
      C: 74, // top of B
      B: 89, // top of A
      A: 100, // already at A; allow up to S edge (effectively no further cap)
      S: 100,
    };
    const cap = maxByBaseLetter[baseLetter];
    overallScore = round(Math.min(boostedRaw, cap));
  } else {
    overallScore = round(boostedRaw);
  }

  return {
    grade: gradeFromScore(overallScore),
    promptScore: round(promptScore),
    efficiencyScore,
    overallScore,
  };
}
