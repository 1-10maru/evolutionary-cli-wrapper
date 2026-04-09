import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvoConfig } from "./types";

const DEFAULT_CONFIG: EvoConfig = {
  formatVersion: 2,
  retention: {
    keepRecentRawEpisodes: 200,
    maxDatabaseBytes: 64 * 1024 * 1024,
    compactOnRun: true,
    vacuumOnCompact: true,
  },
  shellIntegration: {
    enabled: true,
    binDir: "",
    originalCommandMap: {},
    profilePath: getDefaultPowerShellProfilePath(),
  },
  proxy: {
    defaultMode: "auto",
    turnIdleMs: 1200,
  },
  nudge: {
    maxInlineLines: 2,
    cooldownTurns: 2,
    minConfidenceForPercent: 0.65,
  },
};

export function getEvoDir(cwd: string): string {
  return path.join(cwd, ".evo");
}

export function getGlobalEvoHome(cwd: string): string {
  const fromEnv = process.env.EVO_HOME;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.resolve(cwd);
}

export function getGlobalEvoDir(cwd: string): string {
  return path.join(getGlobalEvoHome(cwd), ".evo");
}

export function getConfigPath(cwd: string): string {
  return path.join(getEvoDir(cwd), "config.json");
}

export function getBinDir(cwd: string): string {
  return path.join(cwd, "bin");
}

export function removeEvoData(cwd: string): void {
  fs.rmSync(getEvoDir(cwd), { recursive: true, force: true });
}

export function getDefaultPowerShellProfilePath(): string {
  return path.join(os.homedir(), "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
}

export function ensureEvoConfig(cwd: string): EvoConfig {
  const evoDir = getEvoDir(cwd);
  fs.mkdirSync(evoDir, { recursive: true });
  const configPath = getConfigPath(cwd);

  const nextDefaults: EvoConfig = {
    ...DEFAULT_CONFIG,
    shellIntegration: {
      ...DEFAULT_CONFIG.shellIntegration,
      binDir: getBinDir(cwd),
      profilePath: getDefaultPowerShellProfilePath(),
    },
  };

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(nextDefaults, null, 2));
    return nextDefaults;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<EvoConfig>;
  const config: EvoConfig = {
    formatVersion: nextDefaults.formatVersion,
    retention: {
      ...nextDefaults.retention,
      ...(parsed.retention ?? {}),
    },
    shellIntegration: {
      ...nextDefaults.shellIntegration,
      ...(parsed.shellIntegration ?? {}),
      originalCommandMap: {
        ...nextDefaults.shellIntegration.originalCommandMap,
        ...(parsed.shellIntegration?.originalCommandMap ?? {}),
      },
    },
    proxy: {
      ...nextDefaults.proxy,
      ...(parsed.proxy ?? {}),
    },
    nudge: {
      ...nextDefaults.nudge,
      ...(parsed.nudge ?? {}),
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return config;
}

export function updateEvoConfig(cwd: string, nextConfig: EvoConfig): void {
  const evoDir = getEvoDir(cwd);
  fs.mkdirSync(evoDir, { recursive: true });
  fs.writeFileSync(getConfigPath(cwd), JSON.stringify(nextConfig, null, 2));
}

export function getDefaultConfig(): EvoConfig {
  return {
    ...DEFAULT_CONFIG,
    shellIntegration: {
      ...DEFAULT_CONFIG.shellIntegration,
    },
    proxy: {
      ...DEFAULT_CONFIG.proxy,
    },
    nudge: {
      ...DEFAULT_CONFIG.nudge,
    },
  };
}
