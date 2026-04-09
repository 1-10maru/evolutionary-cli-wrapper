import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const build = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true,
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const init = spawnSync("node", ["dist/index.js", "init", "--cwd", process.cwd()], {
  stdio: "inherit",
  shell: true,
});

if (init.status !== 0) {
  process.exit(init.status ?? 1);
}

const shellSetup = spawnSync("node", ["dist/index.js", "setup-shell", "--cwd", process.cwd()], {
  stdio: "inherit",
  shell: true,
});

if (shellSetup.status !== 0) {
  process.exit(shellSetup.status ?? 1);
}

if (existsSync(".evo/config.json")) {
  console.log("Setup complete. Open a new PowerShell session, then use codex or claude as usual.");
}
