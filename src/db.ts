import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureEvoConfig, getEvoDir } from "./config";
import {
  EpisodeComplexity,
  EpisodeEvent,
  EpisodeSummary,
  ExpectedCostEstimate,
  StatsOverview,
  StorageReport,
  PromptProfile,
  SupportedCli,
  SymbolChangeEvent,
  SymbolSnapshot,
  TurnRecord,
  TurnSummary,
  UsageObservation,
  WorkspaceSnapshot,
} from "./types";

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runningMean(previousMean: number, count: number, nextValue: number): number {
  return ((previousMean * count) + nextValue) / (count + 1);
}

function runningM2(previousMean: number, previousM2: number, count: number, nextValue: number): number {
  if (count <= 0) return 0;
  const delta = nextValue - previousMean;
  const nextMean = previousMean + delta / (count + 1);
  const delta2 = nextValue - nextMean;
  return previousM2 + (delta * delta2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class EvoDatabase {
  readonly db: Database.Database;
  readonly cwd: string;
  readonly evoDir: string;
  readonly dbPath: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.evoDir = getEvoDir(cwd);
    ensureDirectory(this.evoDir);
    this.dbPath = path.join(this.evoDir, "evolutionary.db");
    ensureEvoConfig(cwd);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL,
        cli TEXT NOT NULL,
        command TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        prompt_hash TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        termination_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS prompt_profiles (
        episode_id INTEGER PRIMARY KEY,
        prompt_hash TEXT NOT NULL,
        prompt_length INTEGER NOT NULL,
        prompt_length_bucket TEXT NOT NULL,
        structure_score INTEGER NOT NULL,
        has_bullets INTEGER NOT NULL,
        has_file_refs INTEGER NOT NULL,
        has_symbol_refs INTEGER NOT NULL,
        has_constraint_ref INTEGER NOT NULL,
        has_acceptance_ref INTEGER NOT NULL,
        has_test_ref INTEGER NOT NULL,
        target_specificity_score INTEGER NOT NULL,
        preview TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS episode_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        line_count INTEGER NOT NULL,
        size INTEGER NOT NULL,
        is_text INTEGER NOT NULL,
        extension TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS symbol_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        stable_symbol_id TEXT NOT NULL,
        language TEXT NOT NULL,
        kind TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        parent_qualified_name TEXT,
        signature_hash TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        ast_fingerprint TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS symbol_change_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        stable_symbol_id TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        language TEXT NOT NULL,
        change_kind TEXT NOT NULL,
        before_body_hash TEXT,
        after_body_hash TEXT,
        changed_lines INTEGER NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS episode_summaries (
        episode_id INTEGER PRIMARY KEY,
        surrogate_cost REAL NOT NULL,
        files_read INTEGER NOT NULL,
        lines_read_norm INTEGER NOT NULL,
        symbol_revisits INTEGER NOT NULL,
        retry_count INTEGER NOT NULL,
        failed_verifications INTEGER NOT NULL,
        cross_file_spread INTEGER NOT NULL,
        no_change_turns INTEGER NOT NULL,
        changed_files_count INTEGER NOT NULL,
        changed_symbols_count INTEGER NOT NULL,
        changed_lines_count INTEGER NOT NULL,
        first_pass_green INTEGER NOT NULL,
        prompt_length_bucket TEXT NOT NULL,
        structure_score INTEGER NOT NULL,
        scope_bucket TEXT NOT NULL,
        exploration_mode TEXT NOT NULL,
        attention_entropy REAL NOT NULL DEFAULT 0,
        attention_compression REAL NOT NULL DEFAULT 0,
        novelty_ratio REAL NOT NULL DEFAULT 1,
        expected_cost_confidence REAL NOT NULL DEFAULT 0.2,
        approval_count INTEGER NOT NULL DEFAULT 0,
        approval_burst INTEGER NOT NULL DEFAULT 0,
        tool_error_count INTEGER NOT NULL DEFAULT 0,
        tool_retry_count INTEGER NOT NULL DEFAULT 0,
        tool_failure_streak INTEGER NOT NULL DEFAULT 0,
        edit_failure_count INTEGER NOT NULL DEFAULT 0,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        human_confirmation_burst INTEGER NOT NULL DEFAULT 0,
        friction_score REAL NOT NULL DEFAULT 0,
        stop_and_reframe_signal INTEGER NOT NULL DEFAULT 0,
        best_stop_turn INTEGER,
        suggested_reframe TEXT,
        fix_loop_occurred INTEGER NOT NULL,
        search_loop_occurred INTEGER NOT NULL,
        nice_guidance_awarded INTEGER NOT NULL,
        predicted_loss_rate REAL,
        exp_awarded INTEGER NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS stats_buckets (
        bucket_level TEXT NOT NULL,
        bucket_key TEXT NOT NULL,
        sample_size INTEGER NOT NULL,
        mean_cost REAL NOT NULL,
        ema_cost REAL NOT NULL DEFAULT 0,
        m2_cost REAL NOT NULL DEFAULT 0,
        fix_loop_rate REAL NOT NULL,
        retry_rate REAL NOT NULL,
        last_updated_at TEXT,
        PRIMARY KEY (bucket_level, bucket_key)
      );

      CREATE TABLE IF NOT EXISTS usage_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        turn_index INTEGER,
        cli TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        source TEXT NOT NULL,
        raw_line TEXT NOT NULL,
        confidence REAL NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        turn_index INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        input_text TEXT NOT NULL,
        output_preview TEXT NOT NULL,
        UNIQUE (episode_id, turn_index),
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS turn_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        turn_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details_json TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS turn_summaries (
        episode_id INTEGER NOT NULL,
        turn_index INTEGER NOT NULL,
        surrogate_cost REAL NOT NULL,
        exploration_mode TEXT NOT NULL,
        attention_entropy REAL NOT NULL,
        attention_compression REAL NOT NULL,
        novelty_ratio REAL NOT NULL,
        approval_count INTEGER NOT NULL DEFAULT 0,
        approval_burst INTEGER NOT NULL DEFAULT 0,
        tool_error_count INTEGER NOT NULL DEFAULT 0,
        tool_retry_count INTEGER NOT NULL DEFAULT 0,
        tool_failure_streak INTEGER NOT NULL DEFAULT 0,
        edit_failure_count INTEGER NOT NULL DEFAULT 0,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        human_confirmation_burst INTEGER NOT NULL DEFAULT 0,
        friction_score REAL NOT NULL DEFAULT 0,
        stop_and_reframe_signal INTEGER NOT NULL DEFAULT 0,
        stop_category TEXT NOT NULL DEFAULT 'none',
        stop_confidence REAL NOT NULL DEFAULT 0,
        suggested_reframe TEXT NOT NULL DEFAULT '',
        assistant_reask_rate REAL NOT NULL,
        turn_retry_depth INTEGER NOT NULL,
        response_latency_ms INTEGER NOT NULL,
        response_latency_bucket TEXT NOT NULL,
        mid_episode_novelty_drop REAL NOT NULL,
        recent_nudge_effectiveness REAL NOT NULL,
        intervention_mode TEXT NOT NULL,
        intervention_confidence REAL NOT NULL,
        reason_codes_json TEXT NOT NULL,
        advice_messages_json TEXT NOT NULL,
        PRIMARY KEY (episode_id, turn_index),
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS nudge_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER NOT NULL,
        turn_index INTEGER NOT NULL,
        advice_key TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        tone TEXT NOT NULL,
        text TEXT NOT NULL,
        predicted_saving_rate REAL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      );

      CREATE TABLE IF NOT EXISTS token_calibration_models (
        cli TEXT PRIMARY KEY,
        sample_size INTEGER NOT NULL,
        sum_surrogate_cost REAL NOT NULL,
        sum_total_tokens REAL NOT NULL,
        sum_surrogate_sq REAL NOT NULL,
        sum_cost_token REAL NOT NULL,
        slope REAL NOT NULL,
        intercept REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archived_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_episode_id INTEGER NOT NULL UNIQUE,
        cli TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        prompt_length_bucket TEXT NOT NULL,
        structure_score INTEGER NOT NULL,
        scope_bucket TEXT NOT NULL,
        exploration_mode TEXT NOT NULL,
        attention_entropy REAL NOT NULL DEFAULT 0,
        attention_compression REAL NOT NULL DEFAULT 0,
        novelty_ratio REAL NOT NULL DEFAULT 1,
        expected_cost_confidence REAL NOT NULL DEFAULT 0.2,
        surrogate_cost REAL NOT NULL,
        exp_awarded INTEGER NOT NULL,
        first_pass_green INTEGER NOT NULL,
        fix_loop_occurred INTEGER NOT NULL,
        search_loop_occurred INTEGER NOT NULL,
        changed_files_count INTEGER NOT NULL,
        changed_symbols_count INTEGER NOT NULL,
        changed_lines_count INTEGER NOT NULL,
        total_tokens INTEGER,
        compacted_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("episode_summaries", "attention_entropy", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "attention_compression", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "novelty_ratio", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("episode_summaries", "expected_cost_confidence", "REAL NOT NULL DEFAULT 0.2");
    this.ensureColumn("episode_summaries", "approval_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "approval_burst", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "tool_error_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "tool_retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "tool_failure_streak", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "edit_failure_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "human_confirmation_burst", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "friction_score", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "stop_and_reframe_signal", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "best_stop_turn", "INTEGER");
    this.ensureColumn("episode_summaries", "suggested_reframe", "TEXT");
    this.ensureColumn("episode_summaries", "turn_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("episode_summaries", "intervention_mode", "TEXT NOT NULL DEFAULT 'quiet'");
    this.ensureColumn("turn_summaries", "approval_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "approval_burst", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "tool_error_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "tool_retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "tool_failure_streak", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "edit_failure_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "human_confirmation_burst", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "friction_score", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "stop_and_reframe_signal", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "stop_category", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("turn_summaries", "stop_confidence", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("turn_summaries", "suggested_reframe", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("stats_buckets", "ema_cost", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("stats_buckets", "m2_cost", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("stats_buckets", "last_updated_at", "TEXT");
    this.ensureColumn("archived_episodes", "attention_entropy", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("archived_episodes", "attention_compression", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("archived_episodes", "novelty_ratio", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("archived_episodes", "expected_cost_confidence", "REAL NOT NULL DEFAULT 0.2");
    this.ensureColumn("usage_observations", "turn_index", "INTEGER");

    // v3.0: achievements table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        earned_at TEXT NOT NULL,
        episode_id INTEGER,
        bonus_exp INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  getRecentStructureScoreAverage(limit = 10): number {
    const result = this.db.prepare(`
      SELECT AVG(structure_score) AS avg_score
      FROM (
        SELECT structure_score FROM episode_summaries
        ORDER BY episode_id DESC LIMIT ?
      )
    `).get(limit) as { avg_score: number | null } | undefined;
    return result?.avg_score ?? 0;
  }

  getPreviousEpisodeLoopOccurred(): boolean {
    const row = this.db.prepare(`
      SELECT fix_loop_occurred, search_loop_occurred
      FROM episode_summaries
      ORDER BY episode_id DESC LIMIT 1
    `).get() as { fix_loop_occurred: number; search_loop_occurred: number } | undefined;
    return (row?.fix_loop_occurred ?? 0) !== 0 || (row?.search_loop_occurred ?? 0) !== 0;
  }

  getRecentStructureScores(limit = 5): number[] {
    const rows = this.db.prepare(`
      SELECT structure_score FROM episode_summaries
      ORDER BY episode_id DESC LIMIT ?
    `).all(limit) as Array<{ structure_score: number }>;
    return rows.map((r) => r.structure_score).reverse();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createEpisode(input: {
    cwd: string;
    cli: SupportedCli;
    command: string[];
    startedAt: string;
    promptProfile: PromptProfile;
  }): number {
    const statement = this.db.prepare(`
      INSERT INTO episodes (cwd, cli, command, started_at, prompt_hash, prompt_preview)
      VALUES (@cwd, @cli, @command, @startedAt, @promptHash, @preview)
    `);
    const info = statement.run({
      cwd: input.cwd,
      cli: input.cli,
      command: JSON.stringify(input.command),
      startedAt: input.startedAt,
      promptHash: input.promptProfile.promptHash,
      preview: input.promptProfile.preview,
    });

    this.db
      .prepare(`
        INSERT INTO prompt_profiles (
          episode_id, prompt_hash, prompt_length, prompt_length_bucket, structure_score,
          has_bullets, has_file_refs, has_symbol_refs, has_constraint_ref, has_acceptance_ref,
          has_test_ref, target_specificity_score, preview
        ) VALUES (
          @episodeId, @promptHash, @promptLength, @promptLengthBucket, @structureScore,
          @hasBullets, @hasFileRefs, @hasSymbolRefs, @hasConstraintRef, @hasAcceptanceRef,
          @hasTestRef, @targetSpecificityScore, @preview
        )
      `)
      .run({
        episodeId: Number(info.lastInsertRowid),
        ...input.promptProfile,
        hasBullets: Number(input.promptProfile.hasBullets),
        hasFileRefs: Number(input.promptProfile.hasFileRefs),
        hasSymbolRefs: Number(input.promptProfile.hasSymbolRefs),
        hasConstraintRef: Number(input.promptProfile.hasConstraintRef),
        hasAcceptanceRef: Number(input.promptProfile.hasAcceptanceRef),
        hasTestRef: Number(input.promptProfile.hasTestRef),
      });

    return Number(info.lastInsertRowid);
  }

  appendEvents(episodeId: number, events: EpisodeEvent[]): void {
    const statement = this.db.prepare(`
      INSERT INTO episode_events (episode_id, event_type, source, timestamp, details_json)
      VALUES (@episodeId, @type, @source, @timestamp, @detailsJson)
    `);
    const transaction = this.db.transaction((items: EpisodeEvent[]) => {
      for (const event of items) {
        statement.run({
          episodeId,
          type: event.type,
          source: event.source,
          timestamp: event.timestamp,
          detailsJson: JSON.stringify(event.details),
        });
      }
    });
    transaction(events);
  }

  saveWorkspaceSnapshot(episodeId: number, phase: "before" | "after", snapshot: WorkspaceSnapshot): void {
    const statement = this.db.prepare(`
      INSERT INTO file_snapshots (
        episode_id, phase, relative_path, content_hash, line_count, size, is_text, extension
      ) VALUES (
        @episodeId, @phase, @relativePath, @contentHash, @lineCount, @size, @isText, @extension
      )
    `);
    const transaction = this.db.transaction(() => {
      for (const file of snapshot.files) {
        statement.run({
          episodeId,
          phase,
          relativePath: file.relativePath,
          contentHash: file.contentHash,
          lineCount: file.lineCount,
          size: file.size,
          isText: Number(file.isText),
          extension: file.extension,
        });
      }
    });
    transaction();
  }

  saveSymbolSnapshots(
    episodeId: number,
    phase: "before" | "after",
    snapshots: Map<string, SymbolSnapshot[]>,
  ): void {
    const statement = this.db.prepare(`
      INSERT INTO symbol_snapshots (
        episode_id, phase, relative_path, stable_symbol_id, language, kind, qualified_name,
        parent_qualified_name, signature_hash, body_hash, ast_fingerprint, start_line, end_line
      ) VALUES (
        @episodeId, @phase, @relativePath, @stableSymbolId, @language, @kind, @qualifiedName,
        @parentQualifiedName, @signatureHash, @bodyHash, @astFingerprint, @startLine, @endLine
      )
    `);
    const transaction = this.db.transaction(() => {
      for (const [relativePath, items] of snapshots.entries()) {
        for (const symbol of items) {
          statement.run({
            episodeId,
            phase,
            relativePath,
            ...symbol,
          });
        }
      }
    });
    transaction();
  }

  saveSymbolChanges(episodeId: number, changes: SymbolChangeEvent[]): void {
    const statement = this.db.prepare(`
      INSERT INTO symbol_change_events (
        episode_id, relative_path, stable_symbol_id, qualified_name, kind, language,
        change_kind, before_body_hash, after_body_hash, changed_lines
      ) VALUES (
        @episodeId, @path, @stableSymbolId, @qualifiedName, @kind, @language,
        @changeKind, @beforeBodyHash, @afterBodyHash, @changedLines
      )
    `);
    const transaction = this.db.transaction((items: SymbolChangeEvent[]) => {
      for (const change of items) statement.run({ episodeId, ...change });
    });
    transaction(changes);
  }

  saveUsageObservations(episodeId: number, observations: UsageObservation[]): void {
    if (observations.length === 0) return;
    const statement = this.db.prepare(`
      INSERT INTO usage_observations (
        episode_id, turn_index, cli, prompt_tokens, completion_tokens, total_tokens,
        source, raw_line, confidence
      ) VALUES (
        @episodeId, @turnIndex, @cli, @promptTokens, @completionTokens, @totalTokens,
        @source, @rawLine, @confidence
      )
    `);
    const transaction = this.db.transaction((items: UsageObservation[]) => {
      for (const item of items) statement.run({ episodeId, ...item });
    });
    transaction(observations);
  }

  saveTurns(episodeId: number, turns: TurnRecord[], summaries: TurnSummary[]): void {
    if (turns.length === 0) return;

    const turnStatement = this.db.prepare(`
      INSERT OR REPLACE INTO turns (
        episode_id, turn_index, started_at, finished_at, prompt_hash, prompt_preview, input_text, output_preview
      ) VALUES (
        @episodeId, @turnIndex, @startedAt, @finishedAt, @promptHash, @promptPreview, @inputText, @outputPreview
      )
    `);
    const eventStatement = this.db.prepare(`
      INSERT INTO turn_events (
        episode_id, turn_index, event_type, source, timestamp, details_json
      ) VALUES (
        @episodeId, @turnIndex, @eventType, @source, @timestamp, @detailsJson
      )
    `);
    const summaryStatement = this.db.prepare(`
      INSERT OR REPLACE INTO turn_summaries (
        episode_id, turn_index, surrogate_cost, exploration_mode, attention_entropy, attention_compression,
        novelty_ratio, approval_count, approval_burst, tool_error_count, tool_retry_count, tool_failure_streak,
        edit_failure_count, recovery_attempts, human_confirmation_burst, friction_score,
        stop_and_reframe_signal, stop_category, stop_confidence, suggested_reframe,
        assistant_reask_rate, turn_retry_depth, response_latency_ms, response_latency_bucket,
        mid_episode_novelty_drop, recent_nudge_effectiveness, intervention_mode, intervention_confidence,
        reason_codes_json, advice_messages_json
      ) VALUES (
        @episodeId, @turnIndex, @surrogateCost, @explorationMode, @attentionEntropy, @attentionCompression,
        @noveltyRatio, @approvalCount, @approvalBurst, @toolErrorCount, @toolRetryCount, @toolFailureStreak,
        @editFailureCount, @recoveryAttempts, @humanConfirmationBurst, @frictionScore,
        @stopAndReframeSignal, @stopCategory, @stopConfidence, @suggestedReframe,
        @assistantReaskRate, @turnRetryDepth, @responseLatencyMs, @responseLatencyBucket,
        @midEpisodeNoveltyDrop, @recentNudgeEffectiveness, @interventionMode, @interventionConfidence,
        @reasonCodesJson, @adviceMessagesJson
      )
    `);
    const nudgeStatement = this.db.prepare(`
      INSERT INTO nudge_history (
        episode_id, turn_index, advice_key, category, severity, tone, text, predicted_saving_rate, created_at
      ) VALUES (
        @episodeId, @turnIndex, @adviceKey, @category, @severity, @tone, @text, @predictedSavingRate, @createdAt
      )
    `);

    const transaction = this.db.transaction(() => {
      for (const turn of turns) {
        turnStatement.run({
          episodeId,
          turnIndex: turn.turnIndex,
          startedAt: turn.startedAt,
          finishedAt: turn.finishedAt,
          promptHash: turn.promptProfile.promptHash,
          promptPreview: turn.promptProfile.preview,
          inputText: turn.inputText,
          outputPreview: turn.outputPreview,
        });
        for (const event of turn.events) {
          eventStatement.run({
            episodeId,
            turnIndex: turn.turnIndex,
            eventType: event.type,
            source: event.source,
            timestamp: event.timestamp,
            detailsJson: JSON.stringify(event.details),
          });
        }
      }

      for (const summary of summaries) {
        summaryStatement.run({
          episodeId,
          turnIndex: summary.turnIndex,
          surrogateCost: summary.score.surrogateCost,
          explorationMode: summary.complexity.explorationMode,
          attentionEntropy: summary.complexity.attentionEntropy,
          attentionCompression: summary.complexity.attentionCompression,
          noveltyRatio: summary.complexity.noveltyRatio,
          approvalCount: summary.friction.approvalCount,
          approvalBurst: summary.friction.approvalBurst,
          toolErrorCount: summary.friction.toolErrorCount,
          toolRetryCount: summary.friction.toolRetryCount,
          toolFailureStreak: summary.friction.toolFailureStreak,
          editFailureCount: summary.friction.editFailureCount,
          recoveryAttempts: summary.friction.recoveryAttempts,
          humanConfirmationBurst: summary.friction.humanConfirmationBurst,
          frictionScore: summary.friction.frictionScore,
          stopAndReframeSignal: Number(summary.stopAndReframe.stopAndReframeSignal),
          stopCategory: summary.stopAndReframe.category,
          stopConfidence: summary.stopAndReframe.confidence,
          suggestedReframe: summary.stopAndReframe.suggestedReframe,
          assistantReaskRate: summary.assistantReaskRate,
          turnRetryDepth: summary.turnRetryDepth,
          responseLatencyMs: summary.responseLatencyMs,
          responseLatencyBucket: summary.responseLatencyBucket,
          midEpisodeNoveltyDrop: summary.midEpisodeNoveltyDrop,
          recentNudgeEffectiveness: summary.recentNudgeEffectiveness,
          interventionMode: summary.intervention.mode,
          interventionConfidence: summary.intervention.confidence,
          reasonCodesJson: JSON.stringify(summary.intervention.reasonCodes),
          adviceMessagesJson: JSON.stringify(summary.adviceMessages),
        });

        for (const message of summary.adviceMessages) {
          nudgeStatement.run({
            episodeId,
            turnIndex: summary.turnIndex,
            adviceKey: message.key,
            category: message.category,
            severity: message.severity,
            tone: message.tone,
            text: message.text,
            predictedSavingRate: message.predictedSavingRate ?? null,
            createdAt: new Date().toISOString(),
          });
        }
      }
    });
    transaction();
  }

  finishEpisode(episodeId: number, input: {
    finishedAt: string;
    exitCode: number;
    terminationReason: string;
    summary: EpisodeSummary;
    observedTotalTokens?: number | null;
    cli?: SupportedCli;
  }): void {
    const summary = {
      ...input.summary,
      turnCount: input.summary.turnCount ?? 0,
      interventionMode: input.summary.interventionMode ?? "quiet",
    };
    this.db
      .prepare(`
        UPDATE episodes
        SET finished_at = @finishedAt, exit_code = @exitCode, termination_reason = @terminationReason
        WHERE id = @episodeId
      `)
      .run({ episodeId, ...input });

    this.db
      .prepare(`
        INSERT OR REPLACE INTO episode_summaries (
          episode_id, surrogate_cost, files_read, lines_read_norm, symbol_revisits,
          retry_count, failed_verifications, cross_file_spread, no_change_turns,
          changed_files_count, changed_symbols_count, changed_lines_count, first_pass_green,
          prompt_length_bucket, structure_score, scope_bucket, exploration_mode,
          attention_entropy, attention_compression, novelty_ratio, expected_cost_confidence,
          approval_count, approval_burst, tool_error_count, tool_retry_count, tool_failure_streak,
          edit_failure_count, recovery_attempts, human_confirmation_burst, friction_score,
          stop_and_reframe_signal, best_stop_turn, suggested_reframe,
          fix_loop_occurred, search_loop_occurred, nice_guidance_awarded,
          predicted_loss_rate, exp_awarded, turn_count, intervention_mode
        ) VALUES (
          @episodeId, @surrogateCost, @filesRead, @linesReadNorm, @symbolRevisits,
          @retryCount, @failedVerifications, @crossFileSpread, @noChangeTurns,
          @changedFilesCount, @changedSymbolsCount, @changedLinesCount, @firstPassGreen,
          @promptLengthBucket, @structureScore, @scopeBucket, @explorationMode,
          @attentionEntropy, @attentionCompression, @noveltyRatio, @expectedCostConfidence,
          @approvalCount, @approvalBurst, @toolErrorCount, @toolRetryCount, @toolFailureStreak,
          @editFailureCount, @recoveryAttempts, @humanConfirmationBurst, @frictionScore,
          @stopAndReframeSignal, @bestStopTurn, @suggestedReframe,
          @fixLoopOccurred, @searchLoopOccurred, @niceGuidanceAwarded,
          @predictedLossRate, @expAwarded, @turnCount, @interventionMode
        )
      `)
      .run({
        episodeId,
        ...summary,
        firstPassGreen: Number(summary.firstPassGreen),
        stopAndReframeSignal: Number(summary.stopAndReframeSignal),
        fixLoopOccurred: Number(summary.fixLoopOccurred),
        searchLoopOccurred: Number(summary.searchLoopOccurred),
        niceGuidanceAwarded: Number(summary.niceGuidanceAwarded),
      });

    this.updateStatsBuckets(summary);
    if (typeof input.observedTotalTokens === "number" && input.cli) {
      this.updateTokenCalibration(input.cli, summary.surrogateCost, input.observedTotalTokens);
    }
  }

  private updateStatsBuckets(summary: EpisodeSummary): void {
    const bucketSpecs = [
      {
        bucketLevel: "exact",
        bucketKey: `${summary.promptLengthBucket}|${summary.structureScore}|${summary.scopeBucket}|${summary.explorationMode}`,
      },
      {
        bucketLevel: "backoff1",
        bucketKey: `${summary.structureScore}|${summary.scopeBucket}`,
      },
      {
        bucketLevel: "backoff2",
        bucketKey: `${summary.structureScore}`,
      },
      {
        bucketLevel: "global",
        bucketKey: "global",
      },
    ] as const;

    const select = this.db.prepare(`
      SELECT
        sample_size AS sampleSize,
        mean_cost AS meanCost,
        ema_cost AS emaCost,
        m2_cost AS m2Cost,
        fix_loop_rate AS fixLoopRate,
        retry_rate AS retryRate,
        last_updated_at AS lastUpdatedAt
      FROM stats_buckets WHERE bucket_level = ? AND bucket_key = ?
    `);
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO stats_buckets (
        bucket_level, bucket_key, sample_size, mean_cost, ema_cost, m2_cost,
        fix_loop_rate, retry_rate, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const retrySignal = Number(summary.retryCount > 0);
    const fixLoopSignal = Number(summary.fixLoopOccurred || summary.searchLoopOccurred);
    const now = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      for (const spec of bucketSpecs) {
        const existing = select.get(spec.bucketLevel, spec.bucketKey) as
          | {
              sampleSize: number;
              meanCost: number;
              emaCost: number;
              m2Cost: number;
              fixLoopRate: number;
              retryRate: number;
              lastUpdatedAt: string | null;
            }
          | undefined;

        if (!existing) {
          insert.run(
            spec.bucketLevel,
            spec.bucketKey,
            1,
            summary.surrogateCost,
            summary.surrogateCost,
            0,
            fixLoopSignal,
            retrySignal,
            now,
          );
          continue;
        }

        const alpha = existing.sampleSize < 8 ? 0.35 : 0.2;
        const nextEma = (alpha * summary.surrogateCost) + ((1 - alpha) * (existing.emaCost || existing.meanCost));
        const nextM2 = runningM2(
          existing.meanCost,
          existing.m2Cost ?? 0,
          existing.sampleSize,
          summary.surrogateCost,
        );

        insert.run(
          spec.bucketLevel,
          spec.bucketKey,
          existing.sampleSize + 1,
          runningMean(existing.meanCost, existing.sampleSize, summary.surrogateCost),
          nextEma,
          nextM2,
          runningMean(existing.fixLoopRate, existing.sampleSize, fixLoopSignal),
          runningMean(existing.retryRate, existing.sampleSize, retrySignal),
          now,
        );
      }
    });

    transaction();
  }

  private updateTokenCalibration(cli: SupportedCli, surrogateCost: number, totalTokens: number): void {
    const existing = this.db
      .prepare(`
        SELECT
          sample_size AS sampleSize,
          sum_surrogate_cost AS sumSurrogateCost,
          sum_total_tokens AS sumTotalTokens,
          sum_surrogate_sq AS sumSurrogateSq,
          sum_cost_token AS sumCostToken
        FROM token_calibration_models
        WHERE cli = ?
      `)
      .get(cli) as
      | {
          sampleSize: number;
          sumSurrogateCost: number;
          sumTotalTokens: number;
          sumSurrogateSq: number;
          sumCostToken: number;
        }
      | undefined;

    const nextSampleSize = (existing?.sampleSize ?? 0) + 1;
    const nextSumSurrogateCost = (existing?.sumSurrogateCost ?? 0) + surrogateCost;
    const nextSumTotalTokens = (existing?.sumTotalTokens ?? 0) + totalTokens;
    const nextSumSurrogateSq = (existing?.sumSurrogateSq ?? 0) + (surrogateCost * surrogateCost);
    const nextSumCostToken = (existing?.sumCostToken ?? 0) + (surrogateCost * totalTokens);

    const denominator =
      (nextSampleSize * nextSumSurrogateSq) - (nextSumSurrogateCost * nextSumSurrogateCost);
    const slope =
      Math.abs(denominator) < 1e-9
        ? 0
        : ((nextSampleSize * nextSumCostToken) - (nextSumSurrogateCost * nextSumTotalTokens)) / denominator;
    const intercept =
      nextSampleSize === 0
        ? 0
        : (nextSumTotalTokens - (slope * nextSumSurrogateCost)) / nextSampleSize;

    this.db
      .prepare(`
        INSERT OR REPLACE INTO token_calibration_models (
          cli, sample_size, sum_surrogate_cost, sum_total_tokens, sum_surrogate_sq,
          sum_cost_token, slope, intercept, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cli,
        nextSampleSize,
        nextSumSurrogateCost,
        nextSumTotalTokens,
        nextSumSurrogateSq,
        nextSumCostToken,
        slope,
        intercept,
        new Date().toISOString(),
      );
  }

  lookupExpectedCost(promptProfile: PromptProfile, complexity: EpisodeComplexity): ExpectedCostEstimate {
    const candidates = [
      {
        bucketLevel: "exact" as const,
        bucketKey: `${promptProfile.promptLengthBucket}|${promptProfile.structureScore}|${complexity.scopeBucket}|${complexity.explorationMode}`,
      },
      {
        bucketLevel: "backoff1" as const,
        bucketKey: `${promptProfile.structureScore}|${complexity.scopeBucket}`,
      },
      {
        bucketLevel: "backoff2" as const,
        bucketKey: `${promptProfile.structureScore}`,
      },
      {
        bucketLevel: "global" as const,
        bucketKey: "global",
      },
    ];

    const statement = this.db.prepare(`
      SELECT
        sample_size AS sampleSize,
        mean_cost AS meanCost,
        ema_cost AS emaCost,
        m2_cost AS m2Cost,
        last_updated_at AS lastUpdatedAt
      FROM stats_buckets WHERE bucket_level = ? AND bucket_key = ?
    `);

    for (const candidate of candidates) {
      const row = statement.get(candidate.bucketLevel, candidate.bucketKey) as
        | {
            sampleSize: number;
            meanCost: number;
            emaCost: number;
            m2Cost: number;
            lastUpdatedAt: string | null;
          }
        | undefined;
      if (!row) continue;
      const sampleSize = row.sampleSize;
      const levelPenalty =
        candidate.bucketLevel === "exact" ? 0
        : candidate.bucketLevel === "backoff1" ? 0.35
        : candidate.bucketLevel === "backoff2" ? 0.7
        : 1.0;
      const emaWeight = sampleSize < 8 ? 0.55 : sampleSize < 20 ? 0.45 : 0.3;
      const baseCost =
        (emaWeight * (row.emaCost || row.meanCost)) +
        ((1 - emaWeight) * row.meanCost);
      const variance = sampleSize > 1 ? Math.max((row.m2Cost ?? 0) / (sampleSize - 1), 0) : 4;
      const stdDev = Math.sqrt(Math.max(variance, 0.25));
      const uncertaintyPenalty = (stdDev / Math.sqrt(Math.max(sampleSize, 1))) + levelPenalty;
      const lastUpdatedAt = row.lastUpdatedAt ? new Date(row.lastUpdatedAt) : null;
      const staleDays = lastUpdatedAt
        ? Math.max(0, (Date.now() - lastUpdatedAt.getTime()) / (1000 * 60 * 60 * 24))
        : 180;
      const recencyPenalty = Math.min(1.5, staleDays * 0.03);
      const explorationPenalty = Math.min(
        1.6,
        (complexity.attentionEntropy * 0.45) +
          (complexity.repeatedAttentionRatio * 0.7) +
          (complexity.explorationMode === "scattered" ? 0.35 : 0) +
          (complexity.explorationMode === "loop-prone" ? 0.45 : 0),
      );
      const convergenceBonus = Math.min(
        1.2,
        (Math.max(complexity.attentionCompression, 0) * 0.7) +
          (complexity.noveltyRatio < 0.7 ? 0.15 : 0),
      );
      const structureBonus = Math.min(
        1.4,
        (promptProfile.structureScore * 0.18) + (promptProfile.targetSpecificityScore * 0.08),
      );
      const verificationBonus = promptProfile.hasTestRef && complexity.testsPresent ? 0.45 : 0;
      const expectedCost = Math.max(
        0.5,
        baseCost +
          uncertaintyPenalty +
          recencyPenalty +
          explorationPenalty -
          convergenceBonus -
          structureBonus -
          verificationBonus,
      );
      const confidence =
        Math.max(
          0.1,
          Math.min(
            0.98,
            (sampleSize / (sampleSize + 8)) *
              Math.exp(-staleDays / 120) *
              (candidate.bucketLevel === "exact" ? 1 : candidate.bucketLevel === "backoff1" ? 0.85 : candidate.bucketLevel === "backoff2" ? 0.72 : 0.55),
          ),
        );
      return {
        bucketLevel: candidate.bucketLevel,
        bucketKey: candidate.bucketKey,
        sampleSize,
        baseCost: Number(baseCost.toFixed(2)),
        recencyPenalty: Number(recencyPenalty.toFixed(2)),
        uncertaintyPenalty: Number(uncertaintyPenalty.toFixed(2)),
        explorationPenalty: Number(explorationPenalty.toFixed(2)),
        structureBonus: Number(structureBonus.toFixed(2)),
        verificationBonus: Number(verificationBonus.toFixed(2)),
        expectedCost: Number(expectedCost.toFixed(2)),
        confidence: Number(confidence.toFixed(3)),
      };
    }

    return {
      bucketLevel: "global",
      bucketKey: "bootstrap",
      sampleSize: 0,
      baseCost: 6.5,
      recencyPenalty: 0.9,
      uncertaintyPenalty: 1.2,
      explorationPenalty: Number(((complexity.attentionEntropy * 0.45) + (complexity.repeatedAttentionRatio * 0.7)).toFixed(2)),
      structureBonus: Number(((promptProfile.structureScore * 0.18) + (promptProfile.targetSpecificityScore * 0.08)).toFixed(2)),
      verificationBonus: promptProfile.hasTestRef && complexity.testsPresent ? 0.45 : 0,
      expectedCost: 6.5,
      confidence: 0.12,
    };
  }

  getRecentSymbolTouchCount(stableSymbolId: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(DISTINCT episode_id) AS touchCount
        FROM symbol_change_events
        WHERE stable_symbol_id = ?
      `)
      .get(stableSymbolId) as { touchCount: number };
    return row?.touchCount ?? 0;
  }

  getRecentSearchLoopOverlap(attentionPaths: string[]): number {
    if (attentionPaths.length === 0) return 0;
    const rows = this.db
      .prepare(`
        SELECT details_json AS detailsJson, episode_id AS episodeId
        FROM episode_events
        WHERE event_type IN ('file_read', 'search', 'log_read')
        ORDER BY episode_id DESC, id DESC
        LIMIT 60
      `)
      .all() as Array<{ detailsJson: string; episodeId: number }>;

    const grouped = new Map<number, Set<string>>();
    for (const row of rows) {
      const details = JSON.parse(row.detailsJson) as Record<string, unknown>;
      const pathValue = typeof details.path === "string" ? details.path : null;
      if (!pathValue) continue;
      if (!grouped.has(row.episodeId)) grouped.set(row.episodeId, new Set());
      grouped.get(row.episodeId)?.add(pathValue);
    }

    let bestOverlap = 0;
    const current = new Set(attentionPaths);
    for (const previous of grouped.values()) {
      const intersection = [...current].filter((item) => previous.has(item)).length;
      const union = new Set([...current, ...previous]).size;
      bestOverlap = Math.max(bestOverlap, union === 0 ? 0 : intersection / union);
    }
    return bestOverlap;
  }

  getRecentNudgeEffectiveness(): number {
    const rows = this.db
      .prepare(`
        SELECT predicted_saving_rate AS predictedSavingRate
        FROM nudge_history
        ORDER BY id DESC
        LIMIT 12
      `)
      .all() as Array<{ predictedSavingRate: number | null }>;
    if (rows.length === 0) return 0.5;
    const usable = rows.filter((row) => typeof row.predictedSavingRate === "number") as Array<{
      predictedSavingRate: number;
    }>;
    if (usable.length === 0) return 0.5;
    const mean = usable.reduce((sum, row) => sum + row.predictedSavingRate, 0) / usable.length;
    return Number(clamp(mean + 0.5, 0, 1).toFixed(3));
  }

  getEpisodeStats(): Array<Record<string, unknown>> {
    return this.db
      .prepare(`
        SELECT
          episodes.id,
          episodes.cli,
          episodes.started_at AS startedAt,
          episodes.finished_at AS finishedAt,
          episode_summaries.surrogate_cost AS surrogateCost,
          episode_summaries.exp_awarded AS expAwarded,
          episode_summaries.turn_count AS turnCount,
          episode_summaries.intervention_mode AS interventionMode,
          episode_summaries.nice_guidance_awarded AS niceGuidanceAwarded,
          episode_summaries.fix_loop_occurred AS fixLoopOccurred,
          episode_summaries.search_loop_occurred AS searchLoopOccurred
        FROM episodes
        JOIN episode_summaries ON episode_summaries.episode_id = episodes.id
        ORDER BY episodes.id DESC
      `)
      .all() as Array<Record<string, unknown>>;
  }

  getStatsOverview(): StatsOverview {
    const active = this.db
      .prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(AVG(surrogate_cost), 0) AS avgCost,
          COALESCE(SUM(exp_awarded), 0) AS totalExp
        FROM episode_summaries
      `)
      .get() as { count: number; avgCost: number; totalExp: number };
    const archived = this.db
      .prepare(`
        SELECT
          COUNT(*) AS count,
          COALESCE(AVG(surrogate_cost), 0) AS avgCost,
          COALESCE(SUM(exp_awarded), 0) AS totalExp
        FROM archived_episodes
      `)
      .get() as { count: number; avgCost: number; totalExp: number };

    const totalEpisodes = active.count + archived.count;
    const totalExp = active.totalExp + archived.totalExp;
    const weightedAvg =
      totalEpisodes === 0
        ? 0
        : ((active.avgCost * active.count) + (archived.avgCost * archived.count)) / totalEpisodes;

    return {
      totalEpisodes,
      averageSurrogateCost: Number(weightedAvg.toFixed(2)),
      totalExp,
      activeEpisodeCount: active.count,
      archivedEpisodeCount: archived.count,
      recentEpisodes: this.getEpisodeStats(),
    };
  }

  getStorageReport(): StorageReport {
    const config = ensureEvoConfig(this.cwd);
    const walPath = `${this.dbPath}-wal`;
    const dbBytes = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    const rowCounts: Record<string, number> = {};
    for (const table of [
      "episodes",
      "prompt_profiles",
      "episode_events",
      "file_snapshots",
      "symbol_snapshots",
      "symbol_change_events",
      "turns",
      "turn_events",
      "turn_summaries",
      "nudge_history",
      "episode_summaries",
      "stats_buckets",
      "token_calibration_models",
      "usage_observations",
      "archived_episodes",
    ]) {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      rowCounts[table] = row.count;
    }

    const totalBytes = dbBytes + walBytes;
    return {
      dbPath: this.dbPath,
      dbBytes,
      walBytes,
      totalBytes,
      activeEpisodeCount: rowCounts.episodes,
      archivedEpisodeCount: rowCounts.archived_episodes,
      rowCounts,
      retention: config.retention,
      overLimit: totalBytes > config.retention.maxDatabaseBytes,
    };
  }

  exportKnowledgeBundle(outputPath: string): void {
    const config = ensureEvoConfig(this.cwd);
    const statsBuckets = this.db.prepare(`SELECT * FROM stats_buckets ORDER BY bucket_level, bucket_key`).all();
    const tokenCalibrationModels = this.db.prepare(`SELECT * FROM token_calibration_models ORDER BY cli`).all();
    const payload = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceCwd: this.cwd,
      retention: config.retention,
      statsBuckets,
      tokenCalibrationModels,
    };
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  }

  importKnowledgeBundle(inputPath: string): { importedBuckets: number } {
    const payload = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
      statsBuckets?: Array<{
        bucket_level: string;
        bucket_key: string;
        sample_size: number;
        mean_cost: number;
        ema_cost?: number;
        m2_cost?: number;
        fix_loop_rate: number;
        retry_rate: number;
        last_updated_at?: string | null;
      }>;
      tokenCalibrationModels?: Array<{
        cli: string;
        sample_size: number;
        sum_surrogate_cost: number;
        sum_total_tokens: number;
        sum_surrogate_sq: number;
        sum_cost_token: number;
        slope: number;
        intercept: number;
        updated_at: string;
      }>;
    };
    const incoming = payload.statsBuckets ?? [];
    const calibrationIncoming = payload.tokenCalibrationModels ?? [];
    const select = this.db.prepare(`
      SELECT
        bucket_level AS bucketLevel,
        bucket_key AS bucketKey,
        sample_size AS sampleSize,
        mean_cost AS meanCost,
        ema_cost AS emaCost,
        m2_cost AS m2Cost,
        fix_loop_rate AS fixLoopRate,
        retry_rate AS retryRate,
        last_updated_at AS lastUpdatedAt
      FROM stats_buckets
      WHERE bucket_level = ? AND bucket_key = ?
    `);
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO stats_buckets (
        bucket_level, bucket_key, sample_size, mean_cost, ema_cost, m2_cost,
        fix_loop_rate, retry_rate, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const row of incoming) {
        const existing = select.get(row.bucket_level, row.bucket_key) as
          | {
              bucketLevel: string;
              bucketKey: string;
              sampleSize: number;
              meanCost: number;
              emaCost: number;
              m2Cost: number;
              fixLoopRate: number;
              retryRate: number;
              lastUpdatedAt: string | null;
            }
          | undefined;
        if (!existing) {
          upsert.run(
            row.bucket_level,
            row.bucket_key,
            row.sample_size,
            row.mean_cost,
            row.ema_cost ?? row.mean_cost,
            row.m2_cost ?? 0,
            row.fix_loop_rate,
            row.retry_rate,
            row.last_updated_at ?? new Date().toISOString(),
          );
          continue;
        }

        const totalSample = existing.sampleSize + row.sample_size;
        const delta = row.mean_cost - existing.meanCost;
        const combinedMean =
          ((existing.meanCost * existing.sampleSize) + (row.mean_cost * row.sample_size)) /
          Math.max(totalSample, 1);
        const combinedM2 =
          (existing.m2Cost ?? 0) +
          (row.m2_cost ?? 0) +
          ((delta * delta) * existing.sampleSize * row.sample_size) / Math.max(totalSample, 1);
        const preferredTimestamp =
          new Date(row.last_updated_at ?? 0).getTime() >= new Date(existing.lastUpdatedAt ?? 0).getTime()
            ? (row.last_updated_at ?? existing.lastUpdatedAt ?? new Date().toISOString())
            : (existing.lastUpdatedAt ?? row.last_updated_at ?? new Date().toISOString());
        upsert.run(
          row.bucket_level,
          row.bucket_key,
          totalSample,
          combinedMean,
          new Date(row.last_updated_at ?? 0).getTime() >= new Date(existing.lastUpdatedAt ?? 0).getTime()
            ? (row.ema_cost ?? row.mean_cost)
            : (existing.emaCost ?? existing.meanCost),
          combinedM2,
          ((existing.fixLoopRate * existing.sampleSize) + (row.fix_loop_rate * row.sample_size)) / Math.max(totalSample, 1),
          ((existing.retryRate * existing.sampleSize) + (row.retry_rate * row.sample_size)) / Math.max(totalSample, 1),
          preferredTimestamp,
        );
      }

      const calibrationUpsert = this.db.prepare(`
        INSERT OR REPLACE INTO token_calibration_models (
          cli, sample_size, sum_surrogate_cost, sum_total_tokens, sum_surrogate_sq,
          sum_cost_token, slope, intercept, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const calibrationSelect = this.db.prepare(`
        SELECT * FROM token_calibration_models WHERE cli = ?
      `);
      for (const model of calibrationIncoming) {
        const existing = calibrationSelect.get(model.cli) as Record<string, unknown> | undefined;
        if (!existing) {
          calibrationUpsert.run(
            model.cli,
            model.sample_size,
            model.sum_surrogate_cost,
            model.sum_total_tokens,
            model.sum_surrogate_sq,
            model.sum_cost_token,
            model.slope,
            model.intercept,
            model.updated_at,
          );
          continue;
        }

        const mergedSample = Number(existing.sample_size) + model.sample_size;
        const mergedSumSurrogate = Number(existing.sum_surrogate_cost) + model.sum_surrogate_cost;
        const mergedSumTokens = Number(existing.sum_total_tokens) + model.sum_total_tokens;
        const mergedSumSq = Number(existing.sum_surrogate_sq) + model.sum_surrogate_sq;
        const mergedSumCostToken = Number(existing.sum_cost_token) + model.sum_cost_token;
        const denominator =
          (mergedSample * mergedSumSq) - (mergedSumSurrogate * mergedSumSurrogate);
        const slope =
          Math.abs(denominator) < 1e-9
            ? 0
            : ((mergedSample * mergedSumCostToken) - (mergedSumSurrogate * mergedSumTokens)) / denominator;
        const intercept =
          mergedSample === 0 ? 0 : (mergedSumTokens - (slope * mergedSumSurrogate)) / mergedSample;
        const updatedAt =
          new Date(model.updated_at).getTime() >= new Date(String(existing.updated_at)).getTime()
            ? model.updated_at
            : String(existing.updated_at);
        calibrationUpsert.run(
          model.cli,
          mergedSample,
          mergedSumSurrogate,
          mergedSumTokens,
          mergedSumSq,
          mergedSumCostToken,
          slope,
          intercept,
          updatedAt,
        );
      }
    });

    transaction();
    return { importedBuckets: incoming.length };
  }

  getTokenCalibration(cli: SupportedCli): {
    cli: SupportedCli;
    sampleSize: number;
    slope: number;
    intercept: number;
  } | null {
    const row = this.db
      .prepare(`
        SELECT
          cli,
          sample_size AS sampleSize,
          slope,
          intercept
        FROM token_calibration_models
        WHERE cli = ?
      `)
      .get(cli) as
      | {
          cli: SupportedCli;
          sampleSize: number;
          slope: number;
          intercept: number;
        }
      | undefined;
    return row ?? null;
  }

  compactRawEpisodes(): { compactedEpisodes: number; storageReport: StorageReport } {
    const config = ensureEvoConfig(this.cwd);
    const reportBefore = this.getStorageReport();
    const activeCount = reportBefore.activeEpisodeCount;
    const shouldCompact =
      activeCount > config.retention.keepRecentRawEpisodes ||
      reportBefore.totalBytes > config.retention.maxDatabaseBytes;

    if (!shouldCompact) {
      return { compactedEpisodes: 0, storageReport: reportBefore };
    }

    const keepCount = Math.max(1, config.retention.keepRecentRawEpisodes);
    const rows = this.db
      .prepare(`
        SELECT id
        FROM episodes
        ORDER BY id DESC
      `)
      .all() as Array<{ id: number }>;
    const idsToKeep = new Set(rows.slice(0, keepCount).map((row) => row.id));
    const idsToCompact = rows.filter((row) => !idsToKeep.has(row.id)).map((row) => row.id);

    if (idsToCompact.length === 0) {
      return { compactedEpisodes: 0, storageReport: reportBefore };
    }

    const archiveInsert = this.db.prepare(`
      INSERT OR IGNORE INTO archived_episodes (
        original_episode_id, cli, started_at, finished_at, prompt_length_bucket, structure_score,
        scope_bucket, exploration_mode, attention_entropy, attention_compression, novelty_ratio, expected_cost_confidence,
        surrogate_cost, exp_awarded, first_pass_green,
        fix_loop_occurred, search_loop_occurred, changed_files_count, changed_symbols_count,
        changed_lines_count, total_tokens, compacted_at
      )
      SELECT
        episodes.id,
        episodes.cli,
        episodes.started_at,
        episodes.finished_at,
        episode_summaries.prompt_length_bucket,
        episode_summaries.structure_score,
        episode_summaries.scope_bucket,
        episode_summaries.exploration_mode,
        episode_summaries.attention_entropy,
        episode_summaries.attention_compression,
        episode_summaries.novelty_ratio,
        episode_summaries.expected_cost_confidence,
        episode_summaries.surrogate_cost,
        episode_summaries.exp_awarded,
        episode_summaries.first_pass_green,
        episode_summaries.fix_loop_occurred,
        episode_summaries.search_loop_occurred,
        episode_summaries.changed_files_count,
        episode_summaries.changed_symbols_count,
        episode_summaries.changed_lines_count,
        (SELECT MAX(total_tokens) FROM usage_observations WHERE usage_observations.episode_id = episodes.id),
        @compactedAt
      FROM episodes
      JOIN episode_summaries ON episode_summaries.episode_id = episodes.id
      WHERE episodes.id = @episodeId
    `);

    const deleteStatements = [
      this.db.prepare(`DELETE FROM usage_observations WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM nudge_history WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM turn_summaries WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM turn_events WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM turns WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM symbol_change_events WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM symbol_snapshots WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM file_snapshots WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM episode_events WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM prompt_profiles WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM episode_summaries WHERE episode_id = ?`),
      this.db.prepare(`DELETE FROM episodes WHERE id = ?`),
    ];

    const transaction = this.db.transaction((episodeIds: number[]) => {
      const compactedAt = new Date().toISOString();
      for (const episodeId of episodeIds) {
        archiveInsert.run({ compactedAt, episodeId });
        for (const statement of deleteStatements) statement.run(episodeId);
      }
    });
    transaction(idsToCompact);

    this.db.pragma("wal_checkpoint(TRUNCATE)");
    if (config.retention.vacuumOnCompact) {
      this.db.exec("VACUUM");
    }

    return { compactedEpisodes: idsToCompact.length, storageReport: this.getStorageReport() };
  }

  getEpisodeExplain(episodeId: number): {
    episode: Record<string, unknown>;
    profile: Record<string, unknown>;
    summary: Record<string, unknown>;
    usage: UsageObservation[];
    turns: Array<Record<string, unknown>>;
  } | null {
    const episode = this.db
      .prepare(`SELECT * FROM episodes WHERE id = ?`)
      .get(episodeId) as Record<string, unknown> | undefined;
    if (!episode) return null;

    const profile = this.db
      .prepare(`SELECT * FROM prompt_profiles WHERE episode_id = ?`)
      .get(episodeId) as Record<string, unknown>;
    const summary = this.db
      .prepare(`SELECT * FROM episode_summaries WHERE episode_id = ?`)
      .get(episodeId) as Record<string, unknown>;
    const usage = this.db
      .prepare(`
        SELECT
          cli,
          prompt_tokens AS promptTokens,
          completion_tokens AS completionTokens,
          total_tokens AS totalTokens,
          source,
          raw_line AS rawLine,
          confidence
        FROM usage_observations
        WHERE episode_id = ?
        ORDER BY id ASC
      `)
      .all(episodeId) as UsageObservation[];
    const turns = this.db
      .prepare(`
        SELECT
          turns.turn_index,
          turn_summaries.surrogate_cost,
          turn_summaries.friction_score,
          turn_summaries.approval_count,
          turn_summaries.tool_error_count,
          turn_summaries.tool_retry_count,
          turn_summaries.stop_and_reframe_signal,
          turn_summaries.stop_category,
          turn_summaries.suggested_reframe,
          turn_summaries.intervention_mode,
          turn_summaries.response_latency_bucket,
          turn_summaries.reason_codes_json
        FROM turns
        JOIN turn_summaries
          ON turn_summaries.episode_id = turns.episode_id
         AND turn_summaries.turn_index = turns.turn_index
        WHERE turns.episode_id = ?
        ORDER BY turns.turn_index ASC
      `)
      .all(episodeId) as Array<Record<string, unknown>>;

    return { episode, profile, summary, usage, turns };
  }
}
