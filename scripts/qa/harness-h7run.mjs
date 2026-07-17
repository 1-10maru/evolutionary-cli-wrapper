#!/usr/bin/env node
// H7run — `evo run` path: the prompt_submitted event preview persisted into
// episode_events.details_json must be masked for a secret-bearing prompt
// (runtime.ts fix site). Also re-checks episodes.prompt_preview +
// prompt_profiles.preview via the run path. Shapes assembled from parts.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fs, path, paths, bundleOf, envFor, mkRun, makeRecorder } from "./lib.mjs";

const WORK = (() => { const i = process.argv.indexOf("--work"); return path.resolve(i >= 0 ? process.argv[i + 1] : process.env.EVO_QA_WORK); })();
const P = paths(WORK);
const require = createRequire(import.meta.url);
const results = [];
const rec = makeRecorder(results);

const AWS = "AKIA" + "IOSFODNN7" + "EXAMPLE";
const GH = "ghp" + "_" + "AbCdEf0123456789AbCdEf0123456789AbCd";
const promptText = "ship " + AWS + " plus " + GH + " to staging and confirm the deploy health check passes before promoting to prod";

const dir = mkRun(WORK, "h7run", "runpath");
// evo run --cwd <dir> --prompt-text "<secret>" -- node -e "process.exit(0)"
const r = spawnSync(process.execPath, [bundleOf(P.build), "run", "--cwd", dir, "--prompt-text", promptText, "--", process.execPath, "-e", "process.exit(0)"],
  { env: envFor(WORK, dir), cwd: dir, encoding: "utf8", timeout: 25000 });

const Database = require(path.join(P.build, "node_modules", "better-sqlite3"));
const db = new Database(path.join(dir, ".evo", "evolutionary.db"), { readonly: true });
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ _err: e.message }]; } };
const evRows = q("SELECT event_type, details_json FROM episode_events");
const epRows = q("SELECT prompt_preview FROM episodes");
const ppRows = q("SELECT preview FROM prompt_profiles");
db.close();

const rawSecrets = [AWS, GH];
const leaks = (vals) => rawSecrets.filter((s) => vals.some((v) => typeof v === "string" && v.includes(s)));
const submitted = evRows.filter((x) => x.event_type === "prompt_submitted");
const submittedJson = submitted.map((x) => x.details_json);
const anyEvJson = evRows.map((x) => x.details_json);
rec("H7run_prompt_submitted_event_present", submitted.length > 0 ? "PASS" : "FAIL", `prompt_submitted rows=${submitted.length} exit=${r.status}`);
rec("H7run_prompt_submitted_preview_masked", leaks(submittedJson).length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(leaks(submittedJson))} json=${JSON.stringify(submittedJson).slice(0,300)}`);
rec("H7run_all_episode_events_masked", leaks(anyEvJson).length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(leaks(anyEvJson))}`);
rec("H7run_episodes_prompt_preview_masked", leaks(epRows.map((x) => x.prompt_preview)).length === 0 ? "PASS" : "FAIL", `vals=${JSON.stringify(epRows.map((x) => x.prompt_preview))}`);
rec("H7run_prompt_profiles_preview_masked", leaks(ppRows.map((x) => x.preview)).length === 0 ? "PASS" : "FAIL", `vals=${JSON.stringify(ppRows.map((x) => x.preview))}`);

fs.writeFileSync(path.join(P.results, "H7run.json"), JSON.stringify({ evRows, epRows, ppRows, runExit: r.status, stderr: r.stderr }, null, 2));
const f = results.filter((x) => x.status === "FAIL").length;
console.log(`\n======== H7run TOTAL: ${results.filter((x) => x.status === "PASS").length} PASS / ${f} FAIL ========`);
process.exit(f > 0 ? 1 : 0);
