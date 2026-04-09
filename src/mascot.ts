import fs from "node:fs";
import path from "node:path";
import { getGlobalEvoDir } from "./config";
import {
  EpisodeSummary,
  MascotEpisodeUpdate,
  MascotMood,
  MascotProfile,
  MascotRenderState,
  NudgeCategory,
  RenderedAdviceMessage,
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
  };
}

function ensureMascotDir(cwd: string): void {
  fs.mkdirSync(getGlobalEvoDir(cwd), { recursive: true });
}

function stageForExp(totalBondExp: number): MascotProfile["stage"] {
  let current = STAGE_THRESHOLDS[0].stage;
  for (const threshold of STAGE_THRESHOLDS) {
    if (totalBondExp >= threshold.minExp) current = threshold.stage;
  }
  return current;
}

function stageIndex(stage: MascotProfile["stage"]): number {
  return STAGE_THRESHOLDS.findIndex((item) => item.stage === stage);
}

function progressPercent(totalBondExp: number): number {
  const stage = stageForExp(totalBondExp);
  const index = stageIndex(stage);
  const current = STAGE_THRESHOLDS[index];
  const next = STAGE_THRESHOLDS[Math.min(index + 1, STAGE_THRESHOLDS.length - 1)];
  if (!next || next.stage === stage) return 100;
  const progress = (totalBondExp - current.minExp) / Math.max(1, next.minExp - current.minExp);
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
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
  ensureMascotDir(cwd);
  const filePath = mascotPath(cwd);
  if (!fs.existsSync(filePath)) {
    const profile = defaultMascot();
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
    return profile;
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MascotProfile>;
  const profile: MascotProfile = {
    ...defaultMascot(),
    ...parsed,
    lastMessages: parsed.lastMessages ?? [],
  };
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
  return profile;
}

export function saveMascotProfile(cwd: string, profile: MascotProfile): void {
  ensureMascotDir(cwd);
  fs.writeFileSync(mascotPath(cwd), JSON.stringify(profile, null, 2));
}

export function renderMascotState(profile: MascotProfile): MascotRenderState {
  const threshold = STAGE_THRESHOLDS.find((item) => item.stage === profile.stage) ?? STAGE_THRESHOLDS[0];
  const species = mascotSpecies(profile.speciesId);
  return {
    profile,
    progressPercent: progressPercent(profile.totalBondExp),
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

export function updateMascotAfterEpisode(cwd: string, summary: EpisodeSummary): MascotEpisodeUpdate {
  const previous = loadMascotProfile(cwd);
  const previousStage = previous.stage;
  const totalBondExp = previous.totalBondExp + summary.expAwarded;
  const nextStage = stageForExp(totalBondExp);
  const nextProfile: MascotProfile = {
    ...previous,
    totalBondExp,
    stage: nextStage,
    mood: pickMood(summary),
    favoriteHintStyle: favoriteHint(summary),
    streakDays: summary.firstPassGreen ? previous.streakDays + 1 : 0,
    lastSeenAt: new Date().toISOString(),
  };
  saveMascotProfile(cwd, nextProfile);

  return {
    speciesId: nextProfile.speciesId,
    previousStage,
    nextStage,
    gainedExp: summary.expAwarded,
    totalBondExp,
    progressPercent: progressPercent(totalBondExp),
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
  if (!message) return "いまは静かに見守り中";
  switch (message.category) {
    case "specificity":
      return "関数名か対象ファイルを1個足すと刺さりやすい";
    case "structure":
      return "やること / 完了条件 の2行でかなり通りやすくなる";
    case "verification":
      return "成功条件を1行足すとやり直しを削りやすい";
    case "exploration_focus":
      return "次は見るファイルを1つに絞ろう";
    case "recovery":
      return "現状 / 期待 / NG 条件 で切り直すと抜けやすい";
    case "praise":
      return "かなり気持ちよくハマってる";
    default:
      return message.text;
  }
}

export function renderMascotTurnLine(profile: MascotProfile, summary: TurnSummary): string {
  const state = renderMascotState(profile);
  const lead = summary.adviceMessages[0];
  const mood = currentTurnMood(profile, summary);
  const saving = Math.max(0, Math.round(Math.max(...summary.nudges.map((item) => item.predictedSavingRate), 0) * 100));
  const savingText =
    saving > 0
      ? `${saving}%浮きそう`
      : summary.loopSignals.editLoop || summary.loopSignals.searchLoop
        ? "迷子回避チャンス"
        : "じわっと育成中";
  const expText = `Bond ${state.progressPercent}%`;
  const prefix = colorize(`${state.avatar} ${profile.nickname}`, state.accentTone, true);
  const moodText = colorize(moodLabel(mood), mood === "worried" ? "warning" : mood === "proud" ? "success" : mood === "hyped" ? "accent" : "info");
  const action = colorize(categoryHint(lead), lead?.category === "recovery" ? "danger" : lead?.category === "praise" ? "success" : "accent");
  const savingLabel = colorize(savingText, saving >= 25 ? "accent" : saving > 0 ? "info" : "warning", true);
  const expLabel = dim(`+${Math.max(1, Math.round(summary.score.surrogateCost > 0 ? 4 : 1))} vibe | ${expText}`);

  return `${prefix} ${moodText} | ${action} | ${savingLabel} | ${expLabel}`;
}

export function renderMascotSpecialEvent(profile: MascotProfile, input: {
  message: RenderedAdviceMessage;
  summary: TurnSummary;
}): string {
  const state = renderMascotState(profile);
  const mood = currentTurnMood(profile, input.summary);
  const title =
    input.message.category === "recovery"
      ? "🛟 Evo Rescue"
      : input.message.category === "exploration_focus"
        ? "🧭 Evo Focus"
        : "⚡ Evo Chance";
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
      `${state.avatar} ${profile.nickname} | ${moodLabel(mood)} | Level ${state.level}`,
      categoryHint(input.message),
      saving > 0 ? `いまの節約見込み ${saving}% | Bond ${state.progressPercent}%` : `Bond ${state.progressPercent}% | 次の一手で流れを戻そう`,
    ],
  });
}

export function renderMascotLevelUp(profile: MascotProfile, update: MascotEpisodeUpdate): string {
  const state = renderMascotState(profile);
  const title = update.stageChanged ? "🎉 Level Up" : "🌟 Bond Up";
  const growthLabel = update.stageChanged ? `${update.previousStage} → ${update.nextStage}` : `${update.progressPercent}%まで成長`;
  return formatPanel({
    title,
    tone: update.stageChanged ? "magic" : "success",
    lines: [
      `${state.avatar} ${profile.nickname} が育ったよ`,
      `${growthLabel} | +${update.gainedExp} EXP | total ${update.totalBondExp}`,
      `気分: ${moodLabel(update.mood)} | Bond ${update.progressPercent}%`,
    ],
  });
}

export function formatMascotSpeciesList(): string {
  return MASCOT_SPECIES.map((item) => `${item.emoji} ${item.id} (${item.name})`).join("\n");
}
