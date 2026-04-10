import type Database from "better-sqlite3";
import {
  Achievement,
  EpisodeSummary,
  MascotProfile,
  SessionGradeResult,
} from "./types";

// ── Achievement definitions ──

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
  bonusExp: number;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  {
    key: "first_structure",
    name: "初めての構造化",
    description: "構造スコア3以上のプロンプトを初めて書いた",
    bonusExp: 50,
  },
  {
    key: "file_ref_habit",
    name: "ファイル名マスター",
    description: "ファイル参照を含むプロンプトを5回連続で書いた",
    bonusExp: 80,
  },
  {
    key: "combo_3",
    name: "3連コンボ",
    description: "良いプロンプトを3連続で達成した",
    bonusExp: 30,
  },
  {
    key: "combo_5",
    name: "5連コンボ",
    description: "良いプロンプトを5連続で達成した",
    bonusExp: 50,
  },
  {
    key: "combo_10",
    name: "10連コンボ",
    description: "良いプロンプトを10連続で達成した",
    bonusExp: 100,
  },
  {
    key: "first_pass_5",
    name: "一発成功の達人",
    description: "一発成功を5回連続で達成した",
    bonusExp: 100,
  },
  {
    key: "no_loops_10",
    name: "ループ回避の名手",
    description: "ループなしで10エピソードを完了した",
    bonusExp: 80,
  },
  {
    key: "grade_a",
    name: "Aランク到達",
    description: "セッショングレードAを初めて達成した",
    bonusExp: 100,
  },
  {
    key: "grade_s",
    name: "Sランク到達",
    description: "セッショングレードSを初めて達成した",
    bonusExp: 200,
  },
  {
    key: "recovery_master",
    name: "立て直しの達人",
    description: "ループ検出後、次のターンでループなしに復帰した",
    bonusExp: 60,
  },
  {
    key: "acceptance_habit",
    name: "完了条件マスター",
    description: "完了条件を含むプロンプトを10回書いた",
    bonusExp: 80,
  },
];

// ── DB operations ──

export function ensureAchievementsTable(db: Database.Database): void {
  db.exec(`
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

export function getEarnedAchievementKeys(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT key FROM achievements").all() as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key));
}

export function saveAchievement(
  db: Database.Database,
  achievement: Achievement,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO achievements (key, name, description, earned_at, episode_id, bonus_exp)
    VALUES (@key, @name, @description, @earnedAt, @episodeId, @bonusExp)
  `).run({
    key: achievement.key,
    name: achievement.name,
    description: achievement.description,
    earnedAt: achievement.earnedAt,
    episodeId: achievement.episodeId,
    bonusExp: achievement.bonusExp,
  });
}

export function getAllAchievements(db: Database.Database): Achievement[] {
  return db.prepare("SELECT key, name, description, earned_at AS earnedAt, episode_id AS episodeId, bonus_exp AS bonusExp FROM achievements ORDER BY earned_at").all() as Achievement[];
}

// ── Achievement checking ──

export function checkAchievements(input: {
  db: Database.Database;
  summary: EpisodeSummary;
  mascot: MascotProfile;
  grade: SessionGradeResult;
  episodeId: number;
  previousLoopOccurred: boolean;
}): Achievement[] {
  const earned = getEarnedAchievementKeys(input.db);
  const newly: Achievement[] = [];
  const now = new Date().toISOString();

  function tryAward(key: string): boolean {
    if (earned.has(key)) return false;
    const def = ACHIEVEMENT_DEFS.find((d) => d.key === key);
    if (!def) return false;
    const achievement: Achievement = {
      key: def.key,
      name: def.name,
      description: def.description,
      earnedAt: now,
      episodeId: input.episodeId,
      bonusExp: def.bonusExp,
    };
    saveAchievement(input.db, achievement);
    newly.push(achievement);
    return true;
  }

  // first_structure
  if (input.summary.structureScore >= 3) {
    tryAward("first_structure");
  }

  // combo milestones
  if (input.mascot.comboCount >= 3) tryAward("combo_3");
  if (input.mascot.comboCount >= 5) tryAward("combo_5");
  if (input.mascot.comboCount >= 10) tryAward("combo_10");

  // first_pass_5 (streak check via mascot.streakDays — repurposed for first-pass streak)
  if (input.summary.firstPassGreen && input.mascot.streakDays >= 5) {
    tryAward("first_pass_5");
  }

  // grade achievements
  if (input.grade.grade === "A" || input.grade.grade === "S") {
    tryAward("grade_a");
  }
  if (input.grade.grade === "S") {
    tryAward("grade_s");
  }

  // recovery_master: previous episode had loop, this one doesn't
  if (
    input.previousLoopOccurred &&
    !input.summary.fixLoopOccurred &&
    !input.summary.searchLoopOccurred
  ) {
    tryAward("recovery_master");
  }

  // no_loops_10: check consecutive episodes without loops
  const recentLoopFree = countRecentLoopFreeEpisodes(input.db);
  if (recentLoopFree >= 10) {
    tryAward("no_loops_10");
  }

  // acceptance_habit: count episodes with acceptance ref
  const acceptanceCount = countAcceptanceEpisodes(input.db);
  if (acceptanceCount >= 10) {
    tryAward("acceptance_habit");
  }

  // file_ref_habit: check recent consecutive file-ref prompts
  const fileRefStreak = countRecentFileRefStreak(input.db);
  if (fileRefStreak >= 5) {
    tryAward("file_ref_habit");
  }

  return newly;
}

function countRecentLoopFreeEpisodes(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT fix_loop_occurred, search_loop_occurred
    FROM episode_summaries
    ORDER BY episode_id DESC
    LIMIT 10
  `).all() as Array<{ fix_loop_occurred: number; search_loop_occurred: number }>;

  let count = 0;
  for (const row of rows) {
    if (row.fix_loop_occurred || row.search_loop_occurred) break;
    count++;
  }
  return count;
}

function countAcceptanceEpisodes(db: Database.Database): number {
  const result = db.prepare(`
    SELECT COUNT(*) AS cnt FROM prompt_profiles WHERE has_acceptance_ref = 1
  `).get() as { cnt: number } | undefined;
  return result?.cnt ?? 0;
}

function countRecentFileRefStreak(db: Database.Database): number {
  const rows = db.prepare(`
    SELECT has_file_refs FROM prompt_profiles ORDER BY episode_id DESC LIMIT 10
  `).all() as Array<{ has_file_refs: number }>;

  let count = 0;
  for (const row of rows) {
    if (!row.has_file_refs) break;
    count++;
  }
  return count;
}

// ── Rendering ──

export function renderAchievementCelebration(achievement: Achievement, avatar: string, nickname: string): string {
  return [
    `┌─ 🏆 Achievement Unlocked ──────────────`,
    `│ ${avatar} ${nickname} が「${achievement.name}」を獲得!`,
    `│ ${achievement.description}`,
    `│ +${achievement.bonusExp} ボーナスEXP`,
    `└─────────────────────────────────────────`,
  ].join("\n");
}
