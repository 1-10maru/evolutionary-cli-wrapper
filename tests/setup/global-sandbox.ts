/**
 * vitest globalSetup: create ONE sandbox root per `vitest run`, isolate the
 * main process env (so forked workers inherit a clean env), and remove the
 * sandbox afterwards. Workers re-apply the isolation in ./isolate-env.setup.ts.
 */

import * as fs from "node:fs";
import {
  isolateTestEnvironment,
  makeSandboxRoot,
  SANDBOX_ROOT_VAR,
} from "./isolation";

export default function setup(): () => void {
  const root = makeSandboxRoot();
  process.env[SANDBOX_ROOT_VAR] = root;
  isolateTestEnvironment(process.env, root);
  return () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of a temp dir
    }
  };
}
