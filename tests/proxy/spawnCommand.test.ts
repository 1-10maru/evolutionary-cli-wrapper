import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// We mock node:child_process at the top so the module under test sees the mocked
// spawnSync when it is loaded. We keep the real `spawn` (used by spawnInteractiveCommand
// itself in the .cmd smoke test) by importActual and selectively replace spawnSync.
const mockState = vi.hoisted(() => ({
  spawnSyncImpl: null as null | ((...args: unknown[]) => unknown),
  spawnSyncCallCount: 0,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]): unknown => {
      mockState.spawnSyncCallCount += 1;
      if (mockState.spawnSyncImpl) {
        return mockState.spawnSyncImpl(...args);
      }
      // Fall through to the real spawnSync if no mock is registered
      // (so other tests that rely on real spawnSync still work).
      return (actual.spawnSync as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// Imported AFTER vi.mock so the import sees the mocked module.
import {
  _resetPsBinaryCacheForTesting,
  assertSafeCommandPath,
  quoteArgForCmd,
  resolvePowershellBinary,
  spawnInteractiveCommand,
} from "../../src/proxy/spawnCommand";

function setSpawnSyncMock(impl: (...args: unknown[]) => unknown): void {
  mockState.spawnSyncImpl = impl;
  mockState.spawnSyncCallCount = 0;
}

function clearSpawnSyncMock(): void {
  mockState.spawnSyncImpl = null;
  mockState.spawnSyncCallCount = 0;
}

// ---------------------------------------------------------------------------
// assertSafeCommandPath
// ---------------------------------------------------------------------------
describe("assertSafeCommandPath", () => {
  it("throws on each individual shell metacharacter", () => {
    // Characters blocked by SHELL_METACHAR_RE: [<>|&^"`\n\r%\t\0]
    const dangerous = ["&", "|", ">", "<", "^", '"', "`", "\n", "\r", "%", "\t", "\0"];
    for (const ch of dangerous) {
      expect(
        () => assertSafeCommandPath(`C:\\Users\\me\\bin\\node${ch}.cmd`),
        `expected throw for metachar: ${JSON.stringify(ch)}`,
      ).toThrow("shell metacharacters");
    }
  });

  it("throws on a path embedding %PATH% (cmd.exe variable expansion)", () => {
    expect(() => assertSafeCommandPath("C:\\tools\\%PATH%\\app.cmd")).toThrow("shell metacharacters");
  });

  it("throws on a path embedding a tab character", () => {
    expect(() => assertSafeCommandPath("foo\tbar.cmd")).toThrow("shell metacharacters");
  });

  it("throws on a path embedding a NUL byte", () => {
    expect(() => assertSafeCommandPath("foo\0bar.cmd")).toThrow("shell metacharacters");
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

  it("does NOT throw on a path with semicolons (semicolons are allowed in this regex)", () => {
    // ';' is NOT in the SHELL_METACHAR_RE for the commandPath guard.
    // The shellIntegration shim writer has its own tighter SHIM_PATH_FORBIDDEN regex.
    expect(() => assertSafeCommandPath("C:\\path;with;semis\\app.cmd")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// quoteArgForCmd
// ---------------------------------------------------------------------------
describe("quoteArgForCmd", () => {
  it("returns args without whitespace/specials unquoted", () => {
    expect(quoteArgForCmd("foo")).toBe("foo");
    expect(quoteArgForCmd("--flag=value")).toBe("--flag=value");
    expect(quoteArgForCmd("path/to/file")).toBe("path/to/file");
  });

  it("quotes args containing whitespace", () => {
    expect(quoteArgForCmd("hello world")).toBe('"hello world"');
    expect(quoteArgForCmd("a\tb")).toBe('"a\tb"');
  });

  it("quotes empty strings (so they reach the child as a real empty arg)", () => {
    expect(quoteArgForCmd("")).toBe('""');
  });

  it("quotes args with shell-special characters", () => {
    for (const ch of ['"', "&", "|", "<", ">", "^", "(", ")"]) {
      const arg = `pre${ch}post`;
      const out = quoteArgForCmd(arg);
      expect(out.startsWith('"')).toBe(true);
      expect(out.endsWith('"')).toBe(true);
    }
  });

  it("doubles embedded double-quotes per cmd.exe convention", () => {
    expect(quoteArgForCmd('say "hi"')).toBe('"say ""hi"""');
  });
});

// ---------------------------------------------------------------------------
// resolvePowershellBinary — proper mock-based unit tests via cache reset
// ---------------------------------------------------------------------------
describe("resolvePowershellBinary", () => {
  beforeEach(() => {
    _resetPsBinaryCacheForTesting();
    clearSpawnSyncMock();
  });

  afterEach(() => {
    _resetPsBinaryCacheForTesting();
    clearSpawnSyncMock();
  });

  it("returns 'pwsh' when the locate command exits with status 0 (pwsh found)", () => {
    setSpawnSyncMock(() => ({
      pid: 0,
      output: [],
      stdout: "/usr/bin/pwsh\n",
      stderr: "",
      status: 0,
      signal: null,
    }));
    expect(resolvePowershellBinary()).toBe("pwsh");
    expect(mockState.spawnSyncCallCount).toBeGreaterThanOrEqual(1);
  });

  it("falls back to 'powershell' when the locate command exits non-zero", () => {
    setSpawnSyncMock(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "not found",
      status: 1,
      signal: null,
    }));
    expect(resolvePowershellBinary()).toBe("powershell");
  });

  it("falls back to 'powershell' when the locate command throws", () => {
    setSpawnSyncMock(() => {
      throw new Error("ENOENT: where missing");
    });
    expect(resolvePowershellBinary()).toBe("powershell");
  });

  it("caches the result across multiple calls", () => {
    setSpawnSyncMock(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }));
    expect(resolvePowershellBinary()).toBe("pwsh");
    expect(resolvePowershellBinary()).toBe("pwsh");
    expect(resolvePowershellBinary()).toBe("pwsh");
    // Should have called spawnSync exactly once (cache hits the rest).
    expect(mockState.spawnSyncCallCount).toBe(1);
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

  it("throws synchronously for a .cmd path containing '%' (cmd.exe expansion)", () => {
    expect(() =>
      spawnInteractiveCommand("C:\\Users\\%USER%\\bin\\node.cmd", [], process.cwd()),
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
    let threwGuardError = false;
    try {
      const child = spawnInteractiveCommand(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.ps1",
        [],
        process.cwd(),
      );
      child.kill();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      threwGuardError = msg.includes("shell metacharacters");
    }
    expect(threwGuardError).toBe(false);
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
      expect(stdout).toBeTruthy();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "preserves arg integrity through cmd.exe — 'hello world' arrives as a single arg",
    async () => {
      // Write a .cmd that prints each individual arg on its own line via %~1 / %~2 / etc.
      // %~1 strips surrounding quotes, so we see the raw token cmd.exe parsed.
      const cmdPath = path.join(tmpDir, "args-test.cmd");
      fs.writeFileSync(
        cmdPath,
        "@echo off\r\necho arg1=[%~1]\r\necho arg2=[%~2]\r\necho arg3=[%~3]\r\n",
        { encoding: "utf8" },
      );

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
      // The CRITICAL assertion: arg1 must be the full "hello world", NOT just "hello".
      // The old shell-string form preserved this; we must keep that behaviour.
      expect(stdout).toContain("arg1=[hello world]");
      expect(stdout).toContain("arg2=[foo]");
      expect(stdout).toContain("arg3=[]");
    },
  );
});
