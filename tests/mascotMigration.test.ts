import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMascotFromCwd } from "../src/mascotMigration";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isolatedHome(): string {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "evo-home-mig-"));
  tempDirs.push(fakeHome);
  // os.homedir() honours USERPROFILE on Windows and HOME elsewhere.
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  return fakeHome;
}

describe("mascotMigration", () => {
  it("copies cwd-based mascot.json into ~/.claude/.evo/ on first run", () => {
    const fakeHome = isolatedHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-mig-"));
    tempDirs.push(project);

    // Seed cwd-based mascot.json (the v3.0 location).
    const cwdEvo = path.join(project, ".evo");
    fs.mkdirSync(cwdEvo, { recursive: true });
    const seed = {
      speciesId: "fox",
      nickname: "TestPet",
      stage: "buddy",
      totalBondExp: 500,
      recentEpisodes: [],
    };
    fs.writeFileSync(path.join(cwdEvo, "mascot.json"), JSON.stringify(seed));

    migrateMascotFromCwd(project);

    const homeMascot = path.join(fakeHome, ".claude", ".evo", "mascot.json");
    const sentinel = path.join(fakeHome, ".claude", ".evo", ".migrated-from-cwd");
    expect(fs.existsSync(homeMascot)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(homeMascot, "utf8"));
    expect(migrated.speciesId).toBe("fox");
    expect(migrated.nickname).toBe("TestPet");
  });

  it("is idempotent — does not re-migrate after sentinel exists", () => {
    const fakeHome = isolatedHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-mig2-"));
    tempDirs.push(project);

    // Seed both: cwd source AND existing home destination + sentinel.
    fs.mkdirSync(path.join(project, ".evo"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".evo", "mascot.json"),
      JSON.stringify({ speciesId: "cat", nickname: "ShouldNotOverwrite" }),
    );
    const homeEvo = path.join(fakeHome, ".claude", ".evo");
    fs.mkdirSync(homeEvo, { recursive: true });
    const existing = { speciesId: "dog", nickname: "ExistingPet" };
    fs.writeFileSync(path.join(homeEvo, "mascot.json"), JSON.stringify(existing));
    fs.writeFileSync(path.join(homeEvo, ".migrated-from-cwd"), new Date().toISOString());

    migrateMascotFromCwd(project);

    const stillExisting = JSON.parse(
      fs.readFileSync(path.join(homeEvo, "mascot.json"), "utf8"),
    );
    expect(stillExisting.speciesId).toBe("dog");
    expect(stillExisting.nickname).toBe("ExistingPet");
  });

  it("is a no-op when no source mascot.json exists in cwd", () => {
    const fakeHome = isolatedHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-mig3-"));
    tempDirs.push(project);

    migrateMascotFromCwd(project);

    const homeMascot = path.join(fakeHome, ".claude", ".evo", "mascot.json");
    expect(fs.existsSync(homeMascot)).toBe(false);
  });

  it("writes sentinel even when home already had mascot.json (avoid repeat checks)", () => {
    const fakeHome = isolatedHome();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "evo-project-mig4-"));
    tempDirs.push(project);

    const homeEvo = path.join(fakeHome, ".claude", ".evo");
    fs.mkdirSync(homeEvo, { recursive: true });
    fs.writeFileSync(path.join(homeEvo, "mascot.json"), JSON.stringify({ speciesId: "bear" }));
    // No sentinel yet.

    migrateMascotFromCwd(project);

    expect(fs.existsSync(path.join(homeEvo, ".migrated-from-cwd"))).toBe(true);
  });
});
