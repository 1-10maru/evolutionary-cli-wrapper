import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWrite,
  liveStateTargets,
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
