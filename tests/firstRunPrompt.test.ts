import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeRunFirstRunPrompt } from "../src/firstRunPrompt";

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-first-run-"));
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

function sentinelPath(home: string): string {
  return path.join(home, ".evo", "install-prompt-shown");
}

describe("firstRunPrompt", () => {
  it("does nothing when sentinel file already exists", async () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".evo"), { recursive: true });
    fs.writeFileSync(sentinelPath(home), "previous-run\n");

    const prompt = vi.fn();
    const runInstall = vi.fn();
    const messages: string[] = [];

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: {},
      prompt: prompt as unknown as (q: string) => Promise<string>,
      log: (m) => messages.push(m),
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it("does nothing when settings.json already references evopet statusline", async () => {
    const home = makeTempHome();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        statusLine: {
          type: "command",
          command: `python "${claudeDir}/base_statusline.py"`,
        },
      }),
    );

    const prompt = vi.fn();
    const runInstall = vi.fn();
    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: {},
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinelPath(home))).toBe(false);
  });

  it("does nothing when stdin is not a TTY", async () => {
    const home = makeTempHome();
    const prompt = vi.fn();
    const runInstall = vi.fn();

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: false,
      env: {},
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinelPath(home))).toBe(false);
  });

  it("does nothing when EVO_NO_INSTALL_PROMPT=1 is set", async () => {
    const home = makeTempHome();
    const prompt = vi.fn();
    const runInstall = vi.fn();

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: { EVO_NO_INSTALL_PROMPT: "1" },
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinelPath(home))).toBe(false);
  });

  it("does nothing when EVO_PROXY_ACTIVE=1 is set (running inside proxy spawn)", async () => {
    const home = makeTempHome();
    const prompt = vi.fn();
    const runInstall = vi.fn();

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: { EVO_PROXY_ACTIVE: "1" },
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinelPath(home))).toBe(false);
  });

  it("does nothing when subcommand is install-statusline (recursion guard)", async () => {
    const home = makeTempHome();
    const prompt = vi.fn();
    const runInstall = vi.fn();

    await maybeRunFirstRunPrompt("install-statusline", {
      homeDir: home,
      isTTY: true,
      env: {},
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(runInstall).not.toHaveBeenCalled();
  });

  // --- skip-list expansion (the bug fix) ---
  describe("expanded skip list", () => {
    const skipCases = [
      "proxy",
      "run",
      "pause",
      "resume",
      "shell",
      "setup-shell",
      "undo-shell",
      "uninstall",
      "logs",
      "stats",
      "storage",
      "explain",
      "compact",
      "export-knowledge",
      "import-knowledge",
      "statusline",
      "--version",
      "-V",
      "--help",
      "-h",
    ];
    for (const sub of skipCases) {
      it(`does nothing for subcommand "${sub}"`, async () => {
        const home = makeTempHome();
        const prompt = vi.fn();
        const runInstall = vi.fn();

        await maybeRunFirstRunPrompt(sub, {
          homeDir: home,
          isTTY: true,
          env: {},
          prompt: prompt as unknown as (q: string) => Promise<string>,
          runInstall: runInstall as unknown as (h: string) => Promise<void>,
          log: () => undefined,
        });

        expect(prompt).not.toHaveBeenCalled();
        expect(runInstall).not.toHaveBeenCalled();
        expect(fs.existsSync(sentinelPath(home))).toBe(false);
      });
    }
  });

  describe("argv-based shim detection", () => {
    const shimNames = [
      ["/usr/local/bin/claude", true],
      ["/usr/local/bin/codex", true],
      ["C:/Users/x/bin/claude.cmd", true],
      ["C:/Users/x/bin/claude.ps1", true],
      ["C:/Users/x/bin/claude.exe", true],
      ["/path/to/claude.js", true],
      ["/path/to/codex.cjs", true],
      ["/path/to/CLAUDE", true], // case-insensitive
      ["/path/to/Codex.cmd", true],
      ["/path/to/dist/index.js", false],
      ["/path/to/evo", false],
      ["/path/to/evo.cmd", false],
      ["/path/to/claudette", false], // does not equal "claude"
      ["/path/to/codex-helper", false],
    ] as const;

    for (const [argv1, expectSkip] of shimNames) {
      it(`${expectSkip ? "skips" : "runs"} when argv[1]=${argv1}`, async () => {
        const home = makeTempHome();
        const prompt = vi.fn(async () => "n");
        const runInstall = vi.fn();

        await maybeRunFirstRunPrompt("init", {
          homeDir: home,
          isTTY: true,
          env: {},
          argv: ["node", argv1],
          prompt: prompt as unknown as (q: string) => Promise<string>,
          runInstall: runInstall as unknown as (h: string) => Promise<void>,
          log: () => undefined,
        });

        if (expectSkip) {
          expect(prompt).not.toHaveBeenCalled();
          expect(fs.existsSync(sentinelPath(home))).toBe(false);
        } else {
          expect(prompt).toHaveBeenCalledTimes(1);
        }
      });
    }
  });

  it("calls installStatusline and writes sentinel on yes answer (init subcommand)", async () => {
    const home = makeTempHome();
    const prompt = vi.fn(async () => "y");
    const runInstall = vi.fn(async () => undefined);
    const messages: string[] = [];

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: {},
      argv: ["node", "/path/to/dist/index.js"],
      prompt: prompt as unknown as (q: string) => Promise<string>,
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: (m) => messages.push(m),
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(runInstall).toHaveBeenCalledWith(home);
    expect(fs.existsSync(sentinelPath(home))).toBe(true);
  });

  it("treats empty answer (default) as yes", async () => {
    const home = makeTempHome();
    const runInstall = vi.fn(async () => undefined);

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: {},
      argv: ["node", "/path/to/dist/index.js"],
      prompt: async () => "",
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sentinelPath(home))).toBe(true);
  });

  it("writes sentinel without calling installStatusline on no answer", async () => {
    const home = makeTempHome();
    const runInstall = vi.fn(async () => undefined);

    await maybeRunFirstRunPrompt("init", {
      homeDir: home,
      isTTY: true,
      env: {},
      argv: ["node", "/path/to/dist/index.js"],
      prompt: async () => "n",
      runInstall: runInstall as unknown as (h: string) => Promise<void>,
      log: () => undefined,
    });

    expect(runInstall).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinelPath(home))).toBe(true);
  });
});
