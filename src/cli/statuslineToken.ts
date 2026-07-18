/**
 * Token-half rendering for the statusline — the `model · usage · cwd` line.
 *
 * This is the TypeScript port of the token portion shared by
 * `scripts/token_statusline.py` and the head of `statusline.py`. It exists so
 * `evo statusline --full` can render the COMPLETE statusline (token line +
 * EvoPet block) from a single TS process, letting `evo install-statusline`
 * wire Claude Code straight at the TS renderer instead of deploying the
 * 1090-line Python `statusline.py` (C1).
 *
 * Output parity with the Python token half is intentional and byte-exact:
 * same ANSI colors, same gradient dots, same cwd collapse, same ` · `
 * separator, no trailing newline.
 */

// ── ANSI (matches statusline.py / token_statusline.py) ──
const R = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
// The Python calls this CYAN but the value is an amber/orange used for the cwd.
const CWD_COLOR = "\x1b[38;2;255;185;80m";

/** ` · ` in dim — the token-line separator (identical to the EvoPet SEP). */
export const TOKEN_SEP = ` ${DIM}·${R} `;

/**
 * Python `round()` uses banker's rounding (round-half-to-even); JS `Math.round`
 * rounds half up. Match Python so a fractional percentage ending in .5 renders
 * the same digit in both renderers.
 */
function pyRound(n: number): number {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 → round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Gradient color for a 0–100 percentage — green → amber → red (Python parity). */
function gradient(pct: number): string {
  if (pct < 50) {
    const r = Math.trunc(pct * 5.1);
    return `\x1b[38;2;${r};200;80m`;
  }
  const g = Math.trunc(200 - (pct - 50) * 4);
  return `\x1b[38;2;255;${Math.max(g, 0)};60m`;
}

/** A gradient dot plus a bold rounded percentage, e.g. `●  20%`. */
function dot(pct: number): string {
  const p = pyRound(pct);
  return `${gradient(pct)}●${R} ${BOLD}${p}%${R}`;
}

/** Statusline stdin shape (only the token-relevant fields). */
export interface TokenStatuslineInput {
  model?: unknown;
  cwd?: unknown;
  workspace?: unknown;
  context_window?: unknown;
  rate_limits?: unknown;
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asPercentage(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Resolve the display cwd, collapsing $HOME to `~` and eliding to the last two
 * path segments (`…/parent/dir`) when the path has more than three segments —
 * identical to the Python renderer.
 */
export function collapseCwd(cwd: string, homeDir: string): string {
  const home = homeDir.replace(/\\/g, "/");
  const norm = cwd.replace(/\\/g, "/").split(home).join("~");
  const parts = norm.split("/");
  if (parts.length > 3) {
    return "…/" + parts.slice(-2).join("/");
  }
  return norm;
}

export interface RenderTokenLineDeps {
  /** Home directory (defaults to os.homedir()); injectable for tests. */
  homeDir: string;
  /** Fallback cwd when the payload omits it (defaults to process.cwd()). */
  fallbackCwd: string;
}

/**
 * Render the token line: `model · [ctx …][ · 5h …][ · 7d …] · <cwd>`.
 * Missing usage chips are omitted exactly as the Python renderer omits them.
 * No trailing newline (the caller joins the EvoPet block after it).
 */
export function renderTokenLine(
  data: TokenStatuslineInput,
  deps: RenderTokenLineDeps,
): string {
  const model = asRecord(data.model);
  const modelName =
    typeof model.display_name === "string" && model.display_name
      ? model.display_name
      : "Claude";

  const cwdRaw =
    (typeof data.cwd === "string" && data.cwd) ||
    (() => {
      const ws = asRecord(data.workspace);
      return typeof ws.current_dir === "string" ? ws.current_dir : "";
    })() ||
    deps.fallbackCwd;
  const cwdDisplay = collapseCwd(cwdRaw, deps.homeDir);

  const usage: string[] = [];
  const ctx = asPercentage(asRecord(data.context_window).used_percentage);
  if (ctx !== null) usage.push(`ctx ${dot(ctx)}`);
  const rl = asRecord(data.rate_limits);
  const five = asPercentage(asRecord(rl.five_hour).used_percentage);
  if (five !== null) usage.push(`5h ${dot(five)}`);
  const week = asPercentage(asRecord(rl.seven_day).used_percentage);
  if (week !== null) usage.push(`7d ${dot(week)}`);

  const parts: string[] = [`${BOLD}${modelName}${R}`];
  if (usage.length > 0) parts.push(usage.join(TOKEN_SEP));
  parts.push(`${CWD_COLOR}${cwdDisplay}${R}`);

  return parts.join(TOKEN_SEP);
}
