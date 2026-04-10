import {
  IssueIntakeSummary,
  MascotEpisodeUpdate,
  MascotProfile,
  PredictiveNudge,
  ScoreBreakdown,
  StatsOverview,
  StorageReport,
  TokenCalibrationEstimate,
  TurnSummary,
  UsageObservation,
} from "./types";
import { colorize, dim, formatPanel } from "./terminalUi";
import { renderMascotLevelUp, renderMascotState } from "./mascot";

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
  mascot?: MascotEpisodeUpdate | null;
  tokenEstimate: TokenCalibrationEstimate | null;
  usageObservations: UsageObservation[];
  turns?: TurnSummary[];
}): string {
  const bestNudge = [...input.nudges].sort((left, right) => right.predictedSavingRate - left.predictedSavingRate)[0];
  const lines: string[] = [];
  lines.push("");
  lines.push(
    formatPanel({
      title: input.fixLoopOccurred || input.searchLoopOccurred ? "🧾 Evo Recap" : "🎮 Evo Recap",
      tone: input.fixLoopOccurred || input.searchLoopOccurred ? "warning" : input.niceGuidanceAwarded ? "success" : "info",
      lines: [
        `Episode #${input.episodeId} | Surrogate Cost ${input.score.surrogateCost}`,
        `探索 ${input.score.filesRead} 件 / 再試行 ${input.score.retryCount} 回 / novelty ${percent(input.score.noveltyRatio)}`,
        input.niceGuidanceAwarded
          ? `今回のごほうび: smart guidance bonus +${input.expAwarded} EXP`
          : `今回のごほうび: +${input.expAwarded} EXP`,
      ],
    }),
  );

  if (input.mascot) {
    lines.push(
      dim(
        `Mascot: total=${input.mascot.totalBondExp} EXP | stage=${input.mascot.nextStage} | mood=${input.mascot.mood} | bond=${input.mascot.progressPercent}%`,
      ),
    );
    if (input.mascot.leveledUp || input.mascot.stageChanged) {
      const pseudoProfile: MascotProfile = {
        speciesId: input.mascot.speciesId,
        nickname: "EvoPet",
        stage: input.mascot.nextStage,
        totalBondExp: input.mascot.totalBondExp,
        mood: input.mascot.mood,
        streakDays: 0,
        lastSeenAt: null,
        favoriteHintStyle: "none",
        lastMessages: [],
        comboCount: 0,
        bestCombo: 0,
      };
      lines.push(renderMascotLevelUp(pseudoProfile, input.mascot));
    }
  }

  if (input.turns && input.turns.length > 0) {
    const lastTurn = input.turns[input.turns.length - 1];
    lines.push(dim(`Turns: ${input.turns.length} | last mode=${lastTurn.intervention.mode} | latency=${lastTurn.responseLatencyBucket}`));
    if (lastTurn.friction.frictionScore > 0) {
      lines.push(
        dim(
          `Friction: approvals=${lastTurn.friction.approvalCount}, tool_errors=${lastTurn.friction.toolErrorCount}, retries=${lastTurn.friction.toolRetryCount}, score=${lastTurn.friction.frictionScore}`,
        ),
      );
    }
    if (lastTurn.stopAndReframe.stopAndReframeSignal) {
      lines.push(
        colorize(
          `Stop point: ${lastTurn.stopAndReframe.suggestedReframe} | ${lastTurn.stopAndReframe.avoidableCostLabel}`,
          "warning",
          true,
        ),
      );
    }
  }

  if (input.fixLoopOccurred) {
    lines.push(colorize("🛟 Loop Signal: 同じ修正点を回っていました。次は 現状 / 期待 / NG 条件 で切ると抜けやすいです。", "danger", true));
  }

  if (input.searchLoopOccurred) {
    lines.push(colorize("🧭 Search Signal: 探索が散っていました。次は対象ファイルを 1 つに絞るのがおすすめです。", "warning", true));
  }

  if (bestNudge && bestNudge.predictedSavingRate > 0) {
    lines.push(
      formatPanel({
        title: "🎁 Next Bonus",
        tone: bestNudge.predictedSavingRate >= 0.25 ? "accent" : "info",
        lines: [
          `${Math.round(bestNudge.predictedSavingRate * 100)}% 前後の節約見込み`,
          bestNudge.explanation,
          `${bestNudge.supportSampleSize > 0 ? `類似履歴 ${bestNudge.supportSampleSize} 件` : "履歴がまだ薄いので暫定"} | 信頼度 ${percent(bestNudge.confidence)}`,
        ],
      }),
    );
  } else if (input.predictedLossRate !== null) {
    lines.push(colorize(`🎁 Next Bonus: 構造化すると ${percent(input.predictedLossRate)} 近い節約余地があります。`, "info", true));
  }

  if (input.tokenEstimate) {
    lines.push(
      dim(`Token proxy: total~${input.tokenEstimate.predictedTotalTokens} | confidence=${percent(input.tokenEstimate.confidence)} | samples=${input.tokenEstimate.sampleSize}`),
    );
  }

  if (input.usageObservations.length > 0) {
    const latest = input.usageObservations[input.usageObservations.length - 1];
    lines.push(
      dim(`Usage capture: prompt=${latest.promptTokens ?? "?"}, completion=${latest.completionTokens ?? "?"}, total=${latest.totalTokens ?? "?"} (${latest.source})`),
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

export function formatMascotStats(profile: MascotProfile): string {
  const state = renderMascotState(profile);
  return formatPanel({
    title: "🐾 EvoPet Status",
    tone: state.accentTone,
    lines: [
      `${state.avatar} ${profile.nickname} | species=${profile.speciesId} | stage=${profile.stage} | level=${state.level}`,
      `bond=${profile.totalBondExp} EXP | progress=${state.progressPercent}% | mood=${profile.mood}`,
      `favorite=${profile.favoriteHintStyle} | streak=${profile.streakDays}日`,
    ],
  });
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
  if (typeof explanation.summary.friction_score !== "undefined") {
    lines.push(
      `Internal friction: approvals=${explanation.summary.approval_count ?? 0}, tool_errors=${explanation.summary.tool_error_count ?? 0}, retries=${explanation.summary.tool_retry_count ?? 0}, score=${explanation.summary.friction_score}`,
    );
    lines.push(
      `Stop and reframe: ${Number(explanation.summary.stop_and_reframe_signal) === 1 ? "yes" : "no"} | best stop turn=${explanation.summary.best_stop_turn ?? "n/a"}`,
    );
    if (explanation.summary.suggested_reframe) {
      lines.push(`Suggested reframe: ${explanation.summary.suggested_reframe}`);
    }
  }

  if (explanation.turns && explanation.turns.length > 0) {
    lines.push("");
    lines.push("Turns:");
    for (const turn of explanation.turns) {
      lines.push(
        `- #${turn.turn_index} cost=${turn.surrogate_cost} friction=${turn.friction_score ?? 0} approvals=${turn.approval_count ?? 0} errors=${turn.tool_error_count ?? 0} retries=${turn.tool_retry_count ?? 0} mode=${turn.intervention_mode} latency=${turn.response_latency_bucket} stop=${turn.stop_category ?? "none"}`,
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

export function formatIssueIntake(summary: IssueIntakeSummary): string {
  const nextActions = [
    "1. ROADMAP.md で shared-risk area を確認",
    "2. `codex/<issue-or-topic>` ブランチを切る",
    "3. 完了条件を満たす差分だけに絞って着手",
  ];

  return formatPanel({
    title: `🧠 Agent Intake #${summary.number}`,
    tone: "accent",
    lines: [
      `${summary.title}`,
      `URL: ${summary.url}`,
      `labels: ${summary.labels.length > 0 ? summary.labels.join(", ") : "none"}`,
      `objective: ${summary.objective ?? "not specified"}`,
      `scope: ${summary.scope ?? "not specified"}`,
      `out-of-scope: ${summary.outOfScope ?? "not specified"}`,
      `acceptance: ${summary.acceptance ?? "not specified"}`,
      `docs: ${summary.docsNeeded ?? "not specified"} | reviewer: ${summary.reviewer ?? "not specified"}`,
      `next: ${nextActions.join(" / ")}`,
    ],
  });
}
