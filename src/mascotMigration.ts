// v3.1: One-time migration of mascot.json from cwd-based .evo/ to the new
// PC-global location at ~/.claude/.evo/. Safe to call on every load: a
// sentinel file prevents re-running once successful.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function homeEvoDir(): string {
  return path.join(os.homedir(), ".claude", ".evo");
}

function sentinelPath(): string {
  return path.join(homeEvoDir(), ".migrated-from-cwd");
}

export function migrateMascotFromCwd(cwd: string): void {
  const HOME_EVO = homeEvoDir();
  const MIGRATION_SENTINEL = sentinelPath();

  // Skip if already migrated
  if (fs.existsSync(MIGRATION_SENTINEL)) return;

  const homeMascot = path.join(HOME_EVO, "mascot.json");
  if (fs.existsSync(homeMascot)) {
    // Already exists in new location — just write sentinel and skip
    try {
      fs.mkdirSync(HOME_EVO, { recursive: true });
      fs.writeFileSync(MIGRATION_SENTINEL, new Date().toISOString());
    } catch {
      // best-effort
    }
    return;
  }

  const cwdMascot = path.join(cwd, ".evo", "mascot.json");
  if (!fs.existsSync(cwdMascot)) return; // nothing to migrate

  // Copy (preserve original as backup)
  try {
    fs.mkdirSync(HOME_EVO, { recursive: true });
    fs.copyFileSync(cwdMascot, homeMascot);
    fs.writeFileSync(MIGRATION_SENTINEL, new Date().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evopet] mascot migration failed (${msg}); will retry on next load\n`);
  }
}
