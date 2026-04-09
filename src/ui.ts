import {
  PredictiveNudge,
  ScoreBreakdown,
  StatsOverview,
  StorageReport,
  TokenCalibrationEstimate,
  TurnSummary,
  UsageObservation,
} from "./types";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function formatRunSummary(input: {
  episodeId: number;
  score: ScoreBreakdown;
  nudges: PredictiveNudge[];
  expAwarded: number;
  niceGuidanceAwarded: boolean;
  fixLoopOccurred: boolean;
  searchLoopOccurred: boolean;
  predictedLossRate: number | null;
  tokenEstimate: TokenCalibrationEstimate | null;
  usageObservations: UsageObservation[];
  turns?: TurnSummary[];
}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== Evo Summary ===");
  lines.push(`Episode #${input.episodeId}`);
  lines.push(`Surrogate Cost: ${input.score.surrogateCost}`);
  lines.push(
    `Context: files_read=${input.score.filesRead}, lines_read_norm=${input.score.linesReadNorm}, cross_file_spread=${input.score.crossFileSpread}`,
  );
  lines.push(
    `Recovery: symbol_revisits=${input.score.symbolRevisits}, retries=${input.score.retryCount}, failed_verifications=${input.score.failedVerifications}, no_change_turns=${input.score.noChangeTurns}`,
  );
  lines.push(
    `Exploration: entropy=${input.score.attentionEntropy}, compression=${input.score.attentionCompression}, novelty=${percent(input.score.noveltyRatio)}`,
  );

  if (input.turns && input.turns.length > 0) {
    const lastTurn = input.turns[input.turns.length - 1];
    lines.push(
      `Turns: ${input.turns.length} (last=${lastTurn.intervention.mode}, latency=${lastTurn.responseLatencyBucket}, advice=${lastTurn.adviceMessages.length})`,
    );
  }

  if (input.niceGuidanceAwarded) {
    lines.push(`Reward: smart guidance bonus +${input.expAwarded} EXP`);
  } else {
    lines.push(`EXP: +${input.expAwarded}`);
  }

  if (input.predictedLossRate !== null) {
    lines.push(`Hint: a more structured request could likely save about ${percent(input.predictedLossRate)} here.`);
  }

  if (input.fixLoopOccurred) {
    lines.push("Loop Signal: edit loop detected. Reframing the request should help break the cycle.");
  }

  if (input.searchLoopOccurred) {
    lines.push("Search Signal: attention is spreading. Narrowing the next target file should help.");
  }

  if (input.nudges.length > 0) {
    lines.push("Predictive Nudges:");
    for (const nudge of input.nudges) {
      lines.push(
        `- ${nudge.explanation} saving=${percent(Math.max(nudge.predictedSavingRate, 0))} confidence=${percent(nudge.confidence)}`,
      );
    }
  }

  if (input.tokenEstimate) {
    lines.push(
      `Calibrated token proxy: total~${input.tokenEstimate.predictedTotalTokens} confidence=${percent(input.tokenEstimate.confidence)} samples=${input.tokenEstimate.sampleSize}`,
    );
  }

  if (input.usageObservations.length > 0) {
    const latest = input.usageObservations[input.usageObservations.length - 1];
    lines.push(
      `Usage capture: prompt=${latest.promptTokens ?? "?"}, completion=${latest.completionTokens ?? "?"}, total=${latest.totalTokens ?? "?"} (${latest.source})`,
    );
  }

  return lines.join("\n");
}

export function formatStats(overview: StatsOverview): string {
  if (overview.totalEpisodes === 0) return "No episodes recorded yet.";
  const rank =
    overview.totalExp >= 1000
      ? "Prompt Artisan"
      : overview.totalExp >= 500
        ? "Context Tuner"
        : overview.totalExp >= 200
          ? "Workflow Scout"
          : "Apprentice";

  const lines = [
    `Episodes: ${overview.totalEpisodes} (raw=${overview.activeEpisodeCount}, archived=${overview.archivedEpisodeCount})`,
    `Average Surrogate Cost: ${overview.averageSurrogateCost.toFixed(2)}`,
    `Total EXP: ${overview.totalExp}`,
    `Rank: ${rank}`,
    "",
    "Recent Episodes:",
  ];

  for (const row of overview.recentEpisodes.slice(0, 10)) {
    lines.push(
      `- #${row.id} ${row.cli} cost=${row.surrogateCost} exp=${row.expAwarded} turns=${row.turnCount ?? 0} mode=${row.interventionMode ?? "quiet"} loops=${Number(row.fixLoopOccurred) === 1 || Number(row.searchLoopOccurred) === 1 ? "yes" : "no"}`,
    );
  }

  return lines.join("\n");
}

export function formatStorage(report: StorageReport, compactedEpisodes = 0): string {
  const lines = [
    `Database: ${report.dbPath}`,
    `Size: ${bytes(report.totalBytes)} (db=${bytes(report.dbBytes)}, wal=${bytes(report.walBytes)})`,
    `Episodes: raw=${report.activeEpisodeCount}, archived=${report.archivedEpisodeCount}`,
    `Retention: keep_recent_raw=${report.retention.keepRecentRawEpisodes}, max_db=${bytes(report.retention.maxDatabaseBytes)}, compact_on_run=${report.retention.compactOnRun ? "yes" : "no"}`,
    `Status: ${report.overLimit ? "over limit" : "within limit"}`,
  ];

  if (compactedEpisodes > 0) {
    lines.push(
      `Compaction: archived ${compactedEpisodes} raw episode(s) while keeping learned rollups and archived summaries.`,
    );
  }

  lines.push("");
  lines.push("Rows:");
  for (const [table, count] of Object.entries(report.rowCounts)) {
    lines.push(`- ${table}: ${count}`);
  }

  return lines.join("\n");
}

export function formatExplain(explanation: {
  episode: Record<string, unknown>;
  profile: Record<string, unknown>;
  summary: Record<string, unknown>;
  usage: UsageObservation[];
  turns?: Array<Record<string, unknown>>;
}): string {
  const lines = [
    `Episode #${explanation.episode.id}`,
    `CLI: ${explanation.episode.cli}`,
    `Prompt bucket: ${explanation.profile.prompt_length_bucket}`,
    `Structure score: ${explanation.profile.structure_score}`,
    `Surrogate cost: ${explanation.summary.surrogate_cost}`,
    `Scope bucket: ${explanation.summary.scope_bucket}`,
    `Exploration mode: ${explanation.summary.exploration_mode}`,
    `Attention entropy: ${explanation.summary.attention_entropy ?? explanation.summary.attentionEntropy ?? "?"}`,
    `Attention compression: ${explanation.summary.attention_compression ?? explanation.summary.attentionCompression ?? "?"}`,
    `Novelty ratio: ${explanation.summary.novelty_ratio ?? explanation.summary.noveltyRatio ?? "?"}`,
    `Expected-cost confidence: ${explanation.summary.expected_cost_confidence ?? explanation.summary.expectedCostConfidence ?? "?"}`,
    `First-pass green: ${Number(explanation.summary.first_pass_green) === 1 ? "yes" : "no"}`,
    `Loop flags: edit=${Number(explanation.summary.fix_loop_occurred) === 1 ? "yes" : "no"}, search=${Number(explanation.summary.search_loop_occurred) === 1 ? "yes" : "no"}`,
  ];

  if (typeof explanation.summary.turn_count !== "undefined") {
    lines.push(`Turn count: ${explanation.summary.turn_count}`);
  }
  if (typeof explanation.summary.intervention_mode !== "undefined") {
    lines.push(`Intervention mode: ${explanation.summary.intervention_mode}`);
  }

  if (explanation.turns && explanation.turns.length > 0) {
    lines.push("");
    lines.push("Turns:");
    for (const turn of explanation.turns) {
      lines.push(
        `- #${turn.turn_index} cost=${turn.surrogate_cost} mode=${turn.intervention_mode} latency=${turn.response_latency_bucket} reasons=${turn.reason_codes_json}`,
      );
    }
  }

  if (explanation.usage.length > 0) {
    const latest = explanation.usage[explanation.usage.length - 1];
    lines.push(
      `Captured usage: prompt=${latest.promptTokens ?? "?"}, completion=${latest.completionTokens ?? "?"}, total=${latest.totalTokens ?? "?"}`,
    );
  }

  return lines.join("\n");
}
