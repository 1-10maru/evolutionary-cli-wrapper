#!/usr/bin/env node
// Behavioral matrix — Section H: wrapper self-check fallback (Japanese warning,
// inspected as raw bytes), `evo doctor --quick`, self-check-state persistence,
// and a leak assertion that the REAL ~/.claude/.evo-selfcheck.json is untouched.
// Copy-based, sandboxed (see lib.mjs).
//
// Run: node scripts/qa/harness-selfcheck.mjs --work <sandbox>
import { spawn, spawnSync } from "node:child_process";
import { fs, path, resolveWork, paths, envFor, bundleOf, makeRecorder, realSelfcheckPath } from "./lib.mjs";

const WORK = resolveWork();
const P = paths(WORK);
const HEALTHY = P.build;
const BROKEN = P.broken;
const FAKE_SELFCHECK = path.join(P.fakehome, ".claude", ".evo-selfcheck.json");
const REAL_SELFCHECK = realSelfcheckPath();
const results = [];
const rec = makeRecorder(results);

// proxy run against a specific build root; stderr captured as RAW BYTES.
function proxy(root, args, extra = {}) {
  return new Promise((res) => {
    const bundle = bundleOf(root);
    const runDir = path.join(P.run, "h", path.basename(root) + "-" + Date.now());
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    const t0 = Date.now();
    const c = spawn(process.execPath, [bundle, "proxy", "--cli", "claude", "--", ...args], { env: envFor(WORK, runDir, extra), cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks = [], errChunks = [];
    c.stdout.on("data", (d) => outChunks.push(d));
    c.stderr.on("data", (d) => errChunks.push(d));
    c.on("close", (code) => res({ code, out: Buffer.concat(outChunks), err: Buffer.concat(errChunks), wall: Date.now() - t0 }));
    c.on("error", (e) => res({ code: -1, err: Buffer.from(String(e)), out: Buffer.alloc(0), wall: Date.now() - t0 }));
  });
}
function doctor(root, quick) {
  const args = quick ? ["doctor", "--quick"] : ["doctor"];
  const r = spawnSync(process.execPath, [bundleOf(root), ...args], { env: envFor(WORK, root), cwd: root, encoding: "utf8", timeout: 20000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

(async () => {
  console.log(`harness-selfcheck — HEALTHY=${fs.existsSync(bundleOf(HEALTHY))} BROKEN=${fs.existsSync(bundleOf(BROKEN))}`);
  if (!fs.existsSync(bundleOf(HEALTHY)) || !fs.existsSync(bundleOf(BROKEN))) { console.error(`provision first: node scripts/qa/provision.mjs --work ${WORK}`); process.exit(2); }
  fs.mkdirSync(P.results, { recursive: true });
  const realBefore = stat(REAL_SELFCHECK);
  console.log(`real ${REAL_SELFCHECK} BEFORE: ${realBefore ? `exists mtime=${realBefore.mtimeMs} size=${realBefore.size}` : "absent"}`);
  fs.rmSync(FAKE_SELFCHECK, { force: true });

  // H1: broken proxy → single JAPANESE warning line + mock claude runs, exit 0. Raw bytes.
  const h1 = await proxy(BROKEN, ["-p", "x"], { MOCK_MODE: "exit0", MOCK_TAG: "hbroke" });
  const errUtf8 = h1.err.toString("utf8");
  const warnLineArr = errUtf8.split(/\r?\n/).filter((l) => l.length > 0 && /自己診断|ラッパー|素の claude/.test(l));
  const hasJapanese = /[぀-ヿ一-鿿]/.test(errUtf8);
  const mockRan = /\[MOCK:hbroke:exit0\]/.test(h1.out.toString("utf8"));
  rec("H1_broken_fallback_japanese_1line", h1.code === 0 && warnLineArr.length === 1 && hasJapanese && mockRan ? "PASS" : "FAIL", `exit=${h1.code} warnLines=${warnLineArr.length} hasJapanese=${hasJapanese} mockRan=${mockRan}`);
  const hex = h1.err.slice(0, 24).toString("hex");
  fs.writeFileSync(path.join(P.results, "H1_stderr_raw.txt"), `--- stderr UTF-8 ---\n${errUtf8}\n--- first24 bytes hex ---\n${hex}\n`);
  console.log(`     [H1 warning UTF-8] ${warnLineArr[0] || "(none)"}`);
  console.log(`     [H1 first bytes hex] ${hex}  (e3.. = valid UTF-8 multibyte)`);

  // H2: doctor --quick broken → exit != 0 + FAIL.
  const h2 = doctor(BROKEN, true);
  rec("H2_doctor_quick_broken_fails", h2.status !== 0 && /native-deps/.test(h2.out) && /FAIL/i.test(h2.out) ? "PASS" : "FAIL", `exit=${h2.status}`);
  // H3: doctor --quick healthy → exit 0 + PASS.
  const h3 = doctor(HEALTHY, true);
  rec("H3_doctor_quick_healthy_pass", h3.status === 0 && /PASS/.test(h3.out) ? "PASS" : "FAIL", `exit=${h3.status}`);

  // H4a: healthy proxy → sandbox selfcheck.json exists, ok:true.
  fs.rmSync(FAKE_SELFCHECK, { force: true });
  await proxy(HEALTHY, ["-p", "x"], { MOCK_MODE: "exit0", MOCK_TAG: "h4heal" });
  const s4a = readJson(FAKE_SELFCHECK);
  rec("H4a_persist_healthy_ok_true", s4a && s4a.ok === true && Array.isArray(s4a.checks) ? "PASS" : "FAIL", `exists=${!!s4a} ok=${s4a ? s4a.ok : "n/a"} checks=${s4a ? s4a.checks.length : 0}`);
  // H4b: broken proxy → selfcheck.json records the failure reason.
  fs.rmSync(FAKE_SELFCHECK, { force: true });
  await proxy(BROKEN, ["-p", "x"], { MOCK_MODE: "exit0", MOCK_TAG: "h4broke" });
  const s4b = readJson(FAKE_SELFCHECK);
  const recordsFail = s4b && s4b.ok === false && JSON.stringify(s4b.checks).match(/tree-sitter|missing|native/i);
  rec("H4b_persist_broken_records_reason", recordsFail ? "PASS" : "FAIL", `exists=${!!s4b} ok=${s4b ? s4b.ok : "n/a"} reason=${s4b ? JSON.stringify(s4b.checks.filter((c) => !c.ok).map((c) => c.detail)) : "n/a"}`);
  // H4c: evo doctor (FULL) reads the persisted ok:false → Wrapper Self-check + Critical.
  const h4c = doctor(HEALTHY, false);
  const showsSelfCheck = /self-?check/i.test(h4c.out), showsCritical = /critical/i.test(h4c.out);
  rec("H4c_doctor_full_shows_selfcheck_critical", showsSelfCheck && showsCritical ? "PASS" : "FAIL", `exit=${h4c.status} selfCheckLine=${showsSelfCheck} critical=${showsCritical}`);
  fs.writeFileSync(path.join(P.results, "H4c_doctor_full.txt"), `exit=${h4c.status}\n` + h4c.out);
  // H4d: leak check — real ~/.claude/.evo-selfcheck.json NOT modified.
  const realAfter = stat(REAL_SELFCHECK);
  const unchanged = (!realBefore && !realAfter) || (realBefore && realAfter && realBefore.mtimeMs === realAfter.mtimeMs && realBefore.size === realAfter.size);
  rec("H4d_no_leak_to_real_home", unchanged ? "PASS" : "FAIL", `realBefore=${realBefore ? realBefore.mtimeMs : "absent"} realAfter=${realAfter ? realAfter.mtimeMs : "absent"} unchanged=${unchanged}`);

  fs.writeFileSync(path.join(P.results, "selfcheck-results.json"), JSON.stringify(results, null, 2));
  const p = results.filter((r) => r.status === "PASS").length, f = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n======== selfcheck TOTAL: ${p} PASS / ${f} FAIL ========`);
  process.exit(f > 0 ? 1 : 0);
})();
