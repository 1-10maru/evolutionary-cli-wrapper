import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureEvoConfig, updateEvoConfig } from "../src/config";
import { EvoDatabase } from "../src/db";
import { runProxySession, shouldUseLightweightTracking } from "../src/proxyRuntime";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("proxy runtime", () => {
  it("switches to lightweight tracking for parent workspace folders without project markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-workspace-"));
    tempDirs.push(cwd);
    for (let index = 0; index < 10; index += 1) {
      fs.mkdirSync(path.join(cwd, `project-${index}`), { recursive: true });
    }

    expect(shouldUseLightweightTracking(cwd)).toBe(true);
  });

  it("keeps full tracking for a project root with markers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-"));
    tempDirs.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"demo\"}");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });

    expect(shouldUseLightweightTracking(cwd)).toBe(false);
  });

  it("captures proxied turns, usage, and turn summaries", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-proxy-"));
    tempDirs.push(cwd);
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    const fakeCliPath = path.join(cwd, "fake-cli.js");
    fs.writeFileSync(
      fakeCliPath,
      [
        "const fs = require('node:fs');",
        "console.log('Read src/index.ts');",
        "fs.writeFileSync('changed.txt', 'ok');",
        "console.log('prompt tokens: 12 completion tokens: 4 total tokens: 16');",
      ].join("\n"),
    );

    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          claude: process.execPath,
        },
      },
      proxy: {
        ...config.proxy,
        turnIdleMs: 50,
        defaultMode: "active",
      },
    });

    const result = await runProxySession({
      cwd,
      cli: "claude",
      args: [fakeCliPath],
      mode: "active",
    });

    const db = new EvoDatabase(cwd);
    const explain = db.getEpisodeExplain(result.episodeId);
    const storage = db.getStorageReport();

    expect(result.artifacts.turns?.length).toBeGreaterThan(0);
    expect(result.artifacts.usageObservations.length).toBeGreaterThan(0);
    expect(result.artifacts.mascot?.gainedExp).toBeGreaterThan(0);
    expect(explain?.turns.length).toBeGreaterThan(0);
    expect(storage.rowCounts.turns).toBeGreaterThan(0);
    expect(storage.rowCounts.turn_summaries).toBeGreaterThan(0);
    db.close();
  });

  it("suppresses startup-noise-only turns", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-proxy-noise-"));
    tempDirs.push(cwd);
    const fakeCliPath = path.join(cwd, "fake-noise-cli.js");
    fs.writeFileSync(
      fakeCliPath,
      [
        "console.log('Warning: no stdin data received in 3s, proceeding without it.');",
        "setTimeout(() => {",
        "  console.log('Error: Input must be provided either through stdin or as a prompt argument when using --print');",
        "}, 100);",
        "setTimeout(() => process.exit(1), 200);",
      ].join("\n"),
    );

    const config = ensureEvoConfig(cwd);
    updateEvoConfig(cwd, {
      ...config,
      shellIntegration: {
        ...config.shellIntegration,
        originalCommandMap: {
          ...config.shellIntegration.originalCommandMap,
          claude: process.execPath,
        },
      },
      proxy: {
        ...config.proxy,
        turnIdleMs: 50,
        defaultMode: "active",
      },
    });

    const result = await runProxySession({
      cwd,
      cli: "claude",
      args: [fakeCliPath],
      mode: "active",
    });

    expect(result.artifacts.turns ?? []).toHaveLength(0);
  });
});
