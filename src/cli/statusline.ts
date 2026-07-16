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
import { getUpdateNotice } from "../updateCheck";
import { getEligibleGuidanceTips, tipTag } from "../promptingGuidance";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StatuslineInput {
  cwd?: unknown;
  workspace?: { current_dir?: unknown } | unknown;
  context_window?: { used_percentage?: unknown } | unknown;
  session_id?: unknown;
  sessionId?: unknown;
  // model drives model-aware tip selection (resolveStatuslineModel); rate_limits
  // exist but are not used by EvoPet rendering.
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
    const json = JSON.stringify(data);
    // Atomic write: write to tmp file then rename. Prevents truncated JSON
    // from being read by a concurrent statusline tick (Claude Code re-renders
    // rapidly). Mirrors the atomicWrite pattern from proxyRuntime.ts.
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, filePath);
    } catch {
      // Best-effort cleanup; fall back to direct write so state still updates.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      try { fs.writeFileSync(filePath, json); } catch { /* ignore */ }
    }
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

// ── Width-aware truncation ────────────────────────────────────────────────
// East-Asian wide + emoji code points occupy 2 terminal columns. A single-byte
// slice (the old `s[:30]`) cut through multi-column glyphs and left examples
// meaningless, so truncation is now measured in display columns.

const ADVICE_POINTER = " → 続きは `evo advice`";

function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** A whole-string filesystem path: a path token with no whitespace. */
function looksLikePath(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && !/\s/u.test(t) && /[/\\]/.test(t);
}

function truncateToWidth(s: string, maxCols: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** Back off to the last clause/word boundary, if that keeps most of the text. */
function trimToBoundary(s: string): string {
  const m = s.match(/^(.*[、。，．・:：/!?！？\s])[^、。，．・:：/!?！？\s]*$/u);
  if (m && displayWidth(m[1]) >= displayWidth(s) * 0.5) {
    return m[1].replace(/[\s、。，．・:：]+$/u, "");
  }
  return s;
}

/**
 * Truncate `s` by MEANING to at most `maxCols` display columns:
 *   - a whole-string filesystem path collapses to its basename;
 *   - overflow is cut at the last clause/word boundary;
 *   - when content was elided, append the `evo advice` pointer (pointer:true)
 *     or a single ellipsis, instead of a mid-glyph hard cut.
 */
export function clip(s: string, maxCols: number, opts?: { pointer?: boolean }): string {
  if (!s) return s;
  const str = looksLikePath(s) ? basenameOf(s) : s;
  if (displayWidth(str) <= maxCols) return str;
  const truncated = trimToBoundary(truncateToWidth(str, maxCols));
  return opts?.pointer ? truncated + ADVICE_POINTER : truncated + "…";
}

// Absolute hard total-block cap (final safety net). Even with per-field clip,
// an unclipped field (e.g. a crafted nickname) or a future code path could
// flood the statusline; this bounds the VISIBLE length of the WHOLE assembled
// EvoPet block no matter what. ANSI escape sequences pass through uncounted (so
// colors stay intact); a hard cut appends a reset + the `evo advice` pointer.
// Measured in code points (emoji = 1). The newline between line 1 and line 2
// counts as one visible unit.
export const EVOPET_BLOCK_MAX_CHARS = 500;

export function hardCapVisible(s: string, maxVisible: number): string {
  const cps = Array.from(s);
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < cps.length) {
    if (cps[i] === "\x1b") {
      // Copy a CSI/SGR escape verbatim: ESC [ <params> <final letter>.
      out += cps[i++];
      if (i < cps.length && cps[i] === "[") out += cps[i++];
      while (i < cps.length && !/[A-Za-z]/.test(cps[i])) out += cps[i++];
      if (i < cps.length) out += cps[i++];
      continue;
    }
    if (visible >= maxVisible) break;
    out += cps[i++];
    visible++;
  }
  if (i < cps.length) out += `${ANSI.R}${ADVICE_POINTER}`;
  return out;
}

// Resolve the model from the statusline stdin payload. Claude Code sends it as
// `{ model: { id, display_name } }`; tolerate a bare string too. Authoritative
// per session, so it drives model-aware tip selection in the fallback path.
function resolveStatuslineModel(data: StatuslineInput): string | null {
  const m = (data as Record<string, unknown>).model;
  if (typeof m === "string") return m.trim() || null;
  if (m && typeof m === "object") {
    const obj = m as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id.trim()) return obj.id.trim();
    if (typeof obj.display_name === "string" && obj.display_name.trim()) {
      return obj.display_name.trim();
    }
  }
  return null;
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

  // Strict session identity: prefer the explicit session_id, else derive it
  // from the transcript filename stem (Claude Code sends transcript_path like
  // …/<session-id>.jsonl). When `sid` is known we bind to the per-session
  // live-state file ONLY — never the shared global sinks that every parallel
  // proxy clobbers.
  const transcriptPath = asString(
    (data as Record<string, unknown>).transcript_path,
  );
  const sidFromTranscript = transcriptPath
    ? path.basename(transcriptPath).replace(/\.jsonl$/i, "")
    : "";
  const sid = sessionId || sidFromTranscript;

  // Model from the stdin payload (authoritative for this session) — drives the
  // model-aware tip rotation in the self-tracked fallback below.
  const modelId = resolveStatuslineModel(data);

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
  // Only accept data within the freshness window (10s — matches the proxy's
  // 10s heartbeat and the Python renderer's fresh cutoff).
  let evo: ProxyData | null = null;
  let evoSource: "proxy" | null = null;
  const FRESH_MS = 10000;
  if (sid) {
    // Strict per-session binding: read ONLY <cwd>/.evo/sessions/<sid>.json.
    // A miss/stale here renders NOTHING (handled below) — we never fall back
    // to the shared sinks, which any parallel proxy in this cwd overwrites.
    const perSessionPath = path.join(cwd, ".evo", "sessions", `${sid}.json`);
    const candidate = safeReadJson<ProxyData>(perSessionPath);
    if (candidate) {
      const updatedAt = asNumberOr(candidate.updatedAt, 0) as number;
      if (nowMs - updatedAt < FRESH_MS) {
        evo = candidate;
        evoSource = "proxy";
      }
    }
  } else {
    // Sessionless legacy path: read the shared sinks, newest cwd-local first.
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
    // Suppress shared-sink data for the first two ticks of a session — its
    // cumulative state from a prior session is meaningless on a fresh start.
    // (Per-session files are session-scoped, so this only applies here.)
    if (evo && (selfState.calls ?? 0) <= 2) {
      evo = null;
      evoSource = null;
    }
  }

  const { R, DIM, BOLD, EVO_ACCENT, EVO_INFO, EVO_WARN, EVO_GREEN, EVO_RED, EVO_GOLD } = ANSI;

  // ── Build display ──
  let line1Bits: string[] = [];
  let line2 = "";

  if (evo && evoSource === "proxy") {
    // ═══ Full proxy data ═══
    const avatar = (typeof evo.avatar === "string" && evo.avatar) || "🐣";
    const nick = clip((typeof evo.nickname === "string" && evo.nickname) || "EvoPet", 24);
    const bond = asNumberOr(evo.bond, 0) as number;
    const isg =
      evo.idealStateGauge === null || evo.idealStateGauge === undefined
        ? -1
        : (asNumberOr(evo.idealStateGauge, -1) as number);
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

    // Line 1 essentials only: grade / 指示の質 / 育成度 (max 3 chips after the
    // name). 会話回数 and combo were dropped from the cramped statusline; they
    // remain available in `evo stats`.
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

    // Truncate by meaning: headline/detail to a line budget (pointer when the
    // headline is elided), before/after examples to tight column budgets so
    // the EvoPet block stays at ~2 lines instead of wrapping into noise.
    const adviceC = clip(advice, 72, { pointer: true });
    const detailC = clip(detail, 76);
    const b = clip(before, 28);
    const a = clip(after, 44);

    if (signal && NEG_SET.has(signal)) {
      if (before && after) {
        line2 = `⚠️ ${EVO_WARN}${BOLD}${adviceC}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${b}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${a}"${R}`;
      } else if (advice) {
        line2 = `⚠️ ${EVO_WARN}${BOLD}${adviceC}${R}`;
        if (detail) {
          line2 += `\n   ${BOLD}${detailC}${R}`;
        }
      }
    } else if (POS_SET.has(signal)) {
      line2 = `✨ ${EVO_GREEN}${BOLD}${adviceC}${R}`;
      if (detail) {
        line2 += `\n   ${BOLD}${detailC}${R}`;
      }
    } else if (signal === "tip" && advice) {
      if (before && after) {
        line2 = `💡 ${EVO_INFO}${BOLD}${adviceC}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${b}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${a}"${R}`;
      } else {
        line2 = `💡 ${EVO_INFO}${BOLD}${adviceC}${R}`;
        if (detail) {
          line2 += `\n   ${BOLD}${detailC}${R}`;
        }
      }
    } else if (advice) {
      line2 = `💡 ${BOLD}${EVO_INFO}${adviceC}${R}`;
    }
  } else if (!sid) {
    // ═══ No proxy — self-tracked fallback (sessionless legacy path only) ═══
    // When a sid IS known but has no fresh per-session state we deliberately
    // fall through to render nothing (guard below) instead of this fallback.
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

    // Tip rotation — merge the static library ([汎用]) with model-aware
    // guidance tips ([公式] base / [<model>向け] model-specific). Each tip
    // headline is prefixed with its provenance tag so the user can tell
    // model-tuned advice from the generic/official libraries.
    const guidanceTips = getEligibleGuidanceTips(modelId);
    const tipPool: Array<{
      headline: string;
      tag: string;
      before?: string | null;
      after?: string | null;
      detail?: string;
    }> = [
      ...TIPS.map((t) => ({
        headline: t.headline,
        tag: tipTag("generic"),
        before: t.before,
        after: t.after,
      })),
      ...guidanceTips.map((t) => ({
        headline: t.headline,
        tag: tipTag(t.source, t.audience),
        detail: t.detail,
      })),
    ];
    const tip = tipPool[calls % tipPool.length];
    const th = clip(`${tip.tag} ${tip.headline}`, 72, { pointer: true });
    const tb = tip.before;
    const ta = tip.after;
    if (tb && ta) {
      const tbD = clip(tb, 28);
      const taD = clip(ta, 44);
      line2 = `💡 ${EVO_INFO}${BOLD}${th}${R}\n   ${DIM}❌${R} ${BOLD}${EVO_RED}"${tbD}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${taD}"${R}`;
    } else if (tip.detail) {
      line2 = `💡 ${EVO_INFO}${BOLD}${th}${R}\n   ${BOLD}${clip(tip.detail, 76)}${R}`;
    } else {
      line2 = `💡 ${EVO_INFO}${BOLD}${th}${R}`;
    }
  }

  // Strict per-session binding: a KNOWN session with no fresh per-session state
  // renders nothing at all (never another session's state, never a boost/tip).
  // Child/teammate sessions have no tracked file → they naturally render empty.
  if (!evo && sid) {
    return;
  }

  // Session-start: override line2 with a boost message
  if (isSessionStart) {
    const boost = BOOST_MESSAGES[Math.floor(nowS) % BOOST_MESSAGES.length];
    line2 = `${EVO_GOLD}${BOLD}${boost}${R}`;
  }

  // ── Emit ──
  // Output: line1 (joined with SEP), optional line2 on next line.
  // Never emit the token/model/cwd line — that's ClaudeConfig's job.
  // Assemble the EvoPet block (line 1 + optional line 2), then enforce the
  // absolute hard total-block cap on the joined output as the final backstop.
  const blockLines: string[] = [];
  if (line1Bits.length > 0) blockLines.push(line1Bits.join(SEP));
  if (line2) blockLines.push(line2);

  const out: string[] = [];
  if (blockLines.length > 0) {
    out.push(hardCapVisible(blockLines.join("\n"), EVOPET_BLOCK_MAX_CHARS));
  }

  // Append (last line) an update-available notice when npm has a newer
  // version. Stale-while-revalidate via updateCheck — never blocks.
  try {
    const notice = getUpdateNotice();
    if (notice) {
      out.push(`${DIM}${notice}${R}`);
    }
  } catch {
    // updateCheck must never break statusline rendering.
  }

  if (out.length > 0) {
    process.stdout.write(out.join("\n"));
  }
}
