import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { runInstallStatusline } from "./cli/installStatusline";

/**
 * Subcommands that should NEVER trigger the first-run prompt.
 * - install-statusline: avoid recursion into the same flow.
 * - --version / -V: one-shot informational; don't interrupt.
 */
const SKIP_SUBCOMMANDS = new Set<string>([
  "install-statusline",
  "--version",
  "-V",
]);

export interface FirstRunPromptOptions {
  /** Override homedir for tests. */
  homeDir?: string;
  /** Override TTY check for tests. */
  isTTY?: boolean;
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override prompt for tests; returns "y"/"n"/etc. */
  prompt?: (question: string) => Promise<string>;
  /** Override stdout for tests. */
  log?: (msg: string) => void;
  /**
   * Override the function that runs the actual install flow.
   * Default: real runInstallStatusline. Tests can swap this to capture invocation.
   */
  runInstall?: (homeDir: string) => Promise<void>;
}

interface ResolvedFirstRunPaths {
  home: string;
  sentinelDir: string;
  sentinelFile: string;
  settingsPath: string;
}

function resolveFirstRunPaths(home: string): ResolvedFirstRunPaths {
  const sentinelDir = path.join(home, ".evo");
  return {
    home,
    sentinelDir,
    sentinelFile: path.join(sentinelDir, "install-prompt-shown"),
    settingsPath: path.join(home, ".claude", "settings.json"),
  };
}

/**
 * Inspect ~/.claude/settings.json. Return true iff its `statusLine.command`
 * references an evopet-deployed `base_statusline.py` path. Any read or parse
 * failure conservatively returns false (treat as "not configured yet").
 */
function settingsAlreadyConfigured(settingsPath: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) return false;
    const raw = fs.readFileSync(settingsPath, "utf8");
    if (raw.trim().length === 0) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sl = parsed.statusLine as Record<string, unknown> | undefined;
    if (!sl || typeof sl !== "object") return false;
    const cmd = sl.command;
    if (typeof cmd !== "string") return false;
    return /base_statusline\.py/i.test(cmd);
  } catch {
    return false;
  }
}

function writeSentinel(paths: ResolvedFirstRunPaths): void {
  try {
    fs.mkdirSync(paths.sentinelDir, { recursive: true });
    fs.writeFileSync(
      paths.sentinelFile,
      `${new Date().toISOString()}\n`,
    );
  } catch {
    // best-effort; if this fails the user just gets re-prompted next time,
    // which is harmless
  }
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

function isAffirmativeOrDefault(answer: string): boolean {
  // Default Yes: empty answer counts as yes.
  const trimmed = answer.trim();
  if (trimmed.length === 0) return true;
  return /^(y|yes)$/i.test(trimmed);
}

/**
 * Maybe run the first-run statusline-install prompt.
 *
 * Called from a commander preAction hook before any subcommand executes.
 * Returns immediately (no prompt) when:
 *   - the requested subcommand is itself install-statusline, --version, or -V
 *   - stdin is not a TTY
 *   - EVO_NO_INSTALL_PROMPT=1 is set
 *   - the sentinel file already exists
 *   - settings.json already references the evopet statusline
 *
 * Otherwise prompts once. On Yes -> runs runInstallStatusline + writes sentinel.
 * On No -> writes sentinel only. Either way, returns and lets the original
 * subcommand proceed.
 */
export async function maybeRunFirstRunPrompt(
  currentSubcommand: string,
  options: FirstRunPromptOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const log = options.log ?? ((msg: string) => console.log(msg));
  const askPrompt = options.prompt ?? defaultPrompt;

  if (SKIP_SUBCOMMANDS.has(currentSubcommand)) return;
  if (!isTTY) return;
  if (env.EVO_NO_INSTALL_PROMPT === "1") return;

  const paths = resolveFirstRunPaths(home);

  if (fs.existsSync(paths.sentinelFile)) return;
  if (settingsAlreadyConfigured(paths.settingsPath)) return;

  log("EvoPet statusline integration not detected.");
  const answer = await askPrompt("Set up Claude Code statusline now? [Y/n] ");

  if (isAffirmativeOrDefault(answer)) {
    const runInstall =
      options.runInstall ??
      (async (h: string) => {
        await runInstallStatusline({ homeDir: h });
      });
    try {
      await runInstall(home);
    } catch (err) {
      log(`Statusline install failed: ${(err as Error).message}`);
      // fall through to sentinel write so the user is not nagged again
    }
    writeSentinel(paths);
    return;
  }

  log("Skipping. You can run `evo install-statusline` later if you change your mind.");
  writeSentinel(paths);
}
