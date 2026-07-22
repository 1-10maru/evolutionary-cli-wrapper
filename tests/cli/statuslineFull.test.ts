// Integration tests for `evo statusline --full` (C1) — the TS renderer as the
// SINGLE statusline renderer: token line + EvoPet block from one process, plus
// the parity behaviors ported from statusline.py (stale-dim path, always-on
// essentials placeholders, quiet 待機中 placeholder, minimum→token-only).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const tempDirs: string[] = [];
function makeTempDirs(): { home: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-statusline-full-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

interface RunOpts {
  full?: boolean;
  minimum?: boolean;
}
function run(stdin: object, home: string, cwd: string, opts: RunOpts = {}): { stdout: string; plain: string } {
  const args = [DIST_INDEX, "statusline"];
  if (opts.full) args.push("--full");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // Never let a real machine's update-check touch the output.
    EVO_NO_UPDATE_CHECK: "1",
  };
  if (opts.minimum) env.EVO_DISPLAY_MODE_FILE = writeMode(cwd, "minimum");
  const res = spawnSync(process.execPath, args, { input: JSON.stringify(stdin), cwd, encoding: "utf8", env });
  const stdout = res.stdout ?? "";
  return { stdout, plain: stripAnsi(stdout) };
}

function writeMode(root: string, mode: string): string {
  const f = path.join(root, ".evo-mode");
  fs.writeFileSync(f, mode);
  return f;
}

function baseStdin(cwd: string, extra: object = {}): object {
  return {
    model: { display_name: "Claude Fable 5" },
    cwd,
    context_window: { used_percentage: 20 },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 7 } },
    ...extra,
  };
}

function writeSession(cwd: string, sid: string, payload: object, ageMs = 2000): void {
  const dir = path.join(cwd, ".evo", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sid}.json`),
    JSON.stringify({ sessionId: sid, updatedAt: Date.now() - ageMs, ...payload }),
  );
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("evo statusline --full — token line", () => {
  it("emits the token line (model · gauges · cwd) followed by the EvoPet block", () => {
    const { home, cwd } = makeTempDirs();
    const { plain } = run(baseStdin(cwd), home, cwd, { full: true });
    const lines = plain.split("\n");
    // Line 1 = token line with model + all three gauges.
    expect(lines[0]).toContain("Claude Fable 5");
    expect(lines[0]).toContain("ctx ● 20%");
    expect(lines[0]).toContain("5h ● 40%");
    expect(lines[0]).toContain("7d ● 7%");
    // EvoPet block follows on subsequent line(s).
    expect(plain).toContain("EvoPet");
  });

  it("split mode (no --full) emits ONLY the EvoPet block — no token line", () => {
    const { home, cwd } = makeTempDirs();
    const { plain } = run(baseStdin(cwd), home, cwd, { full: false });
    expect(plain).not.toContain("ctx ● 20%");
    expect(plain).not.toContain("Claude Fable 5");
    expect(plain).toContain("EvoPet");
  });

  it("minimum display mode in full mode emits ONLY the token line (pet hidden, gauges kept)", () => {
    const { home, cwd } = makeTempDirs();
    const { plain } = run(baseStdin(cwd), home, cwd, { full: true, minimum: true });
    expect(plain).toContain("ctx ● 20%");
    expect(plain).not.toContain("EvoPet");
    // Exactly one line (the token line), no EvoPet block.
    expect(plain.split("\n").filter((l) => l.length > 0).length).toBe(1);
  });

  it("minimum display mode in split mode emits nothing", () => {
    const { home, cwd } = makeTempDirs();
    const { stdout } = run(baseStdin(cwd), home, cwd, { full: false, minimum: true });
    expect(stdout.trim()).toBe("");
  });
});

describe("evo statusline --full — EvoPet parity states", () => {
  it("renders the always-on essentials row with placeholders when data is missing", () => {
    const { home, cwd } = makeTempDirs();
    // Fresh proxy payload with NO grade / promptScore / ISG → placeholders.
    writeSession(cwd, "sid1", {
      avatar: "🐣",
      nickname: "Pet",
      sessionGrade: "",
      promptScore: 0,
      idealStateGauge: -1,
    });
    const { plain } = run(baseStdin(cwd, { session_id: "sid1" }), home, cwd, { full: true });
    expect(plain).toContain("評価 —");
    expect(plain).toContain("指示の質: 計測中");
    expect(plain).toContain("育成度 -");
  });

  it("renders live essentials (grade label, 指示の質, 育成度 %) from fresh proxy data", () => {
    const { home, cwd } = makeTempDirs();
    writeSession(cwd, "sid2", {
      avatar: "🐣",
      nickname: "Pet",
      sessionGrade: "C",
      promptScore: 85,
      idealStateGauge: 42,
    });
    const { plain } = run(baseStdin(cwd, { session_id: "sid2" }), home, cwd, { full: true });
    // Grade C label matches statusline.py: "○ C もう一息" (not "標準").
    expect(plain).toContain("C もう一息");
    expect(plain).toContain("指示の質: とても良い!");
    expect(plain).toContain("育成度 42%");
    // Fresh (not stale) → no waiting marker.
    expect(plain).not.toContain("待機中");
  });

  it("renders the DIMMED stale layout with a (待機中) marker for 10s–5min-old data", () => {
    const { home, cwd } = makeTempDirs();
    writeSession(
      cwd,
      "sid3",
      { avatar: "🐣", nickname: "StalePet", sessionGrade: "A", promptScore: 70, idealStateGauge: 60 },
      30000, // 30s old → stale-but-recent
    );
    const { stdout, plain } = run(baseStdin(cwd, { session_id: "sid3" }), home, cwd, { full: true });
    // Full layout preserved (nickname + essentials still present)…
    expect(plain).toContain("StalePet");
    expect(plain).toContain("育成度 60%");
    // …plus the lagging marker, and the block is dimmed (contains the DIM SGR).
    expect(plain).toContain("(待機中)");
    expect(stdout).toContain("\x1b[2m");
  });

  it("ignores proxy data older than the 5-minute window (falls to quiet placeholder)", () => {
    const { home, cwd } = makeTempDirs();
    writeSession(cwd, "sid4", { nickname: "AncientPet", sessionGrade: "A" }, 6 * 60 * 1000);
    const { plain } = run(baseStdin(cwd, { session_id: "sid4" }), home, cwd, { full: true });
    expect(plain).not.toContain("AncientPet");
    expect(plain).toContain("待機中");
  });

  it("shows the token line even when the EvoPet block is the quiet placeholder", () => {
    const { home, cwd } = makeTempDirs();
    const { plain } = run(baseStdin(cwd, { session_id: "sid-none" }), home, cwd, { full: true });
    const lines = plain.split("\n");
    expect(lines[0]).toContain("ctx ● 20%");
    expect(plain).toContain("待機中");
  });

  it("varies the mood comment across ctx bands in the sessionless fallback", () => {
    const { home, cwd } = makeTempDirs();
    // Seed self-state past the 2-tick warm-up so the fallback renders directly.
    fs.writeFileSync(
      path.join(home, ".claude", ".evo-self-state.json"),
      JSON.stringify({ start: Date.now() / 1000, calls: 5, cwd, ctx_pct: 20 }),
    );
    const critical = run(baseStdin(cwd, { context_window: { used_percentage: 85 } }), home, cwd, { full: true });
    // A critical-band comment carries the ⚠️ warning glyph.
    expect(critical.plain).toContain("⚠️");
  });
});
