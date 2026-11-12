/**
 * Pure text measurement + sentence paging for the EvoPet statusline.
 *
 * Everything here is side-effect free (no fs, no env, no clock reads) so the
 * page-flip behaviour can be unit tested by passing an explicit `nowMs`.
 *
 * Width primitives live here rather than in statusline.ts so that the paging
 * code can measure text without importing the renderer (which would create an
 * import cycle). `statusline.ts` re-exports `displayWidth` for compatibility.
 */

// ── Character width ─────────────────────────────────────────────────────────
// East-Asian wide + emoji code points occupy 2 terminal columns. A single-byte
// slice cuts through multi-column glyphs, so all truncation is measured in
// display columns.

/**
 * Emoji_Presentation=Yes code points inside U+2000–U+2BFF.
 *
 * This band is NOT uniformly wide: most of it is East-Asian *Ambiguous*
 * (→ U+2192, ● U+25CF, ○ U+25CB, △ U+25B3, bare ⚠ U+26A0) and renders in ONE
 * column in Windows Terminal. Only the code points that default to emoji
 * presentation render in two, so the table is an explicit allow-list rather
 * than a blanket range.
 */
const EMOJI_PRESENTATION_2000_2BFF: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], // watch, hourglass
  [0x23e9, 0x23ec], // fast-forward / rewind / up / down
  [0x25fd, 0x25fe], // small squares
  [0x2614, 0x2615], // umbrella, hot beverage
  [0x2648, 0x2653], // zodiac
  [0x267f, 0x267f], // wheelchair
  [0x2693, 0x2693], // anchor
  [0x26a1, 0x26a1], // high voltage
  [0x26aa, 0x26ab], // medium circles
  [0x26bd, 0x26be], // soccer, baseball
  [0x26c4, 0x26c5], // snowman, sun behind cloud
  [0x26ce, 0x26ce], // ophiuchus
  [0x26d4, 0x26d4], // no entry
  [0x26ea, 0x26ea], // church
  [0x26f2, 0x26f3], // fountain, golf
  [0x26f5, 0x26f5], // sailboat
  [0x26fa, 0x26fa], // tent
  [0x26fd, 0x26fd], // fuel pump
  [0x2705, 0x2705], // check mark button  (emitted by this renderer)
  [0x270a, 0x270b], // raised fist, raised hand
  [0x2728, 0x2728], // sparkles           (emitted by this renderer: grade S)
  [0x274c, 0x274c], // cross mark         (emitted by this renderer)
  [0x274e, 0x274e], // cross mark button
  [0x2753, 0x2755], // question / exclamation marks
  [0x2757, 0x2757], // exclamation mark
  [0x2795, 0x2797], // plus, minus, divide
  [0x27b0, 0x27b0], // curly loop
  [0x27bf, 0x27bf], // double curly loop
  [0x2b1b, 0x2b1c], // large squares
  [0x2b50, 0x2b50], // star               (emitted by this renderer: grade A)
  [0x2b55, 0x2b55], // hollow red circle
];

function isEmojiPresentation2000(cp: number): boolean {
  if (cp < 0x2000 || cp > 0x2bff) return false;
  for (const [lo, hi] of EMOJI_PRESENTATION_2000_2BFF) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function charWidth(cp: number): number {
  // TAB expands to a tab stop (up to 8 columns), and under-measuring is the
  // only direction that can overflow a line — so count it at its worst case.
  // Combining marks / ZWJ / skin-tone modifiers over-measure, which is safe.
  if (cp === 0x09) return 8;
  // U+FE0F (VS16) is deliberately NOT special-cased: it falls through to the
  // default 1 below, which is what keeps an emoji-presented ambiguous symbol
  // at a total of 2 columns (bare U+26A0 = 1, plus VS16 = 1, so the pair "⚠️"
  // measures 2). Making VS16 zero-width would silently shrink it to 1.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    isEmojiPresentation2000(cp) || // Emoji_Presentation subset of 2000-2BFF
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Hard slice to at most `maxCols` display columns (never mid-glyph). */
export function truncateToWidth(s: string, maxCols: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > maxCols) break;
    out += ch;
    w += cw;
  }
  return out;
}

const CLAUSE_BOUNDARY = /^(.*[、。，．・:：/!?！？\s])[^、。，．・:：/!?！？\s]*$/u;
// ASCII "." is deliberately EXCLUDED: it appears inside version numbers
// ("Opus 4.8") and file paths ("src/utils.ts"), so treating it as a sentence
// end would split those mid-token. English advice therefore pages on ! and ?
// only, and otherwise falls back to the clause/width split. Do not "fix" this
// by adding "." without handling those cases.
const SENTENCE_END = /[。．！？!?]/u;

/** Back off to the last clause/word boundary, if that keeps most of the text. */
export function trimToBoundary(s: string): string {
  const m = s.match(CLAUSE_BOUNDARY);
  if (m && displayWidth(m[1]) >= displayWidth(s) * 0.5) {
    return m[1].replace(/[\s、。，．・:：]+$/u, "");
  }
  return s;
}

/**
 * Back off to the last SENTENCE end (。．!?！？) inside `s`, falling back to the
 * clause boundary when a sentence cut would throw away most of the budget.
 *
 * `trimToBoundary` treats a clause comma the same as a full stop, so the detail
 * line reliably landed mid-sentence. Detail text uses this instead.
 */
export function trimToSentence(s: string, minKeepRatio = 0.4): string {
  const total = displayWidth(s);
  let lastEnd = -1;
  let idx = 0;
  for (const ch of s) {
    idx += ch.length;
    if (SENTENCE_END.test(ch)) lastEnd = idx;
  }
  if (lastEnd > 0) {
    const head = s.slice(0, lastEnd);
    if (displayWidth(head) >= total * minKeepRatio) return head;
  }
  return trimToBoundary(s);
}

// ── Sentence paging ─────────────────────────────────────────────────────────

/** Split on sentence ends, KEEPING the delimiter with its sentence. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    cur += ch;
    if (SENTENCE_END.test(ch)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Take a `budget`-wide head off `s`, preferring a clause boundary. */
function splitHead(s: string, budget: number): { head: string; consumed: number } {
  const raw = truncateToWidth(s, budget);
  if (!raw) {
    // Budget narrower than the first glyph: emit it anyway so we always advance.
    const first = Array.from(s)[0] ?? "";
    return { head: first, consumed: first.length };
  }
  const m = raw.match(CLAUSE_BOUNDARY);
  if (m && displayWidth(m[1]) >= displayWidth(raw) * 0.5) {
    return { head: m[1].replace(/\s+$/u, ""), consumed: m[1].length };
  }
  return { head: raw, consumed: raw.length };
}

/**
 * Split `text` into pages that each fit `budgetCols` display columns.
 *
 * Sentences are packed greedily so a page break never falls mid-sentence; a
 * single sentence wider than the budget is hard-split at the clause boundary.
 */
export function splitIntoPages(text: string, budgetCols: number): string[] {
  if (typeof text !== "string" || text === "") return [];
  const budget =
    Number.isFinite(budgetCols) && budgetCols >= 1 ? Math.floor(budgetCols) : 1;
  if (displayWidth(text) <= budget) return [text];

  const pages: string[] = [];
  let cur = "";
  const flush = (): void => {
    if (cur) {
      pages.push(cur);
      cur = "";
    }
  };

  for (const sentence of splitSentences(text)) {
    if (displayWidth(sentence) > budget) {
      flush();
      let rest = sentence;
      // Guard against a pathological zero-consumption loop.
      let guard = 0;
      while (displayWidth(rest) > budget && guard++ < 10_000) {
        const { head, consumed } = splitHead(rest, budget);
        if (consumed <= 0) break;
        pages.push(head);
        rest = rest.slice(consumed).replace(/^\s+/u, "");
      }
      if (rest) cur = rest;
      continue;
    }
    const candidate = cur + sentence;
    if (displayWidth(candidate) <= budget) {
      cur = candidate;
    } else {
      flush();
      cur = sentence;
    }
  }
  flush();
  return pages.length > 0 ? pages : [text];
}

/**
 * How long one page of advice stays on screen.
 *
 * ── INVARIANT — DO NOT TUNE THIS ALONE ────────────────────────────────────
 * This MUST be >= the `statusLine.refreshInterval` configured in
 * ~/.claude/settings.json (currently 5). The two numbers are a matched pair.
 *
 * The page index is computed from the wall clock, so the renderer shows
 * whatever page the clock has reached at the moment it happens to run. If the
 * statusline refreshes LESS often than pages advance, the intervening pages
 * are never rendered at all — they are SKIPPED, not merely delayed, and the
 * user silently loses that text forever. Measured with 6 pages:
 *
 *   refresh 3s / page 3s -> shows [1,2,3,4,5,6,6,6,6]  skips none
 *   refresh 5s / page 3s -> shows [1,2,4,6,6,6]        SKIPS 3 and 5
 *   refresh 5s / page 5s -> shows [1,2,3,4,5,6]        skips none
 *
 * Raising refreshInterval without raising this constant therefore breaks the
 * feature quietly. `pickPage > walks every page when the refresh cadence
 * matches PAGE_INTERVAL_MS` in tests/cli/statuslineScroll.test.ts pins the
 * relationship — a comment alone would not survive someone tuning one number.
 *
 * (Refresh cadence JITTER is fine and always was: an early tick re-renders the
 * same page, a late one lands on the correct later page. Only a cadence
 * SLOWER than this constant loses pages.)
 */
export const PAGE_INTERVAL_MS = 5000;

/**
 * The `statusLine.refreshInterval` this build is paired with, in SECONDS.
 *
 * settings.json is hand-rolled on this machine and `evo install-statusline`
 * deliberately refuses to touch it, so nothing can read the real value at
 * runtime. Mirroring it here at least makes the pair checkable by a test
 * (`PAGE_INTERVAL_MS / 1000 >= REFRESH_INTERVAL_SECONDS`) instead of resting on
 * a comment. If you change settings.json, change this too — the test will not
 * catch that drift, but the next person reading either file will see both.
 */
export const REFRESH_INTERVAL_SECONDS = 5;

/**
 * Which page to show right now.
 *
 * The index comes from the WALL CLOCK (`nowMs - anchorMs`), not from a counter,
 * so jitter in the refresh cadence never skips a page (see the invariant on
 * PAGE_INTERVAL_MS for the cadence that DOES). It is CLAMPED to the last page —
 * the text stops moving once it has all been shown instead of looping forever.
 * When the advice changes, its payload timestamp changes, which naturally
 * restarts the sequence at page 1.
 */
export function pickPage(
  pages: readonly unknown[],
  nowMs: number,
  anchorMs: number,
  intervalMs = PAGE_INTERVAL_MS,
): number {
  const n = Array.isArray(pages) ? pages.length : 0;
  if (n <= 1) return 0;
  if (!Number.isFinite(nowMs) || !Number.isFinite(anchorMs)) return 0;
  const interval =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : PAGE_INTERVAL_MS;
  const elapsed = nowMs - anchorMs;
  if (!(elapsed > 0)) return 0;
  const idx = Math.floor(elapsed / interval);
  if (!Number.isFinite(idx) || idx <= 0) return 0;
  return Math.min(idx, n - 1);
}
