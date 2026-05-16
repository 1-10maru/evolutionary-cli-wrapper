import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import {
  createProxyShims,
  getShellStatus,
  isCommandCandidateNameValid,
  resolveOriginalCommand,
  setupShellIntegration,
  undoShellIntegration,
} from "../src/shellIntegration";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EVO_TEST_MODE;
  delete process.env.EVO_TEST_WHERE_STDOUT;
  delete process.env.EVO_TEST_ALLOW_INTERPRETER;
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
    const liveShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    writeFile(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "binary");

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

    expect(resolved).toBe(liveShim);
    expect(updatedConfig.shellIntegration.originalCommandMap.claude).toBe(liveShim);
  });

  it("prefers the Windows-native claude.cmd over the extensionless shim from PATH", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-path-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;

    const npmDir = path.join(cwd, "npm");
    const shShim = writeClaudeShShim(npmDir, "node_modules/@anthropic-ai/claude-code/bin/claude.exe");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    writeFile(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "binary");
    process.env.EVO_TEST_WHERE_STDOUT = `${shShim}\r\n${cmdShim}\r\n`;

    const resolved = resolveOriginalCommand(cwd, "claude");

    expect(resolved).toBe(cmdShim);
    expect(ensureEvoConfig(cwd).shellIntegration.originalCommandMap.claude).toBe(cmdShim);
  });

  it("rejects an interpreter binary returned by `where` for cli=claude (e.g. node.exe)", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-where-poison-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;

    const npmDir = path.join(cwd, "npm");
    const nodeDir = path.join(cwd, "nodejs");
    // Simulate a poisoned `where claude` result whose first hit is node.exe
    // (basename does NOT match cli=claude). The legitimate claude.cmd
    // appears second.
    const fakeNodeExe = path.join(nodeDir, "node.exe");
    writeFile(fakeNodeExe, "binary");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    writeFile(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "binary");
    process.env.EVO_TEST_WHERE_STDOUT = `${fakeNodeExe}\r\n${cmdShim}\r\n`;

    const resolved = resolveOriginalCommand(cwd, "claude");

    expect(resolved).toBe(cmdShim);
    expect(resolved).not.toBe(fakeNodeExe);
    expect(ensureEvoConfig(cwd).shellIntegration.originalCommandMap.claude).toBe(cmdShim);
  });

  it("self-heals a poisoned originalCommandMap.claude entry pointing to node.exe", () => {
    process.env.EVO_TEST_MODE = "1";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-shell-config-poison-"));
    tempDirs.push(cwd);
    process.env.EVO_HOME = cwd;

    const npmDir = path.join(cwd, "npm");
    const nodeDir = path.join(cwd, "nodejs");
    const fakeNodeExe = path.join(nodeDir, "node.exe");
    writeFile(fakeNodeExe, "binary");
    const cmdShim = writeClaudeCmdShim(npmDir, "claude.cmd", "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");
    writeFile(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "binary");
    // `where` only returns the legitimate shim. The poison comes from
    // pre-existing config state, mirroring the production bug where
    // `originalCommandMap.claude = "C:\\Program Files\\nodejs\\node.exe"`.
    process.env.EVO_TEST_WHERE_STDOUT = `${cmdShim}\r\n`;

    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          claude: fakeNodeExe,
        },
      },
    });

    const resolved = resolveOriginalCommand(cwd, "claude");
    const updatedConfig = ensureEvoConfig(cwd);

    expect(resolved).toBe(cmdShim);
    expect(updatedConfig.shellIntegration.originalCommandMap.claude).toBe(cmdShim);
    expect(updatedConfig.shellIntegration.originalCommandMap.claude).not.toBe(fakeNodeExe);
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
// isCommandCandidateNameValid — basename-vs-cli validation
// ---------------------------------------------------------------------------
describe("isCommandCandidateNameValid", () => {
  it("accepts the canonical Windows-native shim forms for cli=claude", () => {
    expect(isCommandCandidateNameValid("C:/npm/claude.cmd", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/claude.exe", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/claude.bat", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/claude.ps1", "claude")).toBe(true);
  });

  it("accepts the extensionless POSIX shim and .sh / .bash forms", () => {
    expect(isCommandCandidateNameValid("/usr/local/bin/claude", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("/usr/local/bin/claude.sh", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("/usr/local/bin/claude.bash", "claude")).toBe(true);
  });

  it("accepts the legacy `.evo-original` backup forms", () => {
    expect(isCommandCandidateNameValid("C:/npm/claude.evo-original", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/claude.evo-original.cmd", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/claude.evo-original.ps1", "claude")).toBe(true);
  });

  it("is case-insensitive on the cli stem (Windows)", () => {
    expect(isCommandCandidateNameValid("C:/npm/Claude.CMD", "claude")).toBe(true);
    expect(isCommandCandidateNameValid("C:/npm/CLAUDE.exe", "claude")).toBe(true);
  });

  it("REJECTS interpreter binaries that share neither stem nor extension", () => {
    expect(isCommandCandidateNameValid("C:/Program Files/nodejs/node.exe", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("/usr/bin/node", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("C:/Python311/python.exe", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("/usr/bin/python", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("C:/Program Files/PowerShell/7/pwsh.exe", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("/bin/bash", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("/bin/sh", "claude")).toBe(false);
  });

  it("REJECTS unknown extensions even if the stem matches", () => {
    // We only allow the explicit shim extension allowlist — a `.dll` or
    // `.py` named `claude.*` is suspicious and should not be selected.
    expect(isCommandCandidateNameValid("C:/lib/claude.dll", "claude")).toBe(false);
    expect(isCommandCandidateNameValid("/lib/claude.py", "claude")).toBe(false);
  });

  it("REJECTS empty / falsy inputs defensively", () => {
    expect(isCommandCandidateNameValid("", "claude")).toBe(false);
  });
});
