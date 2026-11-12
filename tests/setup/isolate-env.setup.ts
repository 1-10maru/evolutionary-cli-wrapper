/**
 * vitest setupFiles entry: runs in every worker before each test file.
 * Re-applies the isolation from ./isolation.ts so a test file can never see
 * the EVO_* variables or the real HOME/USERPROFILE/LOCALAPPDATA, even if the
 * worker somehow did not inherit the globalSetup env.
 */

import {
  isolateTestEnvironment,
  makeSandboxRoot,
  SANDBOX_ROOT_VAR,
} from "./isolation";

const root = process.env[SANDBOX_ROOT_VAR] || makeSandboxRoot();
process.env[SANDBOX_ROOT_VAR] = root;
isolateTestEnvironment(process.env, root);
