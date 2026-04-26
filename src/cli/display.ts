import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Persisted EvoPet statusline display modes.
 * - "minimum"   : compact single-line (default)
 * - "expansion" : verbose multi-line with advice/grade/etc.
 *
 * The mode file lives at ~/.claude/.evo-display-mode (single text token, no
 * trailing newline required). Tests can override the location via the
 * EVO_DISPLAY_MODE_FILE env var.
 */
export type DisplayMode = "minimum" | "expansion";

const VALID_MODES: DisplayMode[] = ["minimum", "expansion"];
const DEFAULT_MODE: DisplayMode = "minimum";

/** Resolve the mode file path, honoring EVO_DISPLAY_MODE_FILE for test isolation. */
export function getDisplayModeFile(): string {
  const override = process.env.EVO_DISPLAY_MODE_FILE;
  if (override !== undefined && override !== "") return override;
  return path.join(os.homedir(), ".claude", ".evo-display-mode");
}

/** Read the persisted mode. Returns DEFAULT_MODE when the file is missing or invalid. */
export function readCurrentMode(): DisplayMode {
  const file = getDisplayModeFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return DEFAULT_MODE;
  }
  const trimmed = raw.trim();
  if (trimmed === "minimum" || trimmed === "expansion") {
    return trimmed;
  }
  return DEFAULT_MODE;
}

/** Write a mode to disk, creating the parent directory if needed. */
function writeMode(mode: DisplayMode): void {
  const file = getDisplayModeFile();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; the writeFileSync below will surface any real failure.
  }
  fs.writeFileSync(file, mode);
}

/**
 * Implementation of `evo display [mode]`.
 *
 * No arg       → print current mode + usage hint.
 * "minimum"    → write "minimum".
 * "expansion"  → write "expansion".
 * "toggle"     → flip between minimum and expansion.
 * Anything else → print error to stderr and set process.exitCode = 1.
 *
 * On success, prints "EvoPet display: <mode> (statusline will refresh on next render)".
 */
export async function runDisplayCommand(mode?: string): Promise<void> {
  if (mode === undefined || mode === "") {
    const current = readCurrentMode();
    process.stdout.write(`EvoPet display: ${current}\n`);
    process.stdout.write("Usage: evo display [minimum|expansion|toggle]\n");
    return;
  }

  const normalized = mode.toLowerCase();
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
      `invalid display mode: ${mode}. Expected one of: ${VALID_MODES.join(", ")}, toggle\n`,
    );
    process.exitCode = 1;
    return;
  }

  writeMode(next);
  process.stdout.write(
    `EvoPet display: ${next} (statusline will refresh on next render)\n`,
  );
}
