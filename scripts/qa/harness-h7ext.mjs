#!/usr/bin/env node
// Extended H7 — stored-secret masking across ALL THREE persisted text sites:
//   turns.input_text / turns.prompt_preview / turns.output_preview,
//   episodes.prompt_preview, prompt_profiles.preview.
// Critical case: a secret in the first 160 chars of the PROMPT (args → preview).
// Credential shapes assembled from parts at runtime (no scannable literal here).
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
// Secret within the first 160 chars of the prompt (the critical case).
const promptArg = "deploy " + AWS + " and " + GH + " to prod then verify the health endpoint responds ok and record the run";
const stdinSecret = "also slack xox" + "b-" + "1234567890abcdef" + "\n";

const dir = mkRun(WORK, "h7ext", "mask3");
const genv = { ...envFor(WORK, dir), EVO_FORCE_STDIN_ATTACH: "1", MOCK_MODE: "exit42_3s", MOCK_TAG: "h7e" };
const r = spawnSync(process.execPath, [bundleOf(P.build), "proxy", "--cli", "claude", "--", "-p", promptArg],
  { env: genv, cwd: dir, input: stdinSecret, encoding: "utf8", timeout: 20000 });

const Database = require(path.join(P.build, "node_modules", "better-sqlite3"));
const db = new Database(path.join(dir, ".evo", "evolutionary.db"), { readonly: true });
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ _err: e.message }]; } };
const epRows = q("SELECT prompt_preview FROM episodes");
const ppRows = q("SELECT preview FROM prompt_profiles");
const tuRows = q("SELECT prompt_preview, input_text, output_preview FROM turns");
const evRows = q("SELECT details_json FROM episode_events");
db.close();

const rawSecrets = [AWS, GH];
const leaksIn = (vals) => rawSecrets.filter((s) => vals.some((v) => typeof v === "string" && v.includes(s)));
const epVals = epRows.map((x) => x.prompt_preview);
const ppVals = ppRows.map((x) => x.preview);
const tuPreviewVals = tuRows.map((x) => x.prompt_preview);
const tuInputVals = tuRows.map((x) => x.input_text);

const epLeak = leaksIn(epVals);
const ppLeak = leaksIn(ppVals);
const tuPrevLeak = leaksIn(tuPreviewVals);
const tuInputLeak = leaksIn(tuInputVals);

rec("H7ext_turns_prompt_preview_masked", tuPrevLeak.length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(tuPrevLeak)} vals=${JSON.stringify(tuPreviewVals)}`);
rec("H7ext_turns_input_text_masked", tuInputLeak.length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(tuInputLeak)}`);
rec("H7ext_episodes_prompt_preview_masked", epLeak.length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(epLeak)} vals=${JSON.stringify(epVals)}`);
rec("H7ext_prompt_profiles_preview_masked", ppLeak.length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(ppLeak)} vals=${JSON.stringify(ppVals)}`);
const evVals = evRows.map((x) => x.details_json).filter((v) => typeof v === "string");
const evLeak = leaksIn(evVals);
rec("H7ext_episode_events_details_masked", evLeak.length === 0 ? "PASS" : "FAIL", `leaked=${JSON.stringify(evLeak)} (episode_events.details_json — runtime.ts fix site)`);

fs.writeFileSync(path.join(P.results, "H7ext.json"), JSON.stringify({ epVals, ppVals, tuRows, proxyExit: r.status }, null, 2));
const f = results.filter((x) => x.status === "FAIL").length;
console.log(`\n======== H7ext TOTAL: ${results.filter((x) => x.status === "PASS").length} PASS / ${f} FAIL ========`);
console.log(`(On the BUGGY acd2f95, episodes + prompt_profiles are EXPECTED to FAIL — that is the gap the fix must close.)`);
process.exit(f > 0 ? 1 : 0);
