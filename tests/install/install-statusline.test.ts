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

describe("install-statusline — wrapper construction guard (A2)", () => {
  it("detects an existing wrapper construction and does NOT overwrite it", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    // Simulate a hand-built wrapper setup: a token-only base + a wrapper command.
    const base = path.join(claudeDir, "base_statusline.py");
    fs.writeFileSync(base, "# token-only base placeholder\n");
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          statusLine: { type: "command", command: "bash ~/.claude/scripts/statusline-wrapper.sh" },
          keepThis: "yes",
        },
        null,
        2,
      ),
    );
    const baseBefore = fs.readFileSync(base, "utf8");
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");
    const messages: string[] = [];

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: (m) => messages.push(m),
    });

    expect(result.noop).toBe(true);
    expect(result.settingsUpdated).toBe(false);
    // The token-only base and the wrapper wiring are left byte-for-byte intact.
    expect(fs.readFileSync(base, "utf8")).toBe(baseBefore);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    expect(messages.join("\n")).toMatch(/wrapper/i);
  });

  it("also detects an `evo statusline` wrapper command", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(
        { statusLine: { type: "command", command: "python base.py | evo statusline" } },
        null,
        2,
      ),
    );
    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });
    expect(result.noop).toBe(true);
    expect(result.settingsUpdated).toBe(false);
    // No base_statusline.py was deployed (the guard skipped before the copy).
    expect(fs.existsSync(path.join(claudeDir, "base_statusline.py"))).toBe(false);
  });

  it("proceeds normally when the existing command is NOT a wrapper", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    // A plain single-file command (not a wrapper) — the installer should deploy.
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(
        { statusLine: { type: "command", command: 'python "~/.claude/base_statusline.py"' } },
        null,
        2,
      ),
    );

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    expect(result.noop).toBeUndefined();
    expect(result.settingsUpdated).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, "base_statusline.py"))).toBe(true);
  });
});

describe("install-statusline — non-standard wrapper NAME detection (#34)", () => {
  it("detects a wrapper whose script has a non-standard name (`evo statusline` inside)", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    // Hand-built wrapper with an arbitrary name: the command string mentions
    // neither `statusline-wrapper` nor `evo statusline` — only the script body does.
    const script = path.join(claudeDir, "my-status.sh");
    fs.writeFileSync(script, '#!/usr/bin/env bash\ncat - | tee /tmp/in | evo statusline\n');
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: "bash ~/.claude/my-status.sh" } }, null, 2),
    );
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");
    const messages: string[] = [];

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: (m) => messages.push(m),
    });

    expect(result.noop).toBe(true);
    expect(result.settingsUpdated).toBe(false);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    // The guard fired before the deploy — no renderer was copied over the setup.
    expect(fs.existsSync(path.join(claudeDir, "base_statusline.py"))).toBe(false);
    expect(messages.join("\n")).toMatch(/wrapper/i);
  });

  it("detects a non-standard wrapper that references the token-only base", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const base = path.join(claudeDir, "base_statusline.py");
    fs.writeFileSync(base, "# token-only base placeholder\n");
    const script = path.join(claudeDir, "join-lines.cmd");
    fs.writeFileSync(script, '@echo off\r\npython "%USERPROFILE%\\.claude\\base_statusline.py"\r\n');
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: `cmd /c "${script.replace(/\\/g, "/")}"` } }, null, 2),
    );
    const baseBefore = fs.readFileSync(base, "utf8");

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    expect(result.noop).toBe(true);
    expect(result.settingsUpdated).toBe(false);
    // Token-only base left byte-for-byte intact (not clobbered by the full renderer).
    expect(fs.readFileSync(base, "utf8")).toBe(baseBefore);
  });

  it("still proceeds when the referenced script is unrelated to the wrapper wiring", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const script = path.join(claudeDir, "some-other-tool.sh");
    fs.writeFileSync(script, "#!/usr/bin/env bash\necho unrelated-statusline\n");
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "bash ~/.claude/some-other-tool.sh" } }, null, 2),
    );

    const result = await runInstallStatusline({
      yes: true,
      packageRoot: REPO_ROOT,
      homeDir: home,
      log: () => {},
    });

    expect(result.noop).toBeUndefined();
    expect(result.settingsUpdated).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, "base_statusline.py"))).toBe(true);
  });
});
