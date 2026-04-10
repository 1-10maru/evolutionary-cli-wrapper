import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureEvoConfig,
  getBinDir,
  getCmdAutoRunScriptPath,
  getDefaultPowerShellProfilePath,
  getDefaultPwshProfilePath,
  updateEvoConfig,
} from "./config";
import { SupportedCli } from "./types";

const PROFILE_START = "# >>> evo shell integration >>>";
const PROFILE_END = "# <<< evo shell integration <<<";
const CMD_AUTORUN_REG_PATH = "HKCU\\Software\\Microsoft\\Command Processor";
const CMD_AUTORUN_VALUE = "AutoRun";
const USER_ENV_REG_PATH = "HKCU\\Environment";
let testCmdAutoRunValue: string | null = null;

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

function runPowerShell(command: string): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? result.stdout ?? "PowerShell command failed").trim());
  }
  return String(result.stdout ?? "").trim();
}

function addToUserPath(binDir: string): void {
  if (process.env.EVO_TEST_MODE === "1" || process.platform !== "win32") return;
  try {
    const currentPath = runPowerShell(
      "[System.Environment]::GetEnvironmentVariable('Path','User')",
    );
    const normalBin = normalize(binDir);
    const already = currentPath
      .split(";")
      .some((seg) => seg.trim() && normalize(seg) === normalBin);
    if (already) return;

    const newPath = currentPath ? `${binDir};${currentPath}` : binDir;
    const escaped = escapePowerShellSingleQuotes(newPath);
    runPowerShell(
      `[System.Environment]::SetEnvironmentVariable('Path','${escaped}','User')`,
    );
  } catch {
    /* best-effort — user can add manually */
  }
}

function removeFromUserPath(binDir: string): void {
  if (process.env.EVO_TEST_MODE === "1" || process.platform !== "win32") return;
  try {
    const currentPath = runPowerShell(
      "[System.Environment]::GetEnvironmentVariable('Path','User')",
    );
    const normalBin = normalize(binDir);
    const filtered = currentPath
      .split(";")
      .filter((seg) => seg.trim() && normalize(seg) !== normalBin)
      .join(";");
    if (filtered === currentPath) return;

    const escaped = escapePowerShellSingleQuotes(filtered);
    runPowerShell(
      `[System.Environment]::SetEnvironmentVariable('Path','${escaped}','User')`,
    );
  } catch {
    /* best-effort */
  }
}

function getShellHome(cwd: string): string {
  const fromEnv = process.env.EVO_HOME;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return path.resolve(fromEnv);
  }
  // Fallback: derive evo root from dist/ directory (this file compiles to dist/shellIntegration.js)
  const projectRoot = path.resolve(__dirname, "..");
  if (fs.existsSync(path.join(projectRoot, ".evo", "config.json"))) {
    return projectRoot;
  }
  return cwd;
}

function getCmdAutoRunScriptCommand(cwd: string): string {
  return `call "${getCmdAutoRunScriptPath(cwd)}"`;
}

function getCmdAutoRunValue(): string | null {
  if (process.env.EVO_TEST_MODE === "1") {
    return testCmdAutoRunValue;
  }
  try {
    const value = runPowerShell(
      [
        `$path = 'HKCU:\\Software\\Microsoft\\Command Processor'`,
        "try {",
        "  $value = (Get-ItemProperty -Path $path -Name AutoRun -ErrorAction Stop).AutoRun",
        "  if ($null -ne $value -and $value.ToString().Trim().Length -gt 0) { Write-Output $value }",
        "} catch { }",
      ].join("; "),
    );
    return value || null;
  } catch {
    return null;
  }
}

function stripManagedCmdAutoRun(value: string | null, cwd: string): string | null {
  if (!value) return null;
  const command = getCmdAutoRunScriptCommand(cwd);
  const lowerManaged = command.toLowerCase();
  const parts = value
    .split(/\s*&\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const lower = part.toLowerCase();
      return !lower.includes("evo-cmd-autorun.cmd") && lower !== lowerManaged;
    });
  return parts.join(" & ").trim() || null;
}

function setCmdAutoRunValue(value: string | null): void {
  if (process.env.EVO_TEST_MODE === "1") {
    testCmdAutoRunValue = value && value.trim() ? value : null;
    return;
  }
  const escaped = value ? escapePowerShellSingleQuotes(value) : "";
  if (!value || !value.trim()) {
    runPowerShell(
      [
        `$path = 'HKCU:\\Software\\Microsoft\\Command Processor'`,
        "if (Test-Path $path) {",
        "  try { Remove-ItemProperty -Path $path -Name AutoRun -ErrorAction Stop } catch { }",
        "}",
      ].join("; "),
    );
    return;
  }
  runPowerShell(
    [
      `$path = 'HKCU:\\Software\\Microsoft\\Command Processor'`,
      "New-Item -Path $path -Force | Out-Null",
      `$value = '${escaped}'`,
      "$existing = Get-ItemProperty -Path $path -Name AutoRun -ErrorAction SilentlyContinue",
      "if ($null -eq $existing) {",
      "  New-ItemProperty -Path $path -Name AutoRun -Value $value -PropertyType String -Force | Out-Null",
      "} else {",
      "  Set-ItemProperty -Path $path -Name AutoRun -Value $value",
      "}",
    ].join("; "),
  );
}

function normalizeCmdAutoRunValue(value: string | null): string | null {
  if (!value) return null;
  const staleCondaHook = 'if exist "C:\\ProgramData\\Anaconda3\\condabin\\conda_hook.bat" "C:\\ProgramData\\Anaconda3\\condabin\\conda_hook.bat"';
  const miniCondaHook = path.join(process.env.USERPROFILE ?? "", "miniconda3", "condabin", "conda_hook.bat");
  if (value.trim().toLowerCase() === staleCondaHook.toLowerCase() && fs.existsSync(miniCondaHook)) {
    return `if exist "${miniCondaHook}" "${miniCondaHook}"`;
  }
  return value;
}

function getManagedPowerShellProfilePaths(cwd: string): string[] {
  const config = ensureEvoConfig(cwd);
  return Array.from(
    new Set(
      [config.shellIntegration.profilePath, getDefaultPowerShellProfilePath(), getDefaultPwshProfilePath()]
        .filter(Boolean)
        .map((entry) => path.resolve(entry)),
    ),
  );
}

function buildCmdAutoRunChain(cwd: string, original: string | null): string {
  const managed = getCmdAutoRunScriptCommand(cwd);
  return original && original.trim().length > 0 ? `${managed} & ${original}` : managed;
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

function normalizeResolvedWrapperBase(resolved: string): string {
  const normalizedResolved = resolved.replace(/\.evo-original(\.(cmd|ps1))?$/i, "");
  return normalizedResolved.endsWith(".cmd") || normalizedResolved.endsWith(".ps1")
    ? normalizedResolved.replace(/\.(cmd|ps1)$/i, "")
    : normalizedResolved;
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

function buildCmdAutoRunScript(cwd: string): string {
  const configPath = path.join(cwd, ".evo", "config.json");
  const binDir = getBinDir(cwd);
  return [
    "@echo off",
    `set "EVO_HOME=${cwd}"`,
    `set "EVO_CONFIG=${configPath}"`,
    `set "EVO_BIN=${binDir}"`,
    "set \"PATH=%EVO_BIN%;%PATH%\"",
    "",
  ].join("\r\n");
}

function installCommandWrappers(cwd: string): Partial<Record<SupportedCli, string>> {
  const originalCommandMap: Partial<Record<SupportedCli, string>> = {};
  if (process.env.EVO_TEST_MODE === "1") return originalCommandMap;
  // Record original command locations without overwriting npm global files.
  // Evo bin takes priority via user PATH (addToUserPath) instead.
  for (const cli of ["codex", "claude"] as const) {
    const resolved = resolveOriginalCommand(cwd, cli);
    if (resolved) {
      originalCommandMap[cli] = resolved;
    }
  }
  return originalCommandMap;
}

function restoreCommandWrappers(_cwd: string): void {
  // No-op: npm global files are no longer overwritten (PATH priority used instead).
  // Kept for backward compat — undoShellIntegration still calls this.
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

  const cmdAutoRunPath = getCmdAutoRunScriptPath(cwd);
  fs.writeFileSync(cmdAutoRunPath, buildCmdAutoRunScript(cwd));
  created.push(cmdAutoRunPath);

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
      `export EVO_HOME="${cwd.replace(/\\/g, "/")}"`,
      `export EVO_CONFIG="${configPath.replace(/\\/g, "/")}"`,
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
  const currentCmdAutoRun = getCmdAutoRunValue();
  const storedOriginalCmdAutoRun = normalizeCmdAutoRunValue(
    stripManagedCmdAutoRun(config.shellIntegration.originalCmdAutoRun, cwd),
  );
  const originalCmdAutoRun =
    storedOriginalCmdAutoRun ?? normalizeCmdAutoRunValue(stripManagedCmdAutoRun(currentCmdAutoRun, cwd));

  const nextConfig = {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      enabled: true,
      binDir: getBinDir(cwd),
      originalCommandMap,
      originalCmdAutoRun,
      cmdAutoRunScriptPath: getCmdAutoRunScriptPath(cwd),
    },
  };
  updateEvoConfig(cwd, nextConfig);

  const profilePath = nextConfig.shellIntegration.profilePath;
  for (const targetProfilePath of getManagedPowerShellProfilePaths(cwd)) {
    fs.mkdirSync(path.dirname(targetProfilePath), { recursive: true });
    const existing = fs.existsSync(targetProfilePath) ? fs.readFileSync(targetProfilePath, "utf8") : "";
    fs.writeFileSync(targetProfilePath, replaceManagedBlock(existing, buildPowerShellProfileBlock(cwd)));
  }
  setCmdAutoRunValue(buildCmdAutoRunChain(cwd, originalCmdAutoRun));
  addToUserPath(nextConfig.shellIntegration.binDir);

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
    removed = false;
  }

  for (const targetProfilePath of getManagedPowerShellProfilePaths(cwd)) {
    if (!fs.existsSync(targetProfilePath)) continue;
    const existing = fs.readFileSync(targetProfilePath, "utf8");
    const blockRe = new RegExp(
      `${PROFILE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${PROFILE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`,
      "g",
    );
    const updated = existing.replace(blockRe, "").trimEnd();
    fs.writeFileSync(targetProfilePath, updated ? `${updated}\r\n` : "");
    removed = removed || updated !== existing;
  }

  updateEvoConfig(cwd, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      enabled: false,
    },
  });
  setCmdAutoRunValue(config.shellIntegration.originalCmdAutoRun);
  removeFromUserPath(getBinDir(cwd));

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
