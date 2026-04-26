// spawnCommand — cross-platform spawn helper for the wrapped CLI.
//
// Pure refactor of spawnInteractiveCommand previously inlined in
// src/proxyRuntime.ts. Behaviour is preserved verbatim:
//   - .cmd / .bat → shell:true with quoted args
//   - .ps1 → powershell -NoLogo -NoProfile -File <script> ...args
//   - other → direct spawn, shell:false
// The EVO_PROXY_ACTIVE / EVO_PROXY_DISABLED env vars are injected in all branches.

import { spawn } from "node:child_process";
import path from "node:path";

export function spawnInteractiveCommand(
  commandPath: string,
  args: string[],
  cwd: string,
  inheritStdio = false,
): ReturnType<typeof spawn> {
  const extension = path.extname(commandPath).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const quotedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    return spawn(`"${commandPath}" ${quotedArgs}`.trim(), {
      cwd,
      shell: true,
      stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EVO_PROXY_ACTIVE: "1",
        EVO_PROXY_DISABLED: "0",
      },
    });
  }

  if (extension === ".ps1") {
    return spawn("powershell", ["-NoLogo", "-NoProfile", "-File", commandPath, ...args], {
      cwd,
      shell: false,
      stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        EVO_PROXY_ACTIVE: "1",
        EVO_PROXY_DISABLED: "0",
      },
    });
  }

  return spawn(commandPath, args, {
    cwd,
    shell: false,
    stdio: inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EVO_PROXY_ACTIVE: "1",
      EVO_PROXY_DISABLED: "0",
    },
  });
}
