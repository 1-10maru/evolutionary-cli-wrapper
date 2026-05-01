import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstallStatusline } from "../../src/cli/installStatusline";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-install-statusline-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("install-statusline", () => {
  it("deploys statusline.py and writes settings.json with --yes", async () => {
    const home = makeTempHome();
    const messages: string[] = [];

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: (msg) => messages.push(msg),
    });

    const deployed = path.join(home, ".claude", "base_statusline.py");
    const settings = path.join(home, ".claude", "settings.json");

    expect(fs.existsSync(deployed)).toBe(true);
    expect(fs.existsSync(settings)).toBe(true);

    const json = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(json.statusLine.type).toBe("command");
    expect(json.statusLine.command).toContain("base_statusline.py");
    expect(json.statusLine.command).toMatch(/^python /);

    expect(result.deployedTo).toBe(deployed);
    expect(result.settingsUpdated).toBe(true);
    // No prior settings.json existed, so no backup should be created.
    expect(result.settingsBackup).toBeUndefined();
  });

  it("creates a backup when settings.json already exists", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "ccusage" }, otherKey: 42 }),
    );

    const messages: string[] = [];
    // The existing statusLine is non-evopet, so without --yes we'd be prompted.
    // Use --yes to bypass and confirm overwrite path still backs up.
    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: (msg) => messages.push(msg),
    });

    expect(result.settingsBackup).toBeDefined();
    expect(fs.existsSync(result.settingsBackup!)).toBe(true);
    const backupRaw = fs.readFileSync(result.settingsBackup!, "utf8");
    expect(JSON.parse(backupRaw).statusLine.command).toBe("ccusage");

    // settings.json now points at evopet, but other keys preserved.
    const newJson = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(newJson.statusLine.command).toContain("base_statusline.py");
    expect(newJson.otherKey).toBe(42);
  });

  it("is idempotent: second run with same config writes nothing new", async () => {
    const home = makeTempHome();
    await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });
    const settings = path.join(home, ".claude", "settings.json");
    const beforeMtime = fs.statSync(settings).mtimeMs;

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    expect(result.settingsUpdated).toBe(false);
    // statusline.py is always re-copied (cheap), but settings.json should not be rewritten
    // because the desired command already matches.
    const afterMtime = fs.statSync(settings).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("aborts when the user declines the initial prompt", async () => {
    const home = makeTempHome();
    const result = await runInstallStatusline({
      packageRoot: REPO_ROOT,
      homeDir: home,
      prompt: async () => "n",
      log: () => {},
    });
    expect(result.noop).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "base_statusline.py"))).toBe(false);
  });

  it("refuses to overwrite a non-evopet statusLine without confirmation", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "ccusage" } }),
    );

    // Initial confirmation says yes, then overwrite confirmation says no.
    const answers = ["y", "n"];
    const result = await runInstallStatusline({
      packageRoot: REPO_ROOT,
      homeDir: home,
      prompt: async () => answers.shift() ?? "n",
      log: () => {},
    });

    expect(result.settingsUpdated).toBe(false);
    // statusline.py is still deployed (it's harmless), but settings.json untouched.
    expect(fs.existsSync(path.join(home, ".claude", "base_statusline.py"))).toBe(true);
    const json = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(json.statusLine.command).toBe("ccusage");
  });

  it("uninstall restores backup and removes deployed file", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: "command", command: "ccusage" } }),
    );

    await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    const result = await runInstallStatusline({
      uninstall: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    expect(result.uninstalled).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, "base_statusline.py"))).toBe(false);
    const json = JSON.parse(fs.readFileSync(settings, "utf8"));
    expect(json.statusLine.command).toBe("ccusage");
  });
});
