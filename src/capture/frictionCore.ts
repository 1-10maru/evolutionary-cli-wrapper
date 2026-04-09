import { EpisodeEvent, FrictionSignalCategory, FrictionSummary, StopAndReframeDecision } from "../types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function maxConsecutive(
  events: EpisodeEvent[],
  predicate: (event: EpisodeEvent) => boolean,
  resetPredicate?: (event: EpisodeEvent) => boolean,
): number {
  let best = 0;
  let current = 0;
  for (const event of events) {
    if (predicate(event)) {
      current += 1;
      best = Math.max(best, current);
      continue;
    }
    if (!resetPredicate || resetPredicate(event)) {
      current = 0;
    }
  }
  return best;
}

function isProgressEvent(event: EpisodeEvent): boolean {
  return [
    "patch_applied",
    "test_run",
    "build_run",
    "tool_call_succeeded",
    "tool_retry_succeeded",
    "edit_attempt_recovered",
    "error_recovery_succeeded",
  ].includes(event.type);
}

function isFailureEvent(event: EpisodeEvent): boolean {
  return [
    "tool_call_failed",
    "tool_retry_failed",
    "edit_attempt_failed",
  ].includes(event.type);
}

export function summarizeFrictionEvents(events: EpisodeEvent[]): FrictionSummary {
  const approvalCount = events.filter((event) => event.type === "tool_approval_requested").length;
  const toolErrorCount = events.filter(
    (event) => event.type === "tool_call_failed" || event.type === "tool_retry_failed",
  ).length;
  const toolRetryCount = events.filter((event) => event.type === "tool_retry_requested").length;
  const editFailureCount = events.filter((event) => event.type === "edit_attempt_failed").length;
  const recoveryAttempts = events.filter(
    (event) => event.type === "error_recovery_started" || event.type === "tool_retry_requested",
  ).length;
  const approvalBurst = maxConsecutive(
    events,
    (event) => event.type === "tool_approval_requested" || event.type === "tool_approval_granted",
    (event) => event.type !== "tool_approval_denied" && !isProgressEvent(event),
  );
  const humanConfirmationBurst = maxConsecutive(
    events,
    (event) => event.type === "tool_approval_granted",
    (event) => event.type !== "tool_approval_denied" && !isProgressEvent(event),
  );
  const toolFailureStreak = maxConsecutive(
    events,
    isFailureEvent,
    (event) =>
      ![
        "tool_call_succeeded",
        "tool_retry_succeeded",
        "edit_attempt_recovered",
        "error_recovery_succeeded",
      ].includes(event.type),
  );
  const progressCount = events.filter(isProgressEvent).length;
  const noProgressPressure = progressCount === 0 && (approvalCount > 0 || toolErrorCount > 0 || editFailureCount > 0);

  let dominantSignal: FrictionSignalCategory = "none";
  if (approvalBurst >= 3) dominantSignal = "approval_storm";
  else if (toolFailureStreak >= 2 || toolErrorCount >= 3) dominantSignal = "error_spiral";
  else if (toolRetryCount >= 2 || editFailureCount >= 2) dominantSignal = "retry_loop";
  else if (noProgressPressure && (approvalCount >= 2 || toolRetryCount >= 2)) dominantSignal = "stop_and_reframe";

  const frictionScore = round(
    clamp(
      approvalCount * 0.18 +
        approvalBurst * 0.24 +
        toolErrorCount * 0.26 +
        toolRetryCount * 0.14 +
        toolFailureStreak * 0.28 +
        editFailureCount * 0.18 +
        recoveryAttempts * 0.08 +
        humanConfirmationBurst * 0.16 +
        (noProgressPressure ? 0.35 : 0),
      0,
      4,
    ),
  );
  const stopAndReframeSignal =
    dominantSignal !== "none" ||
    approvalBurst >= 3 ||
    toolFailureStreak >= 2 ||
    (noProgressPressure && approvalCount >= 2) ||
    (editFailureCount >= 2 && toolRetryCount >= 1);
  const confidence = round(
    clamp(
      0.18 +
        approvalCount * 0.06 +
        toolErrorCount * 0.08 +
        toolRetryCount * 0.04 +
        editFailureCount * 0.05 +
        (dominantSignal !== "none" ? 0.18 : 0),
      0.15,
      0.95,
    ),
  );

  return {
    approvalCount,
    approvalBurst,
    toolErrorCount,
    toolRetryCount,
    toolFailureStreak,
    editFailureCount,
    recoveryAttempts,
    humanConfirmationBurst,
    frictionScore,
    stopAndReframeSignal,
    dominantSignal,
    confidence,
  };
}

export function buildStopAndReframeDecision(input: {
  friction: FrictionSummary;
  events: EpisodeEvent[];
}): StopAndReframeDecision {
  const { friction } = input;
  if (!friction.stopAndReframeSignal) {
    return {
      stopAndReframeSignal: false,
      category: "none",
      confidence: friction.confidence,
      reasonCodes: ["friction_low"],
      suggestedReframe: "",
      avoidableCostLabel: "",
    };
  }

  if (friction.approvalBurst >= 3 || friction.humanConfirmationBurst >= 3) {
    return {
      stopAndReframeSignal: true,
      category: "approval_storm",
      confidence: friction.confidence,
      reasonCodes: ["approval_burst", "human_confirmation_burst"],
      suggestedReframe: "現状 / 制約 を先に2行で固定してから続ける",
      avoidableCostLabel: "承認ラッシュ回避見込み 高",
    };
  }

  if (friction.toolFailureStreak >= 2 || friction.toolErrorCount >= 3) {
    return {
      stopAndReframeSignal: true,
      category: "error_spiral",
      confidence: friction.confidence,
      reasonCodes: ["tool_failure_streak", "tool_error_pressure"],
      suggestedReframe: "実行条件と失敗条件を先に固定してからやり直す",
      avoidableCostLabel: "復旧コスト回避見込み 高",
    };
  }

  if (friction.toolRetryCount >= 2 || friction.editFailureCount >= 2) {
    return {
      stopAndReframeSignal: true,
      category: "retry_loop",
      confidence: friction.confidence,
      reasonCodes: ["retry_pressure", "edit_failure_pressure"],
      suggestedReframe: "現状 / 期待 / NG条件 の3行に切り直す",
      avoidableCostLabel: "再試行コスト回避見込み 中",
    };
  }

  return {
    stopAndReframeSignal: true,
    category: "stop_and_reframe",
    confidence: friction.confidence,
    reasonCodes: ["no_progress_pressure"],
    suggestedReframe: "対象を1つに絞って、先にやることを短く固定する",
    avoidableCostLabel: "迷走コスト回避見込み 中",
  };
}

export function findBestStopTurn(turns: Array<{ turnIndex: number; friction: FrictionSummary }>): number | null {
  const candidate = [...turns]
    .filter((turn) => turn.friction.stopAndReframeSignal)
    .sort((left, right) => {
      if (right.friction.frictionScore !== left.friction.frictionScore) {
        return right.friction.frictionScore - left.friction.frictionScore;
      }
      return left.turnIndex - right.turnIndex;
    })[0];
  return candidate?.turnIndex ?? null;
}
