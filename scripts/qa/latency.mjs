#!/usr/bin/env node
// Startup-latency probe: time from proxy spawn -> FIRST child-output byte
// (isolates wrapper startup overhead; the child is an identical mock). Reports
// median/mean over N iters for the provisioned build, and — if a baseline bundle
// is supplied — the delta against it.
//
// Run: node scripts/qa/latency.mjs --work <sandbox> [--baseline <path-to-old/dist/evo.bundle.cjs>] [--iters N]
import { spawn, spawnSync } from "node:child_process";
import { fs, path, resolveWork, paths, envFor, bundleOf, shellIntegrationOf } from "./lib.mjs";

const argv = process.argv.slice(2);
const WORK = resolveWork(argv);
const P = paths(WORK);
const iIdx = argv.indexOf("--iters");
const N = iIdx >= 0 ? parseInt(argv[iIdx + 1], 10) : 12;
const bIdx = argv.indexOf("--baseline");
const baseline = bIdx >= 0 ? path.resolve(argv[bIdx + 1]) : process.env.EVO_QA_BASELINE_BUNDLE || null;

const BUILDS = { "build": bundleOf(P.build) };
if (baseline && fs.existsSync(baseline)) BUILDS["baseline"] = baseline;

function firstByte(bundle, dir) {
  return new Promise((res) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(process.execPath, [bundle, "proxy", "--cli", "claude", "--", "-p", "x"], {
      env: envFor(WORK, dir, { MOCK_MODE: "stream_chunks", MOCK_CHUNKS: "1", MOCK_GAP_MS: "0", MOCK_TAG: "lat" }),
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let firstMs = null;
    c.stdout.on("data", (d) => { if (firstMs === null && /CHUNK 0/.test(d.toString())) firstMs = Number(process.hrtime.bigint() - t0) / 1e6; });
    c.stderr.on("data", () => {});
    c.on("close", () => res(firstMs));
    c.on("error", () => res(null));
  });
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

(async () => {
  if (!fs.existsSync(bundleOf(P.build))) { console.error(`provision first: node scripts/qa/provision.mjs --work ${WORK}`); process.exit(2); }
  const dir = path.join(P.run, "lat");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  spawnSync(process.execPath, ["-e", `require(${JSON.stringify(shellIntegrationOf(P.build))}).createProxyShims(${JSON.stringify(dir)})`], { env: envFor(WORK, dir), cwd: dir });
  const out = {};
  for (const [label, bundle] of Object.entries(BUILDS)) {
    const xs = [];
    for (let i = 0; i < N; i++) { const v = await firstByte(bundle, dir); if (v !== null) xs.push(v); }
    out[label] = { n: xs.length, median: +median(xs).toFixed(1), mean: +mean(xs).toFixed(1), min: +Math.min(...xs).toFixed(1), max: +Math.max(...xs).toFixed(1) };
    console.log(`${label.padEnd(10)} n=${out[label].n} median=${out[label].median}ms mean=${out[label].mean}ms min=${out[label].min} max=${out[label].max}`);
  }
  if (out.baseline && out.build) console.log(`\nDELTA (build - baseline): median ${(out.build.median - out.baseline.median).toFixed(1)}ms | mean ${(out.build.mean - out.baseline.mean).toFixed(1)}ms`);
  else console.log(`\n(no baseline supplied — pass --baseline <old bundle> or EVO_QA_BASELINE_BUNDLE for a delta)`);
  fs.mkdirSync(P.results, { recursive: true });
  fs.writeFileSync(path.join(P.results, "latency.json"), JSON.stringify(out, null, 2));
})();
