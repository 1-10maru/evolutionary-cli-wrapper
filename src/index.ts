#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import path from "node:path";
import { ensureEvoConfig, getBinDir, removeEvoData, updateEvoConfig } from "./config";
import { EvoDatabase } from "./db";
import { chooseMascotSpecies, formatMascotSpeciesList, loadMascotProfile } from "./mascot";
import { runProxySession } from "./proxyRuntime";
import { runEpisode } from "./runtime";
import {
  getShellStatus,
  setupShellIntegration,
  undoShellIntegration,
} from "./shellIntegration";
import { formatExplain, formatMascotStats, formatRunSummary, formatStats, formatStorage } from "./ui";

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
    const config = ensureEvoConfig(cwd);
    const result = await runProxySession({
      cwd,
      cli: String(options.cli).toLowerCase() as "codex" | "claude",
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
  .description("Temporarily stop Evo auto-proxy for new PowerShell sessions.")
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
    console.log("Evo auto-proxy paused for new PowerShell sessions.");
  });

program
  .command("resume")
  .description("Re-enable Evo auto-proxy for new PowerShell sessions.")
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
    console.log("Evo auto-proxy resumed for new PowerShell sessions.");
  });

program
  .command("setup-shell")
  .description("Install PowerShell profile integration and proxy shims.")
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
    console.log(`Open a new PowerShell session to start using codex/claude through Evo automatically.`);
  });

program
  .command("undo-shell")
  .description("Remove the managed PowerShell integration block.")
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
    console.log("Evo shell integration is ON for new PowerShell sessions.");
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
    console.log("Evo shell integration is OFF for new PowerShell sessions.");
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
