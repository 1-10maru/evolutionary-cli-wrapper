#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { Command } from "commander";
import path from "node:path";
import { assertSafeCommandPath, quoteArgForCmd } from "./proxy/spawnCommand";
import { ensureEvoConfig, getBinDir, removeEvoData, updateEvoConfig } from "./config";
import { EvoDatabase } from "./db";
import { readIssueIntake } from "./issueIntake";
import { getLogger } from "./logger";
import { chooseMascotSpecies, formatMascotSpeciesList, loadMascotProfile } from "./mascot";
import { runProxySession } from "./proxyRuntime";
import { runEpisode } from "./runtime";
import { runLogsCommand } from "./cli/logs";
import { runDoctor } from "./cli/doctor";
import { runDisplayCommand } from "./cli/display";
import { runStatuslineCommand } from "./cli/statusline";
import { runAdviceCommand } from "./cli/advice";
import { runInstallStatusline } from "./cli/installStatusline";
import { quickHealthReport, writeSelfCheckState } from "./health";
import { maybeRunFirstRunPrompt } from "./firstRunPrompt";
import {
  getShellStatus,
  resolveOriginalCommand,
  setupShellIntegration,
  undoShellIntegration,
} from "./shellIntegration";
import { formatExplain, formatIssueIntake, formatMascotStats, formatRunSummary, formatStats, formatStorage } from "./ui";

/**
 * Native CLI subcommands that should bypass Evo proxy entirely.
 * These produce their own stdout and must not be decorated with
 * mascot output, tracking, or run summaries.
 */
const PASSTHROUGH_SUBCOMMANDS = new Set(["review"]);

/**
 * Native update-family subcommands that must never be proxied — even at the top
 * level. Claude Code's own auto-updater (and the manual `claude update` /
 * `install` / `migrate-installer` flows) relaunch `claude` and manage helper
 * child processes of their own. Proxying these would (a) hold the running
 * `claude` executable open as an Evo-managed child so Windows cannot replace the
 * locked image (`update_apply_exe_locked`), and (b) let Evo's signal escalation
 * tree-kill a deferred updater helper. We hand these straight to the real CLI
 * with no tracking and no signal handlers.
 */
const UPDATE_SUBCOMMANDS = new Set(["update", "install", "migrate-installer"]);

/**
 * True when this invocation is an update-family operation: a leading update
 * subcommand (`claude update`), or the top-level `--update` flag anywhere in
 * the argument list (`claude --update`).
 */
export function isUpdateInvocation(args: string[]): boolean {
  if (args.length > 0 && UPDATE_SUBCOMMANDS.has(args[0].toLowerCase())) return true;
  return args.some((arg) => arg === "--update");
}

const cliPassthroughLog = getLogger().child("cli.passthrough");
const cliResolveLog = getLogger().child("cli.resolve");

function formatMissingOriginalCommandMessage(cli: "claude"): string {
  return `Could not resolve the original ${cli} command. Evo checked PATH after excluding its own shim, but no live ${cli} install was found. Reinstall the upstream ${cli} CLI, then run npm run setup again if needed.\n`;
}

/**
 * Patch the wrapped-CLI live-state files with passthrough exit info, but ONLY
 * if the files already exist. Passthrough subcommands (e.g. `claude review`)
 * should never CREATE these files — that is the proxy runtime's job.
 *
 * Failures are swallowed silently; this is best-effort observability.
 */
function patchLiveStateOnPassthroughExit(
  cwd: string,
  exitCode: number,
  subcommand: string,
): void {
  const targets = [
    path.join(cwd, ".evo", "live-state.json"),
    path.join(os.homedir(), ".claude", ".evo-live.json"),
  ];
  const now = Date.now();
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) continue;
      const raw = fs.readFileSync(target, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.lastExitCode = exitCode;
      parsed.lastExitSignal = null;
      parsed.lastExitAt = now;
      parsed.lastSubcommand = subcommand;
      parsed.updatedAt = now;
      const json = JSON.stringify(parsed);
      const tmp = `${target}.tmp`;
      try {
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, target);
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        try { fs.writeFileSync(target, json); } catch { /* ignore */ }
      }
    } catch {
      // best-effort — never fail the passthrough on observability writes
    }
  }
}

/**
 * Run the wrapped CLI transparently: no Evo tracking, episode, statusline, run
 * summary, or signal machinery. Resolves the original command, inherits stdio,
 * forwards the child's exit code, and force-exits with it. Used for three cases:
 *
 *   - "subcommand": native passthrough subcommands (e.g. `claude review`).
 *   - "update":     update-family ops (`claude update` / `claude --update`).
 *                   No signal handlers are installed, so Evo can never tree-kill
 *                   a deferred updater helper, and the real CLI owns its own
 *                   child processes and exe replacement.
 *   - "nested":     EVO_PROXY_ACTIVE=1 — claude re-invoked `claude` by name (a
 *                   /logout re-auth flow or an updater relaunch) and hit the evo
 *                   shim again. Opening a second proxy session here is what made
 *                   the outer wrapper wait forever (the /logout hang), so we must
 *                   pass straight through and create no nested episode.
 *
 * Never creates the wrapped-CLI live-state files; it only patches them if they
 * already exist (best-effort observability).
 */
async function runTransparentPassthrough(
  cwd: string,
  cli: "claude",
  args: string[],
  reason: "subcommand" | "update" | "nested" | "self-check",
): Promise<void> {
  const originalCommand = resolveOriginalCommand(cwd, cli);
  if (!originalCommand) {
    cliResolveLog.error("could not resolve original CLI", {
      cli,
      message: `no live ${cli} install on PATH after excluding evo shim`,
    });
    process.stderr.write(formatMissingOriginalCommandMessage(cli));
    process.exit(1);
  }
  // Quote arguments identically to the proxy path: for a .cmd/.bat original,
  // use cmd.exe-aware per-arg quoting (quoteArgForCmd) with
  // windowsVerbatimArguments + a safety check on the command path, so embedded
  // " & | < > ^ reach the child verbatim instead of being interpreted by
  // cmd.exe (mangling / command injection). Non-shell originals pass the argv
  // array directly (shell:false), which needs no quoting.
  const ext = path.extname(originalCommand).toLowerCase();
  const needsShell = ext === ".cmd" || ext === ".bat";
  const passthroughEnv = { ...process.env, EVO_PROXY_ACTIVE: "1" };
  let child;
  if (needsShell) {
    assertSafeCommandPath(originalCommand);
    child = spawn(originalCommand, args.map(quoteArgForCmd), {
      cwd,
      shell: true,
      windowsVerbatimArguments: true,
      stdio: "inherit",
      env: passthroughEnv,
    });
  } else {
    child = spawn(originalCommand, args, {
      cwd,
      stdio: "inherit",
      env: passthroughEnv,
    });
  }
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    cliPassthroughLog.warn("passthrough exited non-zero", {
      cli,
      exitCode: code,
      reason,
      // Log only the first arg (subcommand/flag) — never full content/prompt body.
      args: args[0] ?? "",
    });
  }
  // Best-effort: patch existing live-state files so observers see the
  // passthrough exit code. Never CREATE files here.
  patchLiveStateOnPassthroughExit(cwd, code, args[0] ?? "");
  // Force exit with the child's code, consistent with the proxied branch.
  process.exit(code);
}

const program = new Command();
program.enablePositionalOptions();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgVersion: string = require("../package.json").version;

program
  .name("evo")
  .description("Evolutionary CLI Wrapper")
  .version(pkgVersion);

// First-run statusline prompt: fires once before any subcommand action.
// Internally bails out for install-statusline / --version / non-TTY / sentinel
// already present / settings.json already configured / EVO_NO_INSTALL_PROMPT=1.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  try {
    await maybeRunFirstRunPrompt(actionCommand.name());
  } catch {
    // never let the first-run prompt block the real subcommand
  }
});

program
  .command("init")
  .description("Create the local .evo config with sensible defaults.")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    console.log(`Initialized ${path.join(cwd, ".evo", "config.json")}`);
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("run")
  .description("Run an LLM CLI command with episode tracking and scoring.")
  .allowUnknownOption(true)
  .passThroughOptions()
  .option("--cwd <path>", "Working directory for the wrapped command.", process.cwd())
  .option("--prompt-text <text>", "Prompt text to profile without storing the raw body.")
  .option("--prompt-file <path>", "Read prompt text from a file.")
  .option("--cli <name>", "Override detected CLI kind (claude). Retained for backward compat; only 'claude' is supported.")
  .option("--test-cmd <command>", "Run a verification command after the main command exits.", collectOption, [])
  .argument("<command...>", "Command after --")
  .action(async (command: string[], options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const result = await runEpisode({
      cwd,
      promptText: options.promptText ? String(options.promptText) : undefined,
      promptFile: options.promptFile ? String(options.promptFile) : undefined,
      cliOverride: options.cli ? "claude" : undefined,
      testCommands: (options.testCmd as string[]) ?? [],
      command,
    });

    console.log(
      formatRunSummary({
        episodeId: result.episodeId,
        score: result.artifacts.score,
        nudges: result.artifacts.nudges,
        expAwarded: result.artifacts.summary.expAwarded,
        niceGuidanceAwarded: result.artifacts.summary.niceGuidanceAwarded,
        fixLoopOccurred: result.artifacts.summary.fixLoopOccurred,
        searchLoopOccurred: result.artifacts.summary.searchLoopOccurred,
        predictedLossRate: result.artifacts.summary.predictedLossRate,
        mascot: result.artifacts.mascot,
        tokenEstimate: result.artifacts.tokenEstimate,
        usageObservations: result.artifacts.usageObservations,
        turns: result.artifacts.turns,
      }),
    );
  });

program
  .command("proxy")
  .description("Run claude through the Evo auto-proxy.")
  .allowUnknownOption(true)
  .passThroughOptions()
  .requiredOption("--cli <name>", "CLI family to proxy (claude).")
  .option("--cwd <path>", "Working directory for the proxied command.", process.cwd())
  .argument("[args...]", "Arguments after --")
  .action(async (args: string[], options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    void options.cli;
    const cli = "claude" as const;

    // Nesting guard (fixes both the /logout hang and the auto-update lock): if
    // we are already inside an Evo proxy, claude re-invoked `claude` by name and
    // hit our shim again. Pass straight through with NO tracking/episode/signal
    // machinery so we never open a nested session. Must run before any setup.
    if (process.env.EVO_PROXY_ACTIVE === "1") {
      await runTransparentPassthrough(cwd, cli, args, "nested");
      return;
    }

    // Update-family ops (`claude update` / `claude --update` / install /
    // migrate-installer) must never be proxied even at top level: the native
    // updater owns its own children and needs to replace the running claude exe.
    if (isUpdateInvocation(args)) {
      await runTransparentPassthrough(cwd, cli, args, "update");
      return;
    }

    // Native subcommands like `claude review` bypass Evo entirely.
    if (args.length > 0 && PASSTHROUGH_SUBCOMMANDS.has(args[0].toLowerCase())) {
      await runTransparentPassthrough(cwd, cli, args, "subcommand");
      return;
    }

    // Wrapper self-health-check (never silent again). Before we hand the
    // terminal to the tracked proxy — which loads the native addons and opens
    // the DB — verify the wrapper can actually run: bundle present, native
    // runtime closure present, natives loadable. On failure, print ONE clear
    // warning and run the real claude directly, so a broken Evo install can
    // never leave the user without claude (nor crash/hang silently). The
    // generated shim does a cheap file-presence check too; this additionally
    // catches present-but-unloadable natives (ABI mismatch, corrupt .node) that
    // a file check cannot see, because native loading is now lazy.
    const health = quickHealthReport();
    // Record the result to the inspectable self-check state file so `evo doctor`
    // can surface it later (written on both healthy and failed startups so the
    // record always reflects the latest reality). Best-effort; never throws.
    writeSelfCheckState(health);
    if (!health.ok) {
      const failed = health.checks.filter((c) => !c.ok);
      const summary = failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ");
      cliResolveLog.error("wrapper self-check failed; falling back to real claude", { summary });
      // User-facing warning. Kept ASCII/English (single line) for parity across
      // every Windows console codepage — on a legacy chcp-932 console UTF-8 bytes
      // would mojibake, so the actionable content must not depend on the terminal
      // being UTF-8. The generated shim-level fallback is ASCII for the same
      // reason. (The failing-module name in `summary` makes it self-explanatory.)
      process.stderr.write(
        `evo: wrapper self-check failed (${summary}); running claude directly. ` +
          `See 'evo doctor'; set EVO_PROXY_ACTIVE=1 to bypass.\n`,
      );
      await runTransparentPassthrough(cwd, cli, args, "self-check");
      return;
    }

    const config = ensureEvoConfig(cwd);
    const result = await runProxySession({
      cwd,
      cli,
      args,
      mode: config.proxy.defaultMode,
    });
    console.log(
      formatRunSummary({
        episodeId: result.episodeId,
        score: result.artifacts.score,
        nudges: result.artifacts.nudges,
        expAwarded: result.artifacts.summary.expAwarded,
        niceGuidanceAwarded: result.artifacts.summary.niceGuidanceAwarded,
        fixLoopOccurred: result.artifacts.summary.fixLoopOccurred,
        searchLoopOccurred: result.artifacts.summary.searchLoopOccurred,
        predictedLossRate: result.artifacts.summary.predictedLossRate,
        mascot: result.artifacts.mascot,
        tokenEstimate: result.artifacts.tokenEstimate,
        usageObservations: result.artifacts.usageObservations,
        turns: result.artifacts.turns,
      }),
    );
    // Propagate the wrapped CLI's exit code and force the process to exit.
    // runProxySession may leave lingering handles alive (a resumed stdin, the
    // chokidar watcher, or better-sqlite3), so relying on a natural exit would
    // let the wrapper hang after the child has already finished.
    process.exit(result.exitCode);
  });

program
  .command("pause")
  .description("Temporarily stop Evo auto-proxy for new terminal sessions.")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        enabled: false,
      },
    });
    console.log("Evo auto-proxy paused for new terminal sessions.");
  });

program
  .command("resume")
  .description("Re-enable Evo auto-proxy for new terminal sessions.")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        enabled: true,
      },
    });
    console.log("Evo auto-proxy resumed for new terminal sessions.");
  });

program
  .command("setup-shell")
  .description("Install terminal integration and proxy shims.")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .option("--disable", "Disable shell integration instead of enabling it.", false)
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    if (Boolean(options.disable)) {
      const result = undoShellIntegration(cwd);
      console.log(`Disabled shell integration. Profile updated: ${result.profilePath}`);
      return;
    }
    const result = setupShellIntegration(cwd);
    console.log(`Shell integration ready.`);
    console.log(`bin: ${result.binDir}`);
    console.log(`profile: ${result.profilePath}`);
    console.log(`claude: ${result.originalCommandMap.claude ?? "not found"}`);
    console.log(`Open a new terminal session to start using claude through Evo automatically.`);
  });

program
  .command("undo-shell")
  .description("Remove the managed shell integration block.")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const result = undoShellIntegration(cwd);
    console.log(`Shell integration removed from: ${result.profilePath}`);
  });

program
  .command("forget")
  .description("Delete local Evo history in the selected project folder.")
  .option("--cwd <path>", "Project directory whose .evo folder should be removed.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    removeEvoData(cwd);
    console.log(`Deleted local Evo data from ${path.join(cwd, ".evo")}`);
  });

program
  .command("uninstall")
  .description("Remove shell integration and optionally delete local Evo data.")
  .option("--cwd <path>", "Install directory that owns Evo itself.", process.cwd())
  .option("--purge-data", "Delete the selected folder's .evo data too.", false)
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const result = undoShellIntegration(cwd);
    fs.rmSync(getBinDir(cwd), { recursive: true, force: true });
    if (Boolean(options.purgeData)) {
      removeEvoData(cwd);
    }
    console.log(`Evo shell integration removed from: ${result.profilePath}`);
    console.log(`Local shims removed from: ${getBinDir(cwd)}`);
    if (Boolean(options.purgeData)) {
      console.log(`Local Evo data deleted from: ${path.join(cwd, ".evo")}`);
    }
  });

const shell = program.command("shell").description("Inspect or toggle shell integration state.");
shell
  .command("on")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        enabled: true,
      },
    });
    console.log("Evo shell integration is ON for new terminal sessions.");
  });

shell
  .command("off")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        enabled: false,
      },
    });
    console.log("Evo shell integration is OFF for new terminal sessions.");
  });

shell
  .command("status")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const status = getShellStatus(cwd);
    console.log(`enabled=${status.enabled ? "yes" : "no"}`);
    console.log(`current_session_disabled=${status.currentSessionDisabled ? "yes" : "no"}`);
    console.log(`bin=${status.binDir}`);
    console.log(`profile=${status.profilePath}`);
    console.log(`claude=${status.originalCommandMap.claude ?? "not found"}`);
  });

program
  .command("mode")
  .description("Set the default advice mode for proxied sessions.")
  .argument("<mode>", "auto | active | quiet")
  .option("--cwd <path>", "Project directory that owns the .evo config.", process.cwd())
  .action((mode: string, options: Record<string, unknown>) => {
    if (!["auto", "active", "quiet"].includes(mode)) {
      throw new Error("Mode must be auto, active, or quiet.");
    }
    const cwd = path.resolve(String(options.cwd));
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      proxy: {
        ...config.proxy,
        defaultMode: mode as "auto" | "active" | "quiet",
      },
    });
    console.log(`Default proxy advice mode set to ${mode}.`);
  });

program
  .command("stats")
  .description("Show episode history and current rank.")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const db = new EvoDatabase(cwd);
    console.log(formatMascotStats(loadMascotProfile(cwd)));
    console.log("");
    console.log(formatStats(db.getStatsOverview()));
    db.close();
  });

const issue = program.command("issue").description("Read GitHub issues for agent intake.");
issue
  .command("show")
  .description("Show an issue summary optimized for AI agent intake.")
  .argument("<number>", "Issue number")
  .option("--cwd <path>", "Repo directory used for gh context.", process.cwd())
  .option("--repo <owner/name>", "Explicit GitHub repo when cwd should not be used.")
  .action((number: string, options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const issueNumber = Number(number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Issue number must be a positive integer.");
    }
    const result = readIssueIntake({
      cwd,
      issueNumber,
      repo: options.repo ? String(options.repo) : undefined,
    });
    if (!result.ok) {
      console.log(result.message);
      process.exitCode = 1;
      return;
    }
    console.log(formatIssueIntake(result.summary));
  });

const pet = program.command("pet").description("Inspect or customize EvoPet.");
pet
  .command("list")
  .description("Show the available EvoPet species.")
  .action(() => {
    console.log(formatMascotSpeciesList());
  });

pet
  .command("choose")
  .description("Choose your EvoPet species.")
  .argument("<speciesId>", "Species id from `evo pet list`.")
  .option("--cwd <path>", "Project directory used to resolve EVO_HOME.", process.cwd())
  .action((speciesId: string, options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const profile = chooseMascotSpecies(cwd, speciesId);
    console.log(`EvoPet is now ${profile.speciesId}.`);
    console.log(formatMascotStats(profile));
  });

program
  .command("storage")
  .description("Show database footprint and retention status.")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const db = new EvoDatabase(path.resolve(String(options.cwd)));
    console.log(formatStorage(db.getStorageReport()));
    db.close();
  });

program
  .command("logs")
  .description("Show recent Evo log lines, or bundle them for a bug report")
  .option("--tail <n>", "Show last N lines (default 50)", (v) => parseInt(v, 10))
  .option("--since <dur>", "Show lines since duration ago (e.g. 30m, 2h, 1d)")
  .option("--cwd <dir>", "Working dir to resolve .evo/logs from", process.cwd())
  .option("--bundle", "Create a redacted zip bundle of the last 7 days of logs + doctor output")
  .option("--out <path>", "Output path for the bundle (default: <cwd>/evo-bundle-<timestamp>.zip)")
  .action(async (options: { tail?: number; since?: string; cwd: string; bundle?: boolean; out?: string }) => {
    await runLogsCommand(options);
  });

program
  .command("doctor")
  .description("Print a one-page health report (versions, env, file checks, recent errors, live-state freshness).")
  .option("--json", "Emit machine-readable JSON output instead of formatted text")
  .option("--quick", "Fast self-check only (bundle, native deps, native load, claude resolvable); exits 1 on any failure")
  .option("--cwd <dir>", "Working dir to resolve .evo/ state from", process.cwd())
  .action(async (options: { json?: boolean; quick?: boolean; cwd?: string }) => {
    await runDoctor(options);
  });

program
  .command("display [mode]")
  .description("Toggle EvoPet statusline mode (minimum|expansion|toggle). Without arg, shows current mode.")
  .action(async (mode?: string) => {
    await runDisplayCommand(mode);
  });

program
  .command("statusline")
  .description("Render EvoPet portion of the Claude Code statusline (reads JSON from stdin).")
  .action(async () => {
    await runStatuslineCommand();
  });

program
  .command("advice")
  .description("Print the full EvoPet advice (untruncated) for the most recently active session in this directory.")
  .option("--cwd <path>", "Project directory that owns the .evo live-state.", process.cwd())
  .action((options: Record<string, unknown>) => {
    runAdviceCommand({ cwd: String(options.cwd) });
  });

program
  .command("install-statusline")
  .description("Deploy statusline.py to ~/.claude/ and wire it into Claude Code's settings.json.")
  .option("--yes", "Skip interactive confirmations.", false)
  .option("--uninstall", "Remove the deployed statusline.py and restore the most recent settings.json backup.", false)
  .action(async (options: Record<string, unknown>) => {
    await runInstallStatusline({
      yes: Boolean(options.yes),
      uninstall: Boolean(options.uninstall),
    });
  });

program
  .command("compact")
  .description("Archive old raw episodes while keeping learned rollups and summaries.")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const db = new EvoDatabase(path.resolve(String(options.cwd)));
    const result = db.compactRawEpisodes();
    console.log(formatStorage(result.storageReport, result.compactedEpisodes));
    db.close();
  });

program
  .command("export-knowledge")
  .description("Export learned local stats into a portable JSON bundle.")
  .requiredOption("--output <path>", "Path to the JSON bundle to create.")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const db = new EvoDatabase(path.resolve(String(options.cwd)));
    const outputPath = path.resolve(String(options.output));
    db.exportKnowledgeBundle(outputPath);
    console.log(`Exported knowledge bundle to ${outputPath}`);
    db.close();
  });

program
  .command("import-knowledge")
  .description("Import a portable JSON knowledge bundle and merge it into local stats.")
  .requiredOption("--input <path>", "Path to the JSON bundle to import.")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((options: Record<string, unknown>) => {
    const db = new EvoDatabase(path.resolve(String(options.cwd)));
    const inputPath = path.resolve(String(options.input));
    const result = db.importKnowledgeBundle(inputPath);
    console.log(`Imported ${result.importedBuckets} learned bucket(s) from ${inputPath}`);
    db.close();
  });

program
  .command("explain")
  .description("Explain how a recorded episode was scored.")
  .argument("<episodeId>", "Episode identifier")
  .option("--cwd <path>", "Project directory that owns the .evo database.", process.cwd())
  .action((episodeId: string, options: Record<string, unknown>) => {
    const db = new EvoDatabase(path.resolve(String(options.cwd)));
    const explanation = db.getEpisodeExplain(Number(episodeId));
    if (!explanation) {
      console.error(`Episode ${episodeId} was not found.`);
      db.close();
      process.exitCode = 1;
      return;
    }
    console.log(formatExplain(explanation));
    db.close();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Resolution failure messages from runProxySession are loud-by-design;
  // surface them at ERROR level too so the log file captures them.
  if (/Could not resolve the original claude command/.test(message)) {
    cliResolveLog.error("could not resolve original CLI", {
      cli: "claude",
      message,
    });
  }
  // Capture the full stack + any error code (e.g. SQLITE_BUSY and its failing
  // statement) at debug so DB and other failures are diagnosable — the console
  // still shows only the message.
  getLogger().child("cli").debug("command failed", {
    message,
    code: (error as NodeJS.ErrnoException).code,
    stack: error instanceof Error ? error.stack : undefined,
  });
  console.error(message);
  process.exitCode = 1;
});

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
