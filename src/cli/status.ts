/**
 * `evo status` — read-only one-screen composite status view.
 *
 * Combines, in one render:
 *   (a) EvoPet identity / stage / 育成度 gauge (mascot data)
 *   (b) current quality gauge + streak / combo
 *   (c) current session binding info when a live-state file is present in cwd
 *   (d) doctor quick summary (reuses the quick self-check from src/health.ts)
 *   (e) recent-episode summary from the local database
 *
 * STRICTLY READ-ONLY: this command must never create or modify any state.
 * That is why it deliberately does NOT use `loadMascotProfile` (which writes a
 * default mascot.json / re-normalizes the file on every read) nor `EvoDatabase`
 * (whose constructor creates `.evo/`, config.json and the database file, and
 * runs schema migrations). Instead it does tolerant, best-effort reads:
 *   - mascot.json is read with plain fs + JSON.parse, merged over defaults;
 *   - the episode DB is opened with better-sqlite3 `readonly` +
 *     `fileMustExist` ONLY when the file already exists;
 *   - live-state JSON files are read with a tolerant safe-read.
 * Every section degrades to a "no data" line instead of throwing.
 *
 * `--watch` re-renders every N seconds (default 5) until Ctrl+C — the 常設
 * (persistent) mode.
 */

import fs from "node:fs";
import path from "node:path";

import { getGlobalEvoDir } from "../config";
import { quickHealthReport, HealthReport } from "../health";
import { computeIdealStateGauge, renderMascotState } from "../mascot";
import { colorize, dim, formatPanel } from "../terminalUi";
import { MascotProfile, RecentEpisodeRecord } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusPetSection {
  /** false when mascot.json does not exist (nothing recorded yet). */
  present: boolean;
  avatar: string;
  nickname: string;
  speciesId: string;
  stage: MascotProfile["stage"];
  stageLabel: string;
  /** Ideal State Gauge 0..100, or -1 = no data (測定中). */
  gauge: number;
  mood: MascotProfile["mood"];
  streakDays: number;
  comboCount: number;
  bestCombo: number;
  totalBondExp: number;
  /** Most recent finalized episode grade from the rolling window, if any. */
  lastGrade: string | null;
  /** Rolling-window size backing the gauge (0..20). */
  windowSize: number;
}

export interface StatusSessionSection {
  /** false when no live-state file was found in cwd. */
  present: boolean;
  /** Path of the freshest live-state file that was read (for display). */
  source: string | null;
  /** Milliseconds since the live-state was last updated (null if unknown). */
  ageMs: number | null;
  /** Heuristic: updated within the last 15s → an active proxy session. */
  fresh: boolean;
  sessionGrade: string | null;
  promptScore: number | null;
  turns: number | null;
  userMessages: number | null;
  idealStateGauge: number | null;
  lastExitCode: number | null;
}

export interface StatusDoctorSection {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface StatusEpisodesSection {
  /** false when the DB file does not exist or could not be read. */
  available: boolean;
  /** Why unavailable (dim diagnostic), when available=false. */
  detail: string | null;
  episodeCount: number;
  archivedCount: number;
  /** ISO timestamp of the most recent episode, or null. */
  lastStartedAt: string | null;
}

export interface StatusData {
  cwd: string;
  generatedAt: number;
  pet: StatusPetSection;
  session: StatusSessionSection;
  doctor: StatusDoctorSection;
  episodes: StatusEpisodesSection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tolerant readers (no writes anywhere)
// ─────────────────────────────────────────────────────────────────────────────

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** In-memory default profile — mirrors mascot.ts defaultMascot() (read-only twin). */
function defaultProfile(): MascotProfile {
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

/** Japanese skill label per stage — mirrors mascot.ts stageSkillLabel. */
export function stageLabelJa(stage: MascotProfile["stage"]): string {
  switch (stage) {
    case "egg": return "初心者";
    case "sprout": return "見習い";
    case "buddy": return "実践者";
    case "wizard": return "熟練者";
    case "legend": return "達人";
  }
}

function collectPet(cwd: string): StatusPetSection {
  const mascotFile = path.join(getGlobalEvoDir(cwd), "mascot.json");
  const parsed = fs.existsSync(mascotFile)
    ? safeReadJson<Partial<MascotProfile>>(mascotFile)
    : null;
  const profile: MascotProfile = {
    ...defaultProfile(),
    ...(parsed ?? {}),
    lastMessages: parsed?.lastMessages ?? [],
    recentEpisodes: parsed?.recentEpisodes ?? [],
  };
  const state = renderMascotState(profile);
  const window: RecentEpisodeRecord[] = profile.recentEpisodes ?? [];
  return {
    present: parsed !== null,
    avatar: state.avatar,
    nickname: profile.nickname,
    speciesId: profile.speciesId,
    stage: profile.stage,
    stageLabel: stageLabelJa(profile.stage),
    gauge: computeIdealStateGauge(profile),
    mood: profile.mood,
    streakDays: profile.streakDays,
    comboCount: profile.comboCount,
    bestCombo: profile.bestCombo,
    totalBondExp: profile.totalBondExp,
    lastGrade: window.length > 0 ? window[0].grade || null : null,
    windowSize: window.length,
  };
}

interface LiveStateShape {
  updatedAt?: unknown;
  sessionGrade?: unknown;
  promptScore?: unknown;
  turns?: unknown;
  userMessages?: unknown;
  idealStateGauge?: unknown;
  lastExitCode?: unknown;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Freshness window for "稼働中": generous vs the statusline's 10s (heartbeat ~10s). */
const SESSION_FRESH_MS = 15_000;

/**
 * Find the freshest live-state file in this cwd: every per-session file under
 * `.evo/sessions/*.json` plus the legacy shared `.evo/live-state.json`.
 * Plain tolerant JSON reads only — no imports from proxy modules.
 */
function collectSession(cwd: string, now: number): StatusSessionSection {
  const empty: StatusSessionSection = {
    present: false,
    source: null,
    ageMs: null,
    fresh: false,
    sessionGrade: null,
    promptScore: null,
    turns: null,
    userMessages: null,
    idealStateGauge: null,
    lastExitCode: null,
  };

  const candidates: string[] = [];
  const sessionsDir = path.join(cwd, ".evo", "sessions");
  try {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (name.endsWith(".json")) candidates.push(path.join(sessionsDir, name));
    }
  } catch {
    // no sessions dir — fine
  }
  candidates.push(path.join(cwd, ".evo", "live-state.json"));

  let best: { file: string; data: LiveStateShape; updatedAt: number } | null = null;
  for (const file of candidates) {
    const data = safeReadJson<LiveStateShape>(file);
    if (!data) continue;
    const updatedAt = asFiniteNumber(data.updatedAt) ?? 0;
    if (!best || updatedAt > best.updatedAt) best = { file, data, updatedAt };
  }
  if (!best) return empty;

  const ageMs = best.updatedAt > 0 ? Math.max(0, now - best.updatedAt) : null;
  const grade = typeof best.data.sessionGrade === "string" && best.data.sessionGrade
    ? best.data.sessionGrade
    : null;
  return {
    present: true,
    source: best.file,
    ageMs,
    fresh: ageMs !== null && ageMs < SESSION_FRESH_MS,
    sessionGrade: grade,
    promptScore: asFiniteNumber(best.data.promptScore),
    turns: asFiniteNumber(best.data.turns),
    userMessages: asFiniteNumber(best.data.userMessages),
    idealStateGauge: asFiniteNumber(best.data.idealStateGauge),
    lastExitCode: asFiniteNumber(best.data.lastExitCode),
  };
}

/**
 * Read-only episode summary. Opens the DB with `readonly` + `fileMustExist`
 * ONLY when `.evo/evolutionary.db` already exists; never creates `.evo/`, the
 * config, or the DB (EvoDatabase's constructor does all three, which is why it
 * is not used here). Any failure degrades to `available:false` with a detail.
 */
function collectEpisodes(cwd: string): StatusEpisodesSection {
  const dbPath = path.join(cwd, ".evo", "evolutionary.db");
  if (!fs.existsSync(dbPath)) {
    return {
      available: false,
      detail: "まだ記録がありません (.evo/evolutionary.db なし)",
      episodeCount: 0,
      archivedCount: 0,
      lastStartedAt: null,
    };
  }
  try {
    // Lazy require mirrors src/db.ts: a broken native must not crash `evo status`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const main = db
        .prepare("SELECT COUNT(*) AS count, MAX(started_at) AS last FROM episodes")
        .get() as { count: number; last: string | null };
      let archived = 0;
      try {
        archived = (db.prepare("SELECT COUNT(*) AS count FROM archived_episodes").get() as { count: number }).count;
      } catch {
        // older schema without archived_episodes — treat as 0
      }
      return {
        available: true,
        detail: null,
        episodeCount: main.count + archived,
        archivedCount: archived,
        lastStartedAt: main.last ?? null,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return {
      available: false,
      detail: `DB読み取り不可: ${message}`,
      episodeCount: 0,
      archivedCount: 0,
      lastStartedAt: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly + rendering (pure; testable without a TTY)
// ─────────────────────────────────────────────────────────────────────────────

export function collectStatusData(
  cwd: string,
  deps?: { health?: () => HealthReport; now?: () => number },
): StatusData {
  const now = deps?.now ? deps.now() : Date.now();
  const health = deps?.health ? deps.health() : quickHealthReport();
  return {
    cwd,
    generatedAt: now,
    pet: collectPet(cwd),
    session: collectSession(cwd, now),
    doctor: { ok: health.ok, checks: health.checks },
    episodes: collectEpisodes(cwd),
  };
}

function gaugeLabel(value: number | null): string {
  if (value === null || value < 0) return "測定中";
  return `${value}%`;
}

function moodLabelJa(mood: MascotProfile["mood"]): string {
  switch (mood) {
    case "happy": return "ごきげん";
    case "hyped": return "やる気MAX";
    case "worried": return "しんぱい";
    case "proud": return "どや顔";
    default: return "まったり";
  }
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "更新時刻不明";
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}秒前に更新`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前に更新`;
  const h = Math.round(m / 60);
  return `${h}時間前に更新`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "なし";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderStatus(data: StatusData): string {
  const blocks: string[] = [];

  // (a)+(b) EvoPet identity / stage / gauge / streak
  const pet = data.pet;
  const petLines = [
    `${pet.avatar} ${pet.nickname} | ${pet.stageLabel} (${pet.stage}) | 育成度 ${gaugeLabel(pet.gauge)}`,
    `きぶん: ${moodLabelJa(pet.mood)} | 連続いい指示 ${pet.streakDays}日 | コンボ ${pet.comboCount} (最高 ${pet.bestCombo})`,
    `累計 ${pet.totalBondExp} EXP | 品質ウィンドウ ${pet.windowSize}件` +
      (pet.lastGrade ? ` | 直近グレード ${pet.lastGrade}` : ""),
  ];
  if (!pet.present) {
    petLines.push(dim("まだ記録がありません — claude を使うと育ちはじめます"));
  }
  blocks.push(formatPanel({ title: "🐾 EvoPet ステータス", tone: "accent", lines: petLines }));

  // (c) session binding
  const ses = data.session;
  const sesLines: string[] = [];
  if (!ses.present) {
    sesLines.push(dim("このフォルダにライブセッションはありません"));
  } else {
    const stateLabel = ses.fresh
      ? colorize("稼働中", "success", true)
      : dim("停止中 (古いデータ)");
    sesLines.push(`${stateLabel} | ${formatAge(ses.ageMs)}`);
    const bits: string[] = [];
    if (ses.sessionGrade) bits.push(`グレード ${ses.sessionGrade}`);
    if (ses.promptScore !== null) bits.push(`指示の質 ${ses.promptScore}`);
    if (ses.turns !== null) bits.push(`ターン ${ses.turns}`);
    if (ses.userMessages !== null) bits.push(`発話 ${ses.userMessages}回`);
    if (ses.idealStateGauge !== null) bits.push(`育成度 ${gaugeLabel(ses.idealStateGauge)}`);
    if (bits.length > 0) sesLines.push(bits.join(" | "));
    if (ses.lastExitCode !== null) sesLines.push(dim(`直前の終了コード: ${ses.lastExitCode}`));
  }
  blocks.push(formatPanel({ title: "📡 セッション", tone: ses.fresh ? "success" : "info", lines: sesLines }));

  // (d) doctor quick summary
  const doc = data.doctor;
  const docLines: string[] = [];
  if (doc.ok) {
    docLines.push(colorize(`すべて正常 (${doc.checks.length}項目)`, "success"));
  } else {
    for (const check of doc.checks) {
      docLines.push(
        check.ok
          ? `✅ ${check.name}`
          : colorize(`⚠ ${check.name}: ${check.detail ?? "failed"}`, "warning"),
      );
    }
    docLines.push(dim("詳細は `evo doctor` で確認できます"));
  }
  blocks.push(formatPanel({ title: "🩺 クイック診断", tone: doc.ok ? "success" : "warning", lines: docLines }));

  // (e) episode history
  const ep = data.episodes;
  const epLines: string[] = [];
  if (!ep.available) {
    epLines.push(dim(ep.detail ?? "まだ記録がありません"));
  } else {
    epLines.push(
      `記録 ${ep.episodeCount}件` +
        (ep.archivedCount > 0 ? ` (うちアーカイブ ${ep.archivedCount}件)` : "") +
        ` | 最終記録 ${formatTimestamp(ep.lastStartedAt)}`,
    );
    if (pet.lastGrade) {
      epLines.push(`直近エピソードのグレード: ${pet.lastGrade}`);
    }
    epLines.push(dim("履歴の一覧は `evo stats` で確認できます"));
  }
  blocks.push(formatPanel({ title: "📚 エピソード履歴", tone: "info", lines: epLines }));

  return blocks.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Command entry
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusCommandOptions {
  cwd: string;
  watch?: boolean;
  /** Seconds between renders in --watch mode (default 5, min 1). */
  interval?: number;
}

function renderOnce(cwd: string): string {
  return renderStatus(collectStatusData(cwd));
}

export async function runStatusCommand(options: StatusCommandOptions): Promise<void> {
  const cwd = path.resolve(options.cwd || process.cwd());

  if (!options.watch) {
    process.stdout.write(renderOnce(cwd) + "\n");
    return;
  }

  const rawInterval = options.interval ?? 5;
  if (!Number.isFinite(rawInterval) || rawInterval < 1) {
    process.stderr.write("--interval must be a number of seconds >= 1\n");
    process.exitCode = 1;
    return;
  }
  const intervalMs = Math.round(rawInterval * 1000);

  const paint = () => {
    // Clear screen + home cursor, then render a fresh frame.
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(renderOnce(cwd) + "\n");
    process.stdout.write(
      dim(`(${new Date().toLocaleTimeString()} 更新 — ${rawInterval}秒ごとに再表示 / Ctrl+C で終了)`) + "\n",
    );
  };

  paint();
  // Keep re-rendering until Ctrl+C (SIGINT default behavior terminates us).
  await new Promise<void>((resolve) => {
    const timer = setInterval(paint, intervalMs);
    const stop = () => {
      clearInterval(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
