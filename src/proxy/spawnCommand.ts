// spawnCommand — cross-platform spawn helper for the wrapped CLI.
//
// Pure refactor of spawnInteractiveCommand previously inlined in
// src/proxyRuntime.ts. Behaviour is preserved verbatim:
//   - .cmd / .bat → shell:true with array form + windowsVerbatimArguments
//   - .ps1 → pwsh (preferred) or powershell, -ExecutionPolicy Bypass, shell:false
//   - other → direct spawn, shell:false
// The EVO_PROXY_ACTIVE / EVO_PROXY_DISABLED env vars are injected in all branches.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Shell metacharacters that are dangerous when a commandPath is interpolated
 * into a shell command string. We reject paths that contain these characters
 * at the spawn boundary rather than trying to escape them.
 */
const SHELL_METACHAR_RE = /[<>|&^"`\n\r]/;

/**
 * Asserts that a command path does not contain shell metacharacters.
 * Throws a descriptive Error if any are found.
 */
function assertSafeCommandPath(p: string): void {
  if (SHELL_METACHAR_RE.test(p)) {
    throw new Error(
      `spawnInteractiveCommand: refusing to spawn command path containing shell metacharacters: ${JSON.stringify(p)}`,
    );
  }
}

/** Cache the resolved PowerShell binary name for the lifetime of the process. */
let _cachedPsBinary: string | undefined;

/**
 * Resolves the PowerShell binary to use. Prefers `pwsh` (PowerShell 7+) and
 * falls back to `powershell` (Windows PowerShell 5.x / legacy).
 */
function resolvePowershellBinary(): string {
  if (_cachedPsBinary !== undefined) return _cachedPsBinary;

  const locateCmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locateCmd, ["pwsh"], { encoding: "utf8" });
  _cachedPsBinary = result.status === 0 ? "pwsh" : "powershell";
  return _cachedPsBinary;
}

export function spawnInteractiveCommand(
  commandPath: string,
  args: string[],
  cwd: string,
  inheritStdio = false,
): ReturnType<typeof spawn> {
  const extension = path.extname(commandPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    assertSafeCommandPath(commandPath);
    return spawn(commandPath, args, {
      cwd,
      shell: true,
      windowsVerbatimArguments: true,
      stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EVO_PROXY_ACTIVE: "1",
        EVO_PROXY_DISABLED: "0",
      },
    });
  }

  if (extension === ".ps1") {
    assertSafeCommandPath(commandPath);
    const psBinary = resolvePowershellBinary();
    return spawn(
      psBinary,
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath, ...args],
      {
        cwd,
        shell: false,
        stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          EVO_PROXY_ACTIVE: "1",
          EVO_PROXY_DISABLED: "0",
        },
      },
    );
  }

  assertSafeCommandPath(commandPath);
  return spawn(commandPath, args, {
    cwd,
    shell: false,
    stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EVO_PROXY_ACTIVE: "1",
      EVO_PROXY_DISABLED: "0",
    },
  });
}

// Export internals for testing.
export { assertSafeCommandPath, resolvePowershellBinary };
