#!/usr/bin/env node
// Copy-only provisioner for the behavioral QA harness.
//
// Builds three sandboxed copies of the wrapper under a WORK dir, from a git ref:
//   build/     — healthy: full node_modules + freshly built dist (bundle + shellIntegration)
//   broken/    — build with tree-sitter's native .node removed  (native-load fails)
//   broken-py/ — build with ONLY the python grammar .node removed (dir intact; the
//                all-grammar self-check must still catch it)
//
// SAFETY: the source tree is taken via `git archive` (committed bytes only, never
// the live working tree), node_modules is COPIED (no junctions/symlinks), and a
// leak-audit asserts the REAL repo's node_modules top-level entry count is
// unchanged (derived dynamically — NOT a hardcoded number).
//
// Run: node scripts/qa/provision.mjs --work <sandbox> [--ref <git-ref>]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, resolveWork, paths } from "./lib.mjs";

// The native runtime closure the bundle needs present at load (keep in sync with
// NATIVE_RUNTIME_DEPS in src/health.ts). broken/ and broken-py/ ship only these
// plus dist/, so they stay small.
const NATIVE_CLOSURE = [
  "better-sqlite3",
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-typescript",
  "bindings",
  "file-uri-to-path",
  "node-gyp-build",
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout || ""}\n${r.stderr || ""}`);
  }
  return r;
}

const countTopLevel = (dir) => {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return -1;
  }
};

const removeDotNode = (root) => {
  let removed = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith(".node")) {
        fs.rmSync(fp, { force: true });
        removed++;
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return removed;
};

function makeThinnedBrokenCopy(build, dest, breakDirName) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, "node_modules"), { recursive: true, dereference: true });
  fs.cpSync(path.join(build, "dist"), path.join(dest, "dist"), { recursive: true, dereference: true });
  fs.cpSync(path.join(build, "package.json"), path.join(dest, "package.json"), { dereference: true });
  for (const dep of NATIVE_CLOSURE) {
    const src = path.join(build, "node_modules", dep);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, "node_modules", dep), { recursive: true, dereference: true });
  }
  const removed = removeDotNode(path.join(dest, "node_modules", breakDirName));
  if (removed === 0) throw new Error(`no .node removed under ${breakDirName} — cannot create broken copy`);
  return removed;
}

function main() {
  const argv = process.argv.slice(2);
  const work = resolveWork(argv);
  const refIdx = argv.indexOf("--ref");
  const ref = refIdx >= 0 ? argv[refIdx + 1] : "HEAD";
  const p = paths(work);

  console.log(`provision: repo=${REPO_ROOT}`);
  console.log(`provision: work=${work}  ref=${ref}`);

  // Leak-audit baseline (dynamic; the real repo node_modules must be untouched).
  const realNm = path.join(REPO_ROOT, "node_modules");
  const beforeCount = countTopLevel(realNm);
  console.log(`provision: real node_modules top-level entries BEFORE = ${beforeCount}`);

  fs.rmSync(p.build, { recursive: true, force: true });
  fs.mkdirSync(p.build, { recursive: true, dereference: true });
  fs.mkdirSync(p.results, { recursive: true, dereference: true });
  fs.mkdirSync(path.join(p.fakehome, ".claude"), { recursive: true, dereference: true });

  // 1) source = committed bytes of <ref> via git archive (never the live tree).
  // Extract with a RELATIVE tar filename from inside build/ — a Windows `tar
  // -f C:\...` path is otherwise parsed as a remote "host:file" (the colon).
  const tarName = "src.tar";
  run("git", ["-C", REPO_ROOT, "archive", "--format=tar", "-o", path.join(p.build, tarName), ref]);
  run("tar", ["-xf", tarName], { cwd: p.build });
  fs.rmSync(path.join(p.build, tarName), { force: true });

  // 2) node_modules = COPY of the real repo's (no junctions/symlinks).
  console.log("provision: copying node_modules (copy-only)…");
  fs.cpSync(realNm, path.join(p.build, "node_modules"), { recursive: true, dereference: true });

  // 3) build the bundle + tsc output inside the sandbox copy.
  console.log("provision: npm run build (in sandbox copy)…");
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: p.build, shell: true });
  if (!fs.existsSync(path.join(p.build, "dist", "evo.bundle.cjs"))) {
    throw new Error("build did not produce dist/evo.bundle.cjs");
  }

  // 4) broken variants (thinned copies).
  const nBroke = makeThinnedBrokenCopy(p.build, p.broken, "tree-sitter");
  const nBrokePy = makeThinnedBrokenCopy(p.build, p.brokenPy, "tree-sitter-python");
  console.log(`provision: broken/ (tree-sitter .node removed: ${nBroke}), broken-py/ (python .node removed: ${nBrokePy})`);

  // 5) leak-audit — the real repo node_modules must be byte-count identical.
  const afterCount = countTopLevel(realNm);
  console.log(`provision: real node_modules top-level entries AFTER = ${afterCount}`);
  if (beforeCount !== afterCount || beforeCount < 0) {
    throw new Error(`LEAK-AUDIT FAILED: real node_modules changed (${beforeCount} -> ${afterCount})`);
  }
  console.log(`provision: LEAK-AUDIT OK — real node_modules unchanged (${beforeCount} entries).`);
  console.log("provision: DONE.");
}

main();
