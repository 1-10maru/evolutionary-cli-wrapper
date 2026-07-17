#!/usr/bin/env node
// One-command driver: provision a sandbox from a git ref, then run every
// behavioral suite against it and print an aggregate PASS/FAIL summary.
//
// Run: node scripts/qa/run-all.mjs --work <sandbox> [--ref <git-ref>] [--no-provision]
import { spawnSync } from "node:child_process";
import { path, SCRIPT_DIR, resolveWork } from "./lib.mjs";

const argv = process.argv.slice(2);
const WORK = resolveWork(argv);
const doProvision = !argv.includes("--no-provision");

const node = process.execPath;
const script = (name) => path.join(SCRIPT_DIR, name);

function step(label, args) {
  console.log(`\n########## ${label} ##########`);
  const r = spawnSync(node, args, { stdio: "inherit" });
  return r.status ?? 1;
}

let failed = 0;

if (doProvision) {
  const provArgs = [script("provision.mjs"), "--work", WORK];
  const rIdx = argv.indexOf("--ref");
  if (rIdx >= 0) provArgs.push("--ref", argv[rIdx + 1]);
  const s = step("PROVISION (copy-only)", provArgs);
  if (s !== 0) { console.error("provision failed — aborting."); process.exit(2); }
}

const suites = [
  ["RENDER / SIGNALS / UPDATE / BYPASS (A,B,D,F)", ["harness-render.mjs", "all"]],
  ["CONCURRENCY / STATUSLINE (G,E)", ["harness-concurrency.mjs"]],
  ["SELF-CHECK (H1-H4)", ["harness-selfcheck.mjs"]],
  ["SELF-CHECK broken-python (H5)", ["harness-selfcheck-py.mjs"]],
];
for (const [label, [file, ...rest]] of suites) {
  const s = step(label, [script(file), "--work", WORK, ...rest]);
  if (s !== 0) failed++;
}

// Latency is informational (no hard fail).
step("LATENCY (informational)", [script("latency.mjs"), "--work", WORK]);

console.log(`\n################ QA AGGREGATE: ${failed === 0 ? "ALL SUITES PASS" : failed + " SUITE(S) FAILED"} ################`);
process.exit(failed > 0 ? 1 : 0);
