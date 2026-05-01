import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

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
