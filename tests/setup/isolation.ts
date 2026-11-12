/**
 * Test-environment isolation (pure helpers, no side effects on import).
 *
 * Why: src/config.ts `getGlobalEvoHome` reads EVO_HOME first, and the owner
 * runs `npm test` from shells launched by evo itself — those export EVO_HOME,
 * EVO_CONFIG, EVO_FORCE_NORMAL, … pointing at the LIVE EvoPet state. Inheriting
 * them let the suite write into real mascot/config/crash files. The vitest
 * setup (./isolate-env.setup.ts, wired in vitest.config.ts) applies this before
 * any test module loads, so no test can reach real state by default.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Env var naming the per-run sandbox root (set by ./global-sandbox.ts). */
export const SANDBOX_ROOT_VAR = "VITEST_EVO_SANDBOX_ROOT";

/** Create a fresh per-run sandbox root under the OS temp dir. */
export function makeSandboxRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evo-vitest-"));
}

/**
 * Strip every EVO_* variable from `env` and point the home-ish variables
 * (HOME, USERPROFILE, LOCALAPPDATA) at directories inside `root`, creating
 * them. Returns the names of the EVO_* variables that were removed.
 */
export function isolateTestEnvironment(
  env: NodeJS.ProcessEnv,
  root: string,
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("EVO_")) {
      delete env[key];
      removed.push(key);
    }
  }
  const home = path.join(root, "home");
  const localAppData = path.join(root, "localappdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.LOCALAPPDATA = localAppData;
  return removed;
}
