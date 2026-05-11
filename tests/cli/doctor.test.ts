import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport, runDoctor, DoctorReport } from "../../src/cli/doctor";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-doctor-"));
  tempDirs.push(dir);
  return dir;
}

interface CapturedIo {
  stdout: string;
  restore: () => void;
}

function captureStdout(): CapturedIo {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  return {
    get stdout() { return out; },
    restore: () => {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    },
  };
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["EVO_LOG_DIR", "EVO_HOME", "EVO_DEBUG", "EVO_LOG_LEVEL", "EVO_LOG_FORMAT", "DEBUG"];

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  delete process.env.EVO_LOG_DIR;
  delete process.env.EVO_HOME;
  delete process.env.EVO_DEBUG;
  delete process.env.EVO_LOG_LEVEL;
  delete process.env.EVO_LOG_FORMAT;
  delete process.env.DEBUG;
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

describe("buildReport structure", () => {
  it("returns all top-level keys", () => {
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    expect(report).toHaveProperty("versions");
    expect(report).toHaveProperty("env");
    expect(report).toHaveProperty("files");
    expect(report).toHaveProperty("recentLogs");
    expect(report).toHaveProperty("errorSummary");
    expect(report).toHaveProperty("liveState");
    expect(report).toHaveProperty("criticalIssues");
  });

  it("versions contains expected fields", () => {
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    expect(typeof report.versions.evo).toBe("string");
    expect(typeof report.versions.node).toBe("string");
    expect(typeof report.versions.os).toBe("string");
    expect(typeof report.versions.arch).toBe("string");
    // npm and python can be null on some CIs
  });

  it("errorSummary is numeric", () => {
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    expect(typeof report.errorSummary.errors24h).toBe("number");
    expect(typeof report.errorSummary.warns24h).toBe("number");
  });
});

describe("env var masking", () => {
  it("redacts values for EVO_*_TOKEN, EVO_*_KEY, EVO_*_SECRET, EVO_*_PASSWORD", () => {
    process.env.EVO_MY_TOKEN = "super-secret-token";
    process.env.EVO_API_KEY = "another-secret";
    process.env.EVO_DB_PASSWORD = "mysecret";
    process.env.EVO_LOG_DIR = makeTempDir(); // set a non-sensitive EVO_ var
    const report = buildReport({ cwd: process.env.EVO_LOG_DIR });
    const byKey: Record<string, string> = {};
    for (const { key, value } of report.env) byKey[key] = value;

    expect(byKey["EVO_MY_TOKEN"]).toBe("[REDACTED]");
    expect(byKey["EVO_API_KEY"]).toBe("[REDACTED]");
    expect(byKey["EVO_DB_PASSWORD"]).toBe("[REDACTED]");
    // Non-sensitive EVO_ var is NOT redacted
    expect(byKey["EVO_LOG_DIR"]).not.toBe("[REDACTED]");
  });

  it("does not include non-EVO_ vars", () => {
    process.env.MY_RANDOM_TOKEN = "should-not-appear";
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    const keys = report.env.map((e) => e.key);
    expect(keys).not.toContain("MY_RANDOM_TOKEN");
  });
});

describe("liveState ENOENT graceful handling", () => {
  it("returns found=false for a directory with no live-state.json", () => {
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    expect(report.liveState.found).toBe(false);
  });

  it("returns found=true with ageSeconds when live-state.json exists", () => {
    const dir = makeTempDir();
    const evoDir = path.join(dir, ".evo");
    fs.mkdirSync(evoDir, { recursive: true });
    const updatedAt = Date.now() - 5000;
    fs.writeFileSync(path.join(evoDir, "live-state.json"), JSON.stringify({ updatedAt, foo: "bar" }));
    const report = buildReport({ cwd: dir });
    expect(report.liveState.found).toBe(true);
    expect(report.liveState.updatedAt).toBe(updatedAt);
    expect(typeof report.liveState.ageSeconds).toBe("number");
    expect(report.liveState.ageSeconds).toBeGreaterThanOrEqual(4);
  });
});

describe("files checks", () => {
  it("includes file checks for expected labels", () => {
    const dir = makeTempDir();
    const report = buildReport({ cwd: dir });
    const labels = report.files.map((f) => f.label);
    expect(labels.some((l) => l.includes(".evo/"))).toBe(true);
    expect(labels.some((l) => l.includes("statusline"))).toBe(true);
    expect(labels.some((l) => l.includes("PATH") || l.includes("shim"))).toBe(true);
  });
});

describe("recentLogs", () => {
  it("filters to WARN+ when reading today's log", () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;
    const now = new Date().toISOString();
    const lines = [
      `${now} INFO  [c] info line`,
      `${now} WARN  [c] warn line`,
      `${now} ERROR [c] error line`,
      `${now} DEBUG [c] debug line`,
    ];
    // Today's stamp
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), lines.join("\n") + "\n");
    const report = buildReport({ cwd: dir });
    const recent = report.recentLogs.recentLines;
    expect(recent.some((l) => l.includes("warn line"))).toBe(true);
    expect(recent.some((l) => l.includes("error line"))).toBe(true);
    expect(recent.some((l) => l.includes("info line"))).toBe(false);
    expect(recent.some((l) => l.includes("debug line"))).toBe(false);
  });

  it("counts errors and warns in last 24h", () => {
    const dir = makeTempDir();
    const logDir = path.join(dir, ".evo", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    process.env.EVO_LOG_DIR = logDir;
    const nowIso = new Date().toISOString();
    const d = new Date();
    const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const lines = [
      `${nowIso} ERROR [c] err1`,
      `${nowIso} ERROR [c] err2`,
      `${nowIso} WARN  [c] warn1`,
    ];
    fs.writeFileSync(path.join(logDir, `session-${stamp}.log`), lines.join("\n") + "\n");
    const report = buildReport({ cwd: dir });
    expect(report.errorSummary.errors24h).toBe(2);
    expect(report.errorSummary.warns24h).toBe(1);
  });
});

describe("runDoctor --json output", () => {
  it("emits valid JSON with all top-level keys when --json is passed", async () => {
    const dir = makeTempDir();
    const io = captureStdout();
    try {
      await runDoctor({ json: true, cwd: dir });
    } finally {
      io.restore();
    }
    const parsed = JSON.parse(io.stdout) as DoctorReport;
    expect(parsed).toHaveProperty("versions");
    expect(parsed).toHaveProperty("env");
    expect(parsed).toHaveProperty("files");
    expect(parsed).toHaveProperty("errorSummary");
    expect(parsed).toHaveProperty("liveState");
    expect(parsed).toHaveProperty("criticalIssues");
    expect(Array.isArray(parsed.criticalIssues)).toBe(true);
  });
});

describe("runDoctor text output", () => {
  it("includes section headers in text output", async () => {
    const dir = makeTempDir();
    const io = captureStdout();
    try {
      await runDoctor({ json: false, cwd: dir });
    } finally {
      io.restore();
    }
    expect(io.stdout).toContain("Versions");
    expect(io.stdout).toContain("File Checks");
    expect(io.stdout).toContain("Error Summary");
  });
});
