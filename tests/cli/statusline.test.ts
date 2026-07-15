import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { clip, displayWidth } from "../../src/cli/statusline";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Spawn the pre-built CLI. `npm run build` runs before the suite in the verify
// flow (release:check / CI), so dist is fresh; we never build in-test (that
// races parallel test files that also read dist/).
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

// ── Unit: width-aware clip() ────────────────────────────────────────────────

describe("displayWidth", () => {
  it("counts ASCII as 1 column and CJK/emoji as 2", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("あいう")).toBe(6);
    expect(displayWidth("a あ")).toBe(4); // 1 + 1(space) + 2
    expect(displayWidth("🦊")).toBe(2);
  });
});

describe("clip", () => {
  it("returns the string unchanged when it fits the budget", () => {
    expect(clip("hello", 10)).toBe("hello");
    expect(clip("あいう", 6)).toBe("あいう");
  });

  it("collapses a whole-string filesystem path to its basename", () => {
    expect(clip("C:/Users/x/proj/src/Login.tsx", 100)).toBe("Login.tsx");
    expect(clip("/home/u/repo/pkg/validators.ts", 100)).toBe("validators.ts");
  });

  it("truncates CJK by display columns, not by character count", () => {
    // 6 columns → 3 wide chars fit, then an ellipsis (no clause boundary here).
    expect(clip("あいうえおかき", 6)).toBe("あいう…");
  });

  it("backs off to the last clause/word boundary when one exists", () => {
    const out = clip("src/api.ts を直して。他は触らない", 14);
    expect(out.endsWith("…")).toBe(true);
    // Should not cut mid-clause past the 。 boundary retained in the head.
    expect(out.startsWith("src/api.ts")).toBe(true);
  });

  it("appends the `evo advice` pointer instead of a bare ellipsis when asked", () => {
    const out = clip("これはとても長い日本語のアドバイス本文です本当に長い", 10, {
      pointer: true,
    });
    expect(out).toContain("evo advice");
    expect(out.endsWith("…")).toBe(false);
  });

  it("truncates an over-long basename with an ellipsis", () => {
    const out = clip("/a/b/averyveryverylongbasenamefile.tsx", 8);
    expect(out.startsWith("averyver")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ── Integration: strict per-session binding + provenance tags ────────────────

interface RunResult {
  stdout: string;
  plain: string;
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const tempDirs: string[] = [];

function makeTempDirs(): { home: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evo-statusline-ts-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function runStatusline(stdin: object, home: string, cwd: string): RunResult {
  const res = spawnSync(process.execPath, [DIST_INDEX, "statusline"], {
    input: JSON.stringify(stdin),
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const stdout = res.stdout ?? "";
  return { stdout, plain: stripAnsi(stdout) };
}

function writeSessionFile(cwd: string, sid: string, nickname: string, ageMs = 2000): void {
  const dir = path.join(cwd, ".evo", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    avatar: "🦊",
    nickname,
    userMessages: 5,
    bond: 50,
    idealStateGauge: 70,
    comboCount: 0,
    sessionGrade: "A",
    promptScore: 75,
    signalKind: "good_structure",
    advice: "",
    adviceDetail: "",
    beforeExample: "",
    afterExample: "",
    sessionId: sid,
    updatedAt: Date.now() - ageMs,
  };
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(payload));
}

function baseStdin(cwd: string, extra: object = {}): object {
  return {
    model: { display_name: "Claude Fable 5", id: "claude-fable-5" },
    cwd,
    context_window: { used_percentage: 20 },
    rate_limits: {},
    ...extra,
  };
}

describe("evo statusline (session binding + tags)", () => {
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

  it("binds to the per-session file when session_id matches", () => {
    const { home, cwd } = makeTempDirs();
    writeSessionFile(cwd, "sid-mine", "MyPet");
    const { plain } = runStatusline(baseStdin(cwd, { session_id: "sid-mine" }), home, cwd);
    expect(plain).toContain("MyPet");
  });

  it("renders NOTHING when session_id is known but has no fresh per-session file", () => {
    const { home, cwd } = makeTempDirs();
    // A per-session file for a DIFFERENT session must not leak.
    writeSessionFile(cwd, "sid-other", "OtherPet");
    // And a shared legacy sink must not be borrowed either.
    fs.writeFileSync(
      path.join(cwd, ".evo", "live-state.json"),
      JSON.stringify({ nickname: "LegacyPet", updatedAt: Date.now() - 1000 }),
    );
    const { stdout, plain } = runStatusline(
      baseStdin(cwd, { session_id: "sid-ghost" }),
      home,
      cwd,
    );
    expect(plain).not.toContain("OtherPet");
    expect(plain).not.toContain("LegacyPet");
    expect(stdout.trim()).toBe("");
  });

  it("derives the sid from transcript_path when session_id is absent", () => {
    const { home, cwd } = makeTempDirs();
    writeSessionFile(cwd, "sid-xfer", "XferPet");
    const { plain } = runStatusline(
      baseStdin(cwd, { transcript_path: "/h/.claude/projects/enc/sid-xfer.jsonl" }),
      home,
      cwd,
    );
    expect(plain).toContain("XferPet");
  });

  it("sessionless legacy path reads the shared sink (past warm-up ticks)", () => {
    const { home, cwd } = makeTempDirs();
    fs.mkdirSync(path.join(cwd, ".evo"), { recursive: true });
    // Pre-seed the self-state past the 2-tick warm-up so a single render shows
    // the shared sink (the first two ticks suppress it). cwd matches so no
    // session-reset fires. This keeps the test deterministic (one spawn).
    fs.writeFileSync(
      path.join(home, ".claude", ".evo-self-state.json"),
      JSON.stringify({ start: Date.now() / 1000, calls: 5, cwd, ctx_pct: 20 }),
    );
    fs.writeFileSync(
      path.join(cwd, ".evo", "live-state.json"),
      JSON.stringify({
        avatar: "🦊",
        nickname: "LegacyPet",
        sessionGrade: "A",
        promptScore: 75,
        idealStateGauge: 70,
        updatedAt: Date.now() - 1000,
      }),
    );
    const { plain } = runStatusline(baseStdin(cwd), home, cwd);
    expect(plain).toContain("LegacyPet");
  });

  it("tags fallback tip lines with a provenance bracket ([汎用]/[公式]/[…向け])", () => {
    const { home, cwd } = makeTempDirs();
    // No proxy files at all → self-tracked fallback. First tick shows the
    // session-start boost; the second tick shows a tagged tip line.
    runStatusline(baseStdin(cwd), home, cwd);
    const { plain } = runStatusline(baseStdin(cwd), home, cwd);
    expect(plain).toMatch(/\[(公式|汎用|[^\]]+向け)\]/);
  });
});
