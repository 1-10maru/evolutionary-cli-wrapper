#!/usr/bin/env node
// Behavioral matrix — Section G (multi-window concurrency / isolation) and
// Section E (statusline strictness). Copy-based, sandboxed (see lib.mjs).
//
// Run: node scripts/qa/harness-concurrency.mjs --work <sandbox>
import { spawn, spawnSync } from "node:child_process";
import { fs, path, resolveWork, paths, envFor, mkRun, bundleOf, makeRecorder } from "./lib.mjs";

const WORK = resolveWork();
const P = paths(WORK);
const BUNDLE = bundleOf(P.build);
const results = [];
const rec = makeRecorder(results);

function proxy(dir, args, extra = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [BUNDLE, "proxy", "--cli", "claude", "--", ...args], { env: envFor(WORK, dir, extra), cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => res({ code, out, err, wall: Date.now() - t0 }));
    c.on("error", (e) => res({ code: -1, err: String(e), out: "", wall: Date.now() - t0 }));
  });
}

async function sectionG() {
  console.log("\n=== SECTION G: multi-window concurrency ===");
  const d1 = mkRun(WORK, "geh", "g_win1"), d2 = mkRun(WORK, "geh", "g_win2");
  const [r1, r2] = await Promise.all([
    proxy(d1, ["-p", "win1"], { MOCK_MODE: "stream_chunks", MOCK_CHUNKS: "4", MOCK_GAP_MS: "150", MOCK_TAG: "w1" }),
    proxy(d2, ["-p", "win2"], { MOCK_MODE: "stream_chunks", MOCK_CHUNKS: "4", MOCK_GAP_MS: "150", MOCK_TAG: "w2" }),
  ]);
  const bothOk = r1.code === 0 && r2.code === 0;
  const db1 = fs.existsSync(path.join(d1, ".evo", "evolutionary.db"));
  const db2 = fs.existsSync(path.join(d2, ".evo", "evolutionary.db"));
  const noCross = /w1/.test(r1.out) && !/w2/.test(r1.out) && /w2/.test(r2.out) && !/w1/.test(r2.out);
  rec("G1_both_record", bothOk && db1 && db2 ? "PASS" : "FAIL", `code1=${r1.code} code2=${r2.code} db1=${db1} db2=${db2}`);
  rec("G2_no_crosstalk", noCross ? "PASS" : "FAIL", `w1out=${/w1/.test(r1.out)} w2LeakInto1=${/w2/.test(r1.out)} w2out=${/w2/.test(r2.out)}`);
}

async function sectionE() {
  console.log("\n=== SECTION E: statusline strictness ===");
  const dir = mkRun(WORK, "geh", "e_statusline");
  const r0 = spawnSync(process.execPath, [BUNDLE, "statusline"], { env: envFor(WORK, dir), cwd: dir, encoding: "utf8", timeout: 10000, input: JSON.stringify({ session_id: "no-such-session", cwd: dir }) });
  rec("E1_statusline_no_session_no_crash", r0.status === 0 || r0.status === null ? "PASS" : "INFO", `exit=${r0.status} stdoutLen=${(r0.stdout || "").length} silentOrFallback=${!/EvoPet/.test(r0.stdout || "")}`);
  const r1 = spawnSync(process.execPath, [BUNDLE, "statusline"], { env: envFor(WORK, dir), cwd: dir, encoding: "utf8", timeout: 10000, input: JSON.stringify({ session_id: "FOREIGN-" + Date.now(), cwd: dir }) });
  const emittedOwner = /Lv\.|育成度|EXP|stage=/.test(r1.stdout || "");
  rec("E2_foreign_session_silent", !emittedOwner ? "PASS" : "INFO", `exit=${r1.status} emittedOwnerBlock=${emittedOwner} out=${JSON.stringify((r1.stdout || "").slice(0, 80))}`);
}

(async () => {
  console.log(`harness-concurrency — WORK=${WORK} bundle_exists=${fs.existsSync(BUNDLE)}`);
  if (!fs.existsSync(BUNDLE)) { console.error(`bundle missing — run: node scripts/qa/provision.mjs --work ${WORK}`); process.exit(2); }
  await sectionG();
  await sectionE();
  fs.writeFileSync(path.join(P.results, "concurrency-results.json"), JSON.stringify(results, null, 2));
  const p = results.filter((r) => r.status === "PASS").length, f = results.filter((r) => r.status === "FAIL").length, i = results.filter((r) => r.status === "INFO").length;
  console.log(`\n======== concurrency TOTAL: ${p} PASS / ${f} FAIL / ${i} INFO ========`);
  process.exit(f > 0 ? 1 : 0);
})();
