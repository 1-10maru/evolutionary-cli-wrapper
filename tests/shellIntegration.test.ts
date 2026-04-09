import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import {
  getShellStatus,
  setupShellIntegration,
  undoShellIntegration,
} from "../src/shellIntegration";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shell integration", () => {
  it("creates shims and a managed PowerShell profile block", () => {
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

    expect(fs.existsSync(path.join(cwd, "bin", "codex.cmd"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "bin", "claude.cmd"))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "bin", "claude.cmd"), "utf8")).toContain("title claude [Evo ON]");
    expect(fs.readFileSync(profilePath, "utf8")).toContain("evo shell integration");
    expect(result.profilePath).toBe(profilePath);
    expect(status.enabled).toBe(true);
  });

  it("removes the managed PowerShell profile block", () => {
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
});
