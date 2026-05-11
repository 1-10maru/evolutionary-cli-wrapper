/**
 * Extended logs tests: --bundle functionality and redaction logic.
 * Smoke-tests the zip writer and verifies that sensitive content is masked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLogsCommand, redactSecrets } from "../../src/cli/logs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-cli-logs-bundle-"));
  tempDirs.push(dir);
  return dir;
}

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureStdio(): CapturedIo {
  let stdout = "";
  let stderr = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  (process.stderr as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore: () => {
      (process.stdout as unknown as { write: typeof origOut }).write = origOut;
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    },
  };
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["EVO_LOG_DIR", "EVO_HOME", "EVO_DEBUG", "EVO_LOG_LEVEL", "EVO_LOG_FORMAT"];

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  delete process.env.EVO_LOG_DIR;
  delete process.env.EVO_HOME;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d && fs.existsSync(d)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// ── Minimal ZIP reader ─────────────────────────────────────────────────────

interface ZipFileEntry {
  name: string;
  data: Buffer;
}

/**
 * Parse a ZIP buffer and return the list of entries with decompressed data.
 * Supports the deflate-compressed entries our writer produces.
 */
function parseZip(buf: Buffer): ZipFileEntry[] {
  const entries: ZipFileEntry[] = [];
  let offset = 0;
  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // not a local file header
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    const compressedData = buf.slice(dataStart, dataStart + compressedSize);
    const data = compression === 8
      ? zlib.inflateRawSync(compressedData)
      : compressedData; // stored
    entries.push({ name, data });
    offset = dataStart + compressedSize;
  }
  return entries;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runLogsCommand --bundle smoke test", () => {
  it("creates a valid zip file with expected entries", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;

    // Write a recent log file (today's stamp)
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const logContent = `${new Date().toISOString()} INFO  [test] hello from bundle test\n`;
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), logContent);

    const outPath = path.join(dir, "test-bundle.zip");
    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    expect(io.stdout).toContain(outPath);
    expect(fs.existsSync(outPath)).toBe(true);

    const zipBuf = fs.readFileSync(outPath);
    const entries = parseZip(zipBuf);
    const names = entries.map((e) => e.name);

    // Must contain doctor.json
    expect(names).toContain("doctor.json");
    // Must contain the log file
    expect(names.some((n) => n.startsWith("logs/session-"))).toBe(true);

    // doctor.json must be valid JSON with expected keys
    const doctorEntry = entries.find((e) => e.name === "doctor.json");
    expect(doctorEntry).toBeDefined();
    const doctorParsed = JSON.parse(doctorEntry!.data.toString("utf8")) as Record<string, unknown>;
    expect(doctorParsed).toHaveProperty("versions");
    expect(doctorParsed).toHaveProperty("files");
  });

  it("prints output path to stdout", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;
    const outPath = path.join(dir, "out.zip");

    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    expect(io.stdout).toContain(outPath);
  });
});

describe("--bundle redaction", () => {
  it("drops lines containing originalCmdAutoRun", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;

    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const lines = [
      `${new Date().toISOString()} INFO  [c] safe line`,
      `${new Date().toISOString()} INFO  [c] originalCmdAutoRun=HKCU\\SOFTWARE\\...`,
      `${new Date().toISOString()} INFO  [c] another safe line`,
    ];
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), lines.join("\n") + "\n");

    const outPath = path.join(dir, "redact-test.zip");
    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    const zipBuf = fs.readFileSync(outPath);
    const entries = parseZip(zipBuf);
    const logEntry = entries.find((e) => e.name.startsWith("logs/"));
    expect(logEntry).toBeDefined();
    const content = logEntry!.data.toString("utf8");
    expect(content).toContain("safe line");
    expect(content).not.toContain("originalCmdAutoRun");
  });

  it("redacts TOKEN values inline", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;

    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const line = `${new Date().toISOString()} INFO  [c] env MY_TOKEN=supersecret123 ok`;
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), line + "\n");

    const outPath = path.join(dir, "token-redact.zip");
    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    const zipBuf = fs.readFileSync(outPath);
    const entries = parseZip(zipBuf);
    const logEntry = entries.find((e) => e.name.startsWith("logs/"));
    expect(logEntry).toBeDefined();
    const content = logEntry!.data.toString("utf8");
    expect(content).not.toContain("supersecret123");
    expect(content).toContain("[REDACTED]");
  });

  it("hashes Windows-style usernames in paths", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;

    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const line = `${new Date().toISOString()} INFO  [c] path C:/Users/johndoe/projects/foo`;
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), line + "\n");

    const outPath = path.join(dir, "username-hash.zip");
    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    const zipBuf = fs.readFileSync(outPath);
    const entries = parseZip(zipBuf);
    const logEntry = entries.find((e) => e.name.startsWith("logs/"));
    expect(logEntry).toBeDefined();
    const content = logEntry!.data.toString("utf8");
    expect(content).not.toContain("johndoe");
    // hashed replacement should be present (10-char hex)
    expect(content).toMatch(/C:\/Users\/[a-f0-9]{10}\//);
  });
});

describe("--bundle skips log files older than 7 days", () => {
  it("excludes logs from 8 days ago", async () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;

    const today = new Date();
    const old = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000);
    const todayStamp = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}`;
    const oldStamp = `${old.getUTCFullYear()}${String(old.getUTCMonth() + 1).padStart(2, "0")}${String(old.getUTCDate()).padStart(2, "0")}`;

    fs.writeFileSync(path.join(logDir, `session-${todayStamp}.log`), "recent line\n");
    fs.writeFileSync(path.join(logDir, `session-${oldStamp}.log`), "old line\n");

    const outPath = path.join(dir, "age-filter.zip");
    const io = captureStdio();
    try {
      await runLogsCommand({ bundle: true, out: outPath, cwd: dir });
    } finally {
      io.restore();
    }

    const zipBuf = fs.readFileSync(outPath);
    const entries = parseZip(zipBuf);
    const logNames = entries.filter((e) => e.name.startsWith("logs/")).map((e) => e.name);
    expect(logNames.some((n) => n.includes(todayStamp))).toBe(true);
    expect(logNames.some((n) => n.includes(oldStamp))).toBe(false);
  });
});

// ── redactSecrets() unit tests ──────────────────────────────────────────────
// These cover the three redaction patterns directly, separate from the bundle
// integration tests above. Each pattern has at least one positive case (value
// is fully masked) and one boundary case where the previous implementation
// leaked content.

describe("redactSecrets — JSON-quoted values (Gap 1)", () => {
  it("redacts JSON-style \"KEY\":\"value\"", () => {
    const input = `{"MY_TOKEN":"secret123","other":"keep"}`;
    const out = redactSecrets(input);
    expect(out).not.toContain("secret123");
    expect(out).toContain('"MY_TOKEN":"[REDACTED]"');
    // unrelated keys are preserved
    expect(out).toContain('"other":"keep"');
  });

  it("redacts JSON-style with whitespace around colon", () => {
    const input = `"API_KEY" : "abc-123-def"`;
    const out = redactSecrets(input);
    expect(out).not.toContain("abc-123-def");
    expect(out).toMatch(/"API_KEY"\s*:\s*"\[REDACTED\]"/);
  });

  it("redacts multiple JSON-style secrets in one line", () => {
    const input = `{"FOO_SECRET":"a","BAR_TOKEN":"b","baz":"keep"}`;
    const out = redactSecrets(input);
    expect(out).not.toContain('"a"');
    expect(out).not.toContain('"b"');
    expect(out).toContain('"FOO_SECRET":"[REDACTED]"');
    expect(out).toContain('"BAR_TOKEN":"[REDACTED]"');
    expect(out).toContain('"baz":"keep"');
  });

  it("does not redact non-secret JSON keys", () => {
    const input = `{"name":"johndoe","version":"1.0"}`;
    const out = redactSecrets(input);
    expect(out).toBe(input);
  });
});

describe("redactSecrets — multi-word quoted values (Gap 2)", () => {
  it("redacts the FULL quoted value even with spaces", () => {
    const input = `MY_TOKEN="secret with spaces and lots more"`;
    const out = redactSecrets(input);
    // The whole quoted value is replaced, not just the first word
    expect(out).toBe(`MY_TOKEN="[REDACTED]"`);
    expect(out).not.toContain("with spaces");
    expect(out).not.toContain("lots more");
  });

  it("redacts quoted KEY=\"value\" with mixed special chars", () => {
    const input = `EVO_API_KEY="abc def $$$ &&& 123"`;
    const out = redactSecrets(input);
    expect(out).toBe(`EVO_API_KEY="[REDACTED]"`);
  });

  it("preserves text after the closing quote", () => {
    const input = `prefix MY_PASSWORD="hello world" suffix=ok`;
    const out = redactSecrets(input);
    expect(out).toContain(`MY_PASSWORD="[REDACTED]"`);
    expect(out).toContain("suffix=ok");
    expect(out).not.toContain("hello world");
  });
});

describe("redactSecrets — bare unquoted assignments", () => {
  it("redacts KEY=value (no quotes)", () => {
    const input = `env MY_TOKEN=supersecret123 ok`;
    const out = redactSecrets(input);
    expect(out).not.toContain("supersecret123");
    expect(out).toContain("MY_TOKEN=[REDACTED]");
  });

  it("redacts KEY: value (colon separator, no quotes)", () => {
    const input = `MY_SECRET: deadbeef`;
    const out = redactSecrets(input);
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("MY_SECRET: [REDACTED]");
  });

  it("stops at whitespace for unquoted values (does not eat following text)", () => {
    const input = `MY_KEY=abc next word`;
    const out = redactSecrets(input);
    expect(out).toBe("MY_KEY=[REDACTED] next word");
  });
});

describe("redactSecrets — ordering and idempotency", () => {
  it("does not double-mask (idempotent)", () => {
    const once = redactSecrets(`MY_TOKEN="value"`);
    const twice = redactSecrets(once);
    expect(twice).toBe(once);
  });

  it("JSON pattern wins over bare pattern (no double-mask)", () => {
    // If the bare pattern ran first on `"value"` it would produce `"value`,
    // breaking the JSON pattern. Verify the JSON pattern owns this case.
    const input = `{"MY_TOKEN":"v1"}`;
    const out = redactSecrets(input);
    expect(out).toBe(`{"MY_TOKEN":"[REDACTED]"}`);
  });
});
