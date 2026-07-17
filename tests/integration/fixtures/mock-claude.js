// Mock Claude CLI for integration tests.
// Emits a small burst of synthetic JSONL session entries that match the
// shape proxyRuntime.ts parses (`type: "user"` / `type: "assistant"` with
// `message.content` blocks). Also prints a token-usage line so the proxy's
// usage adapter has something to chew on, then exits with the requested
// code.
//
// CLI usage:
//   node mock-claude.js --out <jsonlPath> [--exit-code <n>] [--turns <n>]
//                       [--hold-stdout-ms <n>]
//
// --hold-stdout-ms <n>: before exiting, spawn a DETACHED grandchild that
// inherits (and holds) this process's stdout fd for <n> ms. Because the wrapper
// pipes our stdout, the grandchild keeps the write end open after we exit, so
// the wrapper's child `close` event is delayed past our `exit` event. This
// reproduces the "child exited but stdio lingers" condition the exit watchdog
// in proxyRuntime.ts guards against. Any unrecognized extra flags (e.g.
// `--update`) are ignored, so the fixture can also stand in for update ops.
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

const outPath = getArg("--out", "");
const exitCode = Number(getArg("--exit-code", "0")) || 0;
const turnCount = Number(getArg("--turns", "3")) || 3;
const holdStdoutMs = Number(getArg("--hold-stdout-ms", "0")) || 0;

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Truncate / create file.
  fs.writeFileSync(outPath, "");
}

function emit(line) {
  if (!outPath) return;
  fs.appendFileSync(outPath, JSON.stringify(line) + "\n");
}

// Synchronous emit-then-exit. Keep total runtime < 50ms so the proxy idle
// timer (50ms in tests) has clear boundaries to work with.
for (let i = 0; i < turnCount; i += 1) {
  emit({ type: "user", message: { content: `please read src/index.ts at turn ${i}` } });
  emit({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } },
      ],
    },
  });
}

// Stdout: a usage observation the proxy may parse.
console.log("Read src/index.ts");
console.log("prompt tokens: 12 completion tokens: 4 total tokens: 16");

if (holdStdoutMs > 0) {
  const { spawn } = require("node:child_process");
  // Grandchild inherits our stdout (fd 1 = the pipe to the wrapper) and keeps it
  // open for holdStdoutMs. detached + unref so we can exit immediately while it
  // lingers, delaying the wrapper's child `close` event past our `exit`.
  const grandchild = spawn(
    process.execPath,
    ["-e", `setTimeout(() => {}, ${holdStdoutMs})`],
    // Neutral cwd (system temp root) so the grandchild never holds the test's
    // project dir busy during cleanup.
    { stdio: ["ignore", 1, "ignore"], detached: true, cwd: require("node:os").tmpdir() },
  );
  grandchild.unref();
}

process.exit(exitCode);
