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

import { readDisplaySettings } from "./display";
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
import { renderTokenLine } from "./statuslineToken";
import {
  charWidth,
  displayWidth,
  pickPage,
  splitIntoPages,
  trimToBoundary,
  trimToSentence,
  truncateToWidth,
  PAGE_INTERVAL_MS,
} from "./statuslineScroll";
import { readFreshestLiveState } from "../proxy/liveStateReader";
import { getUpdateNotice } from "../updateCheck";
import {
  getEligibleGuidanceTips,
  getModelSpecificGuidanceTips,
  pickRotatingTip,
  resolveModelSection,
  tipTag,
} from "../promptingGuidance";
import { pickTipForModel } from "../signalDetector";

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
  /**
   * Page-flip anchors, KEYED BY SESSION ID.
   *
   * This file is per-HOME, and this user runs many Claude Code windows at once,
   * so a single flat advice_key/advice_seen_at pair would have concurrent
   * sessions overwriting each other's anchor and resetting one another to page
   * 1 — the normal case here, not an edge case. Each session gets its own slot;
   * stale slots are pruned on write so the map stays bounded.
   */
  advice_anchors?: Record<string, { key: string; seenAt: number }>;
}

/** Anchors older than this are dropped — a session idle that long restarts at page 1. */
const ANCHOR_TTL_MS = 10 * 60 * 1000;
/** Hard cap on tracked sessions, so a long-lived home never grows the file without bound. */
const ANCHOR_MAX_ENTRIES = 32;

/** Drop expired anchors, then the oldest ones beyond the cap. */
function pruneAnchors(
  anchors: Record<string, { key: string; seenAt: number }>,
  nowMs: number,
): Record<string, { key: string; seenAt: number }> {
  const live = Object.entries(anchors).filter(
    ([, a]) =>
      a &&
      typeof a.seenAt === "number" &&
      Number.isFinite(a.seenAt) &&
      typeof a.key === "string" &&
      nowMs - a.seenAt < ANCHOR_TTL_MS,
  );
  live.sort((x, y) => y[1].seenAt - x[1].seenAt); // newest first
  return Object.fromEntries(live.slice(0, ANCHOR_MAX_ENTRIES));
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

/**
 * Stable identity for a piece of advice — the page-flip anchor key.
 *
 * FNV-1a/32 over every field that participates in paging, so the stored key is
 * bounded (8 hex chars) no matter how large the payload is, and so changing any
 * paged field legitimately restarts the sequence at page 1. Returns "" when
 * there is nothing to page, which the caller reads as "do not animate".
 *
 * Not cryptographic and does not need to be: a collision would only mean two
 * different pieces of advice share a page-flip clock.
 */
export function adviceIdentityKey(
  advice: string,
  detail: string,
  before = "",
  after = "",
): string {
  const s = `${advice}\u0000${detail}\u0000${before}\u0000${after}`;
  if (s === "\u0000\u0000\u0000") return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, in 32-bit arithmetic without overflowing the float53.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Width-aware truncation ────────────────────────────────────────────────
// East-Asian wide + emoji code points occupy 2 terminal columns. A single-byte
// slice (the old `s[:30]`) cut through multi-column glyphs and left examples
// meaningless, so truncation is now measured in display columns.
//
// The primitives themselves live in ./statuslineScroll (pure, no fs/env/clock)
// so the paging code can measure text without importing this renderer.
// `displayWidth` is re-exported here because callers and tests import it from
// this module.

const ADVICE_POINTER = " → 続きは `evo advice`";
const ADVICE_POINTER_COLS = displayWidth(ADVICE_POINTER);

export { charWidth, displayWidth } from "./statuslineScroll";

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

export interface ClipResult {
  /** The rendered text (pointer/ellipsis already appended when asked). */
  text: string;
  /** True when content was elided — drives the once-per-block pointer. */
  truncated: boolean;
}

/**
 * Truncate `s` by MEANING to at most `maxCols` display columns:
 *   - a whole-string filesystem path collapses to its basename;
 *   - overflow is cut at a boundary — the last SENTENCE end when
 *     `sentence: true` (used for the detail body), otherwise the last
 *     clause/word boundary;
 *   - when content was elided, append the `evo advice` pointer (pointer:true)
 *     or a single ellipsis, instead of a mid-glyph hard cut.
 */
export function clipEx(
  s: string,
  maxCols: number,
  opts?: { pointer?: boolean; sentence?: boolean; bare?: boolean },
): ClipResult {
  if (!s) return { text: s, truncated: false };
  const str = looksLikePath(s) ? basenameOf(s) : s;
  if (displayWidth(str) <= maxCols) return { text: str, truncated: false };
  const head = truncateToWidth(str, maxCols);
  const cut = opts?.sentence ? trimToSentence(head) : trimToBoundary(head);
  if (opts?.bare) return { text: cut, truncated: true };
  return {
    text: opts?.pointer ? cut + ADVICE_POINTER : cut + "…",
    truncated: true,
  };
}

/** Back-compat wrapper: same contract as before, discards the truncated flag. */
export function clip(s: string, maxCols: number, opts?: { pointer?: boolean }): string {
  return clipEx(s, maxCols, opts).text;
}

/**
 * Like `clipEx`, but the RESULT — ellipsis included — fits inside `maxCols`.
 *
 * `clip`/`clipEx` treat the budget as content-only and hang the "…" off the
 * end, so two clipped fields on one line each overshoot by a column. Layout
 * code that has an exact column budget uses this instead; the older contract is
 * left alone because callers (and tests) depend on it.
 */
export function clipFit(
  s: string,
  maxCols: number,
  opts?: { sentence?: boolean },
): ClipResult {
  if (!s) return { text: s, truncated: false };
  const str = looksLikePath(s) ? basenameOf(s) : s;
  if (displayWidth(str) <= maxCols) return { text: str, truncated: false };
  const inner = clipEx(str, Math.max(1, maxCols - 1), {
    sentence: opts?.sentence,
    bare: true,
  });
  return { text: `${inner.text}…`, truncated: true };
}

// ── Width-adaptive layout ──────────────────────────────────────────────────
// Claude Code captures the statusline script's stdout instead of attaching it
// to the terminal, so `tput cols` and language-level width detection CANNOT see
// the terminal from inside the script. Claude Code instead exports COLUMNS (and
// LINES) before running it — that env var is the only usable source of width.

/** Columns left unpainted on the right so nothing ever soft-wraps. */
const RIGHT_MARGIN = 2;
/**
 * Width assumed when COLUMNS is absent or unusable.
 *
 * 80, not 120. COLUMNS *does* arrive from Claude Code on this host (measured
 * 2026-09-06: 177 consecutive live ticks, all COLUMNS=165, zero unset), so this
 * is a genuine fallback rather than the common path — but assuming 120 on a
 * host that does not send it produced lines that wrapped on any real 80-column
 * terminal. The old wrapper made that impossible by trimming to one line below
 * 100 columns; without that trim the fallback has to be safe on its own.
 */
export const DEFAULT_COLUMNS = 80;
/** "⚠️ " / "💡 " / "✨ " prefix on the advice headline. */
const ADVICE_PREFIX_COLS = 3;
/** The 3-space hanging indent on the detail / example line. */
const DETAIL_INDENT_COLS = 3;
/** Fixed decoration around the before/after examples: `❌ "" → ✅ ""` + indent. */
const EXAMPLE_DECORATION_COLS = 16;
/** ` (10/10)` — reserved on the detail line when the advice is paginated. */
const PAGE_COUNTER_COLS = 8;

export type WidthTier = "narrow" | "medium" | "wide";

export interface StatuslineBudgets {
  cols: number;
  /** Paintable columns (cols minus the right margin). */
  avail: number;
  tier: WidthTier;
  /** narrow drops line 2 entirely and compacts the line-1 chips. */
  compactChips: boolean;
  showAdvice: boolean;
  showDetail: boolean;
  nickname: number;
  advice: number;
  detail: number;
  before: number;
  after: number;
}

/**
 * Read the terminal width from COLUMNS. Never throws; anything non-numeric,
 * zero, or negative falls back to DEFAULT_COLUMNS.
 */
export function resolveTerminalWidth(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env?.COLUMNS;
  if (typeof raw !== "string" && typeof raw !== "number") return DEFAULT_COLUMNS;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COLUMNS;
  return n;
}

/**
 * Derive every per-field column budget from the real terminal width.
 *
 * Three tiers, so the block degrades by DROPPING LINES rather than by hard-
 * cutting the same fixed 76 columns at every width:
 *   <  80 : line 1 only, compact chips
 *   80-119: line 1 + advice headline
 *   >=120 : line 1 + advice headline + detail line
 */
export function computeBudgets(cols: number): StatuslineBudgets {
  const width =
    Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : DEFAULT_COLUMNS;
  const avail = Math.max(20, width - RIGHT_MARGIN);
  const tier: WidthTier = width < 80 ? "narrow" : width < 120 ? "medium" : "wide";
  const exampleBudget = Math.max(12, avail - EXAMPLE_DECORATION_COLS);
  const before = Math.max(6, Math.round(exampleBudget * 0.39));
  return {
    cols: width,
    avail,
    tier,
    compactChips: tier === "narrow",
    showAdvice: tier !== "narrow",
    showDetail: tier === "wide",
    nickname: Math.min(24, Math.max(8, Math.floor(avail * 0.2))),
    advice: Math.max(16, avail - ADVICE_PREFIX_COLS),
    detail: Math.max(16, avail - DETAIL_INDENT_COLS),
    before,
    after: Math.max(6, exampleBudget - before),
  };
}

/**
 * Hard-cap ONE rendered line to `maxCols` display columns, passing ANSI escapes
 * through uncounted. Budgets already keep content inside the terminal; this is
 * the final net so an unbudgeted chip can never wrap the line and shove the
 * whole statusline down a row.
 */
export function capLineToWidth(line: string, maxCols: number): string {
  if (maxCols <= 0) return line;
  const cps = Array.from(line);
  let out = "";
  let w = 0;
  let i = 0;
  let truncated = false;
  while (i < cps.length) {
    if (cps[i] === "\x1b") {
      out += cps[i++];
      if (i < cps.length && cps[i] === "[") out += cps[i++];
      while (i < cps.length && !/[A-Za-z]/.test(cps[i])) out += cps[i++];
      if (i < cps.length) out += cps[i++];
      continue;
    }
    const cw = charWidth(cps[i].codePointAt(0)!);
    if (w + cw > maxCols) {
      truncated = true;
      break;
    }
    out += cps[i++];
    w += cw;
  }
  return truncated ? `${out}${ANSI.R}` : out;
}

/** Display columns of a rendered line, ignoring its ANSI escapes. */
function visibleWidth(line: string): number {
  return displayWidth(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
}

/** SEP without its ANSI escapes — " · ", the 3 columns it actually occupies. */
const SEP_COLS = 3;

/**
 * Append a decorative trailing chip to line 1 ONLY if it still fits.
 *
 * The mood comment, the session-start boost and the "(待機中)" marker are prose
 * of unbounded length that never went through clipEx. capLineToWidth kept them
 * inside the terminal, but by raw column cut — so in the narrow tier (where
 * line 2 is always dropped, so the mood chip is always appended) they landed
 * mid-word: "順調にスター". Dropping a decoration reads better than severing it.
 */
export function pushIfFits(bits: string[], chip: string, avail: number): void {
  const used = bits.length > 0 ? visibleWidth(bits.join("")) + SEP_COLS * bits.length : 0;
  if (used + visibleWidth(chip) <= avail) bits.push(chip);
}

// ── Narrow-terminal chip abbreviations ─────────────────────────────────────

/**
 * `○ C もう一息` → `○C`. Derived from gradeLabel rather than a second map so
 * the glyph/letter pairing can never drift from the full-width label.
 */
export function compactGrade(grade: string): string {
  const label = gradeLabel(grade);
  if (!label || label === grade) return grade;
  const glyph = Array.from(label)[0] ?? "";
  return glyph === grade ? grade : `${glyph}${grade}`;
}

/** Same score bands as the full-width 指示の質 chip. */
function scoreColor(ps: number): string {
  if (ps >= 80) return ANSI.EVO_GREEN;
  if (ps >= 60) return ANSI.EVO_INFO;
  if (ps >= 40) return ANSI.EVO_WARN;
  return ANSI.EVO_RED;
}

// ── Advice block (headline + optional detail/example line) ─────────────────

export interface AdviceBlockInput {
  /** Leading glyph: ⚠️ / 💡 / ✨. */
  icon: string;
  /** ANSI colour for the headline. */
  color: string;
  headline: string;
  detail?: string;
  before?: string;
  after?: string;
  /**
   * Epoch ms the page-flip animation is anchored to — the payload's own
   * `writtenAt`/`updatedAt`. Null/undefined ⇒ show page 1 only (no animation).
   */
  anchorMs?: number | null;
  nowMs?: number;
  /** User switch: `evo display scroll off` disables page-flipping. */
  scroll?: boolean;
}

// Page-flip cadence. Defined in ./statuslineScroll (single source of truth,
// also `pickPage`'s default) and re-exported here for callers of this module.
// It is coupled to `statusLine.refreshInterval` in settings.json — see the
// invariant on the constant before changing either number.
export { PAGE_INTERVAL_MS } from "./statuslineScroll";

/**
 * Render the advice block for the current width.
 *
 * The `evo advice` pointer is attached AT MOST ONCE, on the LAST line of the
 * block, whenever anything was elided — the headline, the detail, or the whole
 * detail line (dropped below 120 columns). Previously it rode on the headline
 * only, so when the *detail* was what got cut the user was never told where the
 * rest lived.
 */
export function buildAdviceBlock(
  input: AdviceBlockInput,
  b: StatuslineBudgets,
): string {
  const { R, DIM, BOLD, EVO_RED, EVO_GREEN } = ANSI;
  const detail = input.detail ?? "";
  const before = input.before ?? "";
  const after = input.after ?? "";
  const hasExamples = Boolean(before && after);
  // Parity with the previous renderer: a signal that carries only a
  // before/after pair still renders (headline collapses to the icon).
  if (!b.showAdvice || (!input.headline && !(b.showDetail && hasExamples))) {
    return "";
  }
  const hasSecondLine = b.showDetail && (hasExamples || Boolean(detail));
  // Below 120 columns the detail line is dropped wholesale — that is elision,
  // so it must earn the pointer just like a mid-line cut.
  const droppedDetail = !b.showDetail && (hasExamples || Boolean(detail));

  const renderHeadline = (budget: number): { line: string; truncated: boolean } => {
    const c = clipEx(input.headline, budget, { bare: true });
    return {
      line: `${input.icon} ${input.color}${BOLD}${c.text}${R}`,
      truncated: c.truncated,
    };
  };

  const renderExamples = (budget: number): { line: string; truncated: boolean } => {
    const exBudget = Math.max(12, budget - (EXAMPLE_DECORATION_COLS - DETAIL_INDENT_COLS));
    const bBudget = Math.max(6, Math.round(exBudget * 0.39));
    const cb = clipFit(before, bBudget);
    const ca = clipFit(after, Math.max(6, exBudget - bBudget));
    return {
      line: `   ${DIM}❌${R} ${BOLD}${EVO_RED}"${cb.text}"${R} → ${DIM}✅${R} ${BOLD}${EVO_GREEN}"${ca.text}"${R}`,
      truncated: cb.truncated || ca.truncated,
    };
  };

  /**
   * The paged sequence for line 2: the detail split into sentence pages, with
   * the ❌→✅ examples appended as the FINAL page when both are present.
   *
   * The examples used to win outright over the detail, so ~190 columns of
   * detail vanished with no pointer for the most common payload shape (a "tip"
   * signal carries detail AND examples together). Making them the last page
   * delivers both, keeps the block at three lines, and lets the (n/m) counter
   * tell the truth about how much is left.
   */
  const buildPages = (budget: number): Array<{ text: string; examples: boolean }> => {
    const out: Array<{ text: string; examples: boolean }> = [];
    if (detail) {
      for (const p of splitIntoPages(detail, budget)) out.push({ text: p, examples: false });
    }
    if (hasExamples) out.push({ text: "", examples: true });
    return out;
  };

  const renderDetail = (budget: number): { line: string; truncated: boolean } => {
    const scroll = input.scroll !== false;
    const anchor = input.anchorMs;
    const canPage =
      scroll &&
      typeof anchor === "number" &&
      Number.isFinite(anchor) &&
      anchor > 0;

    if (canPage) {
      const pageBudget = Math.max(12, budget - PAGE_COUNTER_COLS);
      const pages = buildPages(pageBudget);
      if (pages.length > 1) {
        const idx = pickPage(
          pages,
          typeof input.nowMs === "number" ? input.nowMs : Date.now(),
          anchor as number,
          PAGE_INTERVAL_MS,
        );
        const counter = `${DIM} (${idx + 1}/${pages.length})${R}`;
        // Nothing is withheld: the wall clock walks the reader through every
        // page — detail sentences first, examples last — and then stops.
        const page = pages[idx];
        const body = page.examples
          ? renderExamples(pageBudget).line
          : `   ${BOLD}${page.text}${R}`;
        return { line: `${body}${counter}`, truncated: false };
      }
    }
    // Not paging (scroll off, or no anchor): show the examples if we have them
    // — they are the most actionable half — but report the dropped detail as
    // elision so the `evo advice` pointer fires. Silently discarding it is the
    // hole this branch used to have.
    if (hasExamples) {
      const ex = renderExamples(budget);
      return { ...ex, truncated: ex.truncated || Boolean(detail) };
    }
    const c = clipFit(detail, budget, { sentence: true });
    return { line: `   ${BOLD}${c.text}${R}`, truncated: c.truncated };
  };

  // Pass 1 — full budgets.
  let head = renderHeadline(b.advice);
  let second: { line: string; truncated: boolean } | null = null;
  if (hasSecondLine) {
    // renderDetail owns BOTH shapes now: it pages the detail with the examples
    // as the final page, or falls back to whichever one it can show.
    second = renderDetail(b.detail);
  }

  const needPointer = head.truncated || (second?.truncated ?? false) || droppedDetail;

  // Pass 2 — attach the pointer to the LAST line. If it already fits beside the
  // rendered content, leave that content alone; only when it would push past
  // the terminal edge do we re-render that one line with the room reserved.
  if (needPointer) {
    const attach = (
      cur: { line: string; truncated: boolean },
      budget: number,
      rerender: (n: number) => { line: string; truncated: boolean },
    ): { line: string; truncated: boolean } => {
      const fits =
        visibleWidth(cur.line) + ADVICE_POINTER_COLS <= b.avail;
      const base = fits ? cur : rerender(Math.max(16, budget - ADVICE_POINTER_COLS));
      return { ...base, line: `${base.line}${DIM}${ADVICE_POINTER}${R}` };
    };
    if (second) {
      second = attach(second, b.detail, (n) => renderDetail(n));
    } else {
      head = attach(head, b.advice, renderHeadline);
    }
  }

  return second ? `${head.line}\n${second.line}` : head.line;
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
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const name =
      typeof obj.display_name === "string" ? obj.display_name.trim() : "";
    // Prefer the id; fall back to the display name when only the name maps to
    // a guidance section (e.g. an id form the pattern table does not know yet
    // but a display name like "Fable 5.2" it does).
    if (id && (resolveModelSection(id) || !name || !resolveModelSection(name))) {
      return id;
    }
    if (name) return name;
    if (id) return id;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export interface StatuslineCommandOptions {
  /**
   * When true, render the COMPLETE statusline: the token line (`model · usage
   * · cwd`) followed by the EvoPet block — parity with the single-file
   * `statusline.py`. This is what `evo install-statusline` wires Claude Code
   * at (C1). When false (the default, used by the split-wrapper construction),
   * only the EvoPet block is emitted; a separate token-only base renders the
   * token line.
   */
  full?: boolean;
}

export async function runStatuslineCommand(
  options: StatuslineCommandOptions = {},
): Promise<void> {
  const fullMode = options.full === true;
  // Parse stdin JSON. Tolerate missing/malformed input — never throw.
  let data: StatuslineInput = {};
  const raw = readStdinSync();
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      // JSON.parse("null") returns null, and JSON.parse("[]")/'"x"' return
      // non-objects — any of which would throw on the first `.cwd` access below.
      // Fail open to the empty payload instead of crashing the statusline.
      data =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as StatuslineInput)
          : {};
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

  // ── Display mode + width-derived layout budgets ──
  const { mode: displayMode, scroll: scrollEnabled } = readDisplaySettings();
  const budgets = computeBudgets(resolveTerminalWidth());

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
      // Carry other sessions' page-flip anchors through OUR reset — this file
      // is shared, so rebuilding it from scratch would reset every concurrent
      // window to page 1. Our own slot is re-established below on first render.
      advice_anchors: loadedSelf.advice_anchors,
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

  // Display mode "minimum" hides the EvoPet block. In split (EvoPet-only) mode
  // that means emit nothing at all. In full mode the token line still renders
  // (you keep model/context/cwd; only the pet is hidden), so we don't bail —
  // we just skip building the EvoPet block below.
  const renderEvopet = displayMode !== "minimum";
  if (!renderEvopet && !fullMode) {
    return;
  }

  const { R, DIM, BOLD, EVO_ACCENT, EVO_INFO, EVO_WARN, EVO_GREEN, EVO_RED, EVO_GOLD } = ANSI;

  // ── Build the EvoPet block (skipped entirely in minimum mode) ──
  // In full mode, minimum still emits the token line below; the EvoPet block
  // is simply left empty here.
  let evoBlockText = "";

  if (renderEvopet) {
    // ── Proxy data resolution ──
    // Freshness matches the Python renderer: data <10s old renders live
    // ("proxy"); 10s–5min old renders the full layout DIMMED with a "(待機中)"
    // marker ("proxy_stale"), so EvoPet doesn't vanish during a long tool call;
    // older than 5min is ignored.
    // A freshness window must be comfortably LONGER than the heartbeat that
    // feeds it. proxyRuntime rewrites live-state every 10s
    // (`setInterval(writeLiveState, 10_000)`), so a 10s FRESH_MS put the payload
    // age right on its own boundary: a healthy live session flickered into the
    // dimmed "(待機中)" state depending on where the tick landed between
    // heartbeats. 25s = 2.5x the heartbeat, so a live proxy always reads fresh
    // while a genuinely dead session still goes stale within half a minute.
    // (This also matters for paging: at 10s, page 3 first became due at exactly
    // the moment the block went dim, so pages 3+ were only ever seen dimmed.)
    const FRESH_MS = 25000; // <25s → live
    const FRESH_WINDOW_MS = 300000; // ≤5min → accepted (rendered dim when >25s)
    let evo: ProxyData | null = null;
    let evoSource: "proxy" | "proxy_stale" | null = null;

    if (sid) {
      // Strict per-session binding: read ONLY <cwd>/.evo/sessions/<sid>.json.
      // A miss/stale here renders the quiet placeholder below — we never fall
      // back to the shared sinks, which any parallel proxy in this cwd
      // overwrites (that cross-pane bleed is exactly what strict binding fixes).
      const perSessionPath = path.join(cwd, ".evo", "sessions", `${sid}.json`);
      const candidate = safeReadJson<ProxyData>(perSessionPath);
      if (candidate) {
        const age = nowMs - (asNumberOr(candidate.updatedAt, 0) as number);
        if (age < FRESH_WINDOW_MS) {
          evo = candidate;
          evoSource = age < FRESH_MS ? "proxy" : "proxy_stale";
        }
      }
    } else {
      // Sessionless legacy path: resolve the freshest generation across the
      // shared sinks via readFreshestLiveState (B2). It parses each sink,
      // prefers live-writer payloads, and breaks ties by seq/writtenAt — so
      // when parallel sessions clobber the shared sinks we pick a coherent
      // newest payload instead of whichever file we happened to read first.
      const candidate = readFreshestLiveState([
        path.join(cwd, ".evo", "live-state.json"),
        path.join(os.homedir(), ".claude", ".evo-live.json"),
      ]);
      if (candidate) {
        const age = nowMs - (asNumberOr(candidate.payload.updatedAt, 0) as number);
        if (age < FRESH_WINDOW_MS) {
          evo = candidate.payload as ProxyData;
          evoSource = age < FRESH_MS ? "proxy" : "proxy_stale";
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

    const isStale = evoSource === "proxy_stale";
    // Dim a chip only when the proxy data is stale (belt-and-suspenders for a
    // long tool call): the whole layout is preserved but subdued.
    const dimIfStale = (s: string): string => (isStale ? `${DIM}${s}${R}` : s);

    let line1Bits: string[] = [];
    let line2 = "";
    // The quiet bound-session placeholder must never be overridden by the
    // session-start boost (it stays a neutral "waiting" marker).
    let quietPlaceholder = false;

    if (evo && evoSource) {
      // ═══ Full proxy data (live or stale-dimmed) ═══
      const avatar = (typeof evo.avatar === "string" && evo.avatar) || "🐣";
      const nick = clip(
        (typeof evo.nickname === "string" && evo.nickname) || "EvoPet",
        budgets.nickname,
      );
      const bond = asNumberOr(evo.bond, 0) as number;
      const isg =
        evo.idealStateGauge === null || evo.idealStateGauge === undefined
          ? -1
          : (asNumberOr(evo.idealStateGauge, -1) as number);
      const grade = asString(evo.sessionGrade);
      const ps = asNumberOr(evo.promptScore, 0) as number;
      const signal = asString(evo.signalKind);
      let advice = asString(evo.advice);
      let detail = asString(evo.adviceDetail);
      let before = asString(evo.beforeExample);
      let after = asString(evo.afterExample);

      // A "tip" is the proxy's filler rotation, chosen for the model the PROXY
      // could resolve (forwarded --model, else ~/.claude/settings.json "model",
      // often a bare alias like "opus[1m]"). That is frequently not the model
      // this session is actually running — a Fable 5.2 session was shown
      // "[Opus 4.8向け]" tips. The stdin payload's model is authoritative, so
      // re-pick the same turn's tip for it. Real signals (warnings/praise) are
      // model-independent and are never touched.
      if (signal === "tip" && modelId) {
        const turnIdx = asNumberOr(evo.turns, 0) as number;
        const t = pickTipForModel(turnIdx, modelId);
        advice = t.headline;
        detail = t.detail;
        before = t.beforeExample ?? "";
        after = t.afterExample ?? "";
      }

      const gc = gradeColor(grade);
      const gradeOk = Boolean(grade) && !gradeContradicts(grade, signal);
      const growth = isg >= 0 ? isg : isg !== -1 && bond < 100 ? bond : -1;

      if (budgets.compactChips) {
        // ── Narrow terminal (<80 cols): one line, abbreviated chips ──
        // e.g. `🦊 ○C · 📝62 · 育34%`. Same three essentials, ~a third of the
        // columns, so the row still fits instead of wrapping.
        line1Bits = [dimIfStale(`${avatar} ${BOLD}${EVO_ACCENT}${nick}${R}`)];
        line1Bits.push(
          gradeOk
            ? dimIfStale(`${gc}${BOLD}${compactGrade(grade)}${R}`)
            : `${DIM}評価—${R}`,
        );
        line1Bits.push(
          ps > 0
            ? dimIfStale(`📝${scoreColor(ps)}${BOLD}${Math.round(ps)}${R}`)
            : `${DIM}📝—${R}`,
        );
        line1Bits.push(
          growth >= 0
            ? dimIfStale(`${BOLD}${EVO_GREEN}育${growth}%${R}`)
            : `${DIM}育—${R}`,
        );
      } else {
        line1Bits = [dimIfStale(`${avatar} ${BOLD}${EVO_ACCENT}${nick}${R}`)];

        // Always-on essentials row (never thins out): grade / 指示の質 / 育成度,
        // each with a dim placeholder when its datum isn't computed yet. Grade is
        // suppressed to the placeholder when its polarity contradicts the signal
        // (TS refinement over the Python renderer, which always shows the label).
        if (gradeOk) {
          line1Bits.push(dimIfStale(`${gc}${BOLD}${gradeLabel(grade)}${R}`));
        } else {
          line1Bits.push(`${DIM}評価 —${R}`);
        }

        if (ps > 0) {
          if (ps >= 80) {
            line1Bits.push(dimIfStale(`📝 ${EVO_GREEN}${BOLD}指示の質: とても良い!${R}`));
          } else if (ps >= 60) {
            line1Bits.push(dimIfStale(`📝 ${EVO_INFO}${BOLD}指示の質: 良好${R}`));
          } else if (ps >= 40) {
            line1Bits.push(dimIfStale(`📝 ${EVO_WARN}${BOLD}指示の質: もう少し具体的に${R}`));
          } else {
            line1Bits.push(dimIfStale(`📝 ${EVO_RED}${BOLD}指示の質: 曖昧すぎるかも${R}`));
          }
        } else {
          line1Bits.push(`${DIM}📝 指示の質: 計測中${R}`);
        }

        // Growth: prefer ISG when available; -1 = no data yet (show "-").
        if (isg >= 0) {
          line1Bits.push(dimIfStale(`${BOLD}${EVO_GREEN}育成度 ${isg}%${R}`));
        } else if (isg === -1) {
          line1Bits.push(`${DIM}育成度 -${R}`);
        } else if (bond < 100) {
          line1Bits.push(dimIfStale(`${BOLD}${EVO_GREEN}育成度 ${bond}%${R}`));
        } else {
          // Residual fallback (e.g. bond ≥ 100 with no ISG): keep the row full.
          line1Bits.push(`${DIM}育成度 -${R}`);
        }
      }

      // Append the "(待機中)" lagging marker as the last chip when stale.
      if (isStale) {
        pushIfFits(line1Bits, `${DIM}(待機中)${R}`, budgets.avail);
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

      // Every column budget below is derived from the REAL terminal width
      // (COLUMNS), and the `evo advice` pointer is attached once, on whichever
      // line ends the block, whenever anything was elided.
      //
      // PAGE-FLIP ANCHOR — content identity, NOT write time.
      // The obvious anchor is the payload's own `writtenAt`/`updatedAt`, and it
      // is wrong: proxyRuntime runs an unconditional 10s heartbeat
      // (`setInterval(writeLiveState, 10_000)`) and liveState stamps
      // `writtenAt: Date.now()` on every write, so the timestamp moves even when
      // the advice text has not changed. Anchoring on it restarts the sequence
      // every few seconds — measured at ~3.3s mean across concurrent writers —
      // which pins the reader to page 1 and makes pages 3+ unreachable.
      //
      // So the anchor is "when did THIS TEXT first appear", tracked in the
      // self-state file we already write every tick (no new state file). The
      // key covers every field that participates in paging, so changing any of
      // them legitimately restarts at page 1.
      // The slot is per SESSION: parallel windows must not reset each other.
      const anchorId = sid || cwd;
      const adviceKey = adviceIdentityKey(advice, detail, before, after);
      let anchorMs: number | null = null;
      if (adviceKey) {
        const prior = loadedSelf.advice_anchors?.[anchorId];
        if (prior && prior.key === adviceKey) {
          anchorMs = asNumberOr(prior.seenAt, nowMs) as number;
        } else {
          anchorMs = nowMs;
          // New text for THIS session: persist so the next tick can measure
          // elapsed time from here. Only on change, so the steady state stays
          // at one self-state write per tick.
          selfState.advice_anchors = pruneAnchors(
            { ...(loadedSelf.advice_anchors ?? {}), [anchorId]: { key: adviceKey, seenAt: anchorMs } },
            nowMs,
          );
          safeWriteJson(selfStateFile, selfState);
        }
      }
      const mkAdvice = (icon: string, color: string): string =>
        buildAdviceBlock(
          {
            icon,
            color,
            headline: advice,
            detail,
            before,
            after,
            anchorMs,
            nowMs,
            scroll: scrollEnabled,
          },
          budgets,
        );

      if (signal && NEG_SET.has(signal)) {
        if ((before && after) || advice) {
          line2 = mkAdvice("⚠️", EVO_WARN);
        }
      } else if (POS_SET.has(signal)) {
        line2 = mkAdvice("✨", EVO_GREEN);
      } else if (signal === "tip" && advice) {
        line2 = mkAdvice("💡", EVO_INFO);
      } else if (advice) {
        line2 = mkAdvice("💡", EVO_INFO);
      }

      // When there's no advice line, append a dim 5-band mood comment (parity
      // with the Python renderer) so line 2 isn't blank.
      if (!line2) {
        const calls = (selfState.calls ?? 1) as number;
        const pool = pickMoodPool(currCtx);
        const mood = pool[calls % pool.length];
        pushIfFits(line1Bits, `${DIM}${mood}${R}`, budgets.avail);
      }
    } else if (sid) {
      // ═══ Known session, no fresh per-session state → quiet placeholder ═══
      // Deliberately does NOT borrow the self-tracked tip rotation or the
      // shared sinks: a bound session with no data of its own renders only a
      // neutral marker (never another session's state). Child/teammate sessions
      // (no tracked file) land here. Parity with the Python "待機中" placeholder.
      line1Bits = [`🦊 ${BOLD}${EVO_ACCENT}EvoPet${R}`, `${DIM}待機中${R}`];
      quietPlaceholder = true;
    } else {
      // ═══ No session id — self-tracked fallback (sessionless legacy path) ═══
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
      // Model-specific tips (what-changed first) take every other slot via
      // pickRotatingTip; otherwise they would be ~8% of a 290-tip rotation.
      type PoolTip = {
        headline: string;
        tag: string;
        before?: string | null;
        after?: string | null;
        detail?: string;
      };
      const generalPool: PoolTip[] = [
        ...TIPS.map((t) => ({
          headline: t.headline,
          tag: tipTag("generic"),
          before: t.before,
          after: t.after,
        })),
        ...getEligibleGuidanceTips(undefined).map((t) => ({
          headline: t.headline,
          tag: tipTag(t.source, t.audience),
          detail: t.detail,
        })),
      ];
      const modelPool: PoolTip[] = getModelSpecificGuidanceTips(modelId).map((t) => ({
        headline: t.headline,
        tag: tipTag(t.source, t.audience, t.changeLabel),
        detail: t.detail,
      }));
      const tip = pickRotatingTip(calls, generalPool, modelPool) ?? generalPool[0];
      // No payload timestamp exists on this path, so `anchorMs: null` keeps the
      // tip on page 1 (static) rather than animating off an unrelated clock.
      line2 = buildAdviceBlock(
        {
          icon: "💡",
          color: EVO_INFO,
          headline: `${tip.tag} ${tip.headline}`,
          detail: tip.detail,
          before: tip.before ?? "",
          after: tip.after ?? "",
          anchorMs: null,
          nowMs,
          scroll: scrollEnabled,
        },
        budgets,
      );
    }

    // Session-start: override line2 with a boost message (not for the quiet
    // bound-session placeholder, which stays neutral).
    if (isSessionStart && !quietPlaceholder) {
      const boost = BOOST_MESSAGES[Math.floor(nowS) % BOOST_MESSAGES.length];
      // Budgeted like any other line-2 content — it used to be hard-cut by
      // capLineToWidth, which severed it mid-word on a narrow terminal.
      line2 = `${EVO_GOLD}${BOLD}${clipFit(boost, budgets.avail).text}${R}`;
    }

    // Assemble the EvoPet block (line 1 + optional line 2). Dim the whole
    // line 2 too when stale, so fresh-bright advice isn't mixed with dim stats.
    // Below 80 columns line 2 is dropped entirely — the essentials row is what
    // has to survive.
    const blockLines: string[] = [];
    if (line1Bits.length > 0) blockLines.push(line1Bits.join(SEP));
    if (line2 && budgets.showAdvice) {
      blockLines.push(isStale ? `${DIM}${line2}${R}` : line2);
    }
    if (blockLines.length > 0) {
      // Final net: bound every PHYSICAL line to the paintable width so an
      // unbudgeted chip (mood comment, boost message, "待機中" marker) can never
      // soft-wrap and shove the prompt down a row.
      const capped = blockLines
        .join("\n")
        .split("\n")
        .map((l) => capLineToWidth(l, budgets.avail))
        .join("\n");
      evoBlockText = hardCapVisible(capped, EVOPET_BLOCK_MAX_CHARS);
    }
  }

  // ── Emit ──
  // Full mode: token line (`model · usage · cwd`) then the EvoPet block on the
  // next line — parity with statusline.py. Split mode: EvoPet block only (the
  // token line is rendered by a separate token-only base). An update-available
  // notice, when present, is appended as a final dim line in both modes.
  const out: string[] = [];
  if (fullMode) {
    const tokenLine = renderTokenLine(data, {
      homeDir: os.homedir(),
      fallbackCwd: process.cwd(),
    });
    out.push(evoBlockText ? `${tokenLine}${SEP}\n${evoBlockText}` : tokenLine);
  } else if (evoBlockText) {
    out.push(evoBlockText);
  }

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
