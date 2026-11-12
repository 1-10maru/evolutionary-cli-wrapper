/**
 * `evo advice` — print the full EvoPet advice for this directory.
 *
 * The statusline truncates advice/detail/before-after to fit one or two lines
 * and points here (`→ 続きは \`evo advice\``) for the untruncated text.
 *
 * CAVEAT: this command has no session_id of its own, so it shows the advice of
 * the MOST RECENTLY ACTIVE session in this directory — it picks the newest
 * per-session file in <cwd>/.evo/sessions by modification time (then falls back
 * to the legacy shared sinks). With multiple concurrent sessions in the same
 * cwd, that is normally the one you just interacted with, but not guaranteed to
 * be a specific pane. It prints the full headline, detail, and before/after.
 *
 * Tip agreement: when the stored advice is the proxy's filler "tip", the
 * statusline does not show it verbatim — it re-picks the same turn's tip for
 * the session's REAL model (the statusline stdin `model`), which the proxy
 * cannot see. The statusline records that model per session in its self-state
 * file (`session_models`, see `rememberSessionModel`), and this command
 * re-picks with the same (turns, model) so both show the same tip. Real
 * signals (warnings/praise) are printed as stored, never re-picked.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pickTipForModel } from "../signalDetector";

interface LiveAdvice {
  advice?: string;
  adviceDetail?: string;
  beforeExample?: string;
  afterExample?: string;
  signalKind?: string;
  turns?: number;
  updatedAt?: number;
}

/** One statusline-observed model per session (key: session id, else cwd). */
export type SessionModels = Record<string, { model: string; seenAt: number }>;

/** Entries older than this are dropped (a day-old session has no live tip). */
const SESSION_MODEL_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap so a long-lived home never grows the self-state file unbounded. */
const SESSION_MODELS_MAX = 32;

/**
 * The statusline's per-HOME self-state file. The statusline writes it every
 * tick; `session_models` in it is what lets this command re-pick the same tip.
 */
export function statuslineSelfStatePath(): string {
  return path.join(os.homedir(), ".claude", ".evo-self-state.json");
}

/**
 * Record `model` for `key` (the statusline's `sid || cwd`) and prune: expired
 * entries go, then the oldest beyond the cap. Pure — returns a new map.
 */
export function rememberSessionModel(
  prev: unknown,
  key: string,
  model: string,
  nowMs: number,
): SessionModels {
  const base: SessionModels =
    prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as SessionModels) : {};
  const merged: SessionModels = { ...base, [key]: { model, seenAt: nowMs } };
  const live = Object.entries(merged).filter(
    ([, v]) =>
      v &&
      typeof v.model === "string" &&
      v.model.length > 0 &&
      typeof v.seenAt === "number" &&
      Number.isFinite(v.seenAt) &&
      nowMs - v.seenAt < SESSION_MODEL_TTL_MS,
  );
  live.sort((a, b) => b[1].seenAt - a[1].seenAt); // newest first
  return Object.fromEntries(live.slice(0, SESSION_MODELS_MAX));
}

/** The model the statusline last saw for `key`, or null. */
function readSessionModel(key: string): string | null {
  try {
    const self = JSON.parse(fs.readFileSync(statuslineSelfStatePath(), "utf8")) as {
      session_models?: SessionModels;
    };
    const entry = self?.session_models?.[key];
    return entry && typeof entry.model === "string" && entry.model ? entry.model : null;
  } catch {
    return null;
  }
}

function readJson(filePath: string): LiveAdvice | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LiveAdvice;
  } catch {
    return null;
  }
}

/** Candidate live-state paths, newest per-session file first, then shared sinks. */
function candidatePaths(cwd: string): string[] {
  const out: string[] = [];
  const sessionsDir = path.join(cwd, ".evo", "sessions");
  try {
    const entries = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(sessionsDir, f))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const e of entries) out.push(e.p);
  } catch {
    // no sessions dir — fall through to shared sinks
  }
  out.push(path.join(cwd, ".evo", "live-state.json"));
  out.push(path.join(os.homedir(), ".claude", ".evo-live.json"));
  return out;
}

export function runAdviceCommand(options: { cwd?: string } = {}): void {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let data: LiveAdvice | null = null;
  let source = "";
  for (const c of candidatePaths(cwd)) {
    const d = readJson(c);
    if (d && (d.advice || d.adviceDetail)) {
      data = d;
      source = c;
      break;
    }
  }

  // Re-pick a filler tip exactly as the statusline does (same turn index, same
  // stdin model), so `evo advice` continues the tip the statusline showed.
  if (data && data.signalKind === "tip") {
    const sessionsDir = path.join(cwd, ".evo", "sessions");
    const key =
      path.dirname(source) === sessionsDir ? path.basename(source, ".json") : cwd;
    const model = readSessionModel(key);
    if (model) {
      const turns = typeof data.turns === "number" && Number.isFinite(data.turns) ? data.turns : 0;
      const t = pickTipForModel(turns, model);
      data = {
        ...data,
        advice: t.headline,
        adviceDetail: t.detail,
        beforeExample: t.beforeExample ?? "",
        afterExample: t.afterExample ?? "",
      };
    }
  }

  if (!data || !(data.advice || data.adviceDetail)) {
    console.log(
      "いま表示できるアドバイスはありません。EvoPet 記録中のセッションで、直近の指示に対する助言がここに出ます。",
    );
    return;
  }

  const lines: string[] = [];
  if (data.advice) lines.push(data.advice);
  if (data.adviceDetail) {
    if (lines.length) lines.push("");
    lines.push(data.adviceDetail);
  }
  if (data.beforeExample && data.afterExample) {
    lines.push("");
    lines.push(`❌ ${data.beforeExample}`);
    lines.push(`✅ ${data.afterExample}`);
  }
  console.log(lines.join("\n"));
}
