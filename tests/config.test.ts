import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, getEvoDir } from "../src/config";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeAggregateDir(): string {
  // Create a dir that looks like an aggregate parent (>=8 subdirs, no project markers).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-aggregate-"));
  tempDirs.push(root);
  for (let i = 0; i < 10; i += 1) {
    fs.mkdirSync(path.join(root, `sub${i}`));
  }
  return root;
}

function makeProjectDir(): string {
  // Create a dir with a project marker (.git) so lightweight tracking is OFF.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return root;
}

describe("ensureEvoConfig lightweight short-circuit", () => {
  it("does NOT create .evo/ in lightweight (aggregate parent) directories", () => {
    const cwd = makeAggregateDir();
    const evoDir = getEvoDir(cwd);
    expect(fs.existsSync(evoDir)).toBe(false);

    const config = ensureEvoConfig(cwd);

    expect(config).toBeDefined();
    expect(config.formatVersion).toBe(2);
    // Critical assertion: the directory must not have been created.
    expect(fs.existsSync(evoDir)).toBe(false);
  });

  it("creates .evo/ in directories with project markers", () => {
    const cwd = makeProjectDir();
    const evoDir = getEvoDir(cwd);
    expect(fs.existsSync(evoDir)).toBe(false);

    const config = ensureEvoConfig(cwd);

    expect(config).toBeDefined();
    expect(fs.existsSync(evoDir)).toBe(true);
    expect(fs.existsSync(path.join(evoDir, "config.json"))).toBe(true);
  });

  it("returns defaults populated with cwd-derived paths in lightweight mode", () => {
    const cwd = makeAggregateDir();
    const config = ensureEvoConfig(cwd);
    expect(config.shellIntegration.binDir).toContain("bin");
    // No .evo/ should have been created as a side effect of computing paths.
    expect(fs.existsSync(getEvoDir(cwd))).toBe(false);
  });
});
