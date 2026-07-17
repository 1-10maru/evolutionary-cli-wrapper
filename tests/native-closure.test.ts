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
 * flagged.
 *
 * This is NOT a tautology: the expected closure is derived independently of the
 * hardcoded helper list. The probe exercises the addons taken from
 * NATIVE_ADDON_EXTERNALS (so a newly added addon is automatically exercised),
 * records EVERY node_modules package actually pulled in via a `require` hook, and
 * the test asserts that measured set equals NATIVE_RUNTIME_DEPS exactly. A new
 * helper dep, a dropped helper, or a new addon whose helpers weren't declared all
 * make the sets differ and fail CI.
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
const addons = JSON.parse(process.argv[3]);
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
const loaded = {};
for (const a of addons) loaded[a] = req(a); // requiring triggers the native load
// Exercise each addon the way the app does, so lazily-loaded bindings surface.
if (loaded["better-sqlite3"]) new (loaded["better-sqlite3"])(":memory:").close();
if (loaded["tree-sitter"]) {
  const p = new (loaded["tree-sitter"])();
  for (const a of addons) {
    if (!a.startsWith("tree-sitter-")) continue;
    const g = loaded[a];
    if (g && g.typescript) { p.setLanguage(g.typescript); p.setLanguage(g.tsx); }
    else if (g) p.setLanguage(g);
  }
}
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
  it("matches the packages actually loaded when exercising the native addons", () => {
    fs.writeFileSync(probeFile, PROBE);
    const out = execFileSync(
      process.execPath,
      [probeFile, repoRoot, JSON.stringify([...NATIVE_ADDON_EXTERNALS])],
      { encoding: "utf8" },
    );
    const actual = new Set(JSON.parse(out) as string[]);
    const declared = new Set(NATIVE_RUNTIME_DEPS);

    // A package the natives actually pull in that ISN'T declared => a thinned
    // node_modules could drop it, pass the file-presence preflight, and crash at
    // load. Add it to NATIVE_RUNTIME_DEPS.
    const undeclared = [...actual].filter((p) => !declared.has(p as (typeof NATIVE_RUNTIME_DEPS)[number]));
    expect(undeclared, `undeclared runtime deps — add to NATIVE_RUNTIME_DEPS: ${undeclared.join(", ")}`).toEqual([]);

    // A declared package that ISN'T loaded => a stale entry that makes the check
    // fall back unnecessarily forever. Remove it.
    const unused = [...declared].filter((p) => !actual.has(p));
    expect(unused, `declared but not loaded — remove from NATIVE_RUNTIME_DEPS: ${unused.join(", ")}`).toEqual([]);

    // Sanity: every declared native addon was exercised.
    for (const addon of NATIVE_ADDON_EXTERNALS) {
      expect(actual.has(addon), `native addon not loaded by probe: ${addon}`).toBe(true);
    }
  });
});
