import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// installer-chain.test.ts
//
// Exercises install/evopet-install.sh end-to-end against an isolated
// HOME / USERPROFILE so the developer's real ~/.claude/ is never touched.
//
// Asserts the README guarantees:
//   - ~/.claude/local/optional-projects.sh is created with a PATH-prepend
//     containing EVO_BIN and an EVOPET_ENABLED guard.
//   - ~/.claude/settings.json is merged: pre-existing keys preserved, the
//     statusLine.command is set to Evopet's command.
//   - ~/.bash_profile gets the shim source line, idempotent on re-run.
//   - Re-running the installer does not duplicate the .bash_profile line and
//     leaves shim file content identical.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(REPO_ROOT, "install", "evopet-install.sh");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-install-"));
  tempDirs.push(dir);
  return dir;
}

function runInstaller(home: string): { stdout: string; stderr: string } {
  // Use bash explicitly so this works on both Linux and Windows (Git Bash).
  // HOME and USERPROFILE both point to the temp dir; HOME is what bash uses,
  // USERPROFILE is set so Node.js os.homedir() also redirects on Windows.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  const stdout = execFileSync("bash", [INSTALLER], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout, stderr: "" };
}

beforeEach(() => {
  // No global setup; each test gets its own temp HOME.
});

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
        // ignore — Windows can transiently hold handles
      }
    }
  }
});

describe("evopet-install.sh", () => {
  it("creates optional-projects.sh shim with dynamic resolver, PATH-prepend, and EVOPET_ENABLED guard", () => {
    const home = makeTempHome();
    runInstaller(home);
    const shimPath = path.join(home, ".claude", "local", "optional-projects.sh");
    expect(fs.existsSync(shimPath)).toBe(true);
    const content = fs.readFileSync(shimPath, "utf8");
    // Placeholder must never leak into the generated shim.
    expect(content).not.toContain("<EVO_ROOT_PLACEHOLDER>");
    // Dynamic resolver: no hardcoded absolute path; resolves evo location at
    // shell-init time so the same shim works across PCs and npm-only installs.
    expect(content).toMatch(/_evo_candidate/);
    // PATH must be prepended with the resolved candidate (not a static EVO_BIN).
    expect(content).toContain('export PATH="$_evo_candidate:$PATH"');
    // Resolver must short-circuit when evo is already on PATH.
    expect(content).toMatch(/command -v evo/);
    // Master kill-switch and EvoPet-specific guard both present.
    expect(content).toContain("DISABLE_OPTIONAL_PROJECTS");
    expect(content).toMatch(/EVOPET_ENABLED/);
  });

  it("preserves pre-existing keys in ~/.claude/settings.json and merges statusLine.command", () => {
    const home = makeTempHome();
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          keepKey: "should-not-be-removed",
          statusLine: { type: "command", command: "old-cmd" },
          theme: "dark",
        },
        null,
        2,
      ),
    );

    runInstaller(home);

    const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(merged.keepKey).toBe("should-not-be-removed");
    expect(merged.theme).toBe("dark");
    // statusLine.command must now be Evopet's command (not the user's old-cmd).
    expect(merged.statusLine).toBeDefined();
    expect(merged.statusLine.type).toBe("command");
    expect(merged.statusLine.command).not.toBe("old-cmd");
    expect(typeof merged.statusLine.command).toBe("string");
    expect(merged.statusLine.command.length).toBeGreaterThan(0);
  });

  it("appends shim source line to ~/.bash_profile and is idempotent on re-run", () => {
    const home = makeTempHome();
    runInstaller(home);
    const profilePath = path.join(home, ".bash_profile");
    expect(fs.existsSync(profilePath)).toBe(true);
    const first = fs.readFileSync(profilePath, "utf8");
    expect(first).toContain(".claude/local/optional-projects.sh");

    // Run installer a second time — the shim source line must not be duplicated.
    runInstaller(home);
    const second = fs.readFileSync(profilePath, "utf8");
    // Count the number of lines that source the shim. The shim source line
    // contains the substring ".claude/local/optional-projects.sh" twice, so
    // we count lines instead of substring occurrences.
    const sourceLineCount = second
      .split(/\r?\n/)
      .filter((line) => line.includes(".claude/local/optional-projects.sh"))
      .length;
    expect(sourceLineCount).toBe(1);
  });

  it("is idempotent: re-run leaves shim file content identical", () => {
    const home = makeTempHome();
    runInstaller(home);
    const shimPath = path.join(home, ".claude", "local", "optional-projects.sh");
    const firstContent = fs.readFileSync(shimPath, "utf8");

    runInstaller(home);
    const secondContent = fs.readFileSync(shimPath, "utf8");
    expect(secondContent).toBe(firstContent);
  });
});
