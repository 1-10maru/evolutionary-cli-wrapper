#!/usr/bin/env node
// Mock `claude` CLI for the copy-based behavioral QA harness.
// Behavior is selected by MOCK_MODE. It never touches anything outside the
// sandbox, and emits a [MOCK:...] marker so a harness can prove the real child
// actually ran (vs the wrapper faking output).
import { spawn } from "node:child_process";

const MODE = process.env.MOCK_MODE || "exit0";
const args = process.argv.slice(2);
const tag = process.env.MOCK_TAG || "mock";
const log = (m) => process.stdout.write(`[MOCK:${tag}:${MODE}] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  switch (MODE) {
    case "exit0":
      log(`args=${JSON.stringify(args)} exiting 0`);
      process.exit(0);
    case "version":
      process.stdout.write("1.2.3 (Claude Code MOCK)\n");
      process.exit(0);
    case "stream_chunks": {
      // N chunks spaced in time, each flushed, to prove CONTINUOUS flow
      // (first byte long before exit). Each line is timestamped at emit.
      const n = parseInt(process.env.MOCK_CHUNKS || "8", 10);
      const gap = parseInt(process.env.MOCK_GAP_MS || "250", 10);
      for (let i = 0; i < n; i++) {
        process.stdout.write(`CHUNK ${i} emit_ms=${Date.now()}\n`);
        await sleep(gap);
      }
      process.stdout.write(`[MOCK:${tag}:stream_chunks] done ${n} chunks\n`);
      process.exit(0);
    }
    case "stdout_var": {
      const total = parseInt(process.env.MOCK_BYTES || "1048576", 10);
      const chunk = Buffer.from(("a".repeat(8 * 1024 - 1) + "\n").repeat(8), "utf8");
      let written = 0;
      const writeMore = () => {
        while (written < total) {
          written += chunk.length;
          if (!process.stdout.write(chunk)) {
            process.stdout.once("drain", writeMore);
            return;
          }
        }
        process.stdout.write(`\n[MOCK:${tag}:stdout_var] done ${written}\n`, () => process.exit(0));
      };
      writeMore();
      break;
    }
    case "interleave": {
      process.stdout.write("OUT-1\n");
      process.stderr.write("ERR-1\n");
      process.stdout.write("OUT-2\n");
      process.stderr.write("ERR-2\n");
      process.exit(0);
    }
    case "exit42_3s":
      log("sleeping 3s then exit 42");
      await sleep(3000);
      process.exit(42);
    case "relaunch": {
      log(`EVO_PROXY_ACTIVE=${process.env.EVO_PROXY_ACTIVE || ""} re-invoking claude by name`);
      const child = spawn("claude", ["--relaunched-probe"], {
        stdio: "inherit",
        shell: true,
        env: { ...process.env, MOCK_MODE: "exit0", MOCK_TAG: "relaunched" },
      });
      child.on("exit", (code) => {
        log(`relaunched child exited code=${code}`);
        process.exit(code ?? 0);
      });
      child.on("error", (e) => {
        log(`relaunch error ${e.message}`);
        process.exit(0);
      });
      break;
    }
    default:
      log("unknown MODE, exit 0");
      process.exit(0);
  }
}
main().catch((e) => {
  process.stderr.write(`mock fatal ${e && e.stack}\n`);
  process.exit(99);
});
