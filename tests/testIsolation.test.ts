import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalEvoHome } from "../src/config";
import { loadMascotProfile, saveMascotProfile } from "../src/mascot";
import { crashLogPath, writeCrashRecord } from "../src/crashGuard";
import { isolateTestEnvironment, SANDBOX_ROOT_VAR } from "./setup/isolation";

/** Recursively list every file under `dir` (empty when it holds none). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

describe("test-suite isolation from live EvoPet state", () => {
  it("the vitest setup already stripped EVO_* and sandboxed the home dirs", () => {
    const root = process.env[SANDBOX_ROOT_VAR];
    expect(root, "setup must publish the sandbox root").toBeTruthy();
    expect(Object.keys(process.env).filter((k) => k.toUpperCase().startsWith("EVO_"))).toEqual([]);
    const inRoot = (p: string | undefined) =>
      !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(root!).toLowerCase() + path.sep);
    expect(inRoot(os.homedir())).toBe(true);
    expect(inRoot(process.env.HOME)).toBe(true);
    expect(inRoot(process.env.USERPROFILE)).toBe(true);
    expect(inRoot(process.env.LOCALAPPDATA)).toBe(true);
  });

  describe("an inherited EVO_HOME never receives writes", () => {
    let saved: NodeJS.ProcessEnv;
    let liveDir: string;
    let sandbox: string;

    beforeEach(() => {
      saved = { ...process.env };
      liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-fake-live-"));
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "evo-iso-"));
    });

    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(liveDir, { recursive: true, force: true });
      fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("isolation removes EVO_HOME/EVO_CONFIG/EVO_FORCE_NORMAL and state writes land in the sandbox", () => {
      // Simulate a shell launched by evo: EVO_* point at the "live" dir.
      process.env.EVO_HOME = liveDir;
      process.env.EVO_CONFIG = path.join(liveDir, ".evo", "config.json");
      process.env.EVO_FORCE_NORMAL = "1";
      expect(getGlobalEvoHome(process.cwd())).toBe(path.resolve(liveDir)); // the hazard

      const removed = isolateTestEnvironment(process.env, sandbox);
      expect(removed).toEqual(
        expect.arrayContaining(["EVO_HOME", "EVO_CONFIG", "EVO_FORCE_NORMAL"]),
      );

      // Exercise real writers: the mascot (global evo home) and the crash log
      // (LOCALAPPDATA).
      const cwd = sandbox;
      saveMascotProfile(cwd, loadMascotProfile(cwd));
      writeCrashRecord(new Error("isolation probe"), "testIsolation");

      expect(listFiles(liveDir)).toEqual([]);
      expect(fs.existsSync(path.join(sandbox, "home", ".claude", ".evo", "mascot.json"))).toBe(true);
      expect(crashLogPath().startsWith(path.join(sandbox, "localappdata"))).toBe(true);
      expect(fs.existsSync(crashLogPath())).toBe(true);
    });
  });
});
