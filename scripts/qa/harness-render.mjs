#!/usr/bin/env node
// Behavioral matrix — Section A (console rendering / streaming),
// B/C (signals, teardown, exit paths), D (auto-update nested relaunch),
// F (EVO_PROXY_ACTIVE=1 bypass). Copy-based, sandboxed (see lib.mjs / README).
//
// Run: node scripts/qa/harness-render.mjs --work <sandbox> [A|B|D|F|all]
import { spawn, spawnSync } from "node:child_process";
import { fs, path, SCRIPT_DIR, FIXTURES, resolveWork, paths, envFor, mkRun, bundleOf, makeRecorder } from "./lib.mjs";

const argv = process.argv.slice(2);
const WORK = resolveWork(argv);
const P = paths(WORK);
const BUNDLE = bundleOf(P.build);
const MOCKJS = path.join(FIXTURES, "mock-claude.mjs");
const RESULTS = P.results;
fs.mkdirSync(RESULTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = makeRecorder(results);

// Strip the Evo banner/recap lines so we can compare the claude payload bytes.
function stripEvo(s) {
  return s
    .split(/\r?\n/)
    .filter(
      (l) =>
        !/EvoPet|Evo\b|Recap|surrogate|episode|mascot|xp\b|lvl|Lv\.|Turns:|Mascot:|Episode|探索|再試行|novelty|ごほうび|🥚|🐣|🎮|🎉/i.test(l) &&
        !/[┌│└├─┐┘┤]/.test(l),
    )
    .join("\n");
}

function proxy(dir, args, extraEnv = {}, { stdinData = null } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const events = [];
    const c = spawn(process.execPath, [BUNDLE, "proxy", "--cli", "claude", "--", ...args], {
      env: envFor(WORK, dir, extraEnv),
      cwd: dir,
      stdio: [stdinData ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; events.push({ stream: "out", ms: Date.now() - t0, text: d.toString("utf8") }); });
    c.stderr.on("data", (d) => { err += d; events.push({ stream: "err", ms: Date.now() - t0, text: d.toString("utf8") }); });
    if (stdinData) { c.stdin.write(stdinData); c.stdin.end(); }
    c.on("close", (code, signal) => res({ code, signal, out, err, events, wall: Date.now() - t0, pid: c.pid }));
    c.on("error", (e) => res({ code: -1, err: String(e), out, events, wall: Date.now() - t0 }));
  });
}

// Baseline env for the direct-mock (no-proxy) parity runs — sandboxed like the
// proxy runs (HOME/USERPROFILE redirected, minimal PATH) rather than inheriting
// the full parent environment.
function directEnv(extra = {}) {
  const pathStr = [path.dirname(process.execPath), "C:\\Windows\\System32"].join(";");
  return {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: P.fakehome,
    HOME: P.fakehome,
    PATH: pathStr,
    Path: pathStr,
    ...extra,
  };
}

function directMock(args, extraEnv = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const events = [];
    const c = spawn(process.execPath, [MOCKJS, ...args], { env: directEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; events.push({ stream: "out", ms: Date.now() - t0, text: d.toString("utf8") }); });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => res({ code, out, err, events, wall: Date.now() - t0 }));
  });
}

function strayProcs(runDir) {
  const needle = runDir.replace(/'/g, "''");
  const q =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" +
    needle +
    "*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", q], { encoding: "utf8" });
  const o = String(r.stdout || "").trim();
  if (!o) return [];
  try { const j = JSON.parse(o); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

async function sectionA() {
  console.log("\n=== SECTION A: interactive console rendering / streaming ===");
  { // A1: continuous flow — first byte well before exit, spread over time.
    const dir = mkRun(WORK, "A", "a1_stream");
    const r = await proxy(dir, ["-p", "streamtest"], { MOCK_MODE: "stream_chunks", MOCK_CHUNKS: "8", MOCK_GAP_MS: "250", MOCK_TAG: "a1" });
    const firstOut = r.events.find((e) => e.stream === "out");
    const chunkLines = (r.out.match(/CHUNK \d+/g) || []).length;
    const firstMs = firstOut ? firstOut.ms : Infinity;
    const spread = r.events.length > 1 ? r.events[r.events.length - 1].ms - r.events[0].ms : 0;
    const ok = r.code === 0 && chunkLines === 8 && firstMs < r.wall - 500 && spread > 800;
    rec("A1_continuous_stream", ok ? "PASS" : "FAIL", `chunks=${chunkLines}/8 firstByte=${firstMs}ms exit=${r.wall}ms spread=${spread}ms code=${r.code}`);
    fs.writeFileSync(path.join(RESULTS, "A1_events.json"), JSON.stringify(r.events, null, 2));
  }
  { // A2: byte parity vs direct mock (payload identical modulo Evo banner/recap).
    const dir = mkRun(WORK, "A", "a2_parity");
    const pr = await proxy(dir, ["-p", "parity"], { MOCK_MODE: "interleave", MOCK_TAG: "a2" });
    const dr = await directMock(["-p", "parity"], { MOCK_MODE: "interleave", MOCK_TAG: "a2" });
    const proxOutClean = stripEvo(pr.out).replace(/\r/g, "").split("\n").filter((l) => l.trim()).join("\n");
    const dirOutClean = dr.out.replace(/\r/g, "").split("\n").filter((l) => l.trim()).join("\n");
    const errHasBoth = /ERR-1/.test(pr.err) && /ERR-2/.test(pr.err);
    rec("A2_byte_parity_stdout", proxOutClean === dirOutClean ? "PASS" : "FAIL", `proxyOut=${JSON.stringify(proxOutClean)} directOut=${JSON.stringify(dirOutClean)}`);
    rec("A2_stderr_forwarded", errHasBoth ? "PASS" : "FAIL", `proxyErr=${JSON.stringify(pr.err.replace(/\r/g, "").trim())}`);
  }
  { // A3: large burst integrity — all bytes forwarded.
    const dir = mkRun(WORK, "A", "a3_large");
    const bytes = 2 * 1024 * 1024;
    const r = await proxy(dir, ["-p", "big"], { MOCK_MODE: "stdout_var", MOCK_BYTES: String(bytes), MOCK_TAG: "a3" });
    const aCount = (r.out.match(/a/g) || []).length;
    const doneMark = /stdout_var\] done (\d+)/.exec(r.out);
    const ok = r.code === 0 && doneMark && aCount >= bytes * 0.98;
    rec("A3_large_burst_integrity", ok ? "PASS" : "FAIL", `aBytes=${aCount} target~=${bytes} done=${doneMark ? doneMark[1] : "none"} code=${r.code}`);
  }
  { // A4: piped interactive lifecycle without hang.
    const dir = mkRun(WORK, "A", "a4_stdinattach");
    const r = await proxy(dir, ["-p", "x"], { MOCK_MODE: "stream_chunks", MOCK_CHUNKS: "3", MOCK_GAP_MS: "100", EVO_FORCE_STDIN_ATTACH: "1", MOCK_TAG: "a4" }, { stdinData: "hello\n" });
    const ok = r.code === 0 && /CHUNK 2/.test(r.out) && r.wall < 10000;
    rec("A4_stdin_attach_no_hang", ok ? "PASS" : "FAIL", `chunks=${(r.out.match(/CHUNK/g) || []).length} code=${r.code} wall=${r.wall}ms`);
  }
}

async function scenarioKill(id, killArgs, treatOrphanAsFail) {
  const dir = mkRun(WORK, "B", id);
  let exit = null;
  const c = spawn(process.execPath, [BUNDLE, "proxy", "--cli", "claude", "--", "-p", "x"], {
    env: envFor(WORK, dir, { MOCK_MODE: "exit42_3s", MOCK_TAG: id }),
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  c.stdout.on("data", () => {});
  c.stderr.on("data", () => {});
  c.on("close", (code) => { exit = code; });
  await sleep(1300);
  const before = strayProcs(dir).length;
  spawnSync("taskkill", ["/PID", String(c.pid), ...killArgs], { encoding: "utf8" });
  await sleep(2500);
  const orphans = strayProcs(dir);
  for (const s of orphans) { try { spawnSync("taskkill", ["/PID", String(s.ProcessId), "/T", "/F"]); } catch {} }
  const status = treatOrphanAsFail ? (orphans.length === 0 ? "PASS" : "FAIL") : "INFO";
  rec(id, status, `killArgs=[${killArgs.join(" ")}] procsBeforeKill=${before} orphansAfter=${orphans.length} evoExit=${exit}`);
}

async function sectionB() {
  console.log("\n=== SECTION B/C: signals, teardown, exit paths ===");
  await scenarioKill("B1_taskkill_tree_T_F", ["/T", "/F"], true);
  await scenarioKill("B2_taskkill_evoonly_F", ["/F"], false);
  await scenarioKill("B3_taskkill_graceful", [], false);
  { const dir = mkRun(WORK, "B", "C_rerun_after_kill");
    const r = await proxy(dir, ["-p", "afterkill"], { MOCK_MODE: "exit0", MOCK_TAG: "cre" });
    rec("C_db_usable_after_kill", r.code === 0 ? "PASS" : "FAIL", `rerun exit=${r.code} wall=${r.wall}ms`); }
  { const dir = mkRun(WORK, "B", "C_quick_exit");
    const t0 = Date.now();
    const r = await proxy(dir, ["-p", "quick"], { MOCK_MODE: "exit0", MOCK_TAG: "qe" });
    rec("C_no_exit_hang", r.code === 0 && Date.now() - t0 < 8000 ? "PASS" : "FAIL", `exit=${r.code} wall=${r.wall}ms (<8s = no hang)`); }
}

async function sectionD() {
  console.log("\n=== SECTION D: auto-update / nested relaunch interception ===");
  const dir = mkRun(WORK, "D", "d1_relaunch");
  const r = await proxy(dir, ["-p", "update"], { MOCK_MODE: "relaunch", MOCK_TAG: "d1" });
  const relaunched = /relaunched/.test(r.out) || /re-invoking/.test(r.out);
  const noHang = r.wall < 12000;
  rec("D1_nested_relaunch_passthrough", r.code === 0 && relaunched && noHang ? "PASS" : "FAIL", `code=${r.code} relaunched=${relaunched} wall=${r.wall}ms`);
  fs.writeFileSync(path.join(RESULTS, "D1_out.txt"), r.out + "\n---ERR---\n" + r.err);
}

async function sectionF() {
  console.log("\n=== SECTION F: EVO_PROXY_ACTIVE=1 bypass ===");
  const dir = mkRun(WORK, "F", "f1_bypass");
  const bypass = await proxy(dir, ["--version"], { MOCK_MODE: "version", EVO_PROXY_ACTIVE: "1", MOCK_TAG: "f1" });
  const direct = await directMock(["--version"], { MOCK_MODE: "version", MOCK_TAG: "f1" });
  const bClean = bypass.out.replace(/\r/g, "").trim();
  const dClean = direct.out.replace(/\r/g, "").trim();
  rec("F1_bypass_version_parity", bClean === dClean ? "PASS" : "FAIL", `bypass=${JSON.stringify(bClean)} direct=${JSON.stringify(dClean)} code=${bypass.code}`);
}

const SECTIONS = { A: sectionA, B: sectionB, D: sectionD, F: sectionF };
(async () => {
  const which = (argv.find((a) => !a.startsWith("--") && a !== WORK && !/[\\/]/.test(a)) || "all").toUpperCase();
  console.log(`harness-render — WORK=${WORK}`);
  console.log(`node=${process.version} bundle_exists=${fs.existsSync(BUNDLE)}`);
  if (!fs.existsSync(BUNDLE)) { console.error(`bundle missing — run: node scripts/qa/provision.mjs --work ${WORK}`); process.exit(2); }
  const order = which === "ALL" ? ["A", "B", "D", "F"] : [which];
  for (const s of order) if (SECTIONS[s]) await SECTIONS[s]();
  fs.writeFileSync(path.join(RESULTS, "render-results.json"), JSON.stringify(results, null, 2));
  const p = results.filter((r) => r.status === "PASS").length;
  const f = results.filter((r) => r.status === "FAIL").length;
  const i = results.filter((r) => r.status === "INFO").length;
  console.log(`\n======== render TOTAL: ${p} PASS / ${f} FAIL / ${i} INFO ========`);
  process.exit(f > 0 ? 1 : 0);
})();
