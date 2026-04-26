import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

export interface LogsCommandOptions {
  tail?: number;
  since?: string;
  cwd?: string;
}

const SESSION_FILE_REGEX = /^session-(\d{8})\.log$/;
const DURATION_TOKEN_REGEX = /(\d+)([dhm])/g;
// ISO 8601 timestamp at the very start of a log line, followed by a space.
// e.g. "2026-04-25T12:34:56.789Z INFO  [comp] message"
const ISO_TIMESTAMP_PREFIX_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/;

/**
 * Parse a duration string like "30m", "2h", "1d", "5d12h30m" into milliseconds.
 * Returns null if the string is empty or contains no recognizable tokens.
 */
export function parseDurationMs(input: string): number | null {
  if (!input) return null;
  let total = 0;
  let matched = false;
  // Reset regex state for each call.
  const re = new RegExp(DURATION_TOKEN_REGEX.source, "g");
  // Verify the entire string is composed of tokens (no stray characters).
  const stripped = input.replace(re, "");
  if (stripped.trim().length > 0) {
    return null;
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    const unit = m[2];
    if (unit === "d") total += n * 24 * 60 * 60 * 1000;
    else if (unit === "h") total += n * 60 * 60 * 1000;
    else if (unit === "m") total += n * 60 * 1000;
    matched = true;
  }
  return matched ? total : null;
}

interface SessionFileEntry {
  name: string;
  fullPath: string;
  /** UTC midnight time (ms) representing the file's day stamp. */
  dayMs: number;
}

function listSessionFiles(logDir: string): SessionFileEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  const out: SessionFileEntry[] = [];
  for (const name of entries) {
    const m = SESSION_FILE_REGEX.exec(name);
    if (!m) continue;
    const stamp = m[1];
    const year = Number(stamp.slice(0, 4));
    const month = Number(stamp.slice(4, 6));
    const day = Number(stamp.slice(6, 8));
    const dayMs = Date.UTC(year, month - 1, day);
    if (!Number.isFinite(dayMs)) continue;
    out.push({ name, fullPath: path.join(logDir, name), dayMs });
  }
  return out;
}

async function readLastLines(filePath: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const ring: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      ring.push(line);
      if (ring.length > n) ring.shift();
    });
    rl.on("close", () => resolve());
    rl.on("error", reject);
    stream.on("error", reject);
  });
  return ring;
}

async function readLinesSince(filePath: string, cutoffMs: number): Promise<string[]> {
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line: string) => {
      const m = ISO_TIMESTAMP_PREFIX_REGEX.exec(line);
      if (!m) return;
      const t = Date.parse(m[1]);
      if (!Number.isFinite(t)) return;
      if (t >= cutoffMs) out.push(line);
    });
    rl.on("close", () => resolve());
    rl.on("error", reject);
    stream.on("error", reject);
  });
  return out;
}

/**
 * Run `evo logs`. Streams the log directory and prints filtered lines to stdout.
 */
export async function runLogsCommand(opts: LogsCommandOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const logDir =
    process.env.EVO_LOG_DIR !== undefined && process.env.EVO_LOG_DIR !== ""
      ? process.env.EVO_LOG_DIR
      : path.join(cwd, ".evo", "logs");

  if (!fs.existsSync(logDir)) {
    process.stderr.write(`no logs found at ${logDir}\n`);
    return;
  }

  let useSince = false;
  let cutoffMs = 0;
  if (opts.since !== undefined && opts.since !== "") {
    const ms = parseDurationMs(opts.since);
    if (ms === null) {
      process.stderr.write(`invalid --since duration: ${opts.since}\n`);
      process.exitCode = 1;
      return;
    }
    cutoffMs = Date.now() - ms;
    useSince = true;
    if (opts.tail !== undefined) {
      process.stderr.write("warning: --tail ignored when --since is provided\n");
    }
  }

  const files = listSessionFiles(logDir);
  if (files.length === 0) {
    return;
  }
  // Newest-to-oldest by stamp.
  files.sort((a, b) => b.dayMs - a.dayMs);

  if (useSince) {
    // cutoff day = UTC midnight of the cutoff timestamp's day.
    const cutoffDate = new Date(cutoffMs);
    const cutoffDayMs = Date.UTC(
      cutoffDate.getUTCFullYear(),
      cutoffDate.getUTCMonth(),
      cutoffDate.getUTCDate(),
    );
    // Walk newest -> oldest; collect, then stop scanning files older than cutoff day.
    const collected: string[][] = [];
    for (const f of files) {
      if (f.dayMs < cutoffDayMs) {
        // This file's day is strictly before the cutoff day → no line in it can
        // satisfy cutoff. Stop walking older files.
        break;
      }
      const lines = await readLinesSince(f.fullPath, cutoffMs);
      collected.push(lines);
    }
    // Print oldest-first within the matched window.
    for (let i = collected.length - 1; i >= 0; i--) {
      for (const line of collected[i]) {
        process.stdout.write(line + "\n");
      }
    }
    return;
  }

  // --tail mode (default 50)
  const n = opts.tail !== undefined && Number.isFinite(opts.tail) ? Math.max(0, Number(opts.tail)) : 50;
  const latest = files[0];
  const tailLines = await readLastLines(latest.fullPath, n);
  for (const line of tailLines) {
    process.stdout.write(line + "\n");
  }
}
