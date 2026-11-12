import { describe, expect, it } from "vitest";
import {
  charWidth,
  displayWidth,
  pickPage,
  splitIntoPages,
  trimToSentence,
  PAGE_INTERVAL_MS,
  REFRESH_INTERVAL_SECONDS,
} from "../../src/cli/statuslineScroll";

// ── TASK F: the 2000–2BFF hole, fixed PRECISELY ─────────────────────────────
// Most of this band is East-Asian *Ambiguous* and renders in ONE column in
// Windows Terminal, so only the Emoji_Presentation=Yes subset is widened.

describe("charWidth in U+2000–U+2BFF", () => {
  it("counts the emoji-presentation symbols this renderer emits as 2 columns", () => {
    expect(charWidth(0x2728)).toBe(2); // ✨ grade S
    expect(charWidth(0x2b50)).toBe(2); // ⭐ grade A
    expect(charWidth(0x274c)).toBe(2); // ❌ before-example
    expect(charWidth(0x2705)).toBe(2); // ✅ after-example
    expect(displayWidth("✨")).toBe(2);
    expect(displayWidth("⭐")).toBe(2);
    expect(displayWidth("❌")).toBe(2);
    expect(displayWidth("✅")).toBe(2);
  });

  it("counts the rest of the standard Emoji_Presentation subset as 2 columns", () => {
    for (const cp of [
      0x231a, 0x231b, 0x23e9, 0x23ec, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648,
      0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4,
      0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd,
      0x270a, 0x270b, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796,
      0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b55,
    ]) {
      expect([cp.toString(16), charWidth(cp)]).toEqual([cp.toString(16), 2]);
    }
  });

  it("leaves AMBIGUOUS symbols at 1 column (they render narrow in Windows Terminal)", () => {
    expect(charWidth(0x2192)).toBe(1); // → separator
    expect(charWidth(0x25cf)).toBe(1); // ● grade B
    expect(charWidth(0x25cb)).toBe(1); // ○ grade C
    expect(charWidth(0x25b3)).toBe(1); // △ grade D
    expect(charWidth(0x26a0)).toBe(1); // ⚠ bare warning sign
  });

  it("keeps ⚠️ (U+26A0 U+FE0F) at 2 columns in total", () => {
    expect(displayWidth("⚠️")).toBe(2);
    expect(displayWidth("⚠️")).toBe(2);
  });

  it("still counts ASCII as 1 and CJK/astral emoji as 2", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("あいう")).toBe(6);
    expect(displayWidth("🦊")).toBe(2);
  });
});

// ── Sentence-preferring truncation ──────────────────────────────────────────

describe("trimToSentence", () => {
  it("prefers the last full stop over a clause comma", () => {
    // trimToSentence receives the ALREADY width-truncated head, so the 40%
    // floor is measured against the budget, not against the untruncated body.
    const s = "最初の文です。次の文は途中";
    expect(trimToSentence(s)).toBe("最初の文です。");
  });

  it("falls back to the clause boundary when a sentence cut keeps too little", () => {
    // The only 。 is 3 chars in — cutting there keeps far under 40% of the text.
    const s = "短い。ここから先がとても長い本文が延々と続いていく内容になっている";
    const out = trimToSentence(s);
    expect(out).not.toBe("短い。");
    expect(out.length).toBeGreaterThan("短い。".length);
  });

  it("handles ASCII sentence enders and text with no boundary at all", () => {
    // "First sentence here." is 20 of 40 columns = 50% >= the 40% floor.
    expect(trimToSentence("First sentence here. and")).toBe(
      "First sentence here.",
    );
    expect(trimToSentence("abcdefghij")).toBe("abcdefghij");
  });
});

// ── splitIntoPages ──────────────────────────────────────────────────────────

describe("splitIntoPages", () => {
  it("returns [] for empty input and [text] when it already fits", () => {
    expect(splitIntoPages("", 40)).toEqual([]);
    expect(splitIntoPages("short", 40)).toEqual(["short"]);
  });

  it("packs whole sentences into pages that fit the budget", () => {
    // Each sentence is 4 ASCII (4 cols) + 。 (2 cols) = 6 cols. A 12-col budget
    // fits exactly two per page.
    const text = "AAAA。BBBB。CCCC。DDDD。";
    const pages = splitIntoPages(text, 12);
    expect(pages).toEqual(["AAAA。BBBB。", "CCCC。DDDD。"]);
    for (const p of pages) expect(displayWidth(p)).toBeLessThanOrEqual(12);
  });

  it("never breaks a page in the middle of a sentence that fits", () => {
    // 18 cols + 42 cols; a 45-col budget holds either alone but not both.
    const text = "一文目はここまで。二文目はもっとずっと長い文章になっている。";
    const pages = splitIntoPages(text, 45);
    expect(pages.length).toBe(2);
    for (const p of pages) {
      expect(p.endsWith("。")).toBe(true);
      expect(displayWidth(p)).toBeLessThanOrEqual(45);
    }
  });

  it("hard-splits a single sentence that is wider than the budget", () => {
    const text = "これは、とても、長い、一つの、文であって、句点が、最後にしか、ありません。";
    const pages = splitIntoPages(text, 20);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(displayWidth(p)).toBeLessThanOrEqual(20);
    // Nothing is lost: joining the pages back reproduces the source glyphs.
    expect(pages.join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
  });

  it("keeps every page inside the budget for a realistic 300-column body", () => {
    const body =
      "Claude Opus 4.8 は、以前のモデルよりもバグの発見が大幅に優れており、" +
      "コードレビューの精度も向上しています。長い調査タスクでは、まず対象" +
      "ファイルを列挙してから読むと安定します。完了条件を一つ書いておくと、" +
      "やり直しの回数が目に見えて減ります。";
    const pages = splitIntoPages(body, 100);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) expect(displayWidth(p)).toBeLessThanOrEqual(100);
  });

  it("terminates on a degenerate budget instead of looping forever", () => {
    const pages = splitIntoPages("あいうえお", 0);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.join("")).toBe("あいうえお");
  });
});

// ── pickPage ────────────────────────────────────────────────────────────────

describe("pickPage", () => {
  const pages = ["p1", "p2", "p3"];
  // Expressed in terms of the constant, so tuning PAGE_INTERVAL_MS does not
  // silently invalidate these expectations.
  const IV = PAGE_INTERVAL_MS;

  it("advances one page per interval from the anchor", () => {
    expect(pickPage(pages, 1000, 1000)).toBe(0);
    expect(pickPage(pages, 1000 + IV - 1, 1000)).toBe(0);
    expect(pickPage(pages, 1000 + IV, 1000)).toBe(1);
    expect(pickPage(pages, 1000 + 2 * IV, 1000)).toBe(2);
  });

  it("CLAMPS to the last page — it never wraps back to page 1", () => {
    expect(pickPage(pages, 1000 + 3 * IV, 1000)).toBe(2);
    expect(pickPage(pages, 1000 + 20 * IV, 1000)).toBe(2);
    expect(pickPage(pages, 1000 + 86_400_000, 1000)).toBe(2);
  });

  it("returns 0 for a single page, an empty list, or a future anchor", () => {
    expect(pickPage(["only"], 999_999, 0)).toBe(0);
    expect(pickPage([], 999_999, 0)).toBe(0);
    expect(pickPage(pages, 1000, 50_000)).toBe(0); // anchor in the future
  });

  it("returns 0 for NaN/Infinity inputs instead of crashing", () => {
    expect(pickPage(pages, Number.NaN, 1000)).toBe(0);
    expect(pickPage(pages, 1000, Number.NaN)).toBe(0);
    expect(pickPage(pages, Number.POSITIVE_INFINITY, 1000)).toBe(0);
    // A bad interval falls back to PAGE_INTERVAL_MS, not to 0 or to a crash.
    const far = 1000 + 5 * IV;
    expect(pickPage(pages, far, 1000, Number.NaN)).toBe(2);
    expect(pickPage(pages, far, 1000, 0)).toBe(2);
    expect(pickPage(pages, far, 1000, -5)).toBe(2);
  });

  it("honours a custom interval", () => {
    expect(pickPage(pages, 1000 + 1000, 1000, 1000)).toBe(1);
    expect(pickPage(pages, 1000 + 1999, 1000, 1000)).toBe(1);
    expect(pickPage(pages, 1000 + 2000, 1000, 1000)).toBe(2);
  });
});

// ── The refresh-cadence invariant ───────────────────────────────────────────
// PAGE_INTERVAL_MS must be >= statusLine.refreshInterval in settings.json. If
// the statusline refreshes LESS often than pages advance, the pages in between
// are never rendered at all — SKIPPED, not delayed, and that text is lost to
// the user. A comment would not survive someone tuning one of the two numbers,
// so the relationship is pinned here.

describe("refresh cadence vs PAGE_INTERVAL_MS", () => {
  /** Page numbers (1-based) a viewer actually sees, ticking every `refreshMs`. */
  function pagesSeen(count: number, refreshMs: number, pageMs: number): number[] {
    const pages = Array.from({ length: count }, (_, i) => String(i + 1));
    const seen: number[] = [];
    // Run well past the end so the clamp is exercised too.
    for (let t = 0; t <= count * pageMs * 2; t += refreshMs) {
      seen.push(pickPage(pages, t, 0, pageMs) + 1);
    }
    return seen;
  }

  const missing = (count: number, seen: number[]): number[] =>
    Array.from({ length: count }, (_, i) => i + 1).filter((p) => !seen.includes(p));

  it("walks every page when the refresh cadence matches PAGE_INTERVAL_MS", () => {
    // This is the shipped configuration: settings.json refreshInterval: 5
    // (5000 ms) paired with PAGE_INTERVAL_MS. Every page must be seen, in
    // order, with none skipped.
    const seen = pagesSeen(6, PAGE_INTERVAL_MS, PAGE_INTERVAL_MS);
    expect(missing(6, seen)).toEqual([]);
    expect(seen.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen[seen.length - 1]).toBe(6); // clamped, never wrapped
  });

  it("still shows every page when the refresh is FASTER (jitter is harmless)", () => {
    // A faster or jittery cadence merely re-renders the same page; nothing is
    // lost. This is the property the wall-clock anchor actually buys.
    for (const refresh of [PAGE_INTERVAL_MS / 2, PAGE_INTERVAL_MS / 5, 250]) {
      const seen = pagesSeen(6, refresh, PAGE_INTERVAL_MS);
      expect([refresh, missing(6, seen)]).toEqual([refresh, []]);
    }
  });

  it("DEMONSTRATES the failure this invariant exists to prevent", () => {
    // Refreshing SLOWER than pages advance drops pages entirely. Pinned as an
    // executable warning: if someone raises refreshInterval past
    // PAGE_INTERVAL_MS, this is what the user gets.
    const seen = pagesSeen(6, 5000, 3000);
    expect(missing(6, seen)).toEqual([3, 5]);
  });

  it("keeps the shipped pair safe for any page count", () => {
    for (const count of [2, 3, 5, 8, 13]) {
      const seen = pagesSeen(count, PAGE_INTERVAL_MS, PAGE_INTERVAL_MS);
      expect([count, missing(count, seen)]).toEqual([count, []]);
    }
  });

  // S4: the comment plus the demonstration above are not enough on their own —
  // nothing in a test can read settings.json. Mirroring the configured refresh
  // as a constant at least makes the ratio assertable.
  it("pins PAGE_INTERVAL_MS >= the configured refreshInterval", () => {
    expect(REFRESH_INTERVAL_SECONDS).toBeGreaterThan(0);
    expect(PAGE_INTERVAL_MS / 1000).toBeGreaterThanOrEqual(REFRESH_INTERVAL_SECONDS);
  });

  it("the bad-interval fallback really is PAGE_INTERVAL_MS, not a literal", () => {
    // Regression: this fell back to a hardcoded 3000 while the default
    // parameter was PAGE_INTERVAL_MS, so the two disagreed and the old test
    // passed only because its inputs scaled with the constant.
    const pages = ["a", "b", "c"];
    const anchor = 1000;
    // One tick short of a full interval: must still be page 0 under EVERY
    // degenerate interval, which is only true if the fallback is the constant.
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect([bad, pickPage(pages, anchor + PAGE_INTERVAL_MS - 1, anchor, bad)]).toEqual([bad, 0]);
      expect([bad, pickPage(pages, anchor + PAGE_INTERVAL_MS, anchor, bad)]).toEqual([bad, 1]);
    }
  });
});

describe("charWidth: TAB is the only under-measure that could overflow", () => {
  it("counts TAB at its worst-case tab stop", () => {
    // Over-measuring is safe (a short line); under-measuring overflows. TAB can
    // expand to 8 columns, so it is measured at 8.
    expect(charWidth(0x09)).toBe(8);
    expect(displayWidth("a\tb")).toBe(10);
  });
});
