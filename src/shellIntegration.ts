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
import { getLogger } from "./logger";
import { SupportedCli } from "./types";

const shellPathLog = getLogger().child("shell.path");
const shellResolveLog = getLogger().child("shell.resolve");
const shellRegistryLog = getLogger().child("shell.registry");

function normalizeErr(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: string };
    return { message: e.message, code: e.code };
  }
  return { message: String(err) };
}

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

function isLegacyEvoBackupCommand(commandPath: string): boolean {
  return /\.evo-original(\.(cmd|ps1))?$/i.test(path.basename(commandPath));
}

function rankResolvedCommandCandidate(commandPath: string): number {
  // Ranking is deterministic across platforms: Evo wraps Windows-native CLI shims
  // (claude.cmd / claude.exe), and tests must verify the same preference order on
  // Linux CI as on Windows hosts.
  const ext = path.extname(commandPath).toLowerCase();
  if (ext === ".exe") return 0;
  if (ext === ".cmd") return 1;
  if (ext === ".bat") return 2;
  if (ext === ".ps1") return 3;
  if (ext === ".sh") return 5;
  if (ext === ".bash") return 6;
  // Extensionless shim (npm posix wrapper) — ranked after Windows-native shims so
  // that `.cmd` siblings win the resolution race on both platforms.
  if (!ext) return 4;
  return 7;
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
  } catch (err) {
    const n = normalizeErr(err);
    shellRegistryLog.warn("registry write failed (addToUserPath)", {
      errno: n.code,
      message: n.message,
    });
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
  } catch (err) {
    const n = normalizeErr(err);
    shellRegistryLog.warn("registry write failed (removeFromUserPath)", {
      errno: n.code,
      message: n.message,
    });
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
  } catch (err) {
    const n = normalizeErr(err);
    shellRegistryLog.warn("registry read failed (getCmdAutoRunValue)", {
      errno: n.code,
      message: n.message,
    });
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
  if (process.env.EVO_TEST_MODE === "1") {
    return [path.resolve(config.shellIntegration.profilePath)];
  }
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

function dedupeCommandCandidates(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalize(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(candidate);
  }
  return deduped;
}

function extractShimTargetPath(commandPath: string): string | null {
  const ext = path.extname(commandPath).toLowerCase();
  if (ext === ".exe") return null;

  let contents: string;
  try {
    contents = fs.readFileSync(commandPath, "utf8");
  } catch {
    return null;
  }

  const patterns = [
    /%dp0%[\\/](?<target>node_modules[^"\r\n]+)/i,
    /\$basedir[\\/](?<target>node_modules[^"\r\n]+)/i,
    /\$PSScriptRoot[\\/](?<target>node_modules[^'"\r\n]+)/i,
  ];
  for (const pattern of patterns) {
    const target = pattern.exec(contents)?.groups?.target;
    if (!target) continue;
    const normalizedTarget = target.replace(/[\\/]+/g, path.sep);
    return path.resolve(path.dirname(commandPath), normalizedTarget);
  }
  return null;
}

/**
 * If a resolved command is an npm interpreter shim (`.cmd` / `.ps1` / `.bat`, or
 * an extensionless stub) that points at a real `.exe`, return that `.exe` so we
 * can spawn it directly instead of through a cmd.exe / PowerShell interpreter
 * layer.
 *
 * Why this matters: npm's PowerShell shim runs
 *   `if ($MyInvocation.ExpectingInput) { $input | & claude.exe $args } ...`
 * With a redirected stdin that never reaches EOF, PowerShell blocks on stdin
 * forever even after `claude.exe` has already exited — so evo's direct child
 * (powershell) never exits and the teardown watchdog, which is keyed on the
 * direct child's exit, never fires. The `.cmd` variant instead surfaces the
 * interactive "Terminate batch job (Y/N)?" prompt on Ctrl+C. Spawning the
 * `.exe` directly removes the interpreter entirely and both symptoms vanish.
 *
 * Strictly guarded to `.exe` targets: a shim that points at a `.js` / `cli.js`
 * (a node launcher) is left alone — following it to node is out of scope here.
 */
function followShimToExe(resolved: string): string {
  const ext = path.extname(resolved).toLowerCase();
  const isShim = ext === ".cmd" || ext === ".ps1" || ext === ".bat" || ext === "";
  if (!isShim) return resolved;
  const target = extractShimTargetPath(resolved);
  if (!target) return resolved;
  if (path.extname(target).toLowerCase() !== ".exe") return resolved;
  if (!fs.existsSync(target)) return resolved;
  return target;
}

/**
 * Whether a resolved command can actually be launched on the current platform
 * by `spawnInteractiveCommand`. On Windows we can spawn `.exe` directly, `.cmd`
 * / `.bat` via cmd.exe, and `.ps1` via pwsh/powershell — but an extensionless
 * POSIX stub (npm's bash wrapper) is not runnable via CreateProcess and would
 * fail with ENOENT under `shell:false`. Accepting/caching such a candidate on
 * Windows produces a broken original-command mapping, so reject it up front.
 * On POSIX, shebang and extensionless stubs are directly executable, so any
 * existing file is considered spawnable.
 */
function isSpawnableOnThisPlatform(commandPath: string): boolean {
  if (process.platform !== "win32") return true;
  const ext = path.extname(commandPath).toLowerCase();
  return ext === ".exe" || ext === ".cmd" || ext === ".bat" || ext === ".ps1";
}

function isUsableCommandCandidate(commandPath: string): boolean {
  if (!commandPath || !fs.existsSync(commandPath)) return false;
  if (!isSpawnableOnThisPlatform(commandPath)) return false;
  const shimTarget = extractShimTargetPath(commandPath);
  return shimTarget ? fs.existsSync(shimTarget) : true;
}

function getSiblingCommandCandidates(commandPath: string, cli: SupportedCli): string[] {
  const dir = path.dirname(commandPath);
  const base = path.join(dir, cli);
  // Always probe both Windows-native (.cmd/.exe/.bat/.ps1) and Unix-style (.sh/.bash)
  // siblings. Evo proxies CLIs that ship Windows shims via npm even when the host
  // OS is Linux (e.g. CI), so the legacy self-heal path must locate the .cmd
  // sibling regardless of process.platform.
  const candidates = [
    base,
    `${base}.cmd`,
    `${base}.exe`,
    `${base}.bat`,
    `${base}.ps1`,
    `${base}.sh`,
    `${base}.bash`,
  ];
  return dedupeCommandCandidates(candidates)
    .filter((candidate) => normalize(candidate) !== normalize(commandPath))
    .sort((a, b) => rankResolvedCommandCandidate(a) - rankResolvedCommandCandidate(b));
}

function persistResolvedCommand(cwd: string, shellHome: string, cli: SupportedCli, resolved: string): void {
  const persistFor = (targetCwd: string): void => {
    const config = ensureEvoConfig(targetCwd);
    if (config.shellIntegration.originalCommandMap[cli] === resolved) return;
    updateEvoConfig(targetCwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          [cli]: resolved,
        },
      },
    });
  };

  persistFor(cwd);
  if (normalize(shellHome) !== normalize(cwd)) {
    persistFor(shellHome);
  }
}

function discoverOriginalCommandsFromPath(shellHome: string, binDir: string, cli: SupportedCli): string[] {
  const testWhereStdout = process.env.EVO_TEST_MODE === "1" ? process.env.EVO_TEST_WHERE_STDOUT : undefined;
  const stdout = testWhereStdout ?? (() => {
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

    if (result.status !== 0) return "";
    return String(result.stdout ?? "");
  })();

  const candidates = dedupeCommandCandidates(
    String(stdout ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => normalize(path.dirname(item)) !== normalize(binDir))
    .filter((item) => !isLegacyEvoBackupCommand(item))
    .sort((a, b) => rankResolvedCommandCandidate(a) - rankResolvedCommandCandidate(b)),
  );
  for (const candidate of candidates) {
    shellPathLog.debug("path candidate", { candidate, exists: fs.existsSync(candidate), cli });
  }
  return candidates;
}

export function resolveOriginalCommand(cwd: string, cli: SupportedCli): string | null {
  const shellHome = getShellHome(cwd);
  const localConfig = ensureEvoConfig(cwd);
  const shellConfig = shellHome === cwd ? localConfig : ensureEvoConfig(shellHome);
  const localKnown = localConfig.shellIntegration.originalCommandMap[cli];
  const shellKnown = shellConfig.shellIntegration.originalCommandMap[cli];
  const binDir = getBinDir(shellHome);
  const configuredCandidates = dedupeCommandCandidates([localKnown, shellKnown]);
  const siblingCandidates = configuredCandidates.flatMap((commandPath) => getSiblingCommandCandidates(commandPath, cli));
  const liveConfiguredCandidates = configuredCandidates.filter((commandPath) => !isLegacyEvoBackupCommand(commandPath));
  const discoveredCandidates = discoverOriginalCommandsFromPath(shellHome, binDir, cli);
  const fallbackCandidates = configuredCandidates;

  const resolvedRaw = dedupeCommandCandidates([
    ...siblingCandidates,
    ...liveConfiguredCandidates,
    ...discoveredCandidates,
    ...fallbackCandidates,
  ]).find((candidate) => isUsableCommandCandidate(candidate)) ?? null;

  // Follow an npm interpreter shim (.cmd/.ps1/.bat/extensionless) through to the
  // real .exe it points at, so we spawn the .exe directly and never wrap it in a
  // cmd.exe/PowerShell layer that can wedge on a never-EOF stdin. No-op unless
  // the shim points at an existing .exe.
  const resolved = resolvedRaw ? followShimToExe(resolvedRaw) : null;

  if (resolved && !isLegacyEvoBackupCommand(resolved)) {
    persistResolvedCommand(cwd, shellHome, cli, resolved);
  }

  if (resolved) {
    shellResolveLog.info("resolved original command", { cli, resolvedPath: resolved });
  }

  return resolved;
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

function buildWrapperContent(kind: "sh" | "cmd" | "ps1", cli: SupportedCli, cwd: string): string {
  const mainPath = path.join(cwd, "dist", "index.js");
  const configPath = path.join(cwd, ".evo", "config.json");
  const cmdBackup = `${cli}.evo-original.cmd`;
  const titleLabel = `${cli} [Evo ON]`;
  // Nesting guard runs before the shellIntegration.enabled check below: a nested
  // re-invocation must pass straight through to the real claude regardless of
  // whether integration is enabled.
  const nestingGuard = buildNestingGuardLines(kind, resolveOriginalForShimGuard(cwd, cli));
  if (kind === "cmd") {
    return [
      "@echo off",
      "setlocal",
      `set \"EVO_HOME=${cwd}\"`,
      `set \"EVO_CONFIG=${configPath}\"`,
      ...nestingGuard,
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
      ...nestingGuard,
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
    ...nestingGuard,
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
  for (const cli of ["claude"] as const) {
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

/**
 * Characters that are forbidden in paths being interpolated into the shim
 * scripts written by `createProxyShims`.  This is the UNION of the dangerous
 * sets for both shim contexts:
 *
 *   PowerShell (.ps1, single-quoted string context):
 *     '   — closes single-quoted string
 *     `   — PowerShell escape
 *     $   — variable expansion
 *     ;   — statement terminator
 *
 *   cmd.exe (.cmd, double-quoted `set "VAR=..."` context):
 *     "   — closes the double-quoted set value
 *     %   — variable expansion (e.g. %PATH%)
 *     &   — command separator
 *     |   — pipe
 *     <   — input redirect
 *     >   — output redirect
 *     ^   — escape character
 *
 *   Always:
 *     \n \r — newlines, allow arbitrary command injection in either context
 *
 * Refusing on the union means we will reject paths that might be unsafe in
 * either generated shim, regardless of which one is being written at the
 * moment.
 */
const SHIM_PATH_FORBIDDEN = /['"`$;%&|<>^\n\r]/;

/**
 * Defense-in-depth nesting guard emitted into every generated shim. When the
 * shim runs while `EVO_PROXY_ACTIVE=1` — i.e. claude re-invoked `claude` by name
 * from inside an Evo proxy (a `/logout` re-auth flow, or the native updater
 * relaunching itself) — it execs the real claude directly instead of opening a
 * second `node dist/index.js proxy` session. The runtime guard in
 * `src/index.ts` is the primary fix; this shim-level guard just avoids paying
 * the Node startup on the nested hop and closes the window before Evo's own
 * process is ever involved.
 *
 * Pure and side-effect free: the caller resolves the original command (skipping
 * resolution entirely in EVO_TEST_MODE) and passes it in. Returns no guard lines
 * when the original cannot be resolved or is unsafe to interpolate into this
 * shim kind — in that case the runtime guard still handles the nested case.
 */
export function buildNestingGuardLines(kind: "sh" | "cmd" | "ps1", original: string | null): string[] {
  if (!original || SHIM_PATH_FORBIDDEN.test(original)) return [];
  if (kind === "cmd") {
    // Two standalone `if` statements, NOT a parenthesized block: inside a
    // `( ... )` block cmd.exe expands %ERRORLEVEL% at parse time (before the
    // `call` runs), so it would always be 0 and mask the nested claude's real
    // exit code. As separate lines, cmd parses the exit line only after the
    // call line has executed, so %ERRORLEVEL% is the real post-call value.
    // (Delayed expansion / `!ERRORLEVEL!` is avoided because enabling it would
    // make `!` special and corrupt any nested claude argument containing `!`.)
    return [
      `if \"%EVO_PROXY_ACTIVE%\"==\"1\" call \"${original}\" %*`,
      `if \"%EVO_PROXY_ACTIVE%\"==\"1\" exit /b %ERRORLEVEL%`,
    ];
  }
  if (kind === "ps1") {
    return [
      "if ($env:EVO_PROXY_ACTIVE -eq '1') {",
      `  & '${escapePowerShellSingleQuotes(original)}' @args`,
      "  exit $LASTEXITCODE",
      "}",
    ];
  }
  return [
    `if [ \"$EVO_PROXY_ACTIVE\" = \"1\" ]; then`,
    `  exec \"${original.replace(/\\/g, "/")}\" \"$@\"`,
    "fi",
  ];
}

/**
 * Resolve the original command for shim-guard emission, skipping resolution in
 * EVO_TEST_MODE (mirrors installCommandWrappers) so unit tests stay
 * deterministic and never trigger a real `where` probe.
 */
function resolveOriginalForShimGuard(cwd: string, cli: SupportedCli): string | null {
  if (process.env.EVO_TEST_MODE === "1") return null;
  return resolveOriginalCommand(cwd, cli);
}

export function createProxyShims(cwd: string): string[] {
  if (SHIM_PATH_FORBIDDEN.test(cwd)) {
    throw new Error(
      `Cannot install shim into a path containing shell metacharacters ` +
        `(single-quote, double-quote, backtick, $, ;, %, &, |, <, >, ^, or newline): ` +
        `${JSON.stringify(cwd)}. ` +
        `Move the project to a path without these characters and re-run 'evo install-statusline'.`,
    );
  }
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

  for (const cli of ["claude"] as const) {
    const original = resolveOriginalForShimGuard(cwd, cli);

    const cmdShimPath = path.join(binDir, `${cli}.cmd`);
    const cmdContent = [
      "@echo off",
      "setlocal",
      `set "EVO_HOME=${cwd}"`,
      `set "EVO_CONFIG=${configPath}"`,
      ...buildNestingGuardLines("cmd", original),
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
      ...buildNestingGuardLines("ps1", original),
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
      ...buildNestingGuardLines("sh", original),
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
