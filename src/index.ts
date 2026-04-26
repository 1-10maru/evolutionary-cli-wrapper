#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { Command } from "commander";
import path from "node:path";
import { ensureEvoConfig, getBinDir, removeEvoData, updateEvoConfig } from "./config";
import { EvoDatabase } from "./db";
import { readIssueIntake } from "./issueIntake";
import { getLogger } from "./logger";
import { chooseMascotSpecies, formatMascotSpeciesList, loadMascotProfile } from "./mascot";
import { runProxySession } from "./proxyRuntime";
import { runEpisode } from "./runtime";
import { runLogsCommand } from "./cli/logs";
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

const cliPassthroughLog = getLogger().child("cli.passthrough");
const cliResolveLog = getLogger().child("cli.resolve");

function formatMissingOriginalCommandMessage(cli: "codex" | "claude"): string {
  return `Could not resolve the original ${cli} command. Evo checked PATH after excluding its own shim, but no live ${cli} install was found. Reinstall the upstream ${cli} CLI, then run npm run setup again if needed.\n`;
}

/**
 * Patch the wrapped-CLI live-state files with passthrough exit info, but ONLY
 * if the files already exist. Passthrough subcommands (e.g. `codex review`)
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

const program = new Command();
program.enablePositionalOptions();

program
  .name("evo")
  .description("Evolutionary CLI Wrapper")
  .version("0.1.0");

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
  .option("--cli <name>", "Override detected CLI kind (codex|claude|generic).")
  .option("--test-cmd <command>", "Run a verification command after the main command exits.", collectOption, [])
  .argument("<command...>", "Command after --")
  .action(async (command: string[], options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const result = await runEpisode({
      cwd,
      promptText: options.promptText ? String(options.promptText) : undefined,
      promptFile: options.promptFile ? String(options.promptFile) : undefined,
      cliOverride: options.cli
        ? (String(options.cli).toLowerCase() as "codex" | "claude" | "generic")
        : undefined,
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
  .description("Run codex/claude through the Evo auto-proxy.")
  .allowUnknownOption(true)
  .passThroughOptions()
  .requiredOption("--cli <name>", "CLI family to proxy (codex|claude).")
  .option("--cwd <path>", "Working directory for the proxied command.", process.cwd())
  .argument("[args...]", "Arguments after --")
  .action(async (args: string[], options: Record<string, unknown>) => {
    const cwd = path.resolve(String(options.cwd));
    const cli = String(options.cli).toLowerCase() as "codex" | "claude";

    // Passthrough: native subcommands like `codex review` bypass Evo entirely
    if (args.length > 0 && PASSTHROUGH_SUBCOMMANDS.has(args[0].toLowerCase())) {
      const originalCommand = resolveOriginalCommand(cwd, cli);
      if (!originalCommand) {
        cliResolveLog.error("could not resolve original CLI", {
          cli,
          message: `no live ${cli} install on PATH after excluding evo shim`,
        });
        process.stderr.write(formatMissingOriginalCommandMessage(cli));
        process.exitCode = 1;
        return;
      }
      const ext = path.extname(originalCommand).toLowerCase();
      const needsShell = ext === ".cmd" || ext === ".bat";
      const child = needsShell
        ? spawn(`"${originalCommand}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`, {
            cwd,
            shell: true,
            stdio: "inherit",
            env: { ...process.env, EVO_PROXY_ACTIVE: "1" },
          })
        : spawn(originalCommand, args, {
            cwd,
            stdio: "inherit",
            env: { ...process.env, EVO_PROXY_ACTIVE: "1" },
          });
      const code = await new Promise<number>((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (c) => resolve(c ?? 1));
      });
      if (code !== 0) {
        cliPassthroughLog.warn("passthrough exited non-zero", {
          cli,
          exitCode: code,
          // Log only first arg (subcommand name) — never full content/prompt body.
          args: args[0],
        });
      }
      // Best-effort: patch existing live-state files so observers see the
      // passthrough exit code. Never CREATE files here.
      patchLiveStateOnPassthroughExit(cwd, code, args[0] ?? "");
      process.exitCode = code;
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
    console.log(`codex: ${result.originalCommandMap.codex ?? "not found"}`);
    console.log(`claude: ${result.originalCommandMap.claude ?? "not found"}`);
    console.log(`Open a new terminal session to start using codex/claude through Evo automatically.`);
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
    console.log(`codex=${status.originalCommandMap.codex ?? "not found"}`);
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
  .description("Show recent Evo log lines")
  .option("--tail <n>", "Show last N lines (default 50)", (v) => parseInt(v, 10))
  .option("--since <dur>", "Show lines since duration ago (e.g. 30m, 2h, 1d)")
  .option("--cwd <dir>", "Working dir to resolve .evo/logs from", process.cwd())
  .action(async (options: { tail?: number; since?: string; cwd: string }) => {
    await runLogsCommand(options);
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
  if (/Could not resolve the original (codex|claude) command/.test(message)) {
    const cliMatch = /the original (codex|claude) command/.exec(message);
    cliResolveLog.error("could not resolve original CLI", {
      cli: cliMatch ? cliMatch[1] : "unknown",
      message,
    });
  }
  console.error(message);
  process.exitCode = 1;
});

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
