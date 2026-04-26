// Mock Claude CLI for integration tests.
// Emits a small burst of synthetic JSONL session entries that match the
// shape proxyRuntime.ts parses (`type: "user"` / `type: "assistant"` with
// `message.content` blocks). Also prints a token-usage line so the proxy's
// usage adapter has something to chew on, then exits with the requested
// code.
//
// CLI usage:
//   node mock-claude.js --out <jsonlPath> [--exit-code <n>] [--turns <n>]
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
process.exit(exitCode);
