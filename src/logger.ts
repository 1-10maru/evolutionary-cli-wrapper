import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";
export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  error(component: string, message: string, ctx?: LogContext): void;
  warn(component: string, message: string, ctx?: LogContext): void;
  info(component: string, message: string, ctx?: LogContext): void;
  debug(component: string, message: string, ctx?: LogContext): void;
  child(component: string): BoundLogger;
  flush(): void;
}

export interface BoundLogger {
  error(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  debug(message: string, ctx?: LogContext): void;
}

/**
 * Parse `DEBUG=evopet:proxy,evopet:render` style env var into a namespace
 * matcher function. Returns null if DEBUG is not set or has no `evopet:*`
 * entries (meaning namespace-level debug filtering is inactive).
 *
 * When the matcher is active, a call to emit() with level DEBUG is passed only
 * if the component matches at least one of the listed namespaces. Wildcard `*`
 * (e.g. `evopet:*`) matches any component that starts with the prefix before
 * the `*`.
 */
function buildDebugNamespaceMatcher(debugEnv: string | undefined): ((ns: string) => boolean) | null {
  if (!debugEnv) return null;
  const tokens = debugEnv.split(",").map((t) => t.trim()).filter((t) => t.startsWith("evopet:"));
  if (tokens.length === 0) return null;
  return (ns: string): boolean => {
    for (const token of tokens) {
      if (token.endsWith("*")) {
        const prefix = token.slice(0, -1); // strip trailing *
        if (ns.startsWith(prefix)) return true;
      } else if (ns === token) {
        return true;
      }
    }
    return false;
  };
}

const LEVEL_ORDER: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const LEVEL_PADDED: Record<LogLevel, string> = {
  ERROR: "ERROR",
  WARN: "WARN ",
  INFO: "INFO ",
  DEBUG: "DEBUG",
};
const ROTATE_REGEX = /^session-(\d{8})\.log$/;
const RETENTION_DAYS = 30;
const QUEUE_HIGH_WATER = 32;

/** Log output format — "text" (default) or "json" (structured JSON lines). */
export type LogFormat = "text" | "json";

interface LoggerState {
  level: LogLevel;
  disabled: boolean;
  logDir: string;
  logFile: string;
  fd: number | null;
  queue: string[];
  exitListener: (() => void) | null;
  beforeExitListener: (() => void) | null;
  initialized: boolean;
  /** When non-null, enables debug for matching namespaces only (DEBUG=evopet:*). */
  debugMatcher: ((ns: string) => boolean) | null;
  /** Output format derived from EVO_LOG_FORMAT env var. */
  format: LogFormat;
}

let state: LoggerState | null = null;

function todayUtcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

function readLevel(): LogLevel {
  // EVO_DEBUG=1 forces DEBUG regardless of EVO_LOG_LEVEL.
  if (process.env.EVO_DEBUG === "1") return "DEBUG";
  // DEBUG=evopet:* also implies DEBUG level when present.
  if (process.env.DEBUG && process.env.DEBUG.includes("evopet:")) return "DEBUG";
  const raw = (process.env.EVO_LOG_LEVEL || "INFO").toUpperCase();
  if (raw === "ERROR" || raw === "WARN" || raw === "INFO" || raw === "DEBUG") {
    return raw;
  }
  return "INFO";
}

function readFormat(): LogFormat {
  return process.env.EVO_LOG_FORMAT === "json" ? "json" : "text";
}

function pruneOldLogs(logDir: string): void {
  try {
    const entries = fs.readdirSync(logDir);
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      const m = ROTATE_REGEX.exec(name);
      if (!m) continue;
      const stamp = m[1];
      const year = Number(stamp.slice(0, 4));
      const month = Number(stamp.slice(4, 6));
      const day = Number(stamp.slice(6, 8));
      const fileTime = Date.UTC(year, month - 1, day);
      if (Number.isFinite(fileTime) && fileTime < cutoffMs) {
        try {
          fs.unlinkSync(path.join(logDir, name));
        } catch {
          // ignore individual delete failures
        }
      }
    }
  } catch {
    // janitorial; never throw
  }
}

// Lightweight tracking detection. We cannot import `./proxy/sessionMode`
// directly because sessionMode imports logger -> circular dependency.
// Instead we re-implement the minimum check here, gated by EVO_LOG_DIR
// override and EVO_LOG_DISABLE escape. Behaviour mirrors
// `shouldUseLightweightTracking` but is deliberately conservative: when
// in doubt, assume lightweight (i.e. do NOT create `.evo/logs/`) to avoid
// disk artefacts in aggregate parent dirs / home dir.
function isLightweightCwdForLogger(baseDir: string): boolean {
  // If user has explicitly set EVO_LOG_DIR, respect it (logger always emits).
  if (process.env.EVO_LOG_DIR) return false;
  let resolved: string;
  try {
    resolved = path.resolve(baseDir);
  } catch {
    return true;
  }
  let homedir: string;
  try {
    homedir = path.resolve(require("node:os").homedir());
  } catch {
    homedir = "";
  }
  if (homedir && resolved === homedir) return true;
  const markers = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
  ];
  for (const marker of markers) {
    try {
      if (fs.existsSync(path.join(resolved, marker))) return false;
    } catch {
      // ignore
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return true;
  }
  const visible = entries.filter((e) => !e.name.startsWith("."));
  const dirCount = visible.filter((e) => e.isDirectory()).length;
  const fileCount = visible.filter((e) => e.isFile()).length;
  if (dirCount >= 8) return true;
  if (dirCount >= 5 && visible.length >= 15 && fileCount <= 6) return true;
  return false;
}

function ensureState(): LoggerState {
  if (state) return state;
  const disabled =
    process.env.EVO_LOG_DISABLE === "1" || isLightweightCwdForLogger(process.env.EVO_LOG_DIR || process.cwd());
  const baseDir = process.env.EVO_LOG_DIR || process.cwd();
  const logDir = path.join(baseDir, ".evo", "logs");
  const logFile = path.join(logDir, `session-${todayUtcStamp()}.log`);
  state = {
    level: readLevel(),
    disabled,
    logDir,
    logFile,
    fd: null,
    queue: [],
    exitListener: null,
    beforeExitListener: null,
    initialized: false,
    debugMatcher: buildDebugNamespaceMatcher(process.env.DEBUG),
    format: readFormat(),
  };
  return state;
}

function initSink(s: LoggerState): void {
  if (s.initialized || s.disabled) return;
  s.initialized = true;
  try {
    fs.mkdirSync(s.logDir, { recursive: true });
  } catch {
    // if we cannot create the dir, downgrade to no-op
    s.disabled = true;
    return;
  }
  pruneOldLogs(s.logDir);
  try {
    s.fd = fs.openSync(s.logFile, "a");
  } catch {
    s.fd = null;
  }
  const flushSync = (): void => {
    flushQueue(s);
  };
  s.exitListener = flushSync;
  s.beforeExitListener = flushSync;
  process.on("exit", s.exitListener);
  process.on("beforeExit", s.beforeExitListener);
}

function flushQueue(s: LoggerState): void {
  if (s.queue.length === 0) return;
  const pending = s.queue.join("");
  s.queue.length = 0;
  if (s.fd !== null) {
    try {
      fs.writeSync(s.fd, pending);
      return;
    } catch {
      // fall through to appendFileSync as best-effort
    }
  }
  try {
    fs.mkdirSync(s.logDir, { recursive: true });
    fs.appendFileSync(s.logFile, pending);
  } catch {
    // best-effort
  }
}

function formatText(level: LogLevel, component: string, message: string, ctx?: LogContext): string {
  const ts = new Date().toISOString();
  const padded = LEVEL_PADDED[level];
  const ctxPart = ctx === undefined ? "" : " " + JSON.stringify(ctx);
  return `${ts} ${padded} [${component}] ${message}${ctxPart}\n`;
}

function formatJson(level: LogLevel, component: string, message: string, ctx?: LogContext): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: level.trim(),
    ns: component,
    msg: message,
  };
  if (ctx !== undefined) {
    Object.assign(entry, ctx);
  }
  return JSON.stringify(entry) + "\n";
}

function formatLine(s: LoggerState, level: LogLevel, component: string, message: string, ctx?: LogContext): string {
  return s.format === "json"
    ? formatJson(level, component, message, ctx)
    : formatText(level, component, message, ctx);
}

function emit(level: LogLevel, component: string, message: string, ctx?: LogContext): void {
  const s = ensureState();
  if (s.disabled) return;

  // Namespace-level debug filter: if DEBUG=evopet:* is active and this is a
  // DEBUG emit, only pass it if the component matches.
  if (level === "DEBUG" && s.debugMatcher !== null && !s.debugMatcher(component)) return;

  if (LEVEL_ORDER[level] > LEVEL_ORDER[s.level]) return;
  initSink(s);
  if (s.disabled) return;
  const line = formatLine(s, level, component, message, ctx);
  s.queue.push(line);
  if (s.queue.length >= QUEUE_HIGH_WATER) {
    flushQueue(s);
  }
  if (s.level === "DEBUG") {
    try {
      process.stderr.write(line);
    } catch {
      // ignore
    }
  }
}

function flushAll(): void {
  const s = state;
  if (!s || s.disabled) return;
  flushQueue(s);
}

const logger: Logger = {
  error: (component, message, ctx) => emit("ERROR", component, message, ctx),
  warn: (component, message, ctx) => emit("WARN", component, message, ctx),
  info: (component, message, ctx) => emit("INFO", component, message, ctx),
  debug: (component, message, ctx) => emit("DEBUG", component, message, ctx),
  child: (component: string): BoundLogger => ({
    error: (message, ctx) => emit("ERROR", component, message, ctx),
    warn: (message, ctx) => emit("WARN", component, message, ctx),
    info: (message, ctx) => emit("INFO", component, message, ctx),
    debug: (message, ctx) => emit("DEBUG", component, message, ctx),
  }),
  flush: flushAll,
};

export function getLogger(): Logger {
  ensureState();
  return logger;
}

/**
 * Returns the resolved log directory for the current logger state.
 * Useful for tooling (e.g. `evo doctor`, `evo logs --bundle`) that needs to
 * locate log files without going through the logger itself.
 */
export function getLogDir(): string {
  const s = ensureState();
  return s.logDir;
}

export function __resetLoggerForTests(): void {
  if (!state) return;
  // Drain any queued lines before tearing down so tests that flushed don't lose data
  flushQueue(state);
  if (state.exitListener) {
    process.removeListener("exit", state.exitListener);
  }
  if (state.beforeExitListener) {
    process.removeListener("beforeExit", state.beforeExitListener);
  }
  if (state.fd !== null) {
    try {
      fs.closeSync(state.fd);
    } catch {
      // ignore
    }
  }
  state = null;
}
