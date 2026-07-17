import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport } from "../src/cli/doctor";

const tempDirs: string[] = [];
const savedEvoHome = process.env.EVO_HOME;

afterEach(() => {
  if (savedEvoHome === undefined) delete process.env.EVO_HOME;
  else process.env.EVO_HOME = savedEvoHome;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-doctor-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".evo"), { recursive: true });
  return dir;
}

describe("evo doctor — resolved-command Critical", () => {
  it("flags a temp/scratchpad-resident originalCommandMap.claude as Critical", () => {
    const cwd = makeCwd();
    process.env.EVO_HOME = cwd;
    const mock = path.join(os.tmpdir(), "claude", "scratchpad", "qa6", "fixtures", "mock", "cmd", "claude.cmd");
    fs.writeFileSync(
      path.join(cwd, ".evo", "config.json"),
      JSON.stringify({ shellIntegration: { originalCommandMap: { claude: mock } } }),
    );
    const report = buildReport({ cwd });
    expect(report.criticalIssues.some((i) => /temp\/scratchpad path/i.test(i))).toBe(true);
  });

  it("does NOT flag a normal npm-global claude", () => {
    const cwd = makeCwd();
    process.env.EVO_HOME = cwd;
    const real = ["C:", "Users", "me", "AppData", "Roaming", "npm", "node_modules", "claude-code", "bin", "claude.exe"].join(path.sep);
    fs.writeFileSync(
      path.join(cwd, ".evo", "config.json"),
      JSON.stringify({ shellIntegration: { originalCommandMap: { claude: real } } }),
    );
    const report = buildReport({ cwd });
    expect(report.criticalIssues.some((i) => /temp\/scratchpad path/i.test(i))).toBe(false);
  });
});

describe("evo doctor — self-check surfacing", () => {
  it("surfaces a failed self-check state as a critical issue", () => {
    const cwd = makeCwd();
    process.env.EVO_HOME = cwd; // selfCheckStatePath → <cwd>/.evo/.evo-selfcheck.json
    fs.writeFileSync(
      path.join(cwd, ".evo", ".evo-selfcheck.json"),
      JSON.stringify({ ok: false, checks: [{ name: "native-load", ok: false, detail: "tree-sitter-python: broken" }], at: Date.now() }),
    );
    const report = buildReport({ cwd });
    expect(report.selfCheck.found).toBe(true);
    expect(report.selfCheck.ok).toBe(false);
    expect(report.selfCheck.failed?.some((f) => /tree-sitter-python/.test(f))).toBe(true);
    expect(report.criticalIssues.some((i) => /self-check FAILED/i.test(i))).toBe(true);
  });

  it("reports ok self-check with no critical", () => {
    const cwd = makeCwd();
    process.env.EVO_HOME = cwd;
    fs.writeFileSync(
      path.join(cwd, ".evo", ".evo-selfcheck.json"),
      JSON.stringify({ ok: true, checks: [{ name: "native-load", ok: true }], at: Date.now() }),
    );
    const report = buildReport({ cwd });
    expect(report.selfCheck.ok).toBe(true);
    expect(report.criticalIssues.some((i) => /self-check FAILED/i.test(i))).toBe(false);
  });
});
