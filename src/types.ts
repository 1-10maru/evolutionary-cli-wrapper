export type SupportedCli = "codex" | "claude" | "generic";
export type InterventionMode = "auto" | "active" | "quiet";
export type InterventionDecisionMode = "active" | "quiet" | "silent";
export type MascotStage = "egg" | "sprout" | "buddy" | "wizard" | "legend";
export type MascotMood = "sleepy" | "happy" | "hyped" | "worried" | "proud";
export type NudgeCategory =
  | "specificity"
  | "structure"
  | "verification"
  | "scope_control"
  | "recovery"
  | "exploration_focus"
  | "praise";
export type NudgeSeverity = "low" | "medium" | "high";
export type NudgeTone = "concise" | "encouraging" | "corrective";
export type NudgeSurface = "inline" | "end_of_turn" | "end_of_session";
export type ProxyAdviceMode = "auto" | "active" | "quiet";
export type FrictionEventType =
  | "tool_call_started"
  | "tool_call_succeeded"
  | "tool_call_failed"
  | "tool_approval_requested"
  | "tool_approval_granted"
  | "tool_approval_denied"
  | "tool_retry_requested"
  | "tool_retry_succeeded"
  | "tool_retry_failed"
  | "edit_attempt_started"
  | "edit_attempt_failed"
  | "edit_attempt_recovered"
  | "error_recovery_started"
  | "error_recovery_succeeded";
export type FrictionSignalCategory =
  | "none"
  | "approval_storm"
  | "error_spiral"
  | "retry_loop"
  | "stop_and_reframe";

export type EpisodeEventType =
  | "prompt_submitted"
  | "file_read"
  | "search"
  | "log_read"
  | "patch_applied"
  | "test_run"
  | "build_run"
  | "no_code_change_response"
  | "clarification_prompt"
  | FrictionEventType
  | "turn_closed"
  | "episode_closed";

export type SnapshotPhase = "before" | "after";
export type SymbolKind = "function" | "method" | "class";
export type SymbolChangeKind = "added" | "modified" | "deleted" | "renamed" | "moved";
export type CounterfactualProfileKind =
  | "structured_baseline"
  | "plus_10_chars_specificity"
  | "with_test_intent";

export interface PromptProfile {
  promptHash: string;
  promptLength: number;
  promptLengthBucket: string;
  structureScore: number;
  hasBullets: boolean;
  hasFileRefs: boolean;
  hasSymbolRefs: boolean;
  hasConstraintRef: boolean;
  hasAcceptanceRef: boolean;
  hasTestRef: boolean;
  targetSpecificityScore: number;
  preview: string;
}

export interface UsageObservation {
  cli: SupportedCli;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  source: "stdout" | "stderr";
  rawLine: string;
  confidence: number;
  turnIndex?: number | null;
}

export interface TokenCalibrationEstimate {
  cli: SupportedCli;
  predictedTotalTokens: number;
  confidence: number;
  sampleSize: number;
}

export interface MascotProfile {
  speciesId: string;
  nickname: string;
  stage: MascotStage;
  totalBondExp: number;
  mood: MascotMood;
  streakDays: number;
  lastSeenAt: string | null;
  favoriteHintStyle: NudgeCategory | "none";
  lastMessages: string[];
  comboCount: number;
  bestCombo: number;
}

export interface MascotRenderState {
  profile: MascotProfile;
  progressPercent: number;
  level: number;
  avatar: string;
  accentTone: "info" | "success" | "warning" | "danger" | "accent" | "magic";
}

export interface MascotEpisodeUpdate {
  speciesId: string;
  previousStage: MascotStage;
  nextStage: MascotStage;
  gainedExp: number;
  totalBondExp: number;
  progressPercent: number;
  leveledUp: boolean;
  stageChanged: boolean;
  mood: MascotMood;
}

export interface RetentionPolicy {
  keepRecentRawEpisodes: number;
  maxDatabaseBytes: number;
  compactOnRun: boolean;
  vacuumOnCompact: boolean;
}

export interface ShellIntegrationConfig {
  enabled: boolean;
  binDir: string;
  originalCommandMap: Partial<Record<SupportedCli, string>>;
  profilePath: string;
  cmdAutoRunScriptPath: string;
  originalCmdAutoRun: string | null;
}

export interface ProxyConfig {
  defaultMode: ProxyAdviceMode;
  turnIdleMs: number;
}

export interface NudgeConfig {
  maxInlineLines: number;
  cooldownTurns: number;
  minConfidenceForPercent: number;
}

export interface EvoConfig {
  formatVersion: number;
  retention: RetentionPolicy;
  shellIntegration: ShellIntegrationConfig;
  proxy: ProxyConfig;
  nudge: NudgeConfig;
  advice: AdviceConfig;
}

export interface EpisodeEvent {
  type: EpisodeEventType;
  source: "wrapper" | "adapter" | "watcher" | "verification" | "proxy";
  timestamp: string;
  details: Record<string, unknown>;
}

export interface FileSnapshot {
  path: string;
  relativePath: string;
  contentHash: string;
  lineCount: number;
  size: number;
  isText: boolean;
  extension: string;
  content?: string;
}

export interface WorkspaceSnapshot {
  files: FileSnapshot[];
  byRelativePath: Map<string, FileSnapshot>;
}

export interface ChangedFile {
  relativePath: string;
  changeKind: "added" | "modified" | "deleted";
  before?: FileSnapshot;
  after?: FileSnapshot;
  changedLines: number;
}

export interface SymbolSnapshot {
  stableSymbolId: string;
  language: string;
  kind: SymbolKind;
  qualifiedName: string;
  parentQualifiedName: string | null;
  signatureHash: string;
  bodyHash: string;
  astFingerprint: string;
  startLine: number;
  endLine: number;
}

export interface SymbolChangeEvent {
  stableSymbolId: string;
  path: string;
  qualifiedName: string;
  kind: SymbolKind;
  language: string;
  changeKind: SymbolChangeKind;
  beforeBodyHash: string | null;
  afterBodyHash: string | null;
  changedLines: number;
}

export interface EpisodeComplexity {
  changedFilesCount: number;
  changedFilesBucket: string;
  changedSymbolsCount: number;
  changedSymbolsBucket: string;
  changedLinesCount: number;
  changedLinesBucket: string;
  testsPresent: boolean;
  languages: string[];
  explorationHeavy: boolean;
  explorationMode: "direct" | "balanced" | "exploration-heavy" | "scattered" | "loop-prone";
  attentionEntropy: number;
  attentionCompression: number;
  noveltyRatio: number;
  repeatedAttentionRatio: number;
  scopeBucket: string;
}

export interface ScoreBreakdown {
  filesRead: number;
  linesReadNorm: number;
  symbolRevisits: number;
  retryCount: number;
  failedVerifications: number;
  crossFileSpread: number;
  noChangeTurns: number;
  attentionEntropy: number;
  attentionCompression: number;
  noveltyRatio: number;
  repeatedAttentionRatio: number;
  explorationPenalty: number;
  convergenceBonus: number;
  surrogateCost: number;
}

export interface ExpectedCostEstimate {
  bucketLevel: "exact" | "backoff1" | "backoff2" | "global";
  bucketKey: string;
  sampleSize: number;
  baseCost: number;
  recencyPenalty: number;
  uncertaintyPenalty: number;
  explorationPenalty: number;
  structureBonus: number;
  verificationBonus: number;
  expectedCost: number;
  confidence: number;
}

export interface PredictiveNudge {
  counterfactual: CounterfactualProfileKind;
  currentCost: number;
  counterfactualCost: number;
  predictedSavingRate: number;
  confidence: number;
  explanation: string;
  category: NudgeCategory;
  supportSampleSize: number;
  bucketLevel: ExpectedCostEstimate["bucketLevel"];
}

export interface RenderedAdviceMessage {
  key: string;
  category: NudgeCategory;
  severity: NudgeSeverity;
  tone: NudgeTone;
  surface: NudgeSurface;
  text: string;
  lineBudget: number;
  predictedSavingRate?: number | null;
}

export interface InterventionDecision {
  mode: InterventionDecisionMode;
  reasonCodes: string[];
  confidence: number;
  displayBudgetLines: number;
}

export interface FrictionSummary {
  approvalCount: number;
  approvalBurst: number;
  toolErrorCount: number;
  toolRetryCount: number;
  toolFailureStreak: number;
  editFailureCount: number;
  recoveryAttempts: number;
  humanConfirmationBurst: number;
  frictionScore: number;
  stopAndReframeSignal: boolean;
  dominantSignal: FrictionSignalCategory;
  confidence: number;
}

export interface StopAndReframeDecision {
  stopAndReframeSignal: boolean;
  category: FrictionSignalCategory;
  confidence: number;
  reasonCodes: string[];
  suggestedReframe: string;
  avoidableCostLabel: string;
}

export interface LoopSignals {
  editLoop: boolean;
  searchLoop: boolean;
  touchedStableSymbolIds: string[];
}

export interface TurnSummary {
  turnIndex: number;
  promptProfile: PromptProfile;
  score: ScoreBreakdown;
  complexity: EpisodeComplexity;
  friction: FrictionSummary;
  stopAndReframe: StopAndReframeDecision;
  loopSignals: LoopSignals;
  nudges: PredictiveNudge[];
  intervention: InterventionDecision;
  adviceMessages: RenderedAdviceMessage[];
  responseLatencyMs: number;
  assistantReaskRate: number;
  turnRetryDepth: number;
  responseLatencyBucket: string;
  midEpisodeNoveltyDrop: number;
  recentNudgeEffectiveness: number;
}

export interface EpisodeSummary {
  surrogateCost: number;
  filesRead: number;
  linesReadNorm: number;
  symbolRevisits: number;
  retryCount: number;
  failedVerifications: number;
  crossFileSpread: number;
  noChangeTurns: number;
  changedFilesCount: number;
  changedSymbolsCount: number;
  changedLinesCount: number;
  firstPassGreen: boolean;
  promptLengthBucket: string;
  structureScore: number;
  scopeBucket: string;
  explorationMode: string;
  attentionEntropy: number;
  attentionCompression: number;
  noveltyRatio: number;
  expectedCostConfidence: number;
  approvalCount: number;
  approvalBurst: number;
  toolErrorCount: number;
  toolRetryCount: number;
  toolFailureStreak: number;
  editFailureCount: number;
  recoveryAttempts: number;
  humanConfirmationBurst: number;
  frictionScore: number;
  stopAndReframeSignal: boolean;
  bestStopTurn: number | null;
  suggestedReframe: string | null;
  fixLoopOccurred: boolean;
  searchLoopOccurred: boolean;
  niceGuidanceAwarded: boolean;
  predictedLossRate: number | null;
  expAwarded: number;
  turnCount?: number;
  interventionMode?: InterventionDecisionMode;
}

export interface RunOptions {
  cwd: string;
  promptText?: string;
  promptFile?: string;
  cliOverride?: SupportedCli;
  testCommands: string[];
  command: string[];
}

export interface ProxyRunOptions {
  cwd: string;
  cli: SupportedCli;
  args: string[];
  mode: ProxyAdviceMode;
}

export interface TurnRecord {
  turnIndex: number;
  startedAt: string;
  finishedAt: string;
  promptProfile: PromptProfile;
  inputText: string;
  outputPreview: string;
  events: EpisodeEvent[];
}

export interface EpisodeArtifacts {
  promptProfile: PromptProfile;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  changedFiles: ChangedFile[];
  symbolSnapshotsBefore: Map<string, SymbolSnapshot[]>;
  symbolSnapshotsAfter: Map<string, SymbolSnapshot[]>;
  symbolChanges: SymbolChangeEvent[];
  complexity: EpisodeComplexity;
  score: ScoreBreakdown;
  nudges: PredictiveNudge[];
  loopSignals: LoopSignals;
  summary: EpisodeSummary;
  mascot?: MascotEpisodeUpdate | null;
  tokenEstimate: TokenCalibrationEstimate | null;
  usageObservations: UsageObservation[];
  events: EpisodeEvent[];
  turns?: TurnSummary[];
}

export interface StorageReport {
  dbPath: string;
  dbBytes: number;
  walBytes: number;
  totalBytes: number;
  activeEpisodeCount: number;
  archivedEpisodeCount: number;
  rowCounts: Record<string, number>;
  retention: RetentionPolicy;
  overLimit: boolean;
}

export interface StatsOverview {
  totalEpisodes: number;
  averageSurrogateCost: number;
  totalExp: number;
  activeEpisodeCount: number;
  archivedEpisodeCount: number;
  recentEpisodes: Array<Record<string, unknown>>;
}

export interface IssueIntakeSummary {
  number: number;
  title: string;
  url: string;
  labels: string[];
  objective: string | null;
  scope: string | null;
  outOfScope: string | null;
  acceptance: string | null;
  docsNeeded: string | null;
  reviewer: string | null;
  rawBody: string;
}

// ── v3.0 Gamification types ──

export type AdviceSignalKind =
  | "prompt_too_vague"
  | "same_file_revisit"
  | "same_function_revisit"
  | "scope_creep"
  | "no_success_criteria"
  | "approval_fatigue"
  | "error_spiral"
  | "retry_loop"
  | "good_structure"
  | "first_pass_success"
  | "improving_trend"
  | "long_session_no_commit"
  | "high_tool_ratio";

export interface AdviceSignal {
  kind: AdviceSignalKind;
  confidence: number;
  severity: NudgeSeverity;
  context: Record<string, unknown>;
}

export interface ActionableAdvice {
  signal: AdviceSignal;
  headline: string;
  detail: string;
  beforeExample?: string;
  afterExample?: string;
  category: NudgeCategory;
}

export type SessionGradeLetter = "S" | "A" | "B" | "C" | "D";

export interface SessionGradeResult {
  grade: SessionGradeLetter;
  promptScore: number;
  efficiencyScore: number;
  overallScore: number;
}

export interface Achievement {
  key: string;
  name: string;
  description: string;
  earnedAt: string;
  episodeId: number;
  bonusExp: number;
}

export interface AdviceConfig {
  vaguePromptThreshold: number;
  sameFileRevisitThreshold: number;
  scopeCreepFileThreshold: number;
  scopeCreepEntropyThreshold: number;
  showBeforeAfterExamples: boolean;
}

export interface LiveStatePayload {
  turns: number;
  /**
   * Count of "real" user messages — JSONL `type: "user"` entries whose
   * content includes at least one non-tool_result block (string content,
   * text blocks, image blocks, etc.). Tool-result responses (which the
   * Anthropic API wire-formats as user-type entries) do NOT increment
   * this counter. `turns` continues to track total user-type events for
   * backward compatibility.
   */
  userMessages?: number;
  toolCalls: number;
  advice: string;
  mood: MascotMood;
  avatar: string;
  nickname: string;
  bond: number;
  updatedAt: number;
  sessionGrade: SessionGradeLetter;
  promptScore: number;
  efficiencyScore: number;
  comboCount: number;
  adviceDetail: string;
  signalKind: AdviceSignalKind | "";
  beforeExample: string;
  afterExample: string;
  /** Last observed exit code of the wrapped CLI. null if it has not exited yet. */
  lastExitCode?: number | null;
  /** Last observed termination signal (e.g. "SIGTERM"). null if exit was clean. */
  lastExitSignal?: string | null;
  /** Epoch ms timestamp of the last exit observation. */
  lastExitAt?: number | null;
  /** Last subcommand observed (e.g. "review" for passthrough). */
  lastSubcommand?: string | null;
}
