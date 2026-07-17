import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NATIVE_ADDON_EXTERNALS, NATIVE_RUNTIME_DEPS } from "../src/health";

/**
 * Drift guard for NATIVE_RUNTIME_DEPS.
 *
 * The launch-fallback shim and the wrapper self-check gate on a HARDCODED list
 * of node_modules packages the bundle needs at runtime (the native addons plus
 * the pure-JS loader helpers they `require` when the DB opens / a parser loads).
 * If a future version of better-sqlite3 / tree-sitter changes that helper chain,
 * a hardcoded list silently goes stale — the exact failure mode #86's review
 * flagged. This test measures the ACTUAL runtime closure by exercising the
 * natives under a `require` hook in a child process and fails if it differs from
 * the hardcoded list, forcing the list to be updated.
 *
 * Requires the native addons to be built (they are, in dev + CI — the rest of
 * the suite already depends on them). If they cannot load, the probe throws and
 * this test fails loudly rather than silently passing.
 */
const PROBE = `
const Module = require("module");
const path = require("path");
const builtins = new Set(Module.builtinModules);
const repo = process.argv[2];
const seen = new Set();
const orig = Module._load;
Module._load = function (request) {
  if (
    request &&
    !request.startsWith(".") &&
    !path.isAbsolute(request) &&
    !request.startsWith("node:") &&
    !builtins.has(request)
  ) {
    const name = request.startsWith("@") ? request.split("/").slice(0, 2).join("/") : request.split("/")[0];
    seen.add(name);
  }
  return orig.apply(this, arguments);
};
const req = Module.createRequire(path.join(repo, "index.js"));
new (req("better-sqlite3"))(":memory:").close();
const p = new (req("tree-sitter"))();
p.setLanguage(req("tree-sitter-javascript"));
req("tree-sitter-python");
const tst = req("tree-sitter-typescript");
p.setLanguage(tst.typescript);
p.setLanguage(tst.tsx);
process.stdout.write(JSON.stringify([...seen].sort()));
`;

const repoRoot = path.resolve(__dirname, "..");
const probeFile = path.join(os.tmpdir(), `evo-closure-probe-${process.pid}.cjs`);

afterAll(() => {
  try {
    fs.unlinkSync(probeFile);
  } catch {
    /* ignore */
  }
});

describe("native runtime closure", () => {
  it("matches the actual packages loaded when exercising the native addons", () => {
    fs.writeFileSync(probeFile, PROBE);
    const out = execFileSync(process.execPath, [probeFile, repoRoot], { encoding: "utf8" });
    const actual = new Set(JSON.parse(out) as string[]);
    const declared = new Set(NATIVE_RUNTIME_DEPS);

    // Every package the natives actually pull in must be declared (a NEW runtime
    // dependency the hardcoded list is missing => the shim/self-check would let a
    // thinned node_modules through and crash at load).
    const undeclared = [...actual].filter((p) => !declared.has(p as (typeof NATIVE_RUNTIME_DEPS)[number]));
    expect(undeclared, `undeclared runtime deps — add to NATIVE_RUNTIME_DEPS: ${undeclared.join(", ")}`).toEqual([]);

    // Every declared dep must actually be loaded (a stale entry that no longer
    // exists => the check would fall back unnecessarily forever).
    const unused = [...declared].filter((p) => !actual.has(p));
    expect(unused, `declared but not loaded — remove from NATIVE_RUNTIME_DEPS: ${unused.join(", ")}`).toEqual([]);

    // Sanity: all five native addons were exercised.
    for (const addon of NATIVE_ADDON_EXTERNALS) {
      expect(actual.has(addon), `native addon not loaded by probe: ${addon}`).toBe(true);
    }
  });
});
