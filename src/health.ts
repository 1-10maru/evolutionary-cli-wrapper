import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Native addons that CANNOT be bundled — they load platform-specific `.node`
 * binaries and stay external in the esbuild bundle, resolved from node_modules
 * at runtime. Single source of truth for the runtime side (imported by
 * shellIntegration's launch-fallback generator and by the health check).
 *
 * Keep in sync with NATIVE_ADDON_EXTERNALS in scripts/bundle.mjs (the build
 * script runs as a plain .mjs and cannot import this TS module).
 */
export const NATIVE_ADDON_EXTERNALS = [
  "better-sqlite3",
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-typescript",
] as const;

/**
 * The full set of node_modules packages the bundle still needs present at
 * runtime: the native addons above PLUS the pure-JS loader helpers those addons
 * `require` from node_modules when the DB is opened / a parser initializes.
 * Measured empirically against a thinned node_modules:
 *   - better-sqlite3 -> `bindings` -> `file-uri-to-path` (loaded on DB open)
 *   - tree-sitter    -> `node-gyp-build`                 (loaded on parser init)
 * Everything the MAIN package depends on (commander, chokidar, strip-ansi, ...)
 * is inlined into the bundle and is intentionally NOT listed — its deletion can
 * no longer break startup.
 */
export const NATIVE_RUNTIME_DEPS = [
  ...NATIVE_ADDON_EXTERNALS,
  "bindings",
  "file-uri-to-path",
  "node-gyp-build",
] as const;

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HealthReport {
  ok: boolean;
  checks: HealthCheck[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/**
 * The Evo install root. This module compiles to `dist/health.js` and the
 * published executable is `dist/evo.bundle.cjs` — both live in `dist/`, so the
 * root is always one directory up from `__dirname`.
 */
export function getEvoRoot(): string {
  return path.resolve(__dirname, "..");
}

/** The self-contained bundle exists and is readable. */
export function checkBundlePresent(root: string = getEvoRoot()): HealthCheck {
  const bundle = path.join(root, "dist", "evo.bundle.cjs");
  try {
    fs.accessSync(bundle, fs.constants.R_OK);
    return { name: "bundle", ok: true, detail: bundle };
  } catch {
    return { name: "bundle", ok: false, detail: `not readable: ${bundle}` };
  }
}

/**
 * Every package in the native runtime closure is present in node_modules. This
 * is the same set the generated launch-fallback shim checks (cheap, no load) —
 * it catches a thinned node_modules before the bundle tries to load a native.
 */
export function checkNativeClosurePresent(root: string = getEvoRoot()): HealthCheck {
  const nm = path.join(root, "node_modules");
  const missing = NATIVE_RUNTIME_DEPS.filter((dep) => !fs.existsSync(path.join(nm, dep)));
  return missing.length === 0
    ? { name: "native-deps", ok: true, detail: `${NATIVE_RUNTIME_DEPS.length} present` }
    : { name: "native-deps", ok: false, detail: `missing: ${missing.join(", ")}` };
}

/**
 * The native addons actually LOAD and run — open an in-memory SQLite database
 * and initialize a tree-sitter parser with a grammar. Catches a present-but-
 * unloadable native (ABI mismatch, corrupt/incompatible `.node`, missing build)
 * that a file-existence check cannot see. The requires are lazy (executed only
 * here), so importing this module never itself triggers a native load.
 */
export function checkNativesLoadable(): HealthCheck {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
  } catch (err) {
    return { name: "native-load", ok: false, detail: `better-sqlite3: ${errMsg(err)}` };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Parser = require("tree-sitter");
    const parser = new Parser();
    // Load AND bind every grammar the AST diff can use (episodeLifecycle drives
    // js/ts/tsx/python). A grammar whose native binding is present-but-broken only
    // throws on setLanguage, so checking javascript alone would pass self-check
    // and then crash mid-session on the first python/typescript file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    parser.setLanguage(require("tree-sitter-javascript"));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    parser.setLanguage(require("tree-sitter-python"));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TypeScript = require("tree-sitter-typescript");
    parser.setLanguage(TypeScript.typescript);
    parser.setLanguage(TypeScript.tsx);
  } catch (err) {
    return { name: "native-load", ok: false, detail: `tree-sitter: ${errMsg(err)}` };
  }
  return { name: "native-load", ok: true };
}

/**
 * Fast wrapper self-check: bundle present, native closure present, natives
 * loadable. No child processes, no DB writes, no disk state — safe to run on
 * every proxy startup. The original-CLI resolution ("proxy round-trip") is
 * checked separately by the caller (it needs shellIntegration, which imports
 * this module — kept out to avoid a cycle).
 */
export function quickHealthReport(root: string = getEvoRoot()): HealthReport {
  const checks = [checkBundlePresent(root), checkNativeClosurePresent(root), checkNativesLoadable()];
  return { ok: checks.every((c) => c.ok), checks };
}

// ── Inspectable self-check state ───────────────────────────────────────────
//
// So a broken wrapper is never silent AND the reason is inspectable later: the
// proxy path records its last self-check result to a small global JSON file that
// `evo doctor` surfaces. Lives next to the live-state file under ~/.claude.

export interface SelfCheckState extends HealthReport {
  /** epoch ms when the self-check ran */
  at: number;
}

export function selfCheckStatePath(): string {
  return path.join(os.homedir(), ".claude", ".evo-selfcheck.json");
}

/** Best-effort atomic write of the last self-check result. Never throws. */
export function writeSelfCheckState(report: HealthReport): void {
  try {
    const target = selfCheckStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload: SelfCheckState = { ok: report.ok, checks: report.checks, at: Date.now() };
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, target);
  } catch {
    // Observability only — never fail a launch on this write.
  }
}

export function readSelfCheckState(): SelfCheckState | null {
  try {
    return JSON.parse(fs.readFileSync(selfCheckStatePath(), "utf8")) as SelfCheckState;
  } catch {
    return null;
  }
}
