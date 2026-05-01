import fs from "node:fs";
import path from "node:path";
import { getGlobalEvoDir } from "./config";
import { migrateMascotFromCwd } from "./mascotMigration";
import {
  EpisodeSummary,
  MascotEpisodeUpdate,
  MascotMood,
  MascotProfile,
  MascotRenderState,
  NudgeCategory,
  RecentEpisodeRecord,
  RenderedAdviceMessage,
  SupportedCli,
  TurnSummary,
} from "./types";
import { colorize, dim, formatPanel } from "./terminalUi";

const MASCOT_FILE = "mascot.json";

const STAGE_THRESHOLDS: Array<{ stage: MascotProfile["stage"]; minExp: number; tone: MascotRenderState["accentTone"] }> = [
  { stage: "egg", minExp: 0, tone: "info" },
  { stage: "sprout", minExp: 120, tone: "success" },
  { stage: "buddy", minExp: 320, tone: "accent" },
  { stage: "wizard", minExp: 720, tone: "magic" },
  { stage: "legend", minExp: 1400, tone: "magic" },
];

// v3.1: Stage progression now driven by Ideal State Gauge (quality), not
// cumulative totalBondExp. Cumulative EXP inflates indefinitely so users
// auto-promote to legend regardless of quality. ISG-based stages reflect
// current sustained prompt quality.
//
// ISG ranges: egg < 25 / sprout 25-45 / buddy 45-65 / wizard 65-82 / legend 82+
const ISG_STAGE_THRESHOLDS: Array<{ stage: MascotProfile["stage"]; minIsg: number; tone: MascotRenderState["accentTone"] }> = [
  { stage: "egg", minIsg: 0, tone: "info" },
  { stage: "sprout", minIsg: 25, tone: "success" },
  { stage: "buddy", minIsg: 45, tone: "accent" },
  { stage: "wizard", minIsg: 65, tone: "magic" },
  { stage: "legend", minIsg: 82, tone: "magic" },
];

export const MASCOT_SPECIES = [
  { id: "chick", emoji: "🐣", name: "ひよこ" },
  { id: "cat", emoji: "🐱", name: "ねこ" },
  { id: "dog", emoji: "🐶", name: "いぬ" },
  { id: "fox", emoji: "🦊", name: "きつね" },
  { id: "rabbit", emoji: "🐰", name: "うさぎ" },
  { id: "bear", emoji: "🐻", name: "くま" },
  { id: "panda", emoji: "🐼", name: "ぱんだ" },
  { id: "koala", emoji: "🐨", name: "こあら" },
  { id: "tiger", emoji: "🐯", name: "とら" },
  { id: "penguin", emoji: "🐧", name: "ぺんぎん" },
] as const;

export type MascotSpeciesId = (typeof MASCOT_SPECIES)[number]["id"];

function mascotPath(cwd: string): string {
  return path.join(getGlobalEvoDir(cwd), MASCOT_FILE);
}

function mascotSpecies(speciesId: string) {
  return MASCOT_SPECIES.find((item) => item.id === speciesId) ?? MASCOT_SPECIES[0];
}

function mascotSpeciesStrict(speciesId: string) {
  return MASCOT_SPECIES.find((item) => item.id === speciesId) ?? null;
}

const ISG_WINDOW = 20;

function defaultMascot(): MascotProfile {
  return {
    speciesId: "chick",
    nickname: "EvoPet",
    stage: "egg",
    totalBondExp: 0,
    mood: "sleepy",
    streakDays: 0,
    lastSeenAt: null,
    favoriteHintStyle: "none",
    lastMessages: [],
    comboCount: 0,
    bestCombo: 0,
    recentEpisodes: [],
  };
}

/**
 * Ideal State Gauge — quality-based 育成度.
 *
 * Replaces stage-EXP progressPercent with a rolling-window quality metric.
 * 100% only when prompt quality is sustained at ideal level. Returns -1 when
 * the window is empty (caller should treat as "no data" / 測定中).
 */
export function computeIdealStateGauge(profile: MascotProfile): number {
  const window = profile.recentEpisodes ?? [];
  if (window.length === 0) return -1;

  const avgPrompt = window.reduce((s, e) => s + e.promptScore, 0) / window.length;
  const avgStruct = window.reduce((s, e) => s + e.structureScore, 0) / window.length;
  const loopCount = window.filter((e) => e.hadFixLoop || e.hadSearchLoop).length;
  const loopRate = loopCount / window.length;
  const nscCount = window.filter((e) => e.signalKind === "no_success_criteria").length;
  const nscRate = nscCount / window.length;

  let streakA = 0;
  for (const ep of window) {
    if (ep.grade === "A") streakA++;
    else break;
  }

  const penaltyLoop = Math.min(30, loopRate * 100);
  const penaltyNsc = Math.min(20, nscRate * 60);
  const bonusStreak = Math.min(15, streakA * 3);

  let isg = avgPrompt + bonusStreak - penaltyLoop - penaltyNsc;
  isg = Math.max(0, Math.min(100, Math.round(isg)));

  // Gate: 100% only when ALL conditions met
  const last5 = window.slice(0, 5);
  const last5LoopFree = last5.every((e) => !e.hadFixLoop && !e.hadSearchLoop);
  const gateMet = avgPrompt >= 90 && avgStruct >= 4 && last5LoopFree;
  if (!gateMet) isg = Math.min(isg, 90);

  return isg;
}

export interface QualityMetrics {
  promptScore: number;
  sessionGrade: string;
  signalKind: string;
}

function appendRecentEpisode(
  profile: MascotProfile,
  summary: EpisodeSummary,
  metrics: QualityMetrics,
): void {
  const record: RecentEpisodeRecord = {
    promptScore: metrics.promptScore,
    structureScore: summary.structureScore ?? 0,
    grade: metrics.sessionGrade,
    hadFixLoop: !!summary.fixLoopOccurred,
    hadSearchLoop: !!summary.searchLoopOccurred,
    signalKind: metrics.signalKind,
    ts: Date.now(),
  };
  const existing = profile.recentEpisodes ?? [];
  profile.recentEpisodes = [record, ...existing].slice(0, ISG_WINDOW);
}

function ensureMascotDir(cwd: string): void {
  fs.mkdirSync(getGlobalEvoDir(cwd), { recursive: true });
}

// Legacy: stage by cumulative EXP. Kept for backward compat / data analysis;
// no longer wired into the live update path as of v3.1.
function stageForExp(totalBondExp: number): MascotProfile["stage"] {
  let current = STAGE_THRESHOLDS[0].stage;
  for (const threshold of STAGE_THRESHOLDS) {
    if (totalBondExp >= threshold.minExp) current = threshold.stage;
  }
  return current;
}

/**
 * v3.1 stage selector — driven by Ideal State Gauge.
 *
 * Returns "egg" when ISG is -1 (no recent-episode data) so new users start
 * at the bottom of the ladder until their prompt quality is measured.
 */
function stageForIsg(profile: MascotProfile): MascotProfile["stage"] {
  const isg = computeIdealStateGauge(profile);
  if (isg < 0) return "egg";
  let current = ISG_STAGE_THRESHOLDS[0].stage;
  for (const threshold of ISG_STAGE_THRESHOLDS) {
    if (isg >= threshold.minIsg) current = threshold.stage;
  }
  return current;
}

function stageIndex(stage: MascotProfile["stage"]): number {
  return STAGE_THRESHOLDS.findIndex((item) => item.stage === stage);
}

function progressPercent(profile: MascotProfile): number {
  return computeIdealStateGauge(profile);
}

function formatGauge(value: number): string {
  return value < 0 ? "測定中" : `${value}%`;
}

function pickMood(summary: EpisodeSummary): MascotMood {
  if (summary.fixLoopOccurred || summary.searchLoopOccurred) return "worried";
  if (summary.niceGuidanceAwarded) return "proud";
  if (summary.predictedLossRate !== null && summary.predictedLossRate >= 0.25) return "hyped";
  if (summary.retryCount === 0 && summary.firstPassGreen) return "happy";
  return "sleepy";
}

function favoriteHint(summary: EpisodeSummary): NudgeCategory | "none" {
  if (summary.fixLoopOccurred) return "recovery";
  if (summary.searchLoopOccurred) return "exploration_focus";
  if (summary.predictedLossRate !== null && summary.predictedLossRate >= 0.2) return "structure";
  if (summary.niceGuidanceAwarded) return "praise";
  return "none";
}

export function loadMascotProfile(cwd: string): MascotProfile {
  // v3.1: one-time migration from cwd-based .evo/ to ~/.claude/.evo/.
  // Sentinel file makes this a no-op after the first successful run.
  migrateMascotFromCwd(cwd);
  ensureMascotDir(cwd);
  const filePath = mascotPath(cwd);
  if (!fs.existsSync(filePath)) {
    const profile = defaultMascot();
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    return profile;
  }

  let parsed: Partial<MascotProfile> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MascotProfile>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evopet] mascot.json read/parse failed (${msg}); falling back to defaults\n`);
  }
  const profile: MascotProfile = {
    ...defaultMascot(),
    ...parsed,
    lastMessages: parsed.lastMessages ?? [],
    comboCount: parsed.comboCount ?? 0,
    bestCombo: parsed.bestCombo ?? 0,
    recentEpisodes: parsed.recentEpisodes ?? [],
  };
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
  return profile;
}

export function saveMascotProfile(cwd: string, profile: MascotProfile): void {
  ensureMascotDir(cwd);
  fs.writeFileSync(mascotPath(cwd), JSON.stringify(profile, null, 2));
}

export function renderMascotState(profile: MascotProfile): MascotRenderState {
  // v3.1: tone now sourced from ISG_STAGE_THRESHOLDS since stage itself is
  // ISG-driven. STAGE_THRESHOLDS is retained for backward compat only.
  const threshold =
    ISG_STAGE_THRESHOLDS.find((item) => item.stage === profile.stage) ??
    ISG_STAGE_THRESHOLDS[0];
  const species = mascotSpecies(profile.speciesId);
  return {
    profile,
    progressPercent: progressPercent(profile),
    level: stageIndex(profile.stage) + 1,
    avatar: species.emoji,
    accentTone: threshold.tone,
  };
}

export function listMascotSpecies(): Array<{ id: string; emoji: string; name: string }> {
  return [...MASCOT_SPECIES];
}

export function chooseMascotSpecies(cwd: string, speciesId: string): MascotProfile {
  const current = loadMascotProfile(cwd);
  const species = mascotSpeciesStrict(speciesId);
  if (!species) {
    throw new Error(`Unknown EvoPet species: ${speciesId}`);
  }
  const next = {
    ...current,
    speciesId: species.id,
  };
  saveMascotProfile(cwd, next);
  return next;
}

// Combo: good prompt = structureScore >= 3 AND firstPassGreen AND no loops
export function updateCombo(profile: MascotProfile, summary: EpisodeSummary): number {
  const isGood =
    summary.structureScore >= 3 &&
    summary.firstPassGreen &&
    !summary.fixLoopOccurred &&
    !summary.searchLoopOccurred;
  if (isGood) {
    profile.comboCount += 1;
    if (profile.comboCount > profile.bestCombo) {
      profile.bestCombo = profile.comboCount;
    }
  } else {
    profile.comboCount = 0;
  }
  return profile.comboCount;
}

// Skill-based EXP formula (v3.0)
export function computeSkillExp(summary: EpisodeSummary, comboCount: number, avgRecentStructureScore: number): number {
  // No EXP for empty sessions
  const hasActivity = (summary.turnCount ?? 0) > 0 ||
    summary.changedFilesCount > 0 ||
    summary.filesRead > 0;
  if (!hasActivity) return 0;

  let exp = 10; // base

  // Skill bonuses
  if (summary.structureScore >= 4) exp += 30;
  else if (summary.structureScore >= 3) exp += 15;

  if (summary.firstPassGreen && summary.retryCount === 0) exp += 25;

  if (summary.explorationMode === "direct" || summary.explorationMode === "balanced") exp += 15;

  if (!summary.fixLoopOccurred && !summary.searchLoopOccurred) exp += 10;

  // Skill penalties (floor at base 10)
  if (summary.structureScore < 2 && summary.changedFilesCount > 2) exp -= 10;
  if (summary.fixLoopOccurred) exp -= 15;
  else if (summary.searchLoopOccurred) exp -= 10;
  if (summary.explorationMode === "scattered") exp -= 10;

  exp = Math.max(10, exp);

  // Combo multiplier (max 2.0x at 10-combo)
  const comboMultiplier = 1.0 + Math.min(comboCount, 10) * 0.1;
  exp = Math.round(exp * comboMultiplier);

  // Improvement bonus
  if (summary.structureScore > avgRecentStructureScore) exp += 20;

  return exp;
}

export function updateMascotAfterEpisode(
  cwd: string,
  summary: EpisodeSummary,
  avgRecentStructureScore?: number,
  qualityMetrics?: QualityMetrics,
): MascotEpisodeUpdate {
  const previous = loadMascotProfile(cwd);
  const previousStage = previous.stage;

  // Update combo first (before EXP calculation uses it)
  updateCombo(previous, summary);

  // Compute skill-based EXP
  const expAwarded = computeSkillExp(summary, previous.comboCount, avgRecentStructureScore ?? 0);
  const totalBondExp = previous.totalBondExp + expAwarded;
  // v3.1: build the candidate profile WITHOUT a stage decision first; append
  // the new episode record, then derive stage from the resulting ISG. This
  // ensures the latest episode is reflected in the stage-relevant window.
  const nextProfile: MascotProfile = {
    ...previous,
    totalBondExp,
    stage: previous.stage, // placeholder — overwritten after ISG calc
    mood: pickMood(summary),
    favoriteHintStyle: favoriteHint(summary),
    streakDays: summary.firstPassGreen ? previous.streakDays + 1 : 0,
    lastSeenAt: new Date().toISOString(),
  };
  // Append rolling-window record for Ideal State Gauge BEFORE deriving stage.
  if (qualityMetrics) {
    appendRecentEpisode(nextProfile, summary, qualityMetrics);
  }
  const nextStage = stageForIsg(nextProfile);
  nextProfile.stage = nextStage;
  saveMascotProfile(cwd, nextProfile);

  return {
    speciesId: nextProfile.speciesId,
    previousStage,
    nextStage,
    gainedExp: expAwarded,
    totalBondExp,
    progressPercent: progressPercent(nextProfile),
    leveledUp: stageIndex(nextStage) > stageIndex(previousStage),
    stageChanged: previousStage !== nextStage,
    mood: nextProfile.mood,
  };
}

function moodLabel(mood: MascotMood): string {
  switch (mood) {
    case "happy":
      return "ごきげん";
    case "hyped":
      return "やる気MAX";
    case "worried":
      return "しんぱい";
    case "proud":
      return "どや顔";
    default:
      return "まったり";
  }
}

function currentTurnMood(profile: MascotProfile, summary: TurnSummary): MascotMood {
  if (summary.loopSignals.editLoop || summary.loopSignals.searchLoop) return "worried";
  if (summary.adviceMessages.some((item) => item.category === "praise")) return "proud";
  if (Math.max(...summary.nudges.map((item) => item.predictedSavingRate), 0) >= 0.25) return "hyped";
  if (summary.score.retryCount === 0) return "happy";
  return profile.mood;
}

function categoryHint(message: RenderedAdviceMessage | undefined): string {
  if (!message) return "指示を待ってるよ! ファイル名と「何をしたいか」を教えてね";
  switch (message.category) {
    case "specificity":
      return "ファイル名や関数名を1つ書くだけで、AIの無駄な探索が半分に減るよ! 例: 「直して」→「src/api.ts の getUser を修正して」";
    case "structure":
      return "箇条書きで「1.やること 2.完了条件」を書くと、AIが見落としにくくなるよ!";
    case "verification":
      return "「○○が通ればOK」を1行足すだけで、AIが余計なことをしなくなるよ! 例: 「テストが全部通ること」";
    case "exploration_focus":
      return "変更対象のファイルを1つに絞って指示すると、AIが迷わず集中できるよ! 「まずこのファイルだけ」って言ってみて";
    case "recovery":
      return "うまくいかない時は「現状: ○○が起きる / 期待: ○○になるべき / NG: ○○は変えない」で整理してみて!";
    case "praise":
      return "いまの指示の出し方、すごく上手! 具体的で構造化されてるから、AIがスムーズに動けてるよ!";
    default:
      return message.text;
  }
}

export function renderMascotTurnLine(profile: MascotProfile, summary: TurnSummary): string {
  const state = renderMascotState(profile);
  const lead = summary.adviceMessages[0];
  const mood = currentTurnMood(profile, summary);
  const saving = Math.max(0, Math.round(Math.max(...summary.nudges.map((item) => item.predictedSavingRate), 0) * 100));
  const prefix = colorize(`${state.avatar} ${profile.nickname}`, state.accentTone, true);

  // Mood-toned prefix for the advice headline
  const moodPrefix = mood === "worried" ? "あわわ、" : mood === "proud" ? "えへへ、" : mood === "hyped" ? "おっ、" : "";
  const action = colorize(
    `${moodPrefix}${categoryHint(lead)}`,
    lead?.category === "recovery" ? "danger" : lead?.category === "praise" ? "success" : "accent",
  );

  // Human-readable saving estimate
  const savingText =
    saving >= 25
      ? `指示を改善すると ${saving}% くらいトークン節約できそう!`
      : saving > 0
        ? `あと少し具体的にすると効率アップできるよ`
        : summary.loopSignals.editLoop || summary.loopSignals.searchLoop
          ? "同じ修正を繰り返してるかも — 指示を整理してみよう"
          : "順調に進んでるよ!";
  const savingLabel = colorize(savingText, saving >= 25 ? "accent" : saving > 0 ? "info" : summary.loopSignals.editLoop ? "warning" : "success");

  // Combo in human-readable form
  const comboText = profile.comboCount >= 3 ? colorize(` | ${profile.comboCount}連続いい感じ!`, "accent", true) : "";

  // Bond as 育成度
  const expLabel = dim(`育成度 ${formatGauge(state.progressPercent)}`);

  return `${prefix} ${action} | ${savingLabel}${comboText} | ${expLabel}`;
}

export function renderMascotStartupLine(profile: MascotProfile, cli: SupportedCli, lightweightTracking: boolean): string {
  // cli is currently always "claude" — the parameter is retained so future CLI
  // families (if any) can be swapped in without churning callers.
  void cli;
  const state = renderMascotState(profile);
  const prefix = colorize(`${state.avatar} ${profile.nickname}`, state.accentTone, true);
  const stageLabel = stageSkillLabel(profile.stage);
  const action = colorize(
    "いっしょに見守るよ! 指示の出し方のコツを教えてあげるね",
    "accent",
  );
  const status = colorize(lightweightTracking ? "軽量モード" : "記録中", lightweightTracking ? "warning" : "success", true);
  const combo = profile.comboCount > 0 ? colorize(` | 前回 ${profile.comboCount}連続いい指示!`, "accent", true) : "";
  const bond = dim(`${stageLabel} | 育成度 ${formatGauge(state.progressPercent)}`);
  return `${prefix} ${action} | ${status}${combo} | ${bond}`;
}

function stageSkillLabel(stage: MascotProfile["stage"]): string {
  switch (stage) {
    case "egg": return "初心者";
    case "sprout": return "見習い";
    case "buddy": return "実践者";
    case "wizard": return "熟練者";
    case "legend": return "達人";
  }
}

export function renderMascotSpecialEvent(profile: MascotProfile, input: {
  message: RenderedAdviceMessage;
  summary: TurnSummary;
}): string {
  const state = renderMascotState(profile);
  const title =
    input.message.category === "recovery"
      ? "🛟 指示の見直しポイント"
      : input.message.category === "exploration_focus"
        ? "🧭 対象を絞ろう"
        : "⚡ 改善チャンス!";
  const tone =
    input.message.category === "recovery"
      ? "danger"
      : input.message.category === "exploration_focus"
        ? "warning"
        : "accent";
  const saving = Math.max(0, Math.round(Math.max(...input.summary.nudges.map((item) => item.predictedSavingRate), 0) * 100));

  return formatPanel({
    title,
    tone,
    lines: [
      `${state.avatar} ${profile.nickname} | ${stageSkillLabel(profile.stage)} | 育成度 ${formatGauge(state.progressPercent)}`,
      categoryHint(input.message),
      saving > 0
        ? `指示を改善すると ${saving}% くらいトークン節約できそう!`
        : "指示の書き方を少し変えるだけで、AIの動きが変わるよ!",
    ],
  });
}

function stageUpMessage(prev: MascotProfile["stage"], next: MascotProfile["stage"]): string {
  switch (next) {
    case "sprout": return "ファイル名を使い始めたね! 見習い昇格!";
    case "buddy": return "構造化と完了条件が身についた! 実践者昇格!";
    case "wizard": return "一発成功率が高い! 熟練者昇格!";
    case "legend": return "安定したコンボ — 達人の境地!";
    default: return `${prev} → ${next}`;
  }
}

export function comboMilestoneMessage(comboCount: number): string | null {
  if (comboCount === 3) return "やるじゃん! 3連続! いい感じ!";
  if (comboCount === 5) return "すごい! 5連コンボ! この調子!";
  if (comboCount === 10) return "10連コンボ!! 達人の域だよ!";
  if (comboCount === 20) return "20連コンボ!!! 伝説級!!!";
  return null;
}

export function renderMascotLevelUp(profile: MascotProfile, update: MascotEpisodeUpdate): string {
  const state = renderMascotState(profile);
  const title = update.stageChanged ? "🎉 ランクアップ!" : "🌟 成長!";
  const growthLabel = update.stageChanged
    ? stageUpMessage(update.previousStage, update.nextStage)
    : `育成度 ${formatGauge(update.progressPercent)} まで成長!`;
  const comboInfo = profile.comboCount >= 3 ? ` | ${profile.comboCount}連続いい指示!` : "";
  return formatPanel({
    title,
    tone: update.stageChanged ? "magic" : "success",
    lines: [
      `${state.avatar} ${profile.nickname} が育ったよ!`,
      `${growthLabel}`,
      `+${update.gainedExp} 経験値 | 累計 ${update.totalBondExp} | 育成度 ${formatGauge(update.progressPercent)}${comboInfo}`,
    ],
  });
}

export function formatMascotSpeciesList(): string {
  return MASCOT_SPECIES.map((item) => `${item.emoji} ${item.id} (${item.name})`).join("\n");
}
