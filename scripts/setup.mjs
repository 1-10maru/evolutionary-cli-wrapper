import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanEnv = {
  ...process.env,
};
delete cleanEnv.EVO_HOME;
delete cleanEnv.EVO_CONFIG;

const build = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true,
  cwd: projectRoot,
  env: cleanEnv,
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const init = spawnSync("node", ["dist/index.js", "init", "--cwd", projectRoot], {
  stdio: "inherit",
  shell: true,
  cwd: projectRoot,
  env: cleanEnv,
});

if (init.status !== 0) {
  process.exit(init.status ?? 1);
}

const shellSetup = spawnSync("node", ["dist/index.js", "setup-shell", "--cwd", projectRoot], {
  stdio: "inherit",
  shell: true,
  cwd: projectRoot,
  env: cleanEnv,
});

if (shellSetup.status !== 0) {
  process.exit(shellSetup.status ?? 1);
}

if (existsSync(path.join(projectRoot, ".evo", "config.json"))) {
  console.log("Setup complete. Open a new terminal session, then use codex or claude as usual.");
}
