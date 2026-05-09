import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import {
  createProxyShims,
  getShellStatus,
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
