import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Persisted EvoPet statusline display modes.
 * - "expansion" : verbose multi-line with advice/grade/etc. (default)
 * - "minimum"   : compact single-line (no output — use `evo display expansion` to re-enable)
 *
 * The mode file lives at ~/.claude/.evo-display-mode. Tests can override the
 * location via the EVO_DISPLAY_MODE_FILE env var.
 *
 * FILE FORMAT — whitespace/comma separated tokens, order irrelevant:
 *   "expansion"              legacy single-token form (still written when
 *                            everything is at its default) — must keep working
 *   "expansion scroll:off"   mode + an independent page-flip switch
 *
 * The scroll flag is INDEPENDENT of the mode, so `evo display scroll off` does
 * not disturb minimum/expansion and vice versa. Anything unrecognised in the
 * file is ignored rather than treated as an error (fail-open: a corrupt file
 * renders the defaults, never crashes the statusline).
 */
export type DisplayMode = "minimum" | "expansion";

const VALID_MODES: DisplayMode[] = ["minimum", "expansion"];
const DEFAULT_MODE: DisplayMode = "expansion";
/** Page-flipping long advice is ON unless the file explicitly says otherwise. */
const DEFAULT_SCROLL = true;
const SCROLL_OFF_TOKEN = "scroll:off";

export interface DisplaySettings {
  mode: DisplayMode;
  scroll: boolean;
}

/** Resolve the mode file path, honoring EVO_DISPLAY_MODE_FILE for test isolation. */
export function getDisplayModeFile(): string {
  const override = process.env.EVO_DISPLAY_MODE_FILE;
  if (override !== undefined && override !== "") return override;
  return path.join(os.homedir(), ".claude", ".evo-display-mode");
}

/** Parse the token soup in the mode file. Unknown tokens are ignored. */
export function parseDisplaySettings(raw: string): DisplaySettings {
  const tokens = String(raw ?? "")
    .split(/[\s,]+/u)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const mode =
    (tokens.find((t) => t === "minimum" || t === "expansion") as
      | DisplayMode
      | undefined) ?? DEFAULT_MODE;
  const scroll = tokens.includes(SCROLL_OFF_TOKEN) ? false : DEFAULT_SCROLL;
  return { mode, scroll };
}

/** Read mode + scroll. Returns the defaults when the file is missing/invalid. */
export function readDisplaySettings(): DisplaySettings {
  const file = getDisplayModeFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { mode: DEFAULT_MODE, scroll: DEFAULT_SCROLL };
  }
  return parseDisplaySettings(raw);
}

/** Read the persisted mode. Returns DEFAULT_MODE when the file is missing or invalid. */
export function readCurrentMode(): DisplayMode {
  return readDisplaySettings().mode;
}

/** Is automatic page-flipping of long advice enabled? Defaults to true. */
export function readScrollEnabled(): boolean {
  return readDisplaySettings().scroll;
}

/**
 * Persist mode + scroll. The legacy single-token form is preserved whenever
 * scroll is at its default, so an existing "expansion" file is not churned and
 * older readers keep working.
 */
function writeSettings(next: DisplaySettings): void {
  const file = getDisplayModeFile();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; the writeFileSync below will surface any real failure.
  }
  const body = next.scroll ? next.mode : `${next.mode} ${SCROLL_OFF_TOKEN}`;
  fs.writeFileSync(file, body);
}

/** Write a mode to disk, preserving the current scroll flag. */
function writeMode(mode: DisplayMode): void {
  writeSettings({ mode, scroll: readDisplaySettings().scroll });
}

/**
 * `scroll:off` → the "off" half. The two-word `scroll off` is canonical; this
 * single alias exists for callers that can only pass one token.
 */
function splitScrollToken(token: string): string | null {
  const m = token.match(/^scroll:(.*)$/u);
  return m ? m[1] : null;
}

function applyScroll(value: string): void {
  const current = readDisplaySettings();
  // No value: report, don't change — same shape as bare `evo display`.
  if (value === "") {
    process.stdout.write(
      `EvoPet advice auto-scroll: ${current.scroll ? "on" : "off"}\n`,
    );
    process.stdout.write("Usage: evo display scroll [on|off|toggle]\n");
    return;
  }
  let scroll: boolean;
  if (value === "on" || value === "true" || value === "1") {
    scroll = true;
  } else if (value === "off" || value === "false" || value === "0") {
    scroll = false;
  } else if (value === "toggle") {
    scroll = !current.scroll;
  } else {
    process.stderr.write(
      `invalid scroll value: ${value}. Expected one of: on, off, toggle\n`,
    );
    process.exitCode = 1;
    return;
  }
  writeSettings({ mode: current.mode, scroll });
  process.stdout.write(
    `EvoPet advice auto-scroll: ${scroll ? "on" : "off"} (statusline will refresh on next render)\n`,
  );
}

/**
 * Implementation of `evo display [mode] [value]`.
 *
 * No arg           → print current mode + scroll + usage hint.
 * "minimum"        → write "minimum".
 * "expansion"      → write "expansion".
 * "toggle"         → flip between minimum and expansion.
 * "scroll on|off|toggle" (single-token alias: "scroll:off")
 *                  → flip automatic page-flipping of long advice, leaving the
 *                    display mode untouched. Bare "scroll" reports the state.
 * Anything else    → print error to stderr and set process.exitCode = 1.
 *
 * On success, prints "EvoPet display: <mode> (statusline will refresh on next render)".
 */
export async function runDisplayCommand(mode?: string, value?: string): Promise<void> {
  if (mode === undefined || mode === "") {
    const current = readDisplaySettings();
    process.stdout.write(`EvoPet display: ${current.mode}\n`);
    process.stdout.write(
      `EvoPet advice auto-scroll: ${current.scroll ? "on" : "off"}\n`,
    );
    process.stdout.write("Usage: evo display [minimum|expansion|toggle]\n");
    process.stdout.write("       evo display scroll [on|off|toggle]\n");
    return;
  }

  const normalized = mode.toLowerCase();

  // Scroll switch — independent of minimum/expansion.
  const inlineScroll = splitScrollToken(normalized);
  if (inlineScroll !== null) {
    applyScroll(inlineScroll);
    return;
  }
  if (normalized === "scroll") {
    applyScroll((value ?? "").toLowerCase());
    return;
  }

  let next: DisplayMode;
  if (normalized === "minimum") {
    next = "minimum";
  } else if (normalized === "expansion") {
    next = "expansion";
  } else if (normalized === "toggle") {
    const current = readCurrentMode();
    next = current === "minimum" ? "expansion" : "minimum";
  } else {
    process.stderr.write(
      `invalid display mode: ${mode}. Expected one of: ${VALID_MODES.join(", ")}, toggle, scroll\n`,
    );
    process.exitCode = 1;
    return;
  }

  writeMode(next);
  process.stdout.write(
    `EvoPet display: ${next} (statusline will refresh on next render)\n`,
  );
}
