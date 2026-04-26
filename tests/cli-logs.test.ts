import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDurationMs, runLogsCommand } from "../src/cli/logs";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-cli-logs-"));
  tempDirs.push(dir);
  return dir;
}

function utcStamp(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function makeLine(ms: number, msg: string): string {
  return `${isoAt(ms)} INFO  [test] ${msg}`;
}

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureStdio(): CapturedIo {
  let stdout = "";
  let stderr = "";
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  // Replace the write methods directly so reassignment is observed by callers.
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
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore: () => {
      (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
      (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
    },
  } as CapturedIo;
}

const ORIGINAL_LOG_DIR = process.env.EVO_LOG_DIR;

beforeEach(() => {
  delete process.env.EVO_LOG_DIR;
});

afterEach(() => {
  if (ORIGINAL_LOG_DIR === undefined) delete process.env.EVO_LOG_DIR;
  else process.env.EVO_LOG_DIR = ORIGINAL_LOG_DIR;
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

describe("parseDurationMs", () => {
  it("parses single tokens", () => {
    expect(parseDurationMs("30m")).toBe(30 * 60 * 1000);
    expect(parseDurationMs("2h")).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationMs("1d")).toBe(24 * 60 * 60 * 1000);
  });

  it("sums multiple tokens", () => {
    expect(parseDurationMs("5d12h30m")).toBe(
      5 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000 + 30 * 60 * 1000,
    );
  });

  it("rejects garbage and empty", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("abc")).toBeNull();
    expect(parseDurationMs("30x")).toBeNull();
  });
});

describe("runLogsCommand --tail", () => {
  it("returns last N lines from the latest session file", async () => {
    const dir = makeTempDir();
    const logsDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date();
    const stamp = utcStamp(today);
    const filePath = path.join(logsDir, `session-${stamp}.log`);
    const lines = Array.from({ length: 10 }, (_, i) =>
      makeLine(today.getTime() - (10 - i) * 1000, `line-${i}`),
    );
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const io = captureStdio();
    try {
      await runLogsCommand({ tail: 3, cwd: dir });
    } finally {
      io.restore();
    }
    const out = io.stdout.split("\n").filter((l) => l.length > 0);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("line-7");
    expect(out[1]).toContain("line-8");
    expect(out[2]).toContain("line-9");
  });

  it("uses default tail of 50 when neither flag is given", async () => {
    const dir = makeTempDir();
    const logsDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const today = new Date();
    const stamp = utcStamp(today);
    const filePath = path.join(logsDir, `session-${stamp}.log`);
    const lines = Array.from({ length: 75 }, (_, i) =>
      makeLine(today.getTime() - (75 - i) * 1000, `line-${i}`),
    );
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const io = captureStdio();
    try {
      await runLogsCommand({ cwd: dir });
    } finally {
      io.restore();
    }
    const out = io.stdout.split("\n").filter((l) => l.length > 0);
    expect(out).toHaveLength(50);
    expect(out[0]).toContain("line-25");
    expect(out[49]).toContain("line-74");
  });
});

describe("runLogsCommand --since", () => {
  it("filters lines by cutoff and walks newest-to-oldest", async () => {
    const dir = makeTempDir();
    const logsDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const now = Date.now();
    const todayStamp = utcStamp(new Date(now));
    const yesterdayStamp = utcStamp(new Date(now - 24 * 60 * 60 * 1000));

    const todayFile = path.join(logsDir, `session-${todayStamp}.log`);
    const yesterdayFile = path.join(logsDir, `session-${yesterdayStamp}.log`);

    fs.writeFileSync(
      todayFile,
      [
        makeLine(now - 10 * 60 * 1000, "today-recent"),
        makeLine(now - 60 * 60 * 1000, "today-old"),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      yesterdayFile,
      makeLine(now - 25 * 60 * 60 * 1000, "yesterday-old") + "\n",
    );

    const io = captureStdio();
    try {
      await runLogsCommand({ since: "30m", cwd: dir });
    } finally {
      io.restore();
    }
    expect(io.stdout).toContain("today-recent");
    expect(io.stdout).not.toContain("today-old");
    expect(io.stdout).not.toContain("yesterday-old");
  });

  it("warns and uses --since when both --tail and --since are provided", async () => {
    const dir = makeTempDir();
    const logsDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const now = Date.now();
    const stamp = utcStamp(new Date(now));
    const filePath = path.join(logsDir, `session-${stamp}.log`);
    fs.writeFileSync(
      filePath,
      [
        makeLine(now - 5 * 60 * 1000, "in-window"),
        makeLine(now - 60 * 60 * 1000, "out-of-window"),
      ].join("\n") + "\n",
    );

    const io = captureStdio();
    try {
      await runLogsCommand({ tail: 1, since: "10m", cwd: dir });
    } finally {
      io.restore();
    }
    expect(io.stdout).toContain("in-window");
    expect(io.stdout).not.toContain("out-of-window");
    expect(io.stderr).toMatch(/--tail ignored/i);
  });
});

describe("runLogsCommand missing dir", () => {
  it("prints 'no logs found' to stderr when the dir does not exist", async () => {
    const dir = makeTempDir();
    // Note: dir exists but dir/.evo/logs does not.
    const io = captureStdio();
    try {
      await runLogsCommand({ tail: 5, cwd: dir });
    } finally {
      io.restore();
    }
    expect(io.stderr).toContain("no logs found at");
  });
});
