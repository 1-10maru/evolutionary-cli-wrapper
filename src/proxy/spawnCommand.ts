// spawnCommand — cross-platform spawn helper for the wrapped CLI.
//
// Pure refactor of spawnInteractiveCommand previously inlined in
// src/proxyRuntime.ts. Behaviour is preserved verbatim:
//   - .cmd / .bat → shell:true with array form + windowsVerbatimArguments,
//                   per-arg cmd.exe-aware quoting via quoteArgForCmd
//   - .ps1 → pwsh (preferred) or powershell, -ExecutionPolicy Bypass, shell:false
//   - other → direct spawn, shell:false
// The EVO_PROXY_ACTIVE / EVO_PROXY_DISABLED env vars are injected in all branches.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * Shell metacharacters that are dangerous when a commandPath is interpolated
 * into a shell command string. We reject paths that contain these characters
 * at the spawn boundary rather than trying to escape them.
 *
 * Includes:
 *   < > | & ^ " `   — classical shell metacharacters
 *   \n \r           — line breaks (would split into multiple commands)
 *   %               — cmd.exe variable expansion (e.g. %PATH%)
 *   \t              — tab (defensive; unusual in legitimate paths)
 *   \0              — null byte (defense in depth against truncation tricks)
 */
const SHELL_METACHAR_RE = /[<>|&^"`\n\r%\t\0]/;

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

/**
 * Quotes a single argument for cmd.exe consumption when used together with
 * `windowsVerbatimArguments: true`.
 *
 * With `windowsVerbatimArguments: true`, Node passes the joined args verbatim
 * to the child process command line; cmd.exe then re-tokenizes via its own
 * parsing rules. To preserve the per-arg boundary, we wrap any arg containing
 * whitespace, embedded quotes, or shell-special characters in double quotes,
 * and escape embedded quotes by doubling them (cmd.exe convention).
 */
function quoteArgForCmd(arg: string): string {
  if (arg.length === 0 || /[\s"&|<>^()]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/** Cache the resolved PowerShell binary name for the lifetime of the process. */
let _cachedPsBinary: string | null = null;

/**
 * Test-only helper to reset the resolved PowerShell binary cache. Allows unit
 * tests to mock `child_process.spawnSync` and re-trigger resolution.
 */
export function _resetPsBinaryCacheForTesting(): void {
  _cachedPsBinary = null;
}

/**
 * Resolves the PowerShell binary to use. Prefers `pwsh` (PowerShell 7+) and
 * falls back to `powershell` (Windows PowerShell 5.x / legacy). If the locate
 * command itself throws (e.g. `where` / `which` missing), falls back to
 * `powershell` gracefully.
 */
function resolvePowershellBinary(): string {
  if (_cachedPsBinary !== null) return _cachedPsBinary;

  const locateCmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(locateCmd, ["pwsh"], { encoding: "utf8" });
    _cachedPsBinary = result.status === 0 ? "pwsh" : "powershell";
  } catch {
    _cachedPsBinary = "powershell";
  }
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
    return spawn(commandPath, args.map(quoteArgForCmd), {
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

/**
 * Terminate a spawned child and, on Windows, its entire process tree.
 *
 * On POSIX, forwarding the signal to the child is enough for our shell:false
 * spawns. On Windows there are no real signals and `.cmd`/`.bat` originals run
 * under a cmd.exe wrapper whose grandchildren survive a plain `child.kill()`;
 * we shell out to `taskkill /PID <pid> /T /F` to tear the whole tree down so
 * the wrapped CLI is never left orphaned. Best-effort: never throws, so it is
 * safe to call from signal handlers and teardown paths.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    child.kill(signal);
  } catch {
    // best-effort — never throw from a signal/teardown path
  }
}

// Export internals for testing.
export { assertSafeCommandPath, quoteArgForCmd, resolvePowershellBinary };
