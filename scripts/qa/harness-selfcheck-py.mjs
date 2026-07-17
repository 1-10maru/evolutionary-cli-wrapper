#!/usr/bin/env node
// Behavioral matrix — Section H5: a BROKEN python grammar only (its .node
// removed; the dir + the js/ts grammars intact). Proves the all-grammar
// checkNativesLoadable catches a broken python binding that the file-existence
// closure check CANNOT see (dir present) and that a js-only check would miss
// (crash mid-session). Copy-based, sandboxed (see lib.mjs).
//
// Run: node scripts/qa/harness-selfcheck-py.mjs --work <sandbox>
import { spawn, spawnSync } from "node:child_process";
import { fs, path, resolveWork, paths, envFor, bundleOf, makeRecorder, realSelfcheckPath } from "./lib.mjs";

const WORK = resolveWork();
const P = paths(WORK);
const BROKEN_PY = P.brokenPy;
const HEALTHY = P.build;
const FAKE_SELFCHECK = path.join(P.fakehome, ".claude", ".evo-selfcheck.json");
const REAL_SELFCHECK = realSelfcheckPath();
const results = [];
const rec = makeRecorder(results);

function proxy(root, args, extra = {}) {
  return new Promise((res) => {
    const runDir = path.join(P.run, "h5", path.basename(root) + "-" + Date.now());
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    const c = spawn(process.execPath, [bundleOf(root), "proxy", "--cli", "claude", "--", ...args], { env: envFor(WORK, runDir, extra), cwd: runDir, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stderr.on("data", (d) => err.push(d));
    c.on("close", (code) => res({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
    c.on("error", (e) => res({ code: -1, out: "", err: String(e) }));
  });
}
function doctorQuick(root) {
  const r = spawnSync(process.execPath, [bundleOf(root), "doctor", "--quick"], { env: envFor(WORK, root), cwd: root, encoding: "utf8", timeout: 20000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const rstat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const countNodeFiles = (dir) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, e.name); if (e.isDirectory()) walk(fp); else if (e.name.endsWith(".node")) n++; } }; try { walk(dir); } catch {} return n; };

(async () => {
  if (!fs.existsSync(bundleOf(BROKEN_PY))) { console.error(`provision first: node scripts/qa/provision.mjs --work ${WORK}`); process.exit(2); }
  fs.mkdirSync(P.results, { recursive: true });
  console.log(`harness-selfcheck-py — broken-py python .node left=${countNodeFiles(path.join(BROKEN_PY, "node_modules", "tree-sitter-python"))}; py-dir present=${fs.existsSync(path.join(BROKEN_PY, "node_modules", "tree-sitter-python"))}`);
  const realBefore = rstat(REAL_SELFCHECK);
  fs.rmSync(FAKE_SELFCHECK, { force: true });

  // H5a: broken-python proxy → single warning line + exec mock, exit 0.
  const h5 = await proxy(BROKEN_PY, ["-p", "x"], { MOCK_MODE: "exit0", MOCK_TAG: "h5py" });
  const warnLines = h5.err.split(/\r?\n/).filter((l) => /自己診断|ラッパー|素の claude/.test(l));
  const loadFailInWarn = /native-load/.test(h5.err) && /tree-sitter/.test(h5.err);
  const namesPython = /python/i.test(h5.err); // observation only
  const mockRan = /\[MOCK:h5py:exit0\]/.test(h5.out);
  rec("H5a_broken_python_caught_fallback", h5.code === 0 && warnLines.length === 1 && loadFailInWarn && mockRan ? "PASS" : "FAIL", `exit=${h5.code} warnLines=${warnLines.length} loadFailReported=${loadFailInWarn} mockRan=${mockRan}`);
  console.log(`     [H5 warning] ${warnLines[0] || "(none)"}`);

  // H5b: persisted state proves closure PASSED (dir present) but native-load FAILED — the NEW coverage.
  const st = readJson(FAKE_SELFCHECK);
  const closureOk = st && st.checks.find((c) => c.name === "native-deps")?.ok === true;
  const loadFail = st && st.checks.find((c) => c.name === "native-load")?.ok === false;
  rec("H5b_closure_ok_but_load_fails", closureOk && loadFail ? "PASS" : "FAIL", `native-deps.ok=${closureOk} native-load.ok=false?${loadFail} (a js-only or file-existence check would have MISSED this)`);
  rec("H5_obs_grammar_named_in_warning", namesPython ? "INFO-named" : "INFO-generic", `native-load detail=${JSON.stringify(st ? st.checks.find((c) => c.name === "native-load")?.detail : "n/a")}`);

  // H5c: doctor --quick on broken-py → exit != 0, native-load FAIL.
  const dq = doctorQuick(BROKEN_PY);
  rec("H5c_doctor_quick_broken_py_fails", dq.status !== 0 && /native-load/.test(dq.out) && /FAIL/i.test(dq.out) ? "PASS" : "FAIL", `exit=${dq.status} native-load-shown=${/native-load/.test(dq.out)}`);
  // H5d: leak check — real ~/.claude/.evo-selfcheck.json unchanged.
  const realAfter = rstat(REAL_SELFCHECK);
  const unchanged = (!realBefore && !realAfter) || (realBefore && realAfter && realBefore.mtimeMs === realAfter.mtimeMs && realBefore.size === realAfter.size);
  rec("H5d_no_leak_to_real_home", unchanged ? "PASS" : "FAIL", `unchanged=${unchanged}`);
  fs.writeFileSync(path.join(P.results, "H5_state.json"), JSON.stringify(st, null, 2));

  const p = results.filter((r) => r.status === "PASS").length, f = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n======== selfcheck-py TOTAL: ${p} PASS / ${f} FAIL ========`);
  process.exit(f > 0 ? 1 : 0);
})();
