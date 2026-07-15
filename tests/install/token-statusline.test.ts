import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("token-only base statusline deploy", () => {
  const tokenScript = path.join(REPO_ROOT, "scripts", "token_statusline.py");

  it("ships a genuinely token-only statusline script (no EvoPet rendering)", () => {
    expect(fs.existsSync(tokenScript)).toBe(true);
    const src = fs.readFileSync(tokenScript, "utf8");
    // Must NOT contain any EvoPet rendering markers — that is the whole point:
    // base_statusline.py renders only the token line so a wrapper running both
    // it and `evo statusline` does not produce two EvoPet blocks.
    for (const marker of ["育成度", "🦊", "idealStateGauge", "_line1_bits", "指示の質"]) {
      expect(src).not.toContain(marker);
    }
    // Must still render the token essentials.
    expect(src).toContain("display_name");
    expect(src).toContain("used_percentage");
  });

  it("setup.mjs deploys the token-only script (not the full statusline.py) as base_statusline.py", () => {
    const setup = fs.readFileSync(path.join(REPO_ROOT, "scripts", "setup.mjs"), "utf8");
    expect(setup).toMatch(/token_statusline\.py/);
    expect(setup).toContain("base_statusline.py");
    // The deploy SOURCE must not be the full repo-root statusline.py.
    expect(setup).not.toMatch(
      /statuslineSrc\s*=\s*path\.join\(\s*projectRoot,\s*["']statusline\.py["']\s*\)/,
    );
  });

  it("publishes the token-only script in the npm package files list", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.files).toContain("scripts/token_statusline.py");
  });
});
