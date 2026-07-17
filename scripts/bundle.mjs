// Produce a self-contained single-file executable of the Evo CLI at
// dist/evo.bundle.cjs.
//
// Why this exists: the CLI's launch path (`node dist/index.js ...`, used by the
// generated claude/codex/evo shims) previously required every runtime dependency
// to be present in the repo's node_modules at startup. When an external process
// thinned node_modules (deleting transitive pure-JS packages such as ansi-regex),
// `claude` itself failed to start with ERR_MODULE_NOT_FOUND — a user-facing
// outage. Bundling inlines all pure-JS dependencies into one file so their
// deletion from node_modules can no longer break startup.
//
// Native addons CANNOT be bundled (they load platform-specific .node binaries),
// so they stay external and are still required from node_modules at runtime. The
// generated shims include a launch fallback that runs the real claude directly
// when the bundle or a native dependency is missing (see src/shellIntegration.ts,
// NATIVE_ADDON_EXTERNALS).
//
// Keep NATIVE_ADDON_EXTERNALS below in sync with the same list in
// src/health.ts (the runtime single source of truth). This build script runs as
// a plain .mjs and cannot import the TS module, hence the duplicated list.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Native addons — cannot be bundled; resolved from node_modules at runtime.
const NATIVE_ADDON_EXTERNALS = [
  "better-sqlite3",
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-typescript",
];

await build({
  entryPoints: [path.join(projectRoot, "src", "index.ts")],
  outfile: path.join(projectRoot, "dist", "evo.bundle.cjs"),
  bundle: true,
  platform: "node",
  // Match the package's engines field (node >= 20). Node 20 is the floor even
  // though this dev box runs newer; the bundle must run on the supported floor.
  target: "node20",
  // CJS is the safe format: package `type` is "commonjs", the entry uses
  // __dirname / require("../package.json") (no import.meta, no top-level await),
  // and the shims launch it with a plain `node <file>`.
  format: "cjs",
  external: NATIVE_ADDON_EXTERNALS,
  // No banner shebang: src/index.ts already begins with `#!/usr/bin/env node`
  // and esbuild preserves it as line 1 of the bundle. Adding another here would
  // produce a second (invalid) shebang on line 2.
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("Bundled → dist/evo.bundle.cjs");
