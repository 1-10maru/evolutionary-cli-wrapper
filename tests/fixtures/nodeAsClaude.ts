import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests that exercise the proxy runtime map `originalCommandMap.claude` to a
// program that behaves like the real CLI. They used to map it directly to
// `process.execPath` (node.exe), but resolveOriginalCommand now REJECTS a bare
// interpreter basename (`node`, `pwsh`, ...) as a claude mapping — that stale-
// cache poisoning is exactly the bug under test. So instead we hand them a
// launcher NAMED `claude(.exe)` that IS the Node binary: a hardlink (or
// symlink/copy fallback), which satisfies the interpreter denylist + name
// constraint while behaving identically to the old direct-node mapping (a plain
// shell:false spawn of Node). One copy is shared per test module.

let shared: string | null = null;

export function nodeAsClaude(): string {
  if (shared && fs.existsSync(shared)) return shared;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-claude-launcher-"));
  const dest = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  try {
    fs.linkSync(process.execPath, dest);
  } catch {
    try {
      fs.symlinkSync(process.execPath, dest);
    } catch {
      fs.copyFileSync(process.execPath, dest);
    }
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      /* ignore */
    }
  }
  shared = dest;
  return dest;
}

export function disposeNodeAsClaude(): void {
  if (shared) {
    try {
      fs.rmSync(path.dirname(shared), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    shared = null;
  }
}
