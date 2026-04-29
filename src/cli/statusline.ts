/**
 * `evo statusline` — render the EvoPet portion of the Claude Code statusline.
 *
 * Reads Claude Code's statusline JSON from stdin, resolves the persisted
 * display mode (~/.claude/.evo-display-mode), and writes 0..N lines of
 * EvoPet content to stdout. NEVER emits the token/model/cwd line — that
 * is ClaudeConfig's `base_statusline.py` job.
 *
 * Ported from ~/.claude/base_statusline.py (the EvoPet rendering portion).
 * Behavior preserved byte-for-byte where reasonable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readCurrentMode } from "./display";
import {
  ANSI,
  BOOST_MESSAGES,
  SEP,
  TIPS,
  gradeColor,
  gradeContradicts,
  gradeLabel,
  pickMoodPool,
} from "./statusline-data";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StatuslineInput {
  cwd?: unknown;
  workspace?: { current_dir?: unknown } | unknown;
  context_window?: { used_percentage?: unknown } | unknown;
  session_id?: unknown;
  sessionId?: unknown;
  // model/rate_limits exist but are not used by EvoPet rendering
  [k: string]: unknown;
}

interface ProxyData {
  avatar?: string | null;
  nickname?: string | null;
  turns?: number | null;
  userMessages?: number | null;
  bond?: number | null;
  idealStateGauge?: number | null;
  comboCount?: number | null;
  sessionGrade?: string | null;
  promptScore?: number | null;
  signalKind?: string | null;
  advice?: string | null;
  adviceDetail?: string | null;
  beforeExample?: string | null;
  afterExample?: string | null;
  updatedAt?: number;
  [k: string]: unknown;
}

interface SelfState {
  start?: number;
  calls?: number;
  tip_idx?: number;
  cwd?: string;
  session_id?: string;
  ctx_pct?: number;
  last?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeReadJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch {
    // Best-effort
  }
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function asNumberOr<T>(v: unknown, fallback: T): number | T {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export async function runStatuslineCommand(): Promise<void> {
  // Parse stdin JSON. Tolerate missing/malformed input — never throw.
  let data: StatuslineInput = {};
  const raw = readStdinSync();
  if (raw.trim()) {
    try {
      data = JSON.parse(raw) as StatuslineInput;
    } catch {
      data = {};
    }
  }

  // Resolve cwd (preferred → workspace.current_dir → process.cwd()).
  let cwd =
    asString((data as Record<string, unknown>).cwd) ||
    (() => {
      const ws = (data as { workspace?: { current_dir?: unknown } }).workspace;
      return ws && typeof ws === "object" ? asString(ws.current_dir) : "";
    })() ||
    process.cwd();

  // Context percentage (used for mood pool + session-reset detection).
  let ctx: number | null = null;
  const cw = (data as { context_window?: { used_percentage?: unknown } })
    .context_window;
  if (cw && typeof cw === "object") {
    const v = cw.used_percentage;
    if (typeof v === "number" && Number.isFinite(v)) ctx = v;
  }

  const sessionId =
    asString((data as Record<string, unknown>).session_id) ||
    asString((data as Record<string, unknown>).sessionId);

  // ── Display mode ──
  const displayMode = readCurrentMode();

  // ── Self-tracked state (~/.claude/.evo-self-state.json) ──
  const selfStateFile = path.join(
    os.homedir(),
    ".claude",
    ".evo-self-state.json",
  );
  const loadedSelf = safeReadJson<SelfState>(selfStateFile) ?? {};
  // Python uses time.time() (seconds, float). We use seconds as float too.
  const nowS = Date.now() / 1000;
  const nowMs = Date.now();
  const currCtx = ctx ?? 0;
  const prevCtx = asNumberOr(loadedSelf.ctx_pct, 0) as number;
  const prevCwd = asString(loadedSelf.cwd);
  const sessionReset =
    (prevCtx > 30 && currCtx < 5) ||
    (prevCwd !== "" && prevCwd !== cwd);

  let selfState: SelfState;
  if (
    !loadedSelf ||
    Object.keys(loadedSelf).length === 0 ||
    sessionReset
  ) {
    selfState = {
      start: nowS,
      calls: 0,
      tip_idx: asNumberOr(loadedSelf.tip_idx, 0) as number,
      cwd,
      session_id: sessionId,
    };
  } else {
    selfState = { ...loadedSelf };
  }
  selfState.calls = (asNumberOr(selfState.calls, 0) as number) + 1;
  selfState.last = nowS;
  selfState.ctx_pct = currCtx;
  selfState.session_id = sessionId;
  safeWriteJson(selfStateFile, selfState);

  const isSessionStart = (selfState.calls ?? 0) === 1;

  // If display mode is minimum, emit nothing (proxy still updated above for
  // continuity when user toggles back to expansion).
  if (displayMode === "minimum") {
    return;
  }

  // ── Proxy data resolution ──
  // Try cwd-local first, then home fallback. Only accept if updatedAt is
  // within the freshness window (10s — matches Python source).
  let evo: ProxyData | null = null;
  let evoSource: "proxy" | null = null;
  const FRESH_MS = 10000;
  for (const tryPath of [
    path.join(cwd, ".evo", "live-state.json"),
    path.join(os.homedir(), ".claude", ".evo-live.json"),
  ]) {
    const candidate = safeReadJson<ProxyData>(tryPath);
    if (!candidate) continue;
    const updatedAt = asNumberOr(candidate.updatedAt, 0) as number;
    if (nowMs - updatedAt < FRESH_MS) {
      evo = candidate;
      evoSource = "proxy";
      break;
    }
  }

  // Suppress proxy data for the first two ticks of a session — its cumulative
  // state from prior sessions is meaningless on a fresh start.
  if (evo && evoSource === "proxy" && (selfState.calls ?? 0) <= 2) {
    evo = null;
    evoSource = null;
  }

  const { R, DIM, BOLD, EVO_ACCENT, EVO_INFO, EVO_WARN, EVO_GREEN, EVO_RED, EVO_GOLD } = ANSI;

  // ── Build display ──
  let line1Bits: string[] = [];
  let line2 = "";

  if (evo && evoSource === "proxy") {
    // ═══ Full proxy data ═══
    const avatar = (typeof evo.avatar === "string" && evo.avatar) || "🐣";
    const nick = (typeof evo.nickname === "string" && evo.nickname) || "EvoPet";
    const userMsgs = asNumberOr(evo.userMessages, 0) as number;
    const bond = asNumberOr(evo.bond, 0) as number;
    const isg =
      evo.idealStateGauge === null || evo.idealStateGauge === undefined
        ? -1
        : (asNumberOr(evo.idealStateGauge, -1) as number);
    const combo = asNumberOr(evo.comboCount, 0) as number;
    const grade = asString(evo.sessionGrade);
    const ps = asNumberOr(evo.promptScore, 0) as number;
    const signal = asString(evo.signalKind);
    const advice = asString(evo.advice);
    const detail = asString(evo.adviceDetail);
    const before = asString(evo.beforeExample);
    const after = asString(evo.afterExample);

    const gc = gradeColor(grade);
    line1Bits = [`${avatar} ${BOLD}${EVO_ACCENT}${nick}${R}`];

    if (grade && !gradeContradicts(grade, signal)) {
      line1Bits.push(`${gc}${BOLD}${gradeLabel(grade)}${R}`);
    }

    // Counter source: prefer proxy userMessages when reasonable, else self.calls
    const selfCalls = (selfState.calls ?? 1) as number;
    let convCount: number;
    if ("userMessages" in evo && userMsgs <= selfCalls + 2) {
      convCount = userMsgs;
    } else {
      convCount = selfCalls;
    }
    if (convCount > 0) {
      line1Bits.push(`${BOLD}${EVO_INFO}${convCount}回目の会話${R}`);
    }

    if (ps > 0) {
      if (ps >= 80) {
        line1Bits.push(`📝 ${EVO_GREEN}${BOLD}指示の質: とても良い!${R}`);
      } else if (ps >= 60) {
        line1Bits.push(`📝 ${EVO_INFO}${BOLD}指示の質: 良好${R}`);
      } else if (ps >= 40) {
        line1Bits.push(`📝 ${EVO_WARN}${BOLD}指示の質: もう少し具体的に${R}`);
      } else {
        line1Bits.push(`📝 ${EVO_RED}${BOLD}指示の質: 曖昧すぎるかも${R}`);
      }
    }

    if (combo >= 3) {
      const cc = combo >= 10 ? EVO_GOLD : combo >= 5 ? EVO_ACCENT : EVO_GREEN;
      line1Bits.push(`${cc}${BOLD}${combo}連続いい感じ!${R}`);
    }

    // Growth: prefer ISG when available; -1 = no data yet (show "測定中")
    if (isg >= 0) {
      line1Bits.push(`${BOLD}${EVO_GREEN}育成度 ${isg}%${R}`);
    } else if (isg === -1) {
      line1Bits.push(`${DIM}育成度 測定中${R}`);
    } else if (bond < 100) {
      line1Bits.push(`${BOLD}${EVO_GREEN}育成度 ${bond}%${R}`);
    }

    // ── Line 2: signal-driven advice ──
    const NEG_SET = new Set([
      "prompt_too_vague",
      "same_file_revisit",
      "same_function_revisit",
      "scope_creep",
      "no_success_criteria",
      "approval_fatigue",
      "error_spiral",
      "retry_loop",
      "high_tool_ratio",
    ]);
    const POS_SET = new Set(["good_structure", "first_pass_success", "improving_trend"]);

    if (signal && NEG_SET.has(signal)) {
      if (before && after) {
        const b = clip(before, 30);
        const a = clip(after, 55);
        line2 = `⚠️ ${EVO_WARN}${BOLD}${advice}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${b}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${a}"${R}`;
      } else if (advice) {
        line2 = `⚠️ ${EVO_WARN}${BOLD}${advice}${R}`;
        if (detail) {
          line2 += `\n   ${BOLD}${detail.slice(0, 70)}${R}`;
        }
      }
    } else if (POS_SET.has(signal)) {
      line2 = `✨ ${EVO_GREEN}${BOLD}${advice}${R}`;
      if (detail) {
        line2 += `\n   ${BOLD}${detail.slice(0, 70)}${R}`;
      }
    } else if (signal === "tip" && advice) {
      if (before && after) {
        const b = clip(before, 30);
        const a = clip(after, 55);
        line2 = `💡 ${EVO_INFO}${BOLD}${advice}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${b}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${a}"${R}`;
      } else {
        line2 = `💡 ${EVO_INFO}${BOLD}${advice}${R}`;
        if (detail) {
          line2 += `\n   ${BOLD}${detail.slice(0, 80)}${R}`;
        }
      }
    } else if (advice) {
      line2 = `💡 ${BOLD}${EVO_INFO}${advice}${R}`;
    }
  } else {
    // ═══ No proxy — self-tracked fallback ═══
    const avatar = "🦊";
    const nick = "EvoPet";
    const calls = (selfState.calls ?? 1) as number;
    line1Bits = [`${avatar} ${BOLD}${EVO_ACCENT}${nick}${R}`];

    const pool = pickMoodPool(currCtx);
    const comment = pool[calls % pool.length];

    if (currCtx >= 80) {
      line1Bits.push(`${EVO_RED}${BOLD}${comment}${R}`);
    } else if (currCtx >= 60) {
      line1Bits.push(`${BOLD}${EVO_WARN}${comment}${R}`);
    } else {
      line1Bits.push(`${BOLD}${EVO_GREEN}${comment}${R}`);
    }

    line1Bits.push(`${DIM}${calls}回目${R}`);

    // Tip rotation
    const tip = TIPS[calls % TIPS.length];
    const th = tip.headline;
    const tb = tip.before;
    const ta = tip.after;
    if (tb && ta) {
      const tbD = clip(tb, 30);
      const taD = clip(ta, 55);
      line2 = `💡 ${EVO_INFO}${BOLD}${th}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${tbD}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${taD}"${R}`;
    } else {
      line2 = `💡 ${EVO_INFO}${BOLD}${th}${R}`;
    }
  }

  // Session-start: override line2 with a boost message
  if (isSessionStart) {
    const boost = BOOST_MESSAGES[Math.floor(nowS) % BOOST_MESSAGES.length];
    line2 = `${EVO_GOLD}${BOLD}${boost}${R}`;
  }

  // ── Emit ──
  // Output: line1 (joined with SEP), optional line2 on next line.
  // Never emit the token/model/cwd line — that's ClaudeConfig's job.
  const out: string[] = [];
  if (line1Bits.length > 0) {
    out.push(line1Bits.join(SEP));
  }
  if (line2) {
    out.push(line2);
  }
  if (out.length > 0) {
    process.stdout.write(out.join("\n"));
  }
}
