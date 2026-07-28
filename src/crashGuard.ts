// crashGuard — never leave the user's terminal wedged, never die silently.
//
// Two failures the wrapper caused in the field, both fixed here:
//
// 1. TERMINAL WEDGE. The wrapped CLI turns on xterm mouse reporting. Evo owns
//    the TTY (the CLI is its child), so when Evo dies without restoring
//    terminal modes the mouse stays in reporting mode and every subsequent
//    mouse movement types escape sequences like `^[[<35;73;27M` into the
//    user's shell. The user sees "garbage typing itself" and has to close the
//    window. Evo never enables these modes itself, but it is the process
//    attached to the terminal, so restoring them is its responsibility.
//
// 2. SILENT-TO-THE-TOOLING DEATH. A raw stack trace on stdout is invisible to
//    any health check. We also append a machine-readable crash record so a
//    watchdog can tell the user something broke before they discover it.
//
// Everything here is best-effort and must never itself throw: this code runs
// on the way out of a process that is already failing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Disable every input-reporting mode the wrapped CLI may have enabled, and
 * make the cursor visible again.
 *
 * Deliberately NOT included: `\x1b[?1049l` (leave alternate screen). Leaving
 * the alt screen here would wipe the crash message we just printed, which is
 * the one thing the user needs to see.
 */
const TERMINAL_RESET =
  "\x1b[?1000l" + // X11 mouse click reporting
  "\x1b[?1002l" + // cell motion tracking
  "\x1b[?1003l" + // all motion tracking
  "\x1b[?1005l" + // UTF-8 extended coordinates
  "\x1b[?1006l" + // SGR extended coordinates (the `^[[<35;73;27M` form)
  "\x1b[?1015l" + // urxvt extended coordinates
  "\x1b[?2004l" + // bracketed paste
  "\x1b[?25h"; //   show cursor

let restored = false;

/**
 * Test-only helper: clears the "already restored" latch so a test can exercise
 * restoreTerminal() more than once per process.
 */
export function __resetTerminalRestoreForTests(): void {
  restored = false;
}

/**
 * Restore terminal modes. Idempotent and safe to call from an `exit` handler
 * (uses only synchronous primitives).
 */
export function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
  } catch {
    /* ignore — restoring output modes below still matters */
  }
  try {
    // Only ever emit escape sequences to a real terminal. Writing them
    // unconditionally corrupts piped/redirected output for every scripted
    // consumer of the CLI — there is also nothing to restore when stdout is
    // not a TTY, because no terminal mode was ever set.
    if (!process.stdout.isTTY) return;
    // writeSync, not process.stdout.write: async writes can be dropped when
    // the process is already exiting.
    fs.writeSync(1, TERMINAL_RESET);
  } catch {
    /* ignore */
  }
}

/**
 * Directory holding crash records. Fixed per-user location rather than the
 * project's `.evo/logs/`, because crashes happen in arbitrary working
 * directories and a watchdog needs exactly one place to look.
 */
export function crashDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const base = localAppData && localAppData.length > 0
    ? path.join(localAppData, "evo")
    : path.join(os.homedir(), ".evo");
  return path.join(base, "crashes");
}

/** Path of the append-only crash log (JSON Lines). */
export function crashLogPath(): string {
  return path.join(crashDir(), "crashes.jsonl");
}

/**
 * Append one crash record. Best-effort: a failure to record must not mask the
 * original error.
 */
export function writeCrashRecord(error: unknown, origin: string): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const errno = (err as NodeJS.ErrnoException).errno;
    const record = {
      at: new Date().toISOString(),
      origin,
      message: err.message,
      code: (err as NodeJS.ErrnoException).code ?? null,
      errno: typeof errno === "number" ? errno : null,
      syscall: (err as NodeJS.ErrnoException).syscall ?? null,
      path: (err as NodeJS.ErrnoException).path ?? null,
      cwd: process.cwd(),
      pid: process.pid,
      version: process.version,
      // Head of the stack only: enough to identify the site, small enough that
      // the log stays cheap to scan.
      stackHead: (err.stack ?? "").split("\n").slice(0, 5).join("\n"),
    };
    const dir = crashDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(crashLogPath(), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Install process-level handlers.
 *
 * Note on signals: we deliberately do NOT register a SIGINT/SIGTERM listener.
 * Adding one changes termination semantics (a listener suppresses the default
 * kill), and `proxyRuntime` already owns SIGINT for Ctrl+C forwarding. The
 * `exit` handler below runs on those paths anyway, so the terminal is restored
 * without us touching signal behaviour.
 */
export function installCrashGuard(): void {
  process.on("exit", () => {
    restoreTerminal();
  });

  process.on("uncaughtException", (error: Error) => {
    writeCrashRecord(error, "uncaughtException");
    restoreTerminal();
    const err = error as NodeJS.ErrnoException;
    const detail = err.code ? ` (${err.code}${err.path ? `: ${err.path}` : ""})` : "";
    process.stderr.write(`evo: fatal error — ${error.message}${detail}\n`);
    process.stderr.write(`evo: crash recorded at ${crashLogPath()}\n`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    writeCrashRecord(reason, "unhandledRejection");
    restoreTerminal();
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`evo: fatal error (unhandled rejection) — ${message}\n`);
    process.stderr.write(`evo: crash recorded at ${crashLogPath()}\n`);
    process.exit(1);
  });
}
