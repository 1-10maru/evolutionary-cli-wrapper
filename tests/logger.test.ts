import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLoggerForTests, getLogger } from "../src/logger";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-logger-"));
  tempDirs.push(dir);
  return dir;
}

function todayUtcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

function logFilePath(baseDir: string): string {
  return path.join(baseDir, ".evo", "logs", `session-${todayUtcStamp()}.log`);
}

function logDir(baseDir: string): string {
  return path.join(baseDir, ".evo", "logs");
}

function waitForFile(filePath: string, timeoutMs = 1000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    // busy-wait briefly; vitest runs in ms scale
  }
  return fs.existsSync(filePath);
}

function readLogContent(filePath: string): string {
  // Force flush by reading after a microtask tick
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

const ORIGINAL_ENV = {
  EVO_LOG_DIR: process.env.EVO_LOG_DIR,
  EVO_LOG_LEVEL: process.env.EVO_LOG_LEVEL,
  EVO_LOG_DISABLE: process.env.EVO_LOG_DISABLE,
};

beforeEach(() => {
  __resetLoggerForTests();
  delete process.env.EVO_LOG_DIR;
  delete process.env.EVO_LOG_LEVEL;
  delete process.env.EVO_LOG_DISABLE;
});

afterEach(() => {
  __resetLoggerForTests();
  if (ORIGINAL_ENV.EVO_LOG_DIR === undefined) delete process.env.EVO_LOG_DIR;
  else process.env.EVO_LOG_DIR = ORIGINAL_ENV.EVO_LOG_DIR;
  if (ORIGINAL_ENV.EVO_LOG_LEVEL === undefined) delete process.env.EVO_LOG_LEVEL;
  else process.env.EVO_LOG_LEVEL = ORIGINAL_ENV.EVO_LOG_LEVEL;
  if (ORIGINAL_ENV.EVO_LOG_DISABLE === undefined) delete process.env.EVO_LOG_DISABLE;
  else process.env.EVO_LOG_DISABLE = ORIGINAL_ENV.EVO_LOG_DISABLE;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("logger format", () => {
  it("emits ISO timestamp, padded level, component, message, and JSON ctx", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const log = getLogger();
    log.info("comp", "hello", { a: 1, b: "x" });
    log.flush();
    const content = readLogContent(logFilePath(dir));
    expect(content.length).toBeGreaterThan(0);
    const line = content.trim();
    // ISO 8601 timestamp + padded INFO level + component + message + JSON ctx
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}\[comp\] hello \{"a":1,"b":"x"\}$/;
    expect(line).toMatch(re);
  });

  it("omits ctx when not provided", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const log = getLogger();
    log.warn("c2", "no ctx");
    log.flush();
    const content = readLogContent(logFilePath(dir));
    const line = content.trim();
    // WARN must be padded to 5 chars: "WARN " (4 letters + 1 space)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN {2}\[c2\] no ctx$/);
  });

  it("pads each level to 5 chars", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    process.env.EVO_LOG_LEVEL = "DEBUG";
    const log = getLogger();
    log.error("c", "e");
    log.warn("c", "w");
    log.info("c", "i");
    log.debug("c", "d");
    log.flush();
    const content = readLogContent(logFilePath(dir));
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain(" ERROR [c] e");
    expect(lines[1]).toContain(" WARN  [c] w");
    expect(lines[2]).toContain(" INFO  [c] i");
    expect(lines[3]).toContain(" DEBUG [c] d");
  });
});

describe("logger level filtering", () => {
  it("WARN level blocks INFO and DEBUG, allows ERROR and WARN", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    process.env.EVO_LOG_LEVEL = "WARN";
    const log = getLogger();
    log.error("c", "err-msg");
    log.warn("c", "warn-msg");
    log.info("c", "info-msg");
    log.debug("c", "debug-msg");
    log.flush();
    const content = readLogContent(logFilePath(dir));
    expect(content).toContain("err-msg");
    expect(content).toContain("warn-msg");
    expect(content).not.toContain("info-msg");
    expect(content).not.toContain("debug-msg");
  });

  it("ERROR level only allows ERROR", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    process.env.EVO_LOG_LEVEL = "ERROR";
    const log = getLogger();
    log.error("c", "e1");
    log.warn("c", "w1");
    log.info("c", "i1");
    log.debug("c", "d1");
    log.flush();
    const content = readLogContent(logFilePath(dir));
    expect(content).toContain("e1");
    expect(content).not.toContain("w1");
    expect(content).not.toContain("i1");
    expect(content).not.toContain("d1");
  });

  it("DEBUG level allows everything", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    process.env.EVO_LOG_LEVEL = "DEBUG";
    const log = getLogger();
    log.error("c", "e");
    log.warn("c", "w");
    log.info("c", "i");
    log.debug("c", "d");
    log.flush();
    const content = readLogContent(logFilePath(dir));
    expect(content).toContain(" e\n");
    expect(content).toContain(" w\n");
    expect(content).toContain(" i\n");
    expect(content).toContain(" d\n");
  });
});

describe("logger file sink", () => {
  it("creates log file at <baseDir>/.evo/logs/session-YYYYMMDD.log", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const log = getLogger();
    log.info("comp", "first line");
    log.flush();
    const expectedPath = logFilePath(dir);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("appends across multiple writes (file size grows)", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const log = getLogger();
    log.info("c", "a");
    log.flush();
    const file = logFilePath(dir);
    waitForFile(file);
    const size1 = fs.statSync(file).size;
    log.info("c", "b");
    log.info("c", "c");
    log.flush();
    const size2 = fs.statSync(file).size;
    expect(size2).toBeGreaterThan(size1);
  });
});

describe("logger disable flag", () => {
  it("EVO_LOG_DISABLE=1 results in no log file", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    process.env.EVO_LOG_DISABLE = "1";
    const log = getLogger();
    log.error("c", "should not write");
    log.info("c", "also no");
    log.flush();
    expect(fs.existsSync(logFilePath(dir))).toBe(false);
    expect(fs.existsSync(logDir(dir))).toBe(false);
  });
});

describe("logger rotation", () => {
  it("deletes old session-YYYYMMDD.log files older than 30 days", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const ld = logDir(dir);
    fs.mkdirSync(ld, { recursive: true });

    const oldFile = path.join(ld, "session-19990101.log");
    const todayFile = path.join(ld, `session-${todayUtcStamp()}.log`);
    fs.writeFileSync(oldFile, "old\n");
    fs.writeFileSync(todayFile, "today\n");

    const log = getLogger();
    log.info("c", "trigger init");
    log.flush();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(todayFile)).toBe(true);
  });

  it("preserves files that don't match session-YYYYMMDD.log pattern", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const ld = logDir(dir);
    fs.mkdirSync(ld, { recursive: true });

    const otherFile = path.join(ld, "other.log");
    const notes = path.join(ld, "notes.txt");
    fs.writeFileSync(otherFile, "x");
    fs.writeFileSync(notes, "y");

    const log = getLogger();
    log.info("c", "trigger init");
    log.flush();

    expect(fs.existsSync(otherFile)).toBe(true);
    expect(fs.existsSync(notes)).toBe(true);
  });
});

describe("logger child", () => {
  it("child(component).info(msg) writes [component] in line", () => {
    const dir = makeTempDir();
    process.env.EVO_LOG_DIR = dir;
    const log = getLogger();
    const bound = log.child("foo");
    bound.info("hi");
    bound.error("err", { code: 42 });
    log.flush();
    const content = readLogContent(logFilePath(dir));
    expect(content).toContain("[foo] hi");
    expect(content).toMatch(/\[foo\] err \{"code":42\}/);
  });
});

describe("logger reset", () => {
  it("__resetLoggerForTests truly resets state — env re-read after reset", () => {
    const dir1 = makeTempDir();
    process.env.EVO_LOG_DIR = dir1;
    process.env.EVO_LOG_LEVEL = "ERROR";
    let log = getLogger();
    log.info("c", "filtered");
    log.flush();
    expect(fs.existsSync(logFilePath(dir1))).toBe(false);

    __resetLoggerForTests();

    const dir2 = makeTempDir();
    process.env.EVO_LOG_DIR = dir2;
    process.env.EVO_LOG_LEVEL = "INFO";
    log = getLogger();
    log.info("c", "now visible");
    log.flush();
    expect(fs.existsSync(logFilePath(dir2))).toBe(true);
    const content = readLogContent(logFilePath(dir2));
    expect(content).toContain("now visible");
  });
});
