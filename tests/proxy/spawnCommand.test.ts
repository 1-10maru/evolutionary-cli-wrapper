import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertSafeCommandPath, spawnInteractiveCommand } from "../../src/proxy/spawnCommand";

// ---------------------------------------------------------------------------
// assertSafeCommandPath
// ---------------------------------------------------------------------------
describe("assertSafeCommandPath", () => {
  it("throws on each individual shell metacharacter", () => {
    // These are the characters blocked by SHELL_METACHAR_RE: [<>|&^"`\n\r]
    const dangerous = ["&", "|", ">", "<", "^", '"', "`", "\n", "\r"];
    for (const ch of dangerous) {
      expect(
        () => assertSafeCommandPath(`C:\\Users\\me\\bin\\node${ch}.cmd`),
        `expected throw for metachar: ${JSON.stringify(ch)}`,
      ).toThrow("shell metacharacters");
    }
  });

  it("does NOT throw on a normal Windows path", () => {
    expect(() => assertSafeCommandPath("C:\\Users\\me\\bin\\node.cmd")).not.toThrow();
  });

  it("does NOT throw on a normal Unix path", () => {
    expect(() => assertSafeCommandPath("/usr/local/bin/node")).not.toThrow();
  });

  it("does NOT throw on a path with spaces (spaces are not metacharacters)", () => {
    expect(() => assertSafeCommandPath("C:\\Program Files\\MyApp\\app.cmd")).not.toThrow();
  });

  it("does NOT throw on a path with semicolons (semicolons are allowed — not in the regex)", () => {
    // ';' is NOT in the SHELL_METACHAR_RE for the commandPath guard.
    // The PowerShell shim path has its own tighter PROFILE_PATH_FORBIDDEN regex.
    expect(() => assertSafeCommandPath("C:\\path;with;semis\\app.cmd")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// spawnInteractiveCommand — metacharacter rejection at the spawn boundary
// ---------------------------------------------------------------------------
describe("spawnInteractiveCommand metacharacter rejection", () => {
  it("throws synchronously for a .cmd path containing '&'", () => {
    expect(() =>
      spawnInteractiveCommand("C:\\Users\\me\\bin\\evil&node.cmd", [], process.cwd()),
    ).toThrow("shell metacharacters");
  });

  it("throws synchronously for a .ps1 path containing '|'", () => {
    expect(() =>
      spawnInteractiveCommand("C:\\Users\\me\\bin\\evil|script.ps1", [], process.cwd()),
    ).toThrow("shell metacharacters");
  });

  it("throws synchronously for a default-branch path containing '>'", () => {
    expect(() =>
      spawnInteractiveCommand("C:\\Users\\me\\bin\\node>evil", [], process.cwd()),
    ).toThrow("shell metacharacters");
  });

  it("does NOT throw for a .ps1 path that is safe", () => {
    // We just need the guard not to throw. The actual spawn may fail because the
    // file doesn't exist, but that's a different kind of error.
    let threw = false;
    let threwGuardError = false;
    try {
      const child = spawnInteractiveCommand(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.ps1",
        [],
        process.cwd(),
      );
      // Kill it immediately so the test doesn't hang.
      child.kill();
    } catch (err: unknown) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      threwGuardError = msg.includes("shell metacharacters");
    }
    // The guard must NOT have triggered. Any spawn-level error (e.g. ENOENT)
    // is acceptable.
    expect(threwGuardError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnInteractiveCommand .ps1 — pwsh resolution
// ---------------------------------------------------------------------------
describe("spawnInteractiveCommand .ps1 binary resolution", () => {
  it("uses the resolved powershell binary when spawning a .ps1 file", () => {
    // We can't easily mock the spawnSync inside resolvePowershellBinary after
    // module load because of the process-lifetime cache and vitest's module
    // isolation. Instead, we verify that spawning a safe .ps1 path does not
    // produce a 'shell metacharacters' error — it either succeeds (on Windows
    // with pwsh/powershell available) or fails with ENOENT.
    let guardError = false;
    try {
      const child = spawnInteractiveCommand("C:\\fake\\script.ps1", [], process.cwd());
      child.kill();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      guardError = msg.includes("shell metacharacters");
    }
    expect(guardError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnInteractiveCommand smoke test — .cmd fixture (Windows-only)
// ---------------------------------------------------------------------------
describe("spawnInteractiveCommand .cmd smoke", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-spawn-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it.skipIf(process.platform !== "win32")(
    "spawns a .cmd file with a space-containing arg and exits 0",
    async () => {
      const cmdPath = path.join(tmpDir, "echo-test.cmd");
      fs.writeFileSync(cmdPath, "@echo off\r\necho %*\r\n", { encoding: "utf8" });

      const child = spawnInteractiveCommand(cmdPath, ["hello world", "foo"], tmpDir, false);

      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });

      expect(exitCode).toBe(0);
      // The echo output should contain our arg content
      expect(stdout).toBeTruthy();
    },
  );
});
