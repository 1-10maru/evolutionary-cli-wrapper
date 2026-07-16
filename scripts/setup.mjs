import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
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

// Deploy the TOKEN-ONLY statusline to ~/.claude/base_statusline.py.
//
// base_statusline.py must render ONLY the model/context/cwd line. The EvoPet
// block is rendered separately by `evo statusline`. A statusline wrapper runs
// both on the same stdin, so deploying the FULL repo statusline.py here (which
// also renders EvoPet) produced two EvoPet blocks. Deploy the token-only
// script instead.
const statuslineSrc = path.join(projectRoot, "scripts", "token_statusline.py");
const claudeDir = path.join(os.homedir(), ".claude");
const statuslineDst = path.join(claudeDir, "base_statusline.py");
if (existsSync(statuslineSrc)) {
  mkdirSync(claudeDir, { recursive: true });
  copyFileSync(statuslineSrc, statuslineDst);
  console.log(`Deployed token-only statusline → ${statuslineDst}`);
}

if (existsSync(path.join(projectRoot, ".evo", "config.json"))) {
  console.log("Setup complete. Open a new terminal session, then use codex or claude as usual.");
}
