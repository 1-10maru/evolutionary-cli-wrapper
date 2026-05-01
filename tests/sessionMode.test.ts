import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldUseLightweightTracking } from "../src/proxy/sessionMode";

const tempDirs: string[] = [];

function makeAggregateParentDir(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-aggregate-"));
  tempDirs.push(cwd);
  for (let index = 0; index < 10; index += 1) {
    fs.mkdirSync(path.join(cwd, `project-${index}`), { recursive: true });
  }
  return cwd;
}

function makeProjectDir(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  return cwd;
}

const ENV_KEYS = ["EVO_FORCE_NORMAL", "EVO_FORCE_LIGHT"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shouldUseLightweightTracking env overrides", () => {
  it("EVO_FORCE_NORMAL=1 in an aggregate parent dir returns false", () => {
    const cwd = makeAggregateParentDir();
    process.env.EVO_FORCE_NORMAL = "1";
    expect(shouldUseLightweightTracking(cwd)).toBe(false);
  });

  it("EVO_FORCE_LIGHT=1 in a project dir with .git marker returns true", () => {
    const cwd = makeProjectDir();
    process.env.EVO_FORCE_LIGHT = "1";
    expect(shouldUseLightweightTracking(cwd)).toBe(true);
  });

  it("Neither set in an aggregate parent dir preserves existing behavior (true)", () => {
    const cwd = makeAggregateParentDir();
    expect(shouldUseLightweightTracking(cwd)).toBe(true);
  });

  it("Neither set in a project dir with .git preserves existing behavior (false)", () => {
    const cwd = makeProjectDir();
    expect(shouldUseLightweightTracking(cwd)).toBe(false);
  });

  it("Both EVO_FORCE_NORMAL=1 and EVO_FORCE_LIGHT=1 set: NORMAL wins (returns false)", () => {
    const cwd = makeProjectDir();
    process.env.EVO_FORCE_NORMAL = "1";
    process.env.EVO_FORCE_LIGHT = "1";
    expect(shouldUseLightweightTracking(cwd)).toBe(false);
  });

  it("EVO_FORCE_NORMAL=true (case-insensitive) also triggers override", () => {
    const cwd = makeAggregateParentDir();
    process.env.EVO_FORCE_NORMAL = "TRUE";
    expect(shouldUseLightweightTracking(cwd)).toBe(false);
  });

  it("EVO_FORCE_LIGHT=true (case-insensitive) also triggers override", () => {
    const cwd = makeProjectDir();
    process.env.EVO_FORCE_LIGHT = "True";
    expect(shouldUseLightweightTracking(cwd)).toBe(true);
  });
});
