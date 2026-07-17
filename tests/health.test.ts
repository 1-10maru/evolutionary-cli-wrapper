import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_ADDON_EXTERNALS,
  NATIVE_RUNTIME_DEPS,
  checkBundlePresent,
  checkNativeClosurePresent,
  checkNativesLoadable,
  quickHealthReport,
} from "../src/health";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-health-"));
  tempDirs.push(dir);
  return dir;
}

describe("native dependency lists", () => {
  it("externals are exactly the five native addons", () => {
    expect([...NATIVE_ADDON_EXTERNALS]).toEqual([
      "better-sqlite3",
      "tree-sitter",
      "tree-sitter-javascript",
      "tree-sitter-python",
      "tree-sitter-typescript",
    ]);
  });

  it("runtime closure adds the pure-JS loader helpers (8 total)", () => {
    expect([...NATIVE_RUNTIME_DEPS]).toEqual([
      ...NATIVE_ADDON_EXTERNALS,
      "bindings",
      "file-uri-to-path",
      "node-gyp-build",
    ]);
    expect(NATIVE_RUNTIME_DEPS).toHaveLength(8);
  });
});

describe("checkBundlePresent", () => {
  it("ok when dist/evo.bundle.cjs is readable", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "evo.bundle.cjs"), "//bundle\n");
    const check = checkBundlePresent(root);
    expect(check.ok).toBe(true);
    expect(check.name).toBe("bundle");
  });

  it("not ok when the bundle is missing", () => {
    const root = makeRoot();
    const check = checkBundlePresent(root);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("evo.bundle.cjs");
  });
});

describe("checkNativeClosurePresent", () => {
  it("ok when every native runtime dep dir exists", () => {
    const root = makeRoot();
    for (const dep of NATIVE_RUNTIME_DEPS) {
      fs.mkdirSync(path.join(root, "node_modules", dep), { recursive: true });
    }
    const check = checkNativeClosurePresent(root);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("8 present");
  });

  it("names the missing deps when the closure is thinned", () => {
    const root = makeRoot();
    for (const dep of NATIVE_RUNTIME_DEPS) {
      if (dep === "file-uri-to-path" || dep === "tree-sitter") continue;
      fs.mkdirSync(path.join(root, "node_modules", dep), { recursive: true });
    }
    const check = checkNativeClosurePresent(root);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("tree-sitter");
    expect(check.detail).toContain("file-uri-to-path");
  });
});

describe("checkNativesLoadable", () => {
  it("loads better-sqlite3 and tree-sitter in the test environment", () => {
    // The repo's native addons are compiled in the dev/CI test env, so this must
    // pass here; the FAIL path is covered by the sandbox behavioral test.
    const check = checkNativesLoadable();
    expect(check.name).toBe("native-load");
    expect(check.ok).toBe(true);
  });
});

describe("quickHealthReport", () => {
  it("aggregates the three load-time checks", () => {
    // Synthetic healthy root (bundle + full closure) so the check is
    // deterministic regardless of whether the real dist bundle is built.
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "evo.bundle.cjs"), "//bundle\n");
    for (const dep of NATIVE_RUNTIME_DEPS) {
      fs.mkdirSync(path.join(root, "node_modules", dep), { recursive: true });
    }
    const report = quickHealthReport(root);
    expect(report.checks.map((c) => c.name)).toEqual(["bundle", "native-deps", "native-load"]);
    // bundle + native-deps deterministically ok; native-load ok in test env.
    expect(report.ok).toBe(true);
  });
});
