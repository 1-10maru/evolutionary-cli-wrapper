import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetLiveStateSeqForTests,
  atomicWrite,
  gcOldSessionFiles,
  liveStateTargets,
  nextLiveStateSeq,
  sessionLiveStatePath,
  sessionsDir,
  teardownLiveStateFiles,
  writeLiveStateDual,
} from "../../src/proxy/liveState";
import { claimOwnership, isPidAlive } from "../../src/proxy/sessionOwnership";

/** Find an integer pid that is currently NOT alive (for GC-owner tests). */
function findDeadPid(): number {
  for (let candidate = 987654321; candidate > 987000000; candidate -= 7) {
    if (!isPidAlive(candidate)) return candidate;
  }
  // Practically unreachable; fall back to a large value.
  return 987654321;
}

beforeEach(() => {
  __resetLiveStateSeqForTests();
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup on Windows
      }
    }
  }
});

describe("liveState targets", () => {
  it("returns dual-target paths under .evo and ~/.claude", () => {
    const cwd = path.resolve("/tmp/proj");
    const { cwdTarget, homeTarget } = liveStateTargets(cwd);
    expect(cwdTarget.endsWith(path.join(".evo", "live-state.json"))).toBe(true);
    expect(homeTarget.startsWith(path.resolve(os.homedir()))).toBe(true);
    expect(homeTarget.endsWith(".evo-live.json")).toBe(true);
  });
});

describe("atomicWrite", () => {
  it("writes the payload via tmp + rename", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const target = path.join(cwd, "out.json");
    atomicWrite(target, '{"x":1}');
    expect(fs.readFileSync(target, "utf8")).toBe('{"x":1}');
    // tmp should not linger
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it("falls back to direct write when rename fails (target dir missing)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    // Pointing at non-existent subdir forces both rename and direct write to fail —
    // but the function must NOT throw (best-effort semantics).
    const target = path.join(cwd, "nonexistent-dir", "out.json");
    expect(() => atomicWrite(target, '{"x":1}')).not.toThrow();
  });
});

describe("writeLiveStateDual", () => {
  it("writes the same payload to both targets", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const payload = { turns: 3, mood: "happy" };
    writeLiveStateDual({ cwdTarget, homeTarget, payload });
    expect(JSON.parse(fs.readFileSync(cwdTarget, "utf8"))).toMatchObject(payload);
    expect(JSON.parse(fs.readFileSync(homeTarget, "utf8"))).toMatchObject(payload);
    // All sinks of one generation carry byte-identical JSON.
    expect(fs.readFileSync(cwdTarget, "utf8")).toBe(fs.readFileSync(homeTarget, "utf8"));
  });

  it("B2: stamps seq, writerPid and writtenAt on every generation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const before = Date.now();
    writeLiveStateDual({ cwdTarget, homeTarget, payload: { turns: 1 } });
    const after = Date.now();
    const written = JSON.parse(fs.readFileSync(cwdTarget, "utf8"));
    expect(written.seq).toBe(1);
    expect(written.writerPid).toBe(process.pid);
    expect(written.writtenAt).toBeGreaterThanOrEqual(before);
    expect(written.writtenAt).toBeLessThanOrEqual(after);
  });

  it("B2: seq is monotonic across successive writes", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      writeLiveStateDual({ cwdTarget, homeTarget, payload: { turns: i } });
      seqs.push(JSON.parse(fs.readFileSync(cwdTarget, "utf8")).seq as number);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it("B2: protocol fields cannot be shadowed by stale copies inside payload", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    // A payload that (wrongly) carries protocol fields must not win.
    writeLiveStateDual({
      cwdTarget,
      homeTarget,
      payload: { seq: 999, writerPid: 1, writtenAt: 0, turns: 2 },
    });
    const written = JSON.parse(fs.readFileSync(cwdTarget, "utf8"));
    expect(written.seq).toBe(1);
    expect(written.writerPid).toBe(process.pid);
    expect(written.writtenAt).toBeGreaterThan(0);
    expect(written.turns).toBe(2);
  });

  it("B2: a failing sink never blocks the remaining sinks", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    // cwdTarget points into a missing directory → both rename and the direct
    // fallback fail. homeTarget and sessionTarget must still be written.
    const cwdTarget = path.join(cwd, "no-such-dir", "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const sessionTarget = path.join(cwd, "sessions", "sid-1.json");
    expect(() =>
      writeLiveStateDual({ cwdTarget, homeTarget, sessionTarget, payload: { turns: 9 } }),
    ).not.toThrow();
    expect(JSON.parse(fs.readFileSync(homeTarget, "utf8")).turns).toBe(9);
    expect(JSON.parse(fs.readFileSync(sessionTarget, "utf8")).turns).toBe(9);
  });
});

describe("nextLiveStateSeq", () => {
  it("increments from 1 after a test reset", () => {
    expect(nextLiveStateSeq()).toBe(1);
    expect(nextLiveStateSeq()).toBe(2);
    __resetLiveStateSeqForTests();
    expect(nextLiveStateSeq()).toBe(1);
  });
});

describe("v3.4.0 per-session targets", () => {
  it("sessionLiveStatePath nests under .evo/sessions/<id>.json", () => {
    const cwd = path.resolve("/tmp/proj");
    const p = sessionLiveStatePath(cwd, "abc-123");
    expect(p.endsWith(path.join(".evo", "sessions", "abc-123.json"))).toBe(true);
    expect(sessionsDir(cwd).endsWith(path.join(".evo", "sessions"))).toBe(true);
  });

  it("writeLiveStateDual writes to per-session file when sessionTarget is set", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const sessionTarget = path.join(cwd, "sessions", "sid-1.json");
    const payload = { turns: 7, sessionId: "sid-1" };
    writeLiveStateDual({ cwdTarget, homeTarget, sessionTarget, payload });
    expect(JSON.parse(fs.readFileSync(cwdTarget, "utf8"))).toMatchObject(payload);
    expect(JSON.parse(fs.readFileSync(homeTarget, "utf8"))).toMatchObject(payload);
    expect(JSON.parse(fs.readFileSync(sessionTarget, "utf8"))).toMatchObject(payload);
    // Same generation → byte-identical JSON in all three sinks.
    const bytes = fs.readFileSync(cwdTarget, "utf8");
    expect(fs.readFileSync(homeTarget, "utf8")).toBe(bytes);
    expect(fs.readFileSync(sessionTarget, "utf8")).toBe(bytes);
  });

  it("writeLiveStateDual skips per-session file when sessionTarget is undefined", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    const sessionsDirPath = path.join(cwd, "sessions");
    const payload = { turns: 1 };
    writeLiveStateDual({ cwdTarget, homeTarget, payload });
    expect(fs.existsSync(cwdTarget)).toBe(true);
    expect(fs.existsSync(homeTarget)).toBe(true);
    expect(fs.existsSync(sessionsDirPath)).toBe(false);
  });

  it("writeLiveStateDual auto-creates the sessions/ directory when missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    // Deeply nested sessions dir that does not exist yet
    const sessionTarget = path.join(cwd, "deep", "nested", "sessions", "sid-x.json");
    expect(fs.existsSync(path.dirname(sessionTarget))).toBe(false);
    writeLiveStateDual({
      cwdTarget,
      homeTarget,
      sessionTarget,
      payload: { x: 1 },
    });
    expect(fs.existsSync(sessionTarget)).toBe(true);
  });
});

describe("gcOldSessionFiles", () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  /** Create `<sessions>/<name>.json` backdated by 10 days. */
  function seedOldSessionFile(cwd: string, name: string): string {
    const dir = sessionsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, "{}");
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, tenDaysAgo, tenDaysAgo);
    return file;
  }

  it("returns 0 counts when sessions/ does not exist", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const result = gcOldSessionFiles(cwd);
    expect(result).toEqual({ scanned: 0, removed: 0, skippedLive: 0 });
  });

  it("prunes files older than maxAgeMs and keeps fresh ones", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const dir = sessionsDir(cwd);
    const oldFile = seedOldSessionFile(cwd, "old");
    const freshFile = path.join(dir, "fresh.json");
    const skipFile = path.join(dir, "not-json.txt");
    fs.writeFileSync(freshFile, "{}");
    fs.writeFileSync(skipFile, "ignored");
    const result = gcOldSessionFiles(cwd, WEEK_MS);
    expect(result.scanned).toBe(2); // .json only
    expect(result.removed).toBe(1);
    expect(result.skippedLive).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(skipFile)).toBe(true); // non-json untouched
  });

  it("does not throw when sessions/ contains unreadable entries", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const dir = sessionsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    // Empty dir is also a valid input — just shouldn't throw
    expect(() => gcOldSessionFiles(cwd)).not.toThrow();
  });

  it("B2: never unlinks an old file whose owner pid is alive", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const liveFile = seedOldSessionFile(cwd, "sid-live");
    // Owner marker held by THIS (alive) process.
    expect(claimOwnership(cwd, "sid-live", process.pid)).toBe(true);
    const result = gcOldSessionFiles(cwd, WEEK_MS);
    expect(result.removed).toBe(0);
    expect(result.skippedLive).toBe(1);
    expect(fs.existsSync(liveFile)).toBe(true);
  });

  it("B2: reclaims an old file whose owner pid is dead", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const deadFile = seedOldSessionFile(cwd, "sid-dead");
    expect(claimOwnership(cwd, "sid-dead", findDeadPid())).toBe(true);
    const result = gcOldSessionFiles(cwd, WEEK_MS);
    expect(result.removed).toBe(1);
    expect(result.skippedLive).toBe(0);
    expect(fs.existsSync(deadFile)).toBe(false);
  });

  it("B2: reclaims an old file with no owner marker at all (pre-B1 leftovers)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const orphan = seedOldSessionFile(cwd, "sid-orphan");
    const result = gcOldSessionFiles(cwd, WEEK_MS);
    expect(result.removed).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("B2: keeps the file when the liveness probe throws (fail-open)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const file = seedOldSessionFile(cwd, "sid-err");
    const result = gcOldSessionFiles(cwd, WEEK_MS, () => {
      throw new Error("probe exploded");
    });
    expect(result.removed).toBe(0);
    expect(result.skippedLive).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("teardownLiveStateFiles", () => {
  it("removes both targets and ENOENT is silent", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-"));
    tempDirs.push(cwd);
    const cwdTarget = path.join(cwd, "cwd.json");
    const homeTarget = path.join(cwd, "home.json");
    fs.writeFileSync(cwdTarget, "{}");
    // homeTarget intentionally missing → ENOENT path exercised
    expect(() => teardownLiveStateFiles(cwdTarget, homeTarget)).not.toThrow();
    expect(fs.existsSync(cwdTarget)).toBe(false);
    expect(fs.existsSync(homeTarget)).toBe(false);
  });
});
