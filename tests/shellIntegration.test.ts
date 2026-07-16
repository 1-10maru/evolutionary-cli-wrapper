import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import {
  buildNestingGuardLines,
  createProxyShims,
  followShimToExe,
  getShellStatus,
  isUsableCommandCandidate,
  resolveOriginalCommand,
  setupShellIntegration,
  undoShellIntegration,
} from "../src/shellIntegration";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EVO_TEST_MODE;
  delete process.env.EVO_TEST_WHERE_STDOUT;
  delete process.env.EVO_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeClaudeCmdShim(rootDir: string, fileName: string, target: string): string {
  const shimPath = path.join(rootDir, fileName);
  writeFile(
    shimPath,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      `\"%dp0%\\${target.replace(/\//g, "\\")}\" %*`,
      "",
    ].join("\r\n"),
  );
  return shimPath;
}

function writeClaudeShShim(rootDir: string, target: string): string {
  const shimPath = path.join(rootDir, "claude");
  writeFile(
    shimPath,
    [
      "#!/bin/sh",
      "basedir=$(dirname \"$0\")",
      `exec \"$basedir/${target.replace(/\\/g, "/")}\" \"$@\"`,
      "",
    ].join("\n"),
  );
  return shimPath;
}

describe("shell integration", () => {
  it("creates shims and a managed PowerShell profile block", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-"));
    tempDirs.push(cwd);
    const profilePath = path.join(cwd, "PowerShell", "profile.ps1");
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        profilePath,
      },
    });

    const result = setupShellIntegration(cwd);
    const status = getShellStatus(cwd);

    expect(fs.existsSync(path.join(cwd, "bin", "claude.cmd"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "bin", "evo-cmd-autorun.cmd"))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "bin", "claude.cmd"), "utf8")).toContain("title claude [Evo ON]");
    expect(fs.readFileSync(profilePath, "utf8")).toContain("evo shell integration");
    expect(fs.readFileSync(profilePath, "utf8")).not.toContain("zellij");
    expect(fs.readFileSync(path.join(cwd, "bin", "evo-cmd-autorun.cmd"), "utf8")).not.toContain("zellij");
    expect(result.profilePath).toBe(profilePath);
    expect(status.enabled).toBe(true);
  });

  it("removes the managed PowerShell profile block", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-undo-"));
    tempDirs.push(cwd);
    const profilePath = path.join(cwd, "PowerShell", "profile.ps1");
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        profilePath,
      },
    });
    setupShellIntegration(cwd);

    const result = undoShellIntegration(cwd);
    const contents = fs.readFileSync(profilePath, "utf8");

    expect(result.profilePath).toBe(profilePath);
    expect(contents).not.toContain("evo shell integration");
  });

  it("self-heals a legacy claude.evo-original.cmd mapping to the live sibling shim", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-resolve-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;
    process.env.EVO_TEST_WHERE_STDOUT = "";

    const npmDir = path.join(cwd, "npm");
    const legacyShim = writeClaudeCmdShim(npmDir, "claude.evo-original.cmd", "node_modules\\@anthropic-ai\\claude-code\\cli.js");
    writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    const exePath = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    writeFile(exePath, "binary");

    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          claude: legacyShim,
        },
      },
    });

    const resolved = resolveOriginalCommand(cwd, "claude");
    const updatedConfig = ensureEvoConfig(cwd);

    // Self-heals off the legacy backup to the live claude.cmd sibling, which is
    // then followed through to the real .exe it targets (FIX A).
    expect(resolved).toBe(exePath);
    expect(updatedConfig.shellIntegration.originalCommandMap.claude).toBe(exePath);
  });

  it("prefers the Windows-native claude.cmd over the extensionless shim from PATH", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-path-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;

    const npmDir = path.join(cwd, "npm");
    // Point the two shims at DIFFERENT exes so the resolved path reveals which
    // shim won the ranking — each is now followed through to its own .exe.
    const shShim = writeClaudeShShim(npmDir, "node_modules/@anthropic-ai/claude-code/bin/claude-posix.exe");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    const cmdExe = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    writeFile(cmdExe, "binary");
    writeFile(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude-posix.exe"), "binary");
    process.env.EVO_TEST_WHERE_STDOUT = `${shShim}\r\n${cmdShim}\r\n`;

    const resolved = resolveOriginalCommand(cwd, "claude");

    // The .cmd outranks the extensionless sh shim, and is followed to its exe.
    expect(resolved).toBe(cmdExe);
    expect(ensureEvoConfig(cwd).shellIntegration.originalCommandMap.claude).toBe(cmdExe);
  });

  it("rejects broken shims whose packaged target no longer exists", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-broken-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;
    process.env.EVO_TEST_WHERE_STDOUT = "";

    const npmDir = path.join(cwd, "npm");
    const legacyShim = writeClaudeCmdShim(npmDir, "claude.evo-original.cmd", "node_modules\\@anthropic-ai\\claude-code\\cli.js");
    writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");

    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          claude: legacyShim,
        },
      },
    });

    expect(resolveOriginalCommand(cwd, "claude")).toBeNull();
    expect(ensureEvoConfig(cwd).shellIntegration.originalCommandMap.claude).toBe(legacyShim);
  });
});

// ---------------------------------------------------------------------------
// buildNestingGuardLines — EVO_PROXY_ACTIVE=1 shim guard (defense-in-depth)
// ---------------------------------------------------------------------------
describe("buildNestingGuardLines", () => {
  it("cmd guard propagates the real nested exit code (no parse-time masking)", () => {
    const lines = buildNestingGuardLines("cmd", "C:\\npm\\claude.cmd");
    // Must NOT wrap `exit /b %ERRORLEVEL%` in a `( ... )` block — cmd.exe would
    // expand %ERRORLEVEL% at parse time (before the call), always yielding 0
    // and swallowing the nested claude's non-zero exit code.
    expect(lines.some((l) => l.includes("("))).toBe(false);
    expect(lines.some((l) => l.trim() === ")")).toBe(false);
    // The exit must be a standalone `if` line so %ERRORLEVEL% is expanded only
    // after the call line has executed.
    expect(lines).toContain('if "%EVO_PROXY_ACTIVE%"=="1" call "C:\\npm\\claude.cmd" %*');
    expect(lines).toContain('if "%EVO_PROXY_ACTIVE%"=="1" exit /b %ERRORLEVEL%');
  });

  it("ps1 guard forwards args and propagates $LASTEXITCODE", () => {
    const lines = buildNestingGuardLines("ps1", "C:\\npm\\claude.cmd");
    expect(lines.join("\n")).toContain("$env:EVO_PROXY_ACTIVE -eq '1'");
    expect(lines).toContain("  & 'C:\\npm\\claude.cmd' @args");
    expect(lines).toContain("  exit $LASTEXITCODE");
  });

  it("sh guard execs the resolved original", () => {
    const lines = buildNestingGuardLines("sh", "/usr/local/bin/claude");
    expect(lines.join("\n")).toContain('[ "$EVO_PROXY_ACTIVE" = "1" ]');
    expect(lines).toContain('  exec "/usr/local/bin/claude" "$@"');
  });

  it("emits nothing when the original is missing or unsafe to interpolate", () => {
    expect(buildNestingGuardLines("cmd", null)).toEqual([]);
    // Contains cmd metacharacters (& and |) rejected by SHIM_PATH_FORBIDDEN.
    expect(buildNestingGuardLines("cmd", "C:\\bad & path|x\\claude.cmd")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createProxyShims — shim writer path injection guard (PowerShell + cmd.exe)
// ---------------------------------------------------------------------------
describe("createProxyShims path injection guard", () => {
  // PowerShell-context dangerous chars
  it("throws when the cwd contains a semicolon (PowerShell statement terminator)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test;injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a single-quote (PowerShell quote terminator)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test'injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a backtick (PowerShell escape)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test`injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a dollar sign (PowerShell variable expansion)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test$injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  // cmd.exe-context dangerous chars
  it("throws when the cwd contains a double-quote (cmd.exe set quote terminator)", () => {
    const badPath = path.join(os.tmpdir(), 'evo-test"injection');
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a percent sign (cmd.exe variable expansion)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test%PATH%injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains an ampersand (cmd.exe command separator)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test&injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a pipe (cmd.exe pipe)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test|injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a less-than (cmd.exe input redirect)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test<injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a greater-than (cmd.exe output redirect)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test>injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("throws when the cwd contains a caret (cmd.exe escape)", () => {
    const badPath = path.join(os.tmpdir(), "evo-test^injection");
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  // Cross-context
  it("throws when the cwd contains a newline", () => {
    const badPath = `${os.tmpdir()}/evo-test\ninjection`;
    expect(() => createProxyShims(badPath)).toThrow("shell metacharacters");
  });

  it("does NOT throw for a normal project path (spaces allowed)", () => {
    // We use a non-existent path so mkdirSync inside createProxyShims would
    // fail — but the guard must throw BEFORE fs operations. We rely on the
    // error message content to distinguish a guard rejection from an fs error.
    const normalPath = path.join(os.tmpdir(), "evo-normal project path");
    try {
      createProxyShims(normalPath);
      // If it didn't throw at all (i.e., the directory happened to get created),
      // clean up and let the test pass.
      fs.rmSync(normalPath, { recursive: true, force: true });
    } catch (err: unknown) {
      // The guard should NOT have fired; any other error (e.g., ENOENT from fs)
      // is acceptable since we didn't actually create the directory.
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("shell metacharacters");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOriginalCommand — follow an npm interpreter shim through to the .exe
// (FIX A). Cross-platform: EVO_TEST_MODE fixtures, no real `where` probe.
// ---------------------------------------------------------------------------
function writeClaudePs1Shim(rootDir: string, target: string): string {
  const shimPath = path.join(rootDir, "claude.ps1");
  writeFile(
    shimPath,
    [
      "#!/usr/bin/env pwsh",
      `if ($MyInvocation.ExpectingInput) { $input | & \"$PSScriptRoot\\${target.replace(/\//g, "\\")}\" $args }`,
      `else { & \"$PSScriptRoot\\${target.replace(/\//g, "\\")}\" $args }`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
  );
  return shimPath;
}

describe("resolveOriginalCommand — interpreter-shim follow-through (FIX A)", () => {
  function setup(prefix: string): string {
    process.env.EVO_TEST_MODE = "1";
    process.env.EVO_TEST_WHERE_STDOUT = "";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;
    return cwd;
  }

  function mapClaudeTo(cwd: string, commandPath: string): void {
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: { ...config.shellIntegration.originalCommandMap, claude: commandPath },
      },
    });
  }

  const EXE_REL = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";

  it("follows a .cmd shim through to the real .exe it targets", () => {
    const cwd = setup("evo-shim-cmd-exe-");
    const npmDir = path.join(cwd, "npm");
    const exePath = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    writeFile(exePath, "MZ fake binary");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", EXE_REL);
    mapClaudeTo(cwd, cmdShim);

    expect(resolveOriginalCommand(cwd, "claude")).toBe(exePath);
  });

  it("follows a .ps1 shim through to the real .exe it targets", () => {
    const cwd = setup("evo-shim-ps1-exe-");
    const npmDir = path.join(cwd, "npm");
    const exePath = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    writeFile(exePath, "MZ fake binary");
    const ps1Shim = writeClaudePs1Shim(npmDir, EXE_REL);
    mapClaudeTo(cwd, ps1Shim);

    expect(resolveOriginalCommand(cwd, "claude")).toBe(exePath);
  });

  it("does NOT redirect a shim that targets a .js launcher (leaves node shims alone)", () => {
    const cwd = setup("evo-shim-cmd-js-");
    const npmDir = path.join(cwd, "npm");
    const jsTarget = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    writeFile(jsTarget, "console.log('hi')");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js");
    mapClaudeTo(cwd, cmdShim);

    // .js targets must be left alone — resolution stays on the shim.
    expect(resolveOriginalCommand(cwd, "claude")).toBe(cmdShim);
  });
});

// ---------------------------------------------------------------------------
// Interpreter denylist + positive constraint (regression for the stale-cache
// -> node.exe poisoning). Fixture: an npm dir with live native-style
// claude.cmd/.ps1 that target node_modules/.../bin/claude.exe (present), plus
// the three stale cli.js-era backups (cli.js ABSENT).
// ---------------------------------------------------------------------------
const CLAUDE_EXE_REL = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const CLI_JS_REL_WIN = "node_modules\\@anthropic-ai\\claude-code\\cli.js";

function writeStaleBackupCmd(rootDir: string, fileName: string): string {
  const p = path.join(rootDir, fileName);
  writeFile(
    p,
    [
      "@ECHO off",
      "SETLOCAL",
      "SET dp0=%~dp0",
      `IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )`,
      `"%_prog%"  "%dp0%\\${CLI_JS_REL_WIN}" %*`,
      "",
    ].join("\r\n"),
  );
  return p;
}

function writeStaleBackupPs1(rootDir: string, fileName: string): string {
  const p = path.join(rootDir, fileName);
  writeFile(
    p,
    [
      "#!/usr/bin/env pwsh",
      `& "$PSScriptRoot\\${CLI_JS_REL_WIN}" $args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
  );
  return p;
}

function writeStaleBackupSh(rootDir: string, fileName: string): string {
  const p = path.join(rootDir, fileName);
  writeFile(
    p,
    [
      "#!/bin/sh",
      'basedir=$(dirname "$0")',
      'if [ -x "$basedir/node" ]; then',
      '  exec "$basedir/node"  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
      "else",
      '  exec node  "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"',
      "fi",
      "",
    ].join("\n"),
  );
  return p;
}

describe("resolveOriginalCommand — interpreter denylist + positive constraint", () => {
  function setup(prefix: string): string {
    process.env.EVO_TEST_MODE = "1";
    process.env.EVO_TEST_WHERE_STDOUT = "";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;
    return cwd;
  }

  function mapClaudeTo(cwd: string, commandPath: string): void {
    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: { ...config.shellIntegration.originalCommandMap, claude: commandPath },
      },
    });
  }

  // Build the fixture npm dir; returns the live shims + the present bin/claude.exe.
  function buildFixture(cwd: string, opts: { exePresent?: boolean } = {}) {
    const npmDir = path.join(cwd, "npm");
    const exePath = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (opts.exePresent !== false) writeFile(exePath, "MZ fake binary");
    const liveCmd = writeClaudeCmdShim(npmDir, "claude.cmd", CLAUDE_EXE_REL);
    const livePs1 = writeClaudePs1Shim(npmDir, CLAUDE_EXE_REL);
    const backupCmd = writeStaleBackupCmd(npmDir, "claude.evo-original.cmd");
    const backupPs1 = writeStaleBackupPs1(npmDir, "claude.evo-original.ps1");
    const backupSh = writeStaleBackupSh(npmDir, "claude.evo-original");
    return { npmDir, exePath, liveCmd, livePs1, backupCmd, backupPs1, backupSh };
  }

  it("(a) rejects a poisoned node.exe cache and resolves the live shim's real .exe, never node.exe", () => {
    const cwd = setup("evo-deny-cache-node-");
    const fx = buildFixture(cwd);
    // Cached node.exe lives in a SEPARATE dir (like C:\Program Files\nodejs), so
    // it is not a sibling of the live shims — reproducing the real bug where the
    // cached interpreter (candidate order pos 2) beat the discovered shim (pos 3).
    const nodejsDir = path.join(cwd, "nodejs");
    const stalenode = path.join(nodejsDir, "node.exe");
    writeFile(stalenode, "MZ node");
    mapClaudeTo(cwd, stalenode);
    process.env.EVO_TEST_WHERE_STDOUT = `${fx.liveCmd}\r\n${fx.livePs1}\r\n`;

    const resolved = resolveOriginalCommand(cwd, "claude");
    expect(resolved).toBe(fx.exePath);
    expect(resolved).not.toBe(stalenode);
  });

  it("(b) resolves to the real .exe from an empty cache with backups present", () => {
    const cwd = setup("evo-deny-empty-");
    const fx = buildFixture(cwd);
    process.env.EVO_TEST_WHERE_STDOUT = `${fx.liveCmd}\r\n${fx.livePs1}\r\n`;
    expect(resolveOriginalCommand(cwd, "claude")).toBe(fx.exePath);
  });

  it("(c) never selects a stale backup even when it is the cached value", () => {
    const cwd = setup("evo-deny-backup-cache-");
    const fx = buildFixture(cwd);
    mapClaudeTo(cwd, fx.backupCmd);
    // No discovery — resolution self-heals off the backup to its live sibling.
    expect(resolveOriginalCommand(cwd, "claude")).toBe(fx.exePath);
  });

  it("(d) does not select a live shim whose node_modules target is missing", () => {
    const cwd = setup("evo-deny-missing-target-");
    const fx = buildFixture(cwd, { exePresent: false });
    process.env.EVO_TEST_WHERE_STDOUT = `${fx.liveCmd}\r\n${fx.livePs1}\r\n`;
    // bin/claude.exe absent → shims not usable → nothing acceptable resolves.
    expect(resolveOriginalCommand(cwd, "claude")).toBeNull();
  });

  it("(e) followShimToExe never returns a path outside <shimdir>/node_modules", () => {
    const cwd = setup("evo-deny-containment-");
    const npmDir = path.join(cwd, "npm");
    // A shim whose extracted target escapes node_modules via `..`.
    const escaping = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules/../../evil.exe");
    // Create the escaped target so only the containment guard can reject it.
    writeFile(path.join(cwd, "evil.exe"), "MZ evil");
    expect(followShimToExe(escaping)).toBe(escaping);

    // A contained shim IS followed.
    const exePath = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    writeFile(exePath, "MZ fake");
    const contained = writeClaudeCmdShim(npmDir, "claude-good.cmd", CLAUDE_EXE_REL);
    expect(followShimToExe(contained)).toBe(exePath);
  });

  it("(f) isUsableCommandCandidate rejects a bare node.exe", () => {
    const cwd = setup("evo-deny-usable-node-");
    const nodeExe = path.join(cwd, "node.exe");
    writeFile(nodeExe, "MZ node");
    expect(isUsableCommandCandidate(nodeExe)).toBe(false);
  });
});
