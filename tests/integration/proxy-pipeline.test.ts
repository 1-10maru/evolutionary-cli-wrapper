import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../../src/config";
import { __resetLoggerForTests, getLogger } from "../../src/logger";
import { runProxySession } from "../../src/proxyRuntime";

// ---------------------------------------------------------------------------
// Scope reduction (documented for future maintainers):
//
// The full pipeline includes a JSONL transcript watcher and a live-state
// JSON sink at <cwd>/.evo/live-state.json + ~/.claude/.evo-live.json. Both
// only activate when `liveTrackingEnabled` is true, which requires
// process.stderr.isTTY — false under vitest. Additionally, the proxy
// unconditionally calls teardownLiveTracking() on session end, which
// unlinks both live-state files. This makes assertion on the live-state
// JSON impractical from a vanilla integration test without modifying the
// source under test.
//
// Therefore this test focuses on the parts of the pipeline that DO leave
// observable artifacts after runProxySession resolves:
//   1. The structured logger writes to <EVO_LOG_DIR>/.evo/logs/session-*.log
//      and persists across teardown.
//   2. proxy.startup / proxy.spawn / proxy.subprocess components log the
//      episode lifecycle.
//   3. proxy.subprocess classifies non-zero exits as WARN, zero as INFO.
//   4. The live-state writer is exercised (the close handler always calls
//      writeLiveState) but the file itself is unlinked before the test can
//      observe it; the act of writing is implied by the absence of write
//      failure WARN entries in the log.
//
// The mock CLI fixture (tests/integration/fixtures/mock-claude.js) emits
// synthetic JSONL entries shaped like real Claude Code sessions, but those
// only matter when the watcher is active. They are kept in case future
// refactors wire the watcher up under a non-TTY test mode.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = {
  EVO_LOG_DIR: process.env.EVO_LOG_DIR,
  EVO_LOG_LEVEL: process.env.EVO_LOG_LEVEL,
  EVO_LOG_DISABLE: process.env.EVO_LOG_DISABLE,
  EVO_LIVE_TRACKING: process.env.EVO_LIVE_TRACKING,
  EVO_HOME: process.env.EVO_HOME,
  EVO_TEST_MODE: process.env.EVO_TEST_MODE,
  EVO_TEST_WHERE_STDOUT: process.env.EVO_TEST_WHERE_STDOUT,
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function readLog(baseDir: string): string {
  const p = logFilePath(baseDir);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

const FIXTURE_PATH = path.resolve(__dirname, "fixtures", "mock-claude.js");

beforeEach(() => {
  __resetLoggerForTests();
  delete process.env.EVO_LOG_DIR;
  delete process.env.EVO_LOG_LEVEL;
  delete process.env.EVO_LOG_DISABLE;
  // Force live-state writes off so we don't pollute ~/.claude/.evo-live.json
  // from concurrent local dev sessions. The close handler still calls
  // writeLiveState unconditionally, but with EVO_LIVE_TRACKING=0 the
  // initial setup path is skipped — and teardownLiveTracking will unlink
  // anything we did write before the test inspects it anyway.
  process.env.EVO_LIVE_TRACKING = "0";
});

afterEach(() => {
  // Flush any queued log lines and reset the singleton so the next test
  // re-reads EVO_LOG_DIR.
  try {
    getLogger().flush();
  } catch {
    // ignore
  }
  __resetLoggerForTests();
  for (const k of [
    "EVO_LOG_DIR",
    "EVO_LOG_LEVEL",
    "EVO_LOG_DISABLE",
    "EVO_LIVE_TRACKING",
    "EVO_HOME",
    "EVO_TEST_MODE",
    "EVO_TEST_WHERE_STDOUT",
  ] as const) {
    const orig = ORIGINAL_ENV[k];
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
  if (process.env.EVO_TEST_KEEP_TMP === "1") {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      // eslint-disable-next-line no-console
      if (dir) console.log("[keep-tmp]", dir);
    }
    return;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // EBUSY on Windows for chokidar handles is acceptable; tmp dir
        // will be cleaned up by the OS eventually.
      }
    }
  }
});

async function runProxyWithMock(opts: {
  cwd: string;
  exitCode: number;
  jsonlOut: string;
}): Promise<{ episodeId: number }> {
  // Suppress `where claude` discovery so resolveOriginalCommand cannot find a
  // real claude binary on the developer's PATH and pick it over our node
  // mock. EVO_TEST_MODE=1 + empty EVO_TEST_WHERE_STDOUT forces an empty
  // discovery list. Also pin shellHome to opts.cwd via EVO_HOME so the
  // resolver doesn't pull a stale `originalCommandMap.claude` from the
  // developer's actual evo install.
  process.env.EVO_TEST_MODE = "1";
  process.env.EVO_TEST_WHERE_STDOUT = "";
  process.env.EVO_HOME = opts.cwd;
  const config = ensureEvoConfig(opts.cwd);
  updateEvoConfig(opts.cwd, {
    ...config,
    shellIntegration: {
      ...config.shellIntegration,
      originalCommandMap: {
        ...config.shellIntegration.originalCommandMap,
        // Map "claude" -> Node so resolveOriginalCommand returns Node and
        // our argv[0] (FIXTURE_PATH) is the script Node runs.
        claude: process.execPath,
      },
    },
    proxy: {
      ...config.proxy,
      turnIdleMs: 50,
      defaultMode: "active",
    },
  });

  const result = await runProxySession({
    cwd: opts.cwd,
    cli: "claude",
    args: [
      FIXTURE_PATH,
      "--out",
      opts.jsonlOut,
      "--exit-code",
      String(opts.exitCode),
      "--turns",
      "3",
    ],
    mode: "active",
  });
  return { episodeId: result.episodeId };
}

describe("integration: proxy + logger pipeline", () => {
  it("writes episode lifecycle logs and classifies a clean exit as INFO", async () => {
    const cwd = makeTempDir("evo-int-clean-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"demo"}');
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });

    process.env.EVO_LOG_DIR = cwd;
    // Re-init logger with the new EVO_LOG_DIR.
    __resetLoggerForTests();

    const jsonl = path.join(cwd, "fake-session.jsonl");
    await runProxyWithMock({ cwd, exitCode: 0, jsonlOut: jsonl });

    getLogger().flush();
    const content = readLog(cwd);
    expect(content.length).toBeGreaterThan(0);

    // Episode lifecycle: startup header + spawn announcement.
    expect(content).toMatch(/\[proxy\.startup\] session header emitted/);
    expect(content).toMatch(/\[proxy\.spawn\] spawning subprocess/);

    // Subprocess exit observed: clean exit must be INFO, not WARN.
    const exitLine = content
      .split("\n")
      .find((l) => /\[proxy\.subprocess\] subprocess exited/.test(l));
    expect(exitLine).toBeDefined();
    expect(exitLine).toMatch(/ INFO {2}\[proxy\.subprocess\]/);
    expect(exitLine).toMatch(/"exitCode":0/);

    // The follow-up "live state updated with exit code" entry should also be
    // present, and must include the same exit code.
    expect(content).toMatch(
      /\[proxy\.subprocess\] live state updated with exit code .*"exitCode":0/,
    );
  }, 30_000);

  it("classifies a non-zero exit as WARN at component proxy.subprocess", async () => {
    const cwd = makeTempDir("evo-int-fail-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"demo"}');

    process.env.EVO_LOG_DIR = cwd;
    __resetLoggerForTests();

    const jsonl = path.join(cwd, "fake-session.jsonl");
    await runProxyWithMock({ cwd, exitCode: 7, jsonlOut: jsonl });

    getLogger().flush();
    const content = readLog(cwd);
    const lines = content.split("\n");
    const warnExitLine = lines.find(
      (l) =>
        /\[proxy\.subprocess\] subprocess exited/.test(l) &&
        / WARN {2}\[proxy\.subprocess\]/.test(l),
    );
    expect(warnExitLine).toBeDefined();
    expect(warnExitLine).toMatch(/"exitCode":7/);

    // No INFO-level "subprocess exited" line should be present in this run.
    const infoExitLine = lines.find(
      (l) =>
        /\[proxy\.subprocess\] subprocess exited/.test(l) &&
        / INFO {2}\[proxy\.subprocess\]/.test(l),
    );
    expect(infoExitLine).toBeUndefined();
  }, 30_000);

  it("isolates EVO_LOG_DIR per test (no pollution across tmp dirs)", async () => {
    const cwdA = makeTempDir("evo-int-isoA-");
    const cwdB = makeTempDir("evo-int-isoB-");
    fs.writeFileSync(path.join(cwdA, "package.json"), '{"name":"a"}');
    fs.writeFileSync(path.join(cwdB, "package.json"), '{"name":"b"}');

    // Run A
    process.env.EVO_LOG_DIR = cwdA;
    __resetLoggerForTests();
    await runProxyWithMock({
      cwd: cwdA,
      exitCode: 0,
      jsonlOut: path.join(cwdA, "a.jsonl"),
    });
    getLogger().flush();
    __resetLoggerForTests();

    // Run B
    process.env.EVO_LOG_DIR = cwdB;
    __resetLoggerForTests();
    await runProxyWithMock({
      cwd: cwdB,
      exitCode: 0,
      jsonlOut: path.join(cwdB, "b.jsonl"),
    });
    getLogger().flush();

    const contentA = readLog(cwdA);
    const contentB = readLog(cwdB);
    expect(contentA.length).toBeGreaterThan(0);
    expect(contentB.length).toBeGreaterThan(0);
    // The cwd field is logged by proxy.spawn — confirm each log only saw
    // its own cwd.
    expect(contentA).toContain(JSON.stringify(cwdA).slice(1, -1));
    expect(contentB).toContain(JSON.stringify(cwdB).slice(1, -1));
    expect(contentA).not.toContain(JSON.stringify(cwdB).slice(1, -1));
    expect(contentB).not.toContain(JSON.stringify(cwdA).slice(1, -1));
  }, 60_000);
});
