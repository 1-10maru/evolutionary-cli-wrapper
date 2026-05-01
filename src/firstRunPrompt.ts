import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { runInstallStatusline } from "./cli/installStatusline";

/**
 * Subcommands that should NEVER trigger the first-run prompt.
 *
 * Categories:
 * - External-CLI wrappers: invoked by claude/codex shims as
 *   `evo proxy --cli claude -- ...` or `evo run -- ...`. Firing the prompt
 *   here would interrupt the user's actual claude/codex session — never OK.
 * - Shim/PATH state managers: `pause`, `resume`, `shell`, `setup-shell`,
 *   `undo-shell`, `uninstall`. These are infrastructure commands often
 *   driven by automation; an interactive prompt is hostile.
 * - Diagnostic / one-shot info-only commands: `--version`, `-V`, `--help`,
 *   `-h`, `logs`, `stats`, `storage`, `explain`. The user expects output
 *   only, not setup interaction.
 * - Recursion guard: `install-statusline` itself.
 *
 * The prompt is still allowed for genuinely interactive setup commands
 * (`init`, `mode`, `pet`, `issue`, `forget`, `display`, etc.) where a
 * one-time prompt for statusline integration is acceptable.
 */
const SKIP_SUBCOMMANDS = new Set<string>([
  // External-CLI wrappers (shim-invoked) — MUST stay in skip list.
  "proxy",
  "run",
  // Shim/PATH state management.
  "pause",
  "resume",
  "shell",
  "setup-shell",
  "undo-shell",
  "uninstall",
  // Diagnostic / info-only.
  "logs",
  "stats",
  "storage",
  "explain",
  "compact",
  "export-knowledge",
  "import-knowledge",
  "statusline",
  // One-shot version/help flags (commander may pass these as the "subcommand"
  // name when no real command is matched).
  "--version",
  "-V",
  "--help",
  "-h",
  // Recursion guard.
  "install-statusline",
]);

/**
 * Detect whether this evo invocation came through a claude/codex shim.
 *
 * The shell shim resolves to `node /path/to/dist/index.js proxy --cli claude -- ...`.
 * In that case `process.argv[1]` is the JS entrypoint (dist/index.js), not
 * `claude`. But defensively we also handle the case where someone has
 * symlinked/renamed the entrypoint to a name ending in `claude` or `codex`.
 *
 * Precise rule: the basename of argv[1], stripped of common script
 * extensions, must equal `claude` or `codex` (case-insensitive).
 */
function isShimInvokedByName(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (!entry || typeof entry !== "string") return false;
  const base = path.basename(entry).toLowerCase();
  // Strip a single trailing extension if present (.js, .cjs, .mjs, .cmd, .bat,
  // .ps1, .sh, .exe). We do NOT strip every dot — just one common one — so
  // names like `claude.js` match but `claude.evo.js` does not (it would have
  // basename `claude.evo.js` -> stripped to `claude.evo`, which is fine).
  const withoutExt = base.replace(/\.(js|cjs|mjs|cmd|bat|ps1|sh|exe)$/i, "");
  return withoutExt === "claude" || withoutExt === "codex";
}

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
  /** Override process.argv for tests. */
  argv?: readonly string[];
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
 * Returns immediately (no prompt) when ANY of the following is true:
 *   - the requested subcommand is in SKIP_SUBCOMMANDS (proxy, run, pause,
 *     resume, shell, setup-shell, undo-shell, uninstall, logs, stats,
 *     storage, explain, compact, export-knowledge, import-knowledge,
 *     statusline, --version, -V, --help, -h, install-statusline)
 *   - process.argv[1] ends in `claude` or `codex` (shim-invoked path) —
 *     belt-and-suspenders against any subcommand reaching the prompt
 *     when the entrypoint itself is the shim
 *   - stdin is not a TTY (non-interactive invocation, e.g. piped, cron, CI)
 *   - EVO_NO_INSTALL_PROMPT=1 is set
 *   - EVO_PROXY_ACTIVE=1 is set (we are running inside a proxy spawn)
 *   - the sentinel file already exists
 *   - settings.json already references the evopet statusline
 *
 * Otherwise prompts once. On Yes -> runs runInstallStatusline + writes sentinel.
 * On No -> writes sentinel only. Either way, returns and lets the original
 * subcommand proceed.
 *
 * RATIONALE: the prompt firing during a `claude` or `codex` session would
 * interrupt the user's actual work. The `proxy` and `run` subcommands are
 * the wrapper entry points used by the shell shims; they MUST be silent.
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
  const argv = options.argv ?? process.argv;

  if (SKIP_SUBCOMMANDS.has(currentSubcommand)) return;
  if (isShimInvokedByName(argv)) return;
  if (!isTTY) return;
  if (env.EVO_NO_INSTALL_PROMPT === "1") return;
  if (env.EVO_PROXY_ACTIVE === "1") return;

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
