import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureEvoConfig, getBinDir, updateEvoConfig } from "./config";
import { SupportedCli } from "./types";

const PROFILE_START = "# >>> evo shell integration >>>";
const PROFILE_END = "# <<< evo shell integration <<<";

function escapePowerShellSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

function getPathEnv(env: NodeJS.ProcessEnv): string {
  return env.Path ?? env.PATH ?? "";
}

function setPathEnv(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const next = { ...env };
  if ("Path" in next) next.Path = value;
  else next.PATH = value;
  return next;
}

function normalize(p: string): string {
  return path.resolve(p).toLowerCase();
}

function getShellHome(cwd: string): string {
  const fromEnv = process.env.EVO_HOME;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }
  return cwd;
}

export function resolveOriginalCommand(cwd: string, cli: SupportedCli): string | null {
  if (cli === "generic") return null;
  const shellHome = getShellHome(cwd);
  const localConfig = ensureEvoConfig(cwd);
  const localKnown = localConfig.shellIntegration.originalCommandMap[cli];
  if (localKnown && fs.existsSync(localKnown)) return localKnown;

  const shellConfig = shellHome === cwd ? localConfig : ensureEvoConfig(shellHome);
  const shellKnown = shellConfig.shellIntegration.originalCommandMap[cli];
  if (shellKnown && fs.existsSync(shellKnown)) return shellKnown;

  const binDir = getBinDir(shellHome);
  const currentPath = getPathEnv(process.env);
  const filteredPath = currentPath
    .split(";")
    .filter((segment) => segment && normalize(segment) !== normalize(binDir))
    .join(";");

  const result = spawnSync("where", [cli], {
    cwd: shellHome,
    shell: true,
    encoding: "utf8",
    env: setPathEnv(process.env, filteredPath),
  });

  if (result.status !== 0) return null;
  const candidates = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => normalize(path.dirname(item)) !== normalize(binDir));

  return candidates[0] ?? null;
}

function getWrapperTargets(basePath: string): Array<{ path: string; backupPath: string; kind: "sh" | "cmd" | "ps1" }> {
  return [
    {
      path: basePath,
      backupPath: `${basePath}.evo-original`,
      kind: "sh",
    },
    {
      path: `${basePath}.cmd`,
      backupPath: `${basePath}.evo-original.cmd`,
      kind: "cmd",
    },
    {
      path: `${basePath}.ps1`,
      backupPath: `${basePath}.evo-original.ps1`,
      kind: "ps1",
    },
  ];
}

function buildWrapperContent(kind: "sh" | "cmd" | "ps1", cli: "codex" | "claude", cwd: string): string {
  const mainPath = path.join(cwd, "dist", "index.js");
  const configPath = path.join(cwd, ".evo", "config.json");
  const cmdBackup = `${cli}.evo-original.cmd`;
  const titleLabel = `${cli} [Evo ON]`;
  if (kind === "cmd") {
    return [
      "@echo off",
      "setlocal",
      `set \"EVO_HOME=${cwd}\"`,
      `set \"EVO_CONFIG=${configPath}\"`,
      `if exist \"%~dp0${cmdBackup}\" (`,
      "  for /f \"usebackq delims=\" %%A in (`powershell -NoProfile -Command \"$cfg=Get-Content -Raw '%EVO_CONFIG%' | ConvertFrom-Json; if($cfg.shellIntegration.enabled){'1'}else{'0'}\"`) do set \"EVO_ENABLED=%%A\"",
      ") else (",
      "  set \"EVO_ENABLED=1\"",
      ")",
      "if \"%EVO_ENABLED%\"==\"0\" (",
      `  call \"%~dp0${cmdBackup}\" %*`,
      "  exit /b %ERRORLEVEL%",
      ")",
      `title ${titleLabel}`,
      `node \"${mainPath}\" proxy --cli ${cli} -- %*`,
      "",
    ].join("\r\n");
  }
  if (kind === "ps1") {
    const escapedMain = mainPath.replace(/\\/g, "\\\\");
    const escapedConfig = configPath.replace(/\\/g, "\\\\");
    return [
      "#!/usr/bin/env pwsh",
      `$env:EVO_HOME = '${escapePowerShellSingleQuotes(cwd)}'`,
      `$evoConfig = '${escapePowerShellSingleQuotes(escapedConfig)}'`,
      "$evoEnabled = $true",
      "if (Test-Path $evoConfig) {",
      "  try {",
      "    $cfg = Get-Content -Raw $evoConfig | ConvertFrom-Json",
      "    if ($null -ne $cfg.shellIntegration.enabled) { $evoEnabled = [bool]$cfg.shellIntegration.enabled }",
      "  } catch { $evoEnabled = $true }",
      "}",
      "if (-not $evoEnabled) {",
      `  & \"$PSScriptRoot\\${cli}.evo-original.ps1\" @args`,
      "  exit $LASTEXITCODE",
      "}",
      `$Host.UI.RawUI.WindowTitle = '${escapePowerShellSingleQuotes(titleLabel)}'`,
      `& node '${escapePowerShellSingleQuotes(mainPath)}' proxy --cli ${cli} -- @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `EVO_HOME="${cwd.replace(/\\/g, "/")}"`,
    `EVO_CONFIG="${configPath.replace(/\\/g, "/")}"`,
    `if [ -f "$0.evo-original" ] && command -v node >/dev/null 2>&1; then`,
    `  if node -e "const fs=require('fs');const p=process.argv[1];try{const c=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(c.shellIntegration&&c.shellIntegration.enabled===false?'0':'1')}catch{process.stdout.write('1')}" "$EVO_CONFIG" | grep -q '^0$'; then`,
    `    exec "$0.evo-original" "$@"`,
    "  fi",
    "fi",
    `exec node "${mainPath.replace(/\\/g, "/")}" proxy --cli ${cli} -- "$@"`,
    "",
  ].join("\n");
}

function installCommandWrappers(cwd: string): Partial<Record<SupportedCli, string>> {
  const originalCommandMap: Partial<Record<SupportedCli, string>> = {};
  for (const cli of ["codex", "claude"] as const) {
    const resolved = resolveOriginalCommand(cwd, cli);
    if (!resolved) continue;
    const normalizedResolved = resolved.replace(/\.evo-original(\.(cmd|ps1))?$/i, "");
    const basePath =
      normalizedResolved.endsWith(".cmd") || normalizedResolved.endsWith(".ps1")
        ? normalizedResolved.replace(/\.(cmd|ps1)$/i, "")
        : normalizedResolved;
    const targets = getWrapperTargets(basePath);
    for (const target of targets) {
      if (fs.existsSync(target.path) && !fs.existsSync(target.backupPath)) {
        fs.copyFileSync(target.path, target.backupPath);
      }
      const content = buildWrapperContent(target.kind, cli, cwd);
      fs.writeFileSync(target.path, content);
    }
    const backupCmd = `${basePath}.evo-original.cmd`;
    originalCommandMap[cli] = fs.existsSync(backupCmd) ? backupCmd : resolved;
  }
  return originalCommandMap;
}

function restoreCommandWrappers(cwd: string): void {
  const config = ensureEvoConfig(cwd);
  for (const cli of ["codex", "claude"] as const) {
    const knownBackup = config.shellIntegration.originalCommandMap[cli];
    const backupCmdBase = knownBackup
      ? knownBackup.replace(/\.evo-original\.cmd$/i, "")
      : path.join(process.env.APPDATA ?? "", "npm", cli);
    const basePath =
      backupCmdBase.endsWith(".cmd") || backupCmdBase.endsWith(".ps1")
        ? backupCmdBase.replace(/\.(cmd|ps1)$/i, "")
        : backupCmdBase;
    for (const target of getWrapperTargets(basePath)) {
      if (fs.existsSync(target.backupPath)) {
        fs.copyFileSync(target.backupPath, target.path);
      }
    }
  }
}

export function createProxyShims(cwd: string): string[] {
  const binDir = getBinDir(cwd);
  fs.mkdirSync(binDir, { recursive: true });
  const configPath = path.join(cwd, ".evo", "config.json");

  const created: string[] = [];
  const evoShimPath = path.join(binDir, "evo.cmd");
  fs.writeFileSync(
    evoShimPath,
    `@echo off\r\nsetlocal\r\nset "EVO_HOME=${cwd}"\r\nset "EVO_CONFIG=${configPath}"\r\nnode "%~dp0..\\dist\\index.js" %*\r\n`,
  );
  created.push(evoShimPath);

  const evoPs1Path = path.join(binDir, "evo.ps1");
  fs.writeFileSync(
    evoPs1Path,
    [
      "#!/usr/bin/env pwsh",
      `$env:EVO_HOME = '${escapePowerShellSingleQuotes(cwd)}'`,
      `$env:EVO_CONFIG = '${escapePowerShellSingleQuotes(configPath)}'`,
      `& node '${escapePowerShellSingleQuotes(path.join(cwd, "dist", "index.js"))}' @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
  );
  created.push(evoPs1Path);

  for (const cli of ["codex", "claude"] as const) {
    const cmdShimPath = path.join(binDir, `${cli}.cmd`);
    const cmdContent = [
      "@echo off",
      "setlocal",
      `set "EVO_HOME=${cwd}"`,
      `set "EVO_CONFIG=${configPath}"`,
      `title ${cli} [Evo ON]`,
      `node "%~dp0..\\dist\\index.js" proxy --cli ${cli} -- %*`,
      "",
    ].join("\r\n");
    fs.writeFileSync(cmdShimPath, cmdContent);
    created.push(cmdShimPath);

    const ps1ShimPath = path.join(binDir, `${cli}.ps1`);
    const ps1Content = [
      "#!/usr/bin/env pwsh",
      `$env:EVO_HOME = '${escapePowerShellSingleQuotes(cwd)}'`,
      `$env:EVO_CONFIG = '${escapePowerShellSingleQuotes(configPath)}'`,
      `$Host.UI.RawUI.WindowTitle = '${escapePowerShellSingleQuotes(`${cli} [Evo ON]`)}'`,
      `& node '${escapePowerShellSingleQuotes(path.join(cwd, "dist", "index.js"))}' proxy --cli ${cli} -- @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
    fs.writeFileSync(ps1ShimPath, ps1Content);
    created.push(ps1ShimPath);

    const shShimPath = path.join(binDir, cli);
    const shContent = [
      "#!/bin/sh",
      `EVO_HOME="${cwd.replace(/\\/g, "/")}"`,
      `EVO_CONFIG="${configPath.replace(/\\/g, "/")}"`,
      `exec node "${path.join(cwd, "dist", "index.js").replace(/\\/g, "/")}" proxy --cli ${cli} -- "$@"`,
      "",
    ].join("\n");
    fs.writeFileSync(shShimPath, shContent);
    created.push(shShimPath);
  }

  return created;
}

export function buildPowerShellProfileBlock(cwd: string): string {
  const config = ensureEvoConfig(cwd);
  const binDir = config.shellIntegration.binDir;
  const evoHome = cwd;
  const configPath = path.join(cwd, ".evo", "config.json");
  return [
    PROFILE_START,
    `$env:EVO_HOME = '${escapePowerShellSingleQuotes(evoHome)}'`,
    `$env:EVO_PROXY_HOME = '${escapePowerShellSingleQuotes(evoHome)}'`,
    `$env:EVO_PROXY_DEFAULT = '${config.proxy.defaultMode}'`,
    `$evoBin = '${escapePowerShellSingleQuotes(binDir)}'`,
    `$evoConfigPath = '${escapePowerShellSingleQuotes(configPath)}'`,
    "$evoEnabled = $true",
    "if (Test-Path $evoConfigPath) {",
    "  try {",
    "    $evoConfig = Get-Content -Raw $evoConfigPath | ConvertFrom-Json",
    "    if ($null -ne $evoConfig.shellIntegration.enabled) {",
    "      $evoEnabled = [bool]$evoConfig.shellIntegration.enabled",
    "    }",
    "  } catch {",
    "    $evoEnabled = $true",
    "  }",
    "}",
    "if ($evoEnabled -and (Test-Path $evoBin)) {",
    "  if (-not (($env:Path -split ';') -contains $evoBin)) {",
    "    $env:Path = \"$evoBin;$env:Path\"",
    "  }",
    "}",
    PROFILE_END,
    "",
  ].join("\r\n");
}

function replaceManagedBlock(existing: string, nextBlock: string): string {
  const blockRe = new RegExp(
    `${PROFILE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${PROFILE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`,
    "g",
  );
  const stripped = existing.replace(blockRe, "").trimEnd();
  return `${stripped}${stripped ? "\r\n\r\n" : ""}${nextBlock}`;
}

export function setupShellIntegration(cwd: string): {
  profilePath: string;
  binDir: string;
  originalCommandMap: Partial<Record<SupportedCli, string>>;
} {
  const config = ensureEvoConfig(cwd);
  createProxyShims(cwd);
  const originalCommandMap = installCommandWrappers(cwd);

  const nextConfig = {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      enabled: true,
      binDir: getBinDir(cwd),
      originalCommandMap,
    },
  };
  updateEvoConfig(cwd, nextConfig);

  const profilePath = nextConfig.shellIntegration.profilePath;
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "";
  fs.writeFileSync(profilePath, replaceManagedBlock(existing, buildPowerShellProfileBlock(cwd)));

  return {
    profilePath,
    binDir: nextConfig.shellIntegration.binDir,
    originalCommandMap,
  };
}

export function undoShellIntegration(cwd: string): { profilePath: string; removed: boolean } {
  const config = ensureEvoConfig(cwd);
  const profilePath = config.shellIntegration.profilePath;
  let removed = false;
  restoreCommandWrappers(cwd);

  if (fs.existsSync(profilePath)) {
    const existing = fs.readFileSync(profilePath, "utf8");
    const blockRe = new RegExp(
      `${PROFILE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${PROFILE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`,
      "g",
    );
    const updated = existing.replace(blockRe, "").trimEnd();
    fs.writeFileSync(profilePath, updated ? `${updated}\r\n` : "");
    removed = updated !== existing;
  }

  updateEvoConfig(cwd, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      enabled: false,
    },
  });

  return { profilePath, removed };
}

export function setShellEnabled(cwd: string, enabled: boolean): void {
  const config = ensureEvoConfig(cwd);
  updateEvoConfig(cwd, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      enabled,
    },
  });
}

export function getShellStatus(cwd: string): {
  enabled: boolean;
  binDir: string;
  profilePath: string;
  currentSessionDisabled: boolean;
  originalCommandMap: Partial<Record<SupportedCli, string>>;
} {
  const config = ensureEvoConfig(cwd);
  return {
    enabled: config.shellIntegration.enabled,
    binDir: config.shellIntegration.binDir,
    profilePath: config.shellIntegration.profilePath,
    currentSessionDisabled: process.env.EVO_PROXY_DISABLED === "1",
    originalCommandMap: config.shellIntegration.originalCommandMap,
  };
}
