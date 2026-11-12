import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAdviceBlock,
  capLineToWidth,
  clip,
  clipEx,
  compactGrade,
  computeBudgets,
  displayWidth,
  hardCapVisible,
  resolveTerminalWidth,
  adviceIdentityKey,
  pushIfFits,
  DEFAULT_COLUMNS,
  EVOPET_BLOCK_MAX_CHARS,
  PAGE_INTERVAL_MS,
} from "../../src/cli/statusline";
import { parseDisplaySettings, runDisplayCommand } from "../../src/cli/display";

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

describe("hardCapVisible (absolute safety net)", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("leaves a short string untouched", () => {
    expect(hardCapVisible("hello", 100)).toBe("hello");
  });

  it("bounds the VISIBLE length of a pathological plain string", () => {
    const out = hardCapVisible("x".repeat(200_000), 300);
    expect(strip(out).length).toBeLessThanOrEqual(300 + " → 続きは `evo advice`".length);
    expect(out).toContain("evo advice");
  });

  it("does not count ANSI escapes toward the visible budget", () => {
    // 50 colored 1-char segments = 50 visible chars, well under the cap.
    const colored = Array.from({ length: 50 }, () => "\x1b[31mx\x1b[0m").join("");
    const out = hardCapVisible(colored, 100);
    expect(strip(out)).toBe("x".repeat(50));
    expect(out).toBe(colored); // untouched: visible 50 <= 100
  });

  it("counts a wide/emoji code point as one visible unit (no mid-surrogate cut)", () => {
    const out = hardCapVisible("🦊".repeat(500), 10);
    // 10 emoji kept, then the pointer — never a broken surrogate half.
    expect(Array.from(strip(out).replace(" → 続きは `evo advice`", "")).length).toBe(10);
  });
});

// ── Unit: width-adaptive layout ─────────────────────────────────────────────

const plainOf = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

describe("resolveTerminalWidth", () => {
  it("reads COLUMNS (Claude Code captures stdout, so tput cols cannot work)", () => {
    expect(resolveTerminalWidth({ COLUMNS: "60" })).toBe(60);
    expect(resolveTerminalWidth({ COLUMNS: " 204 " })).toBe(204);
  });

  it("falls back to the default when COLUMNS is missing or unusable", () => {
    expect(resolveTerminalWidth({})).toBe(DEFAULT_COLUMNS);
    expect(resolveTerminalWidth({ COLUMNS: "" })).toBe(DEFAULT_COLUMNS);
    expect(resolveTerminalWidth({ COLUMNS: "wide" })).toBe(DEFAULT_COLUMNS);
    expect(resolveTerminalWidth({ COLUMNS: "0" })).toBe(DEFAULT_COLUMNS);
    expect(resolveTerminalWidth({ COLUMNS: "-40" })).toBe(DEFAULT_COLUMNS);
  });
});

describe("computeBudgets", () => {
  it("picks the tier from the width and scales the budgets with it", () => {
    expect(computeBudgets(60).tier).toBe("narrow");
    expect(computeBudgets(79).tier).toBe("narrow");
    expect(computeBudgets(80).tier).toBe("medium");
    expect(computeBudgets(119).tier).toBe("medium");
    expect(computeBudgets(120).tier).toBe("wide");
    expect(computeBudgets(200).tier).toBe("wide");
    // Budgets are derived, not the old fixed 72/76/28/44.
    expect(computeBudgets(200).advice).toBeGreaterThan(computeBudgets(120).advice);
    expect(computeBudgets(200).detail).toBeGreaterThan(computeBudgets(120).detail);
  });

  it("drops line 2 below 80 and the detail line below 120", () => {
    expect(computeBudgets(60)).toMatchObject({ showAdvice: false, showDetail: false, compactChips: true });
    expect(computeBudgets(90)).toMatchObject({ showAdvice: true, showDetail: false, compactChips: false });
    expect(computeBudgets(160)).toMatchObject({ showAdvice: true, showDetail: true, compactChips: false });
  });

  it("reserves a right margin and survives nonsense widths", () => {
    expect(computeBudgets(120).avail).toBe(118);
    expect(computeBudgets(Number.NaN).cols).toBe(DEFAULT_COLUMNS);
    expect(computeBudgets(0).cols).toBe(DEFAULT_COLUMNS);
    expect(computeBudgets(5).avail).toBeGreaterThanOrEqual(20);
  });
});

describe("capLineToWidth", () => {
  it("bounds a line by display columns without counting ANSI escapes", () => {
    const colored = `\x1b[31m${"あ".repeat(50)}\x1b[0m`;
    const out = capLineToWidth(colored, 10);
    expect(displayWidth(plainOf(out))).toBeLessThanOrEqual(10);
    expect(out.startsWith("\x1b[31m")).toBe(true);
  });

  it("leaves a line that already fits completely untouched", () => {
    const line = "\x1b[1mhello\x1b[0m";
    expect(capLineToWidth(line, 40)).toBe(line);
  });
});

describe("compactGrade", () => {
  it("abbreviates the full-width grade label to glyph + letter", () => {
    expect(compactGrade("S")).toBe("✨S");
    expect(compactGrade("A")).toBe("⭐A");
    expect(compactGrade("B")).toBe("●B");
    expect(compactGrade("C")).toBe("○C");
    expect(compactGrade("D")).toBe("△D");
  });

  it("passes an unknown grade through instead of doubling it", () => {
    expect(compactGrade("X")).toBe("X");
    expect(compactGrade("")).toBe("");
  });
});

describe("clipEx sentence-preferring truncation", () => {
  it("prefers a sentence end over a clause comma for detail text", () => {
    const detail = "一文目はここで終わる。二文目は途中で、切れてしまう内容";
    const sentence = clipEx(detail, 40, { sentence: true });
    const clause = clipEx(detail, 40);
    expect(sentence.truncated).toBe(true);
    expect(plainOf(sentence.text)).toContain("一文目はここで終わる。");
    // The clause rule stops at the 、 instead — that is the old behaviour.
    expect(sentence.text).not.toBe(clause.text);
  });

  it("reports whether anything was elided", () => {
    expect(clipEx("short", 40).truncated).toBe(false);
    expect(clipEx("あ".repeat(40), 10).truncated).toBe(true);
  });
});

describe("buildAdviceBlock", () => {
  const LONG_DETAIL =
    "Claude Opus 4.8 は、以前のモデルよりもバグの発見が大幅に優れています。" +
    "コードレビューでは対象ファイルを先に列挙すると精度が上がります。" +
    "完了条件を一つ書いておくと、やり直しの回数が目に見えて減ります。" +
    "長い調査タスクでは、途中経過を短く報告させると迷子になりません。";

  const base = {
    icon: "💡",
    color: "\x1b[36m",
    headline: "指示に完了条件を1つ足しましょう",
    detail: LONG_DETAIL,
    anchorMs: 1_000_000,
    nowMs: 1_000_000,
    scroll: true,
  };

  it("emits nothing below 80 columns (line 1 is what has to survive)", () => {
    expect(buildAdviceBlock(base, computeBudgets(60))).toBe("");
  });

  it("emits headline only between 80 and 119 columns", () => {
    const out = buildAdviceBlock(base, computeBudgets(100));
    expect(out.split("\n")).toHaveLength(1);
    expect(plainOf(out)).toContain("完了条件");
  });

  it("emits headline + detail at 120 columns and up", () => {
    const out = buildAdviceBlock(base, computeBudgets(160));
    expect(out.split("\n")).toHaveLength(2);
  });

  it("never overflows the paintable width at any tier", () => {
    for (const cols of [60, 80, 100, 120, 160, 200, 300]) {
      const b = computeBudgets(cols);
      const out = buildAdviceBlock(base, b);
      for (const line of out.split("\n")) {
        if (!line) continue;
        expect([cols, displayWidth(plainOf(line))]).toEqual([
          cols,
          expect.any(Number),
        ]);
        expect(displayWidth(plainOf(line))).toBeLessThanOrEqual(b.avail);
      }
    }
  });

  it("points at `evo advice` when the DETAIL is what got cut — not just the headline", () => {
    // Headline fits easily; only the detail is elided. The old renderer put the
    // pointer on the headline only, so this case silently told the user nothing.
    const out = buildAdviceBlock({ ...base, scroll: false }, computeBudgets(120));
    expect(plainOf(out)).toContain("evo advice");
  });

  it("points at `evo advice` when the whole detail line is dropped by width", () => {
    const out = buildAdviceBlock(base, computeBudgets(100));
    expect(plainOf(out)).toContain("evo advice");
  });

  it("attaches the pointer EXACTLY ONCE, on the last line of the block", () => {
    const out = buildAdviceBlock(
      { ...base, headline: "あ".repeat(200), scroll: false },
      computeBudgets(120),
    );
    const plain = plainOf(out);
    expect(plain.match(/evo advice/g)).toHaveLength(1);
    const lines = out.split("\n");
    expect(plainOf(lines[lines.length - 1])).toContain("evo advice");
    expect(plainOf(lines[0])).not.toContain("evo advice");
  });

  it("omits the pointer entirely when nothing was elided", () => {
    const out = buildAdviceBlock(
      { ...base, headline: "短い助言", detail: "短い詳細。" },
      computeBudgets(200),
    );
    expect(plainOf(out)).not.toContain("evo advice");
  });

  it("does not truncate mid-sentence: the detail ends on a sentence boundary", () => {
    const out = buildAdviceBlock({ ...base, scroll: false }, computeBudgets(120));
    const detailLine = plainOf(out.split("\n")[1])
      .replace(" → 続きは `evo advice`", "")
      .replace(/…$/u, "")
      .trimEnd();
    // The cut lands on a full stop; the ellipsis then marks the elision. The
    // old clause rule stopped at a 、 and left a dangling half-sentence.
    expect(detailLine.endsWith("。")).toBe(true);
  });

  // ── page flip ──
  it("advances one page per PAGE_INTERVAL_MS and then STAYS on the last page", () => {
    const b = computeBudgets(120);
    const IV = PAGE_INTERVAL_MS;
    const page = (dt: number) =>
      plainOf(buildAdviceBlock({ ...base, nowMs: base.anchorMs + dt }, b));
    const counter = (s: string) => (s.match(/\((\d+)\/(\d+)\)/) ?? [])[0] ?? "";
    const total = Number(
      (page(0).match(/\(\d+\/(\d+)\)/) ?? [])[1] ?? "0",
    );
    expect(total).toBeGreaterThan(1);

    expect(counter(page(0))).toBe(`(1/${total})`);
    expect(counter(page(IV))).toBe(`(2/${total})`);
    // Walk to the end, then keep going: it CLAMPS, never wraps to (1/N).
    const lastDt = (total - 1) * IV;
    expect(counter(page(lastDt))).toBe(`(${total}/${total})`);
    expect(counter(page(lastDt + IV))).toBe(`(${total}/${total})`);
    expect(counter(page(lastDt + 20 * IV))).toBe(`(${total}/${total})`);
    expect(counter(page(86_400_000))).toBe(`(${total}/${total})`);
    // And each page shows DIFFERENT text.
    expect(page(0)).not.toBe(page(IV));
    expect(page(IV)).not.toBe(page(2 * IV));
  });

  it("shows no counter and never animates when the advice fits on one page", () => {
    const b = computeBudgets(200);
    const short = { ...base, detail: "短い詳細です。" };
    const a = buildAdviceBlock(short, b);
    const z = buildAdviceBlock({ ...short, nowMs: short.anchorMs + 999_999 }, b);
    expect(plainOf(a)).not.toMatch(/\(\d+\/\d+\)/);
    expect(a).toBe(z);
  });

  it("stays static on page 1 when scroll is off or no timestamp anchors it", () => {
    const b = computeBudgets(120);
    const late = base.anchorMs + 6 * PAGE_INTERVAL_MS;
    const offA = buildAdviceBlock({ ...base, scroll: false }, b);
    const offB = buildAdviceBlock({ ...base, scroll: false, nowMs: late }, b);
    expect(offA).toBe(offB);
    expect(plainOf(offA)).not.toMatch(/\(\d+\/\d+\)/);

    const noAnchorA = buildAdviceBlock({ ...base, anchorMs: null }, b);
    const noAnchorB = buildAdviceBlock({ ...base, anchorMs: null, nowMs: late }, b);
    expect(noAnchorA).toBe(noAnchorB);
    expect(plainOf(noAnchorA)).not.toMatch(/\(\d+\/\d+\)/);
  });

  it("restarts at page 1 when the advice changes (its timestamp moves)", () => {
    const b = computeBudgets(120);
    const later = base.anchorMs + 2 * PAGE_INTERVAL_MS;
    const old = plainOf(buildAdviceBlock({ ...base, nowMs: later }, b));
    expect(old).toMatch(/\(3\/\d+\)/);
    // A new payload carries a new writtenAt, which becomes the new anchor.
    const fresh = plainOf(
      buildAdviceBlock({ ...base, anchorMs: later, nowMs: later }, b),
    );
    expect(fresh).toMatch(/\(1\/\d+\)/);
  });

  it("renders a before/after example pair without overflowing", () => {
    const b = computeBudgets(120);
    const out = buildAdviceBlock(
      {
        ...base,
        detail: "",
        before: "この関数を直して".repeat(6),
        after: "src/api.ts の validate() の null 分岐を直して".repeat(4),
      },
      b,
    );
    expect(out.split("\n")).toHaveLength(2);
    for (const line of out.split("\n")) {
      expect(displayWidth(plainOf(line))).toBeLessThanOrEqual(b.avail);
    }
    expect(plainOf(out)).toContain("evo advice");
  });
});

// ── B1: the page-flip anchor is CONTENT identity, not write time ────────────
// proxyRuntime runs an unconditional 10s heartbeat and liveState stamps
// `writtenAt: Date.now()` on every write, so anchoring on the payload timestamp
// restarted the sequence every few seconds and pinned the reader to page 1.

describe("adviceIdentityKey", () => {
  it("is stable for identical text and differs for any changed field", () => {
    const k = adviceIdentityKey("a", "d", "b", "af");
    expect(adviceIdentityKey("a", "d", "b", "af")).toBe(k);
    expect(adviceIdentityKey("A", "d", "b", "af")).not.toBe(k);
    expect(adviceIdentityKey("a", "D", "b", "af")).not.toBe(k);
    expect(adviceIdentityKey("a", "d", "B", "af")).not.toBe(k);
    expect(adviceIdentityKey("a", "d", "b", "AF")).not.toBe(k);
  });

  it("is bounded regardless of payload size, and empty when there is nothing to page", () => {
    expect(adviceIdentityKey("x".repeat(200_000), "y".repeat(200_000))).toHaveLength(8);
    expect(adviceIdentityKey("", "")).toBe("");
    expect(adviceIdentityKey("", "", "", "")).toBe("");
  });

  it("does not collide across field boundaries", () => {
    // "ab"+"" and "a"+"b" must differ — the separator has to be real.
    expect(adviceIdentityKey("ab", "")).not.toBe(adviceIdentityKey("a", "b"));
  });
});

describe("page-flip anchored on content identity (B1)", () => {
  const DETAIL =
    "一文目はここで終わります。二文目もここで終わります。三文目もここで終わります。" +
    "四文目もここで終わります。五文目もここで終わります。";
  const b = computeBudgets(120);
  const mk = (anchorMs: number | null, nowMs: number) =>
    plainOf(
      buildAdviceBlock(
        { icon: "💡", color: "", headline: "見出し", detail: DETAIL, anchorMs, nowMs, scroll: true },
        b,
      ),
    );
  const pageOf = (s: string) => Number((s.match(/\((\d+)\/\d+\)/) ?? [])[1] ?? 0);

  const totalPages = Number((mk(1_000_000, 1_000_000).match(/\(\d+\/(\d+)\)/) ?? [])[1] ?? 0);

  it("walks forward when the anchor is STABLE across ticks", () => {
    expect(totalPages).toBeGreaterThan(1);
    const seen = Array.from({ length: totalPages + 2 }, (_, i) =>
      pageOf(mk(1_000_000, 1_000_000 + i * PAGE_INTERVAL_MS)),
    );
    // Every page in order, then clamped on the last.
    const expected = Array.from({ length: totalPages + 2 }, (_, i) =>
      Math.min(i + 1, totalPages),
    );
    expect(seen).toEqual(expected);
  });

  it("is pinned to page 1 when the anchor is RE-STAMPED every tick (the bug)", () => {
    // What `writtenAt` did: the heartbeat moved it, so elapsed was always ~0.
    const seen = [0, 1, 2, 3, 4].map((i) => {
      const now = 1_000_000 + i * PAGE_INTERVAL_MS;
      return pageOf(mk(now, now)); // anchor == now, every tick
    });
    expect(seen).toEqual([1, 1, 1, 1, 1]);
  });

  it("restarts at page 1 only when the CONTENT key changes", () => {
    const k1 = adviceIdentityKey("見出し", DETAIL);
    // Same text seen again later: the key matches, so the stored seenAt is
    // reused and the sequence keeps advancing rather than resetting.
    expect(adviceIdentityKey("見出し", DETAIL)).toBe(k1);
    expect(pageOf(mk(1_000_000, 1_000_000 + (totalPages - 1) * PAGE_INTERVAL_MS))).toBe(totalPages);
    // Different text -> different key -> caller anchors at now -> page 1.
    expect(adviceIdentityKey("別の見出し", DETAIL)).not.toBe(k1);
  });
});

// ── B2: examples are the FINAL page, not a replacement for the detail ───────

describe("detail + examples together (B2)", () => {
  const live = {
    icon: "💡",
    color: "",
    headline: "[汎用] 「直して」だけだと、AIは何をどう直すかを推測するところからスタートしちゃうよ",
    detail:
      "対象ファイルを先に列挙すると精度が上がります。完了条件を一行足すとやり直しが減ります。" +
      "途中経過を短く報告させると方向のズレにすぐ気づけます。",
    before: "なんかエラー出る、直して",
    after: "npm run build で TypeError 返してるっぽい",
    anchorMs: 1_000_000,
    nowMs: 1_000_000,
    scroll: true,
  };

  it("no longer DROPS the detail when examples exist", () => {
    const out = plainOf(buildAdviceBlock(live, computeBudgets(200)));
    expect(out).toContain("対象ファイルを先に列挙");
  });

  it("pages the detail first and shows the examples as the LAST page", () => {
    const b = computeBudgets(120);
    const at = (dt: number) =>
      plainOf(buildAdviceBlock({ ...live, nowMs: live.anchorMs + dt }, b));
    const total = Number((at(0).match(/\(\d+\/(\d+)\)/) ?? [])[1] ?? 0);
    expect(total).toBeGreaterThan(1);

    // First page is detail, not examples.
    expect(at(0)).not.toContain("❌");
    // Final page is the examples.
    const last = at((total - 1) * PAGE_INTERVAL_MS);
    expect(last).toContain("❌");
    expect(last).toContain("✅");
    expect(last).toContain(`(${total}/${total})`);
    // And it stays there.
    expect(at((total + 5) * PAGE_INTERVAL_MS)).toContain(`(${total}/${total})`);
  });

  it("points at `evo advice` when paging is OFF and the detail is dropped", () => {
    // Without paging only one of the two can be shown; the pointer must fire.
    const out = plainOf(buildAdviceBlock({ ...live, scroll: false }, computeBudgets(200)));
    expect(out).toContain("❌");
    expect(out).toContain("evo advice");
  });

  it("keeps every page inside the paintable width", () => {
    for (const cols of [120, 160, 200, 300]) {
      const b = computeBudgets(cols);
      for (let i = 0; i < 8; i++) {
        const out = buildAdviceBlock({ ...live, nowMs: live.anchorMs + i * PAGE_INTERVAL_MS }, b);
        for (const line of out.split("\n")) {
          if (line) expect([cols, displayWidth(plainOf(line)) <= b.avail]).toEqual([cols, true]);
        }
      }
    }
  });
});

// ── S2: decorative chips are budgeted, not severed ──────────────────────────

describe("pushIfFits (S2)", () => {
  it("appends a chip that fits and drops one that does not", () => {
    const bits = ["\x1b[1mabcdefghij\x1b[0m"]; // 10 visible columns
    pushIfFits(bits, "short", 40); // 10 + 3 + 5 = 18 <= 40
    expect(bits).toHaveLength(2);
    pushIfFits(bits, "x".repeat(50), 40); // would overflow → dropped whole
    expect(bits).toHaveLength(2);
  });

  it("drops rather than severing mid-word (the 順調にスター case)", () => {
    const bits = ["🦊 エボにゃん", "○C", "📝62", "育34%"];
    const mood = "順調にスタートしてるね!";
    const before = bits.length;
    pushIfFits(bits, mood, 40);
    // At 40 columns the mood comment cannot fit, so it is absent entirely —
    // never a half-word. If it IS appended, it must be the WHOLE string.
    expect(bits.length === before || bits[bits.length - 1] === mood).toBe(true);
  });
});

// ── Unit: the display-mode file gained an independent scroll flag ───────────

describe("parseDisplaySettings", () => {
  it("keeps the legacy single-token file working (backward compatibility)", () => {
    expect(parseDisplaySettings("expansion")).toEqual({ mode: "expansion", scroll: true });
    expect(parseDisplaySettings("minimum")).toEqual({ mode: "minimum", scroll: true });
    expect(parseDisplaySettings("expansion\n")).toEqual({ mode: "expansion", scroll: true });
  });

  it("reads the scroll flag independently of the mode", () => {
    expect(parseDisplaySettings("expansion scroll:off")).toEqual({ mode: "expansion", scroll: false });
    expect(parseDisplaySettings("minimum scroll:off")).toEqual({ mode: "minimum", scroll: false });
    expect(parseDisplaySettings("scroll:off")).toEqual({ mode: "expansion", scroll: false });
  });

  it("defaults on garbage instead of throwing (fail-open)", () => {
    expect(parseDisplaySettings("")).toEqual({ mode: "expansion", scroll: true });
    expect(parseDisplaySettings("¯\\_(ツ)_/¯")).toEqual({ mode: "expansion", scroll: true });
    expect(parseDisplaySettings(undefined as unknown as string)).toEqual({
      mode: "expansion",
      scroll: true,
    });
  });
});

describe("evo display scroll", () => {
  /** Run `fn` with an isolated mode file and stdout/stderr muted. */
  async function withModeFile(
    initial: string,
    fn: (file: string) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-display-"));
    const file = path.join(dir, ".evo-display-mode");
    fs.writeFileSync(file, initial);
    const prevEnv = process.env.EVO_DISPLAY_MODE_FILE;
    const prevCode = process.exitCode;
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.env.EVO_DISPLAY_MODE_FILE = file;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await fn(file);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      process.exitCode = prevCode;
      if (prevEnv === undefined) delete process.env.EVO_DISPLAY_MODE_FILE;
      else process.env.EVO_DISPLAY_MODE_FILE = prevEnv;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  it("takes the two-word form and leaves the mode alone", async () => {
    // Starts from a pre-existing LEGACY single-token file, exactly as shipped.
    await withModeFile("expansion", async (file) => {
      await runDisplayCommand("scroll", "off");
      expect(fs.readFileSync(file, "utf8")).toBe("expansion scroll:off");
      // Changing the mode must preserve the scroll flag, and vice versa.
      await runDisplayCommand("minimum");
      expect(fs.readFileSync(file, "utf8")).toBe("minimum scroll:off");
      await runDisplayCommand("scroll", "on");
      expect(fs.readFileSync(file, "utf8")).toBe("minimum");
      await runDisplayCommand("scroll", "toggle");
      expect(fs.readFileSync(file, "utf8")).toBe("minimum scroll:off");
    });
  });

  it("accepts the single-token alias but not the dropped ones", async () => {
    await withModeFile("expansion", async (file) => {
      await runDisplayCommand("scroll:off");
      expect(fs.readFileSync(file, "utf8")).toBe("expansion scroll:off");
      // `scroll=off` / `scroll-off` were dropped — they are invalid MODES now.
      await runDisplayCommand("scroll=off");
      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(file, "utf8")).toBe("expansion scroll:off");
    });
  });

  it("reports without writing when no value is given, and rejects garbage", async () => {
    await withModeFile("expansion scroll:off", async (file) => {
      await runDisplayCommand("scroll");
      expect(fs.readFileSync(file, "utf8")).toBe("expansion scroll:off");
      await runDisplayCommand("scroll", "banana");
      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(file, "utf8")).toBe("expansion scroll:off");
    });
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

  it("renders a quiet 待機中 placeholder (never another session's state) when session_id is known but has no fresh per-session file", () => {
    const { home, cwd } = makeTempDirs();
    // A per-session file for a DIFFERENT session must not leak.
    writeSessionFile(cwd, "sid-other", "OtherPet");
    // And a shared legacy sink must not be borrowed either.
    fs.writeFileSync(
      path.join(cwd, ".evo", "live-state.json"),
      JSON.stringify({ nickname: "LegacyPet", updatedAt: Date.now() - 1000 }),
    );
    const { plain } = runStatusline(
      baseStdin(cwd, { session_id: "sid-ghost" }),
      home,
      cwd,
    );
    // Parity with statusline.py: a bound session with no data of its own shows
    // the neutral "待機中" marker — but STILL never another session's state.
    expect(plain).toContain("待機中");
    expect(plain).not.toContain("OtherPet");
    expect(plain).not.toContain("LegacyPet");
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

  it("hard-caps a pathological payload (200KB advice + detail + nickname) at the total-block cap", () => {
    const { home, cwd } = makeTempDirs();
    // Skip the session-start boost so the 200KB advice actually renders (and is
    // capped) instead of being replaced by the first-tick boost message.
    fs.writeFileSync(
      path.join(home, ".claude", ".evo-self-state.json"),
      JSON.stringify({ start: Date.now() / 1000, calls: 5, cwd, ctx_pct: 20 }),
    );
    const dir = path.join(cwd, ".evo", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s1.json"),
      JSON.stringify({
        avatar: "🦊",
        nickname: "猫".repeat(200_000),
        sessionGrade: "A",
        promptScore: 85,
        idealStateGauge: 70,
        signalKind: "tip",
        advice: "x".repeat(200_000),
        adviceDetail: "y".repeat(200_000),
        beforeExample: "b".repeat(200_000),
        afterExample: "a".repeat(200_000),
        sessionId: "s1",
        updatedAt: Date.now() - 1000,
      }),
    );
    const { plain } = runStatusline(baseStdin(cwd, { session_id: "s1" }), home, cwd);
    // Whole rendered EvoPet block (all lines), ANSI already stripped, is bounded
    // by the total-block cap + the appended pointer — never the ~1MB the payload
    // could have flooded.
    const pointerLen = " → 続きは `evo advice`".length;
    expect(plain.length).toBeLessThanOrEqual(EVOPET_BLOCK_MAX_CHARS + pointerLen);
    expect(plain).toContain("evo advice"); // pointer to the full content
  });
});
