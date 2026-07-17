// Shared helpers for the copy-based behavioral QA harness.
//
// SAFETY MODEL (see README.md):
//   - Repo SOURCE (this dir + fixtures/) is read-only; nothing here writes into
//     the repo. All mutable state (the built copy, run dirs, results, fake HOME)
//     lives under a caller-supplied WORK dir (a sandbox), never the real repo.
//   - The wrapped `claude` is a MOCK (fixtures/mock-claude.mjs) resolved via a
//     sandbox-only PATH; HOME/USERPROFILE/EVO_HOME are redirected into WORK so a
//     run can never touch the real ~/.claude or the real repo.
//   - No junctions/symlinks anywhere; provisioning is copy-only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const FIXTURES = path.join(SCRIPT_DIR, "fixtures");
export const MOCK_CMD_DIR = path.join(FIXTURES, "mock", "cmd");

const NODEDIR = path.dirname(process.execPath);
const SYS32 = "C:\\Windows\\System32";
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0";

/** Resolve the WORK sandbox dir: --work <dir> arg, then EVO_QA_WORK, then a
 *  default under the OS temp dir. Refuses anything inside the repo. */
export function resolveWork(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--work");
  const fromArg = i >= 0 ? argv[i + 1] : undefined;
  const work = path.resolve(fromArg || process.env.EVO_QA_WORK || path.join(os.tmpdir(), "evo-qa-work"));
  if (work === REPO_ROOT || work.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`WORK dir must be OUTSIDE the repo (got ${work}); pass --work <sandbox> or set EVO_QA_WORK`);
  }
  return work;
}

/** Standard sub-paths inside a WORK dir. */
export function paths(work) {
  return {
    work,
    build: path.join(work, "build"), // healthy provisioned build (dist + node_modules)
    broken: path.join(work, "broken"), // build copy with a tree-sitter native removed
    brokenPy: path.join(work, "broken-py"), // build copy with ONLY the python grammar native removed
    fakehome: path.join(work, "fakehome"), // redirected HOME/USERPROFILE
    results: path.join(work, "results"),
    run: path.join(work, "run"),
  };
}

export const bundleOf = (root) => path.join(root, "dist", "evo.bundle.cjs");
export const shellIntegrationOf = (root) => path.join(root, "dist", "shellIntegration.js");

/** The REAL user self-check state file — used ONLY for leak assertions (that a
 *  sandboxed run did not modify it). Derived from os.homedir(), never hardcoded. */
export const realSelfcheckPath = () => path.join(os.homedir(), ".claude", ".evo-selfcheck.json");

/** Sandbox env: PATH limited to the run's bin, the MOCK claude, node, and the
 *  Windows system dirs. HOME/USERPROFILE/EVO_HOME redirected into WORK. */
export function envFor(work, dir, extra = {}) {
  const fakehome = paths(work).fakehome;
  const P = [path.join(dir, "bin"), MOCK_CMD_DIR, NODEDIR, SYS32, PS].join(";");
  return {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: fakehome,
    HOME: fakehome,
    EVO_HOME: dir,
    EVO_CONFIG: path.join(dir, ".evo", "config.json"),
    EVO_DISABLE_HEARTBEAT: "1",
    EVO_EXIT_WATCHDOG_MS: "1500",
    PATH: P,
    Path: P,
    ...extra,
  };
}

/** Create a fresh run dir under WORK and generate its .evo config + bin shims
 *  from the provisioned build's shellIntegration. */
export function mkRun(work, section, id) {
  const dir = path.join(paths(work).run, section, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const shellint = shellIntegrationOf(paths(work).build);
  spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(shellint)}).createProxyShims(${JSON.stringify(dir)})`],
    { env: envFor(work, dir), cwd: dir, encoding: "utf8" },
  );
  return dir;
}

/** Make a console recorder bound to a results array. */
export function makeRecorder(list) {
  return (id, status, reason) => {
    list.push({ id, status, reason });
    console.log(`${String(status).padEnd(6)} ${String(id).padEnd(40)} ${reason ?? ""}`);
  };
}

export { fs, os, path };
