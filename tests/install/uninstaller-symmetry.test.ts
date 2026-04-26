import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// uninstaller-symmetry.test.ts
//
// Asserts evopet-uninstall.sh fully reverses evopet-install.sh:
//   - shim file removed
//   - .bash_profile shim source line removed
//   - settings.json keys NOT installed by Evopet are preserved (e.g. keepKey)
//   - statusLine removed if it matches the installed command
//   - statusLine preserved if user customised it after install
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(REPO_ROOT, "install", "evopet-install.sh");
const UNINSTALLER = path.join(REPO_ROOT, "install", "evopet-uninstall.sh");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-uninstall-"));
  tempDirs.push(dir);
  return dir;
}

function runScript(home: string, script: string): void {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  execFileSync("bash", [script], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("evopet-uninstall.sh", () => {
  it("removes ~/.claude/local/optional-projects.sh after install", () => {
    const home = makeTempHome();
    runScript(home, INSTALLER);
    const shimPath = path.join(home, ".claude", "local", "optional-projects.sh");
    expect(fs.existsSync(shimPath)).toBe(true);
    runScript(home, UNINSTALLER);
    expect(fs.existsSync(shimPath)).toBe(false);
  });

  it("removes shim source line from ~/.bash_profile", () => {
    const home = makeTempHome();
    runScript(home, INSTALLER);
    const profilePath = path.join(home, ".bash_profile");
    runScript(home, UNINSTALLER);
    const after = fs.readFileSync(profilePath, "utf8");
    expect(after).not.toContain(".claude/local/optional-projects.sh");
  });

  it("preserves user keys in settings.json (does not delete keepKey)", () => {
    const home = makeTempHome();
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ keepKey: "should-not-be-removed", theme: "dark" }, null, 2),
    );
    runScript(home, INSTALLER);
    runScript(home, UNINSTALLER);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(after.keepKey).toBe("should-not-be-removed");
    expect(after.theme).toBe("dark");
  });

  it("removes statusLine if it matches the installed command", () => {
    const home = makeTempHome();
    runScript(home, INSTALLER);
    runScript(home, UNINSTALLER);
    const settingsPath = path.join(home, ".claude", "settings.json");
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(after.statusLine).toBeUndefined();
  });

  it("preserves statusLine if the user customised it after install", () => {
    const home = makeTempHome();
    runScript(home, INSTALLER);
    const settingsPath = path.join(home, ".claude", "settings.json");
    const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // Simulate the user customising statusLine after install.
    merged.statusLine = { type: "command", command: "user-custom-statusline" };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    runScript(home, UNINSTALLER);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // User's custom statusLine must survive — the uninstaller only removes
    // statusLine when it equals the value the installer wrote.
    expect(after.statusLine).toBeDefined();
    expect(after.statusLine.command).toBe("user-custom-statusline");
  });
});
