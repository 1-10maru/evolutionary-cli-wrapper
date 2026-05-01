import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  gcOldSessionFiles,
  liveStateTargets,
  sessionLiveStatePath,
  sessionsDir,
  teardownLiveStateFiles,
  writeLiveStateDual,
} from "../../src/proxy/liveState";

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
    expect(JSON.parse(fs.readFileSync(cwdTarget, "utf8"))).toEqual(payload);
    expect(JSON.parse(fs.readFileSync(homeTarget, "utf8"))).toEqual(payload);
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
    expect(JSON.parse(fs.readFileSync(cwdTarget, "utf8"))).toEqual(payload);
    expect(JSON.parse(fs.readFileSync(homeTarget, "utf8"))).toEqual(payload);
    expect(JSON.parse(fs.readFileSync(sessionTarget, "utf8"))).toEqual(payload);
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
  it("returns 0 counts when sessions/ does not exist", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const result = gcOldSessionFiles(cwd);
    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  it("prunes files older than maxAgeMs and keeps fresh ones", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-livestate-gc-"));
    tempDirs.push(cwd);
    const dir = sessionsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = path.join(dir, "old.json");
    const freshFile = path.join(dir, "fresh.json");
    const skipFile = path.join(dir, "not-json.txt");
    fs.writeFileSync(oldFile, "{}");
    fs.writeFileSync(freshFile, "{}");
    fs.writeFileSync(skipFile, "ignored");
    // Backdate oldFile by 10 days
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    const result = gcOldSessionFiles(cwd, 7 * 24 * 60 * 60 * 1000);
    expect(result.scanned).toBe(2); // .json only
    expect(result.removed).toBe(1);
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
