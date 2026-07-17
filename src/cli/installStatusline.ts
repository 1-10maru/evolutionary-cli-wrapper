// `evo install-statusline` — the END-USER, single-file statusline installer.
//
// It deploys the FULL `statusline.py` (token line + EvoPet) to
// `~/.claude/base_statusline.py` and points settings.json at it directly. This
// is one of two supported constructions:
//   • single-file (THIS command): full renderer, no wrapper. For end users who
//     just want EvoPet in their statusline.
//   • split "wrapper": a TOKEN-ONLY base + `evo statusline`, joined by a wrapper
//     script. Deployed by `npm run setup` for the dev / hand-built setup.
// The two must not clobber each other: this command DETECTS an existing wrapper
// construction (see looksLikeWrapperConstruction) and refuses to overwrite it,
// so a full renderer is never stacked on top of a token-only base (which would
// render EvoPet twice).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { getDisplayModeFile } from "./display";

export interface InstallStatuslineOptions {
  yes?: boolean;
  uninstall?: boolean;
  /**
   * Override the package root used to locate `statusline.py`.
   * Defaults to two levels up from this compiled file (dist/cli/ → dist/ → repo root).
   */
  packageRoot?: string;
  /**
   * Override the home directory. Used by tests to point at a tmp dir.
   */
  homeDir?: string;
  /**
   * Override the readline prompt for tests.
   */
  prompt?: (question: string) => Promise<string>;
  /**
   * Override stdout for tests.
   */
  log?: (msg: string) => void;
}

interface ResolvedPaths {
  statuslineSrc: string;
  claudeDir: string;
  statuslineDst: string;
  settingsPath: string;
}

function resolvePaths(opts: InstallStatuslineOptions): ResolvedPaths {
  const packageRoot = opts.packageRoot ?? path.resolve(__dirname, "..", "..");
  const home = opts.homeDir ?? os.homedir();
  const claudeDir = path.join(home, ".claude");
  return {
    statuslineSrc: path.join(packageRoot, "statusline.py"),
    claudeDir,
    statuslineDst: path.join(claudeDir, "base_statusline.py"),
    settingsPath: path.join(claudeDir, "settings.json"),
  };
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Statusline command we deploy. We use literal `python` (not `python3`):
 * - On Windows, `python3` is rarely on PATH; `python` is the standard launcher.
 * - On macOS / Linux, modern installs alias `python` to Python 3, and most users
 *   running Claude Code already have it. The existing install/evopet-install.sh
 *   uses the same form, so we stay consistent.
 */
function buildStatuslineCommand(deployPath: string): string {
  // Use forward slashes for portability inside the JSON string. Python on
  // Windows accepts forward slashes in path arguments.
  const normalized = deployPath.replace(/\\/g, "/");
  return `python "${normalized}"`;
}

interface DesiredStatusline {
  type: "command";
  command: string;
}

function statuslineMatches(existing: unknown, desired: DesiredStatusline): boolean {
  if (!existing || typeof existing !== "object") return false;
  const obj = existing as Record<string, unknown>;
  return obj.type === desired.type && obj.command === desired.command;
}

function looksLikeEvopetCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /base_statusline\.py/i.test(command);
}

// The EvoPet statusline can be deployed two ways, for two audiences:
//   • single-file renderer (what THIS command installs): the full `statusline.py`
//     copied to `~/.claude/base_statusline.py`, invoked directly by settings.json.
//   • split "wrapper" construction (what `npm run setup` / a hand-built dev setup
//     uses): a TOKEN-ONLY base + `evo statusline`, joined by a wrapper script so
//     the token line and the EvoPet block render on the same stdin.
// `evo install-statusline` only owns the single-file path. If it detected the
// wrapper construction and deployed the full renderer over the token-only base,
// EvoPet would render twice (once from the full base, once from `evo statusline`).
// So we detect an existing wrapper setup and refuse to clobber it.
function looksLikeWrapperConstruction(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /statusline-wrapper|evo\s+statusline/i.test(command);
}

/** Peek `statusLine.command` from settings.json; undefined if absent/unparseable. */
function readStatusLineCommand(settingsPath: string): unknown {
  try {
    if (!fs.existsSync(settingsPath)) return undefined;
    const raw = fs.readFileSync(settingsPath, "utf8");
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sl = parsed.statusLine;
    return sl && typeof sl === "object" ? (sl as Record<string, unknown>).command : undefined;
  } catch {
    // Unparseable settings — let the normal flow surface the JSON error later.
    return undefined;
  }
}

export async function runInstallStatusline(
  options: InstallStatuslineOptions = {},
): Promise<{
  deployedTo?: string;
  settingsBackup?: string;
  settingsUpdated: boolean;
  uninstalled?: boolean;
  noop?: boolean;
}> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const askPrompt = options.prompt ?? defaultPrompt;
  const paths = resolvePaths(options);

  if (options.uninstall) {
    return uninstall({ paths, log });
  }

  if (!fs.existsSync(paths.statuslineSrc)) {
    throw new Error(
      `statusline.py not found at ${paths.statuslineSrc}. Reinstall the evolutionary-cli-wrapper package.`,
    );
  }

  // A2: never clobber a hand-built / setup-deployed WRAPPER construction. If the
  // current statusLine.command runs a wrapper (or `evo statusline`), the base is
  // token-only and deploying the full renderer would double-render EvoPet — so
  // skip entirely and leave the user's wiring untouched.
  const existingCommand = readStatusLineCommand(paths.settingsPath);
  if (looksLikeWrapperConstruction(existingCommand)) {
    log(
      "Detected an existing wrapper-based statusline (statusLine.command runs a " +
        "wrapper / `evo statusline`). Leaving it untouched — `evo install-statusline` " +
        "manages only the single-file renderer and will not overwrite a wrapper setup.",
    );
    return { settingsUpdated: false, noop: true };
  }

  if (!options.yes) {
    log(`This will:`);
    log(`  - Copy ${paths.statuslineSrc}`);
    log(`         → ${paths.statuslineDst}`);
    log(`  - Update ${paths.settingsPath} (backup created first)`);
    const ans = await askPrompt("Proceed? [y/N] ");
    if (!isAffirmative(ans)) {
      log("Aborted.");
      return { settingsUpdated: false, noop: true };
    }
  }

  fs.mkdirSync(paths.claudeDir, { recursive: true });
  fs.copyFileSync(paths.statuslineSrc, paths.statuslineDst);
  log(`Copied statusline.py → ${paths.statuslineDst}`);

  const desired: DesiredStatusline = {
    type: "command",
    command: buildStatuslineCommand(paths.statuslineDst),
  };

  let parsed: Record<string, unknown> = {};
  let settingsExisted = false;
  if (fs.existsSync(paths.settingsPath)) {
    settingsExisted = true;
    const raw = fs.readFileSync(paths.settingsPath, "utf8");
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Failed to parse ${paths.settingsPath}: ${(err as Error).message}. ` +
            `Fix the JSON manually or move it aside, then rerun.`,
        );
      }
    }
  }

  const existingStatusline = parsed.statusLine;

  if (statuslineMatches(existingStatusline, desired)) {
    log(`settings.json statusLine already correct, skipping write.`);
    log(``);
    log(`Files written:`);
    log(`  ${paths.statuslineDst}`);
    log(`Next step: restart your Claude Code session.`);
    return { deployedTo: paths.statuslineDst, settingsUpdated: false };
  }

  if (
    existingStatusline &&
    typeof existingStatusline === "object" &&
    !looksLikeEvopetCommand((existingStatusline as Record<string, unknown>).command) &&
    !options.yes
  ) {
    const cur = (existingStatusline as Record<string, unknown>).command;
    log(`Existing statusLine command found: ${String(cur)}`);
    const ans = await askPrompt("Overwrite with evopet's statusline? [y/N] ");
    if (!isAffirmative(ans)) {
      log("Kept existing statusLine. statusline.py was deployed but settings.json was not modified.");
      return { deployedTo: paths.statuslineDst, settingsUpdated: false };
    }
  }

  let backupPath: string | undefined;
  if (settingsExisted) {
    backupPath = `${paths.settingsPath}.bak.${timestamp()}`;
    fs.copyFileSync(paths.settingsPath, backupPath);
    log(`Backed up existing settings.json → ${backupPath}`);
  }

  parsed.statusLine = desired;
  fs.writeFileSync(paths.settingsPath, JSON.stringify(parsed, null, 2) + "\n");
  log(`Updated ${paths.settingsPath}`);

  // Initialise display mode to "expansion" for first-time installs so EvoPet
  // is visible immediately. Existing users who already wrote a mode file keep
  // their preference unchanged.
  const modeFile = getDisplayModeFile();
  if (!fs.existsSync(modeFile)) {
    try {
      fs.mkdirSync(path.dirname(modeFile), { recursive: true });
      fs.writeFileSync(modeFile, "expansion");
      log(`Set EvoPet display mode: expansion (run "evo display minimum" to compact)`);
    } catch {
      // Best-effort; failure here should not abort a successful install.
    }
  }

  log(``);
  log(`Files written:`);
  log(`  ${paths.statuslineDst}`);
  log(`  ${paths.settingsPath}`);
  if (backupPath) log(`Backup created: ${backupPath}`);
  log(`Next step: restart your Claude Code session.`);

  return {
    deployedTo: paths.statuslineDst,
    settingsBackup: backupPath,
    settingsUpdated: true,
  };
}

function uninstall({
  paths,
  log,
}: {
  paths: ResolvedPaths;
  log: (msg: string) => void;
}): {
  settingsUpdated: boolean;
  uninstalled: true;
  deployedTo?: string;
  settingsBackup?: string;
} {
  let removedFile = false;
  if (fs.existsSync(paths.statuslineDst)) {
    fs.unlinkSync(paths.statuslineDst);
    removedFile = true;
    log(`Removed ${paths.statuslineDst}`);
  } else {
    log(`No file at ${paths.statuslineDst}, skipping.`);
  }

  // Find the most recent backup and restore it.
  let restored = false;
  if (fs.existsSync(paths.claudeDir)) {
    const entries = fs.readdirSync(paths.claudeDir);
    const backups = entries
      .filter((name) => name.startsWith("settings.json.bak."))
      .sort();
    const latest = backups[backups.length - 1];
    if (latest) {
      const backupFull = path.join(paths.claudeDir, latest);
      fs.copyFileSync(backupFull, paths.settingsPath);
      log(`Restored settings.json from ${backupFull}`);
      restored = true;
    } else if (fs.existsSync(paths.settingsPath)) {
      // No backup — strip the statusLine key if it points to evopet.
      try {
        const raw = fs.readFileSync(paths.settingsPath, "utf8");
        const parsed = (raw.trim().length ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const cur = parsed.statusLine as Record<string, unknown> | undefined;
        if (cur && looksLikeEvopetCommand(cur.command)) {
          delete parsed.statusLine;
          fs.writeFileSync(paths.settingsPath, JSON.stringify(parsed, null, 2) + "\n");
          log(`Removed evopet statusLine entry from ${paths.settingsPath} (no backup found).`);
          restored = true;
        }
      } catch {
        // best-effort; do not fail uninstall
      }
    }
  }

  return {
    settingsUpdated: restored,
    uninstalled: true,
    deployedTo: removedFile ? paths.statuslineDst : undefined,
  };
}
