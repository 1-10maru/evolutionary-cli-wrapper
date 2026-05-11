import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { buildReport } from "./doctor";

export interface LogsCommandOptions {
  tail?: number;
  since?: string;
  cwd?: string;
  bundle?: boolean;
  out?: string;
}

// ── Redaction helpers ──────────────────────────────────────────────────────

const SENSITIVE_LINE_RE = /originalCmdAutoRun/i;
// Match Windows-style user paths: C:/Users/<name>/... or C:\Users\<name>\...
const WIN_USER_PATH_RE = /([Cc]:[/\\][Uu]sers[/\\])([^/\\]+)([/\\])/g;

/**
 * Pattern 1 — JSON-style: `"KEY":"value"` or `"KEY": "value"`.
 * Captures the key (with surrounding quotes) and the value-opening quote so
 * the replacement preserves the syntactic structure.
 */
const SECRET_JSON_RE = /("(?:\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*)"\s*:\s*)"([^"]*)"/gi;
/**
 * Pattern 2 — quoted bare assignment: `KEY="multi word value"`.
 * Reads through to the closing quote so multi-word values are fully masked
 * (the old `\S+` pattern stopped at the first whitespace and leaked the tail).
 */
const SECRET_QUOTED_RE = /(\b\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*\s*=\s*)"([^"]*)"/gi;
/**
 * Pattern 3 — unquoted assignment: `KEY=value` or `KEY: value` (no quotes).
 * Value is a non-whitespace, non-quote run. The leading `(?!["'])` lookahead
 * prevents this pattern from eating quoted values (those belong to Pattern 1
 * or Pattern 2). Without it, `KEY="abc def"` would be matched as
 * `KEY=` + `"abc` and leak the rest.
 */
const SECRET_BARE_RE = /(\b\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*\s*[:=]\s*)(?!["'])([^\s"']+)/gi;

function hashUsername(name: string): string {
  return crypto.createHash("sha1").update(name).digest("hex").slice(0, 10);
}

/**
 * Redact secret values in a single log line. Applies three patterns in order
 * from most-specific to least-specific so a single value is only masked once:
 *   1. JSON-style `"KEY":"value"` → `"KEY":"[REDACTED]"`
 *   2. quoted bare `KEY="value"` → `KEY="[REDACTED]"`
 *   3. unquoted `KEY=value` / `KEY: value` → `KEY=[REDACTED]`
 *
 * Exported for unit testing.
 */
export function redactSecrets(line: string): string {
  let out = line;
  // Pattern 1: JSON-quoted (most specific) — must run first so the quoted
  // value isn't matched by Pattern 3 as `"value"` (non-whitespace run).
  out = out.replace(SECRET_JSON_RE, '$1"[REDACTED]"');
  // Pattern 2: quoted bare assignment (KEY="value with spaces")
  out = out.replace(SECRET_QUOTED_RE, '$1"[REDACTED]"');
  // Pattern 3: unquoted (KEY=value, no surrounding quotes)
  out = out.replace(SECRET_BARE_RE, '$1[REDACTED]');
  return out;
}

function redactLine(line: string): string {
  // Drop lines with sensitive registry paths
  if (SENSITIVE_LINE_RE.test(line)) return "";
  // Redact inline sensitive key=value pairs (three patterns)
  let out = redactSecrets(line);
  // Hash usernames in Windows-style paths
  out = out.replace(WIN_USER_PATH_RE, (_, prefix, username, sep) => {
    return `${prefix}${hashUsername(username)}${sep}`;
  });
  return out;
}

function redactConfigObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return (obj as unknown[]).map(redactConfigObject);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/(_TOKEN|_KEY|_SECRET|_PASSWORD)$/i.test(k)) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      result[k] = redactConfigObject(v);
    } else if (typeof v === "string" && /originalCmdAutoRun/i.test(k)) {
      result[k] = "[REDACTED]";
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ── Minimal ZIP writer (no external dependencies) ─────────────────────────
// We implement a ZIP 2.0 writer (no ZIP64; up to 4 GB per file, sufficient for
// log bundles) using Node's built-in zlib for deflate. Log bundles are
// typically a few MB total — well within the 32-bit size header limits.

interface ZipEntry {
  name: string; // path inside the zip
  data: Buffer;
}

/**
 * Write a minimal ZIP archive to `outPath` from an array of in-memory entries.
 * Uses DEFLATE compression via Node's built-in zlib.
 *
 * Design note: We chose Node built-ins over `archiver` to keep zero new runtime
 * dependencies. The implementation is a straightforward local-file-header +
 * central-directory format (ZIP version 2.0, no ZIP64). All size fields are
 * 32-bit, so individual entries and the total archive are capped at 4 GB —
 * sufficient for log bundles (typically a few MB).
 */
function writeZip(outPath: string, entries: ZipEntry[]): void {
  const parts: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0x0800, 6);      // general purpose bit flag: UTF-8
    localHeader.writeUInt16LE(8, 8);           // compression: DEFLATE
    localHeader.writeUInt16LE(0, 10);          // mod time
    localHeader.writeUInt16LE(0, 12);          // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuffer.copy(localHeader, 30);
    parts.push(localHeader);
    parts.push(compressed);

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBuffer.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // signature
    cdEntry.writeUInt16LE(20, 4);          // version made by
    cdEntry.writeUInt16LE(20, 6);          // version needed
    cdEntry.writeUInt16LE(0x0800, 8);      // UTF-8
    cdEntry.writeUInt16LE(8, 10);          // DEFLATE
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(compressed.length, 20);
    cdEntry.writeUInt32LE(entry.data.length, 24);
    cdEntry.writeUInt16LE(nameBuffer.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra
    cdEntry.writeUInt16LE(0, 32); // comment
    cdEntry.writeUInt16LE(0, 34); // disk start
    cdEntry.writeUInt16LE(0, 36); // internal attrs
    cdEntry.writeUInt32LE(0, 38); // external attrs
    cdEntry.writeUInt32LE(offset, 42); // local header offset
    nameBuffer.copy(cdEntry, 46);
    centralDirEntries.push(cdEntry);

    offset += localHeader.length + compressed.length;
  }

  const cdStart = offset;
  const cdBuffer = Buffer.concat(centralDirEntries);
  parts.push(cdBuffer);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  fs.writeFileSync(outPath, Buffer.concat(parts));
}

/** CRC-32 implementation (standard ZIP CRC). */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Bundle logic ───────────────────────────────────────────────────────────

async function runBundleCommand(opts: LogsCommandOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const logDir =
    process.env.EVO_LOG_DIR !== undefined && process.env.EVO_LOG_DIR !== ""
      ? process.env.EVO_LOG_DIR
      : path.join(cwd, ".evo", "logs");

  const entries: ZipEntry[] = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Collect last 7 days of session log files
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter((n) => SESSION_FILE_REGEX.test(n));
    for (const name of files) {
      const m = SESSION_FILE_REGEX.exec(name);
      if (!m) continue;
      const stamp = m[1];
      const year = Number(stamp.slice(0, 4));
      const month = Number(stamp.slice(4, 6));
      const day = Number(stamp.slice(6, 8));
      const dayMs = Date.UTC(year, month - 1, day);
      if (dayMs < sevenDaysAgo) continue;
      const filePath = path.join(logDir, name);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const redacted = raw
          .split("\n")
          .map(redactLine)
          .filter((l) => l !== "")
          .join("\n");
        entries.push({ name: `logs/${name}`, data: Buffer.from(redacted, "utf8") });
      } catch {
        // skip unreadable file
      }
    }
  }

  // doctor.json
  try {
    const report = buildReport({ cwd });
    const doctorJson = JSON.stringify(report, null, 2);
    entries.push({ name: "doctor.json", data: Buffer.from(doctorJson, "utf8") });
  } catch {
    // best-effort
  }

  // Redacted config.json
  const evoHome = process.env.EVO_HOME ?? path.join(require("node:os").homedir(), ".claude");
  const configPath = path.join(evoHome, ".evo", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const redacted = redactConfigObject(parsed);
    entries.push({ name: "config.json", data: Buffer.from(JSON.stringify(redacted, null, 2), "utf8") });
  } catch {
    // ENOENT or parse error — skip
  }

  // Write zip
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(cwd, `evo-bundle-${ts}.zip`);

  writeZip(outPath, entries);
  process.stdout.write(`evo-bundle written to: ${outPath}\n`);
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
 * When `opts.bundle` is true, creates a redacted zip bundle instead.
 */
export async function runLogsCommand(opts: LogsCommandOptions): Promise<void> {
  if (opts.bundle) {
    await runBundleCommand(opts);
    return;
  }
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
