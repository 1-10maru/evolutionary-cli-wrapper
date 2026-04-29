/**
 * Pure data exports for the EvoPet statusline subcommand.
 *
 * COMMENTS and TIPS are auto-extracted verbatim from
 * ~/.claude/base_statusline.py (pre-slim HEAD version) — see
 * statusline-data-raw.ts for the raw extraction.
 *
 * BOOST_MESSAGES, polarity sets, and grade label/color maps are ported
 * from the same Python source. Do NOT add or remove entries without
 * explicit user instruction — content is curated.
 */

import { COMMENTS_DATA, TIPS_DATA } from "./statusline-data-raw";

export type Mood = "start" | "early" | "working" | "busy" | "critical";

export const ANSI = {
  R: "\x1b[0m",
  DIM: "\x1b[2m",
  BOLD: "\x1b[1m",
  EVO_ACCENT: "\x1b[38;2;180;130;255m",
  EVO_INFO: "\x1b[38;2;100;200;255m",
  EVO_WARN: "\x1b[38;2;255;200;80m",
  EVO_GREEN: "\x1b[38;2;120;220;120m",
  EVO_RED: "\x1b[38;2;255;100;100m",
  EVO_GOLD: "\x1b[38;2;255;215;0m",
} as const;

/** SEP for joining line-1 bits — ` · ` in dim. */
export const SEP = ` ${ANSI.DIM}·${ANSI.R} `;

/** Session-start boost rotation (12 entries). Selected by floor(now_s) % 12. */
export const BOOST_MESSAGES: readonly string[] = [
  "\u{1f680} さあ始めよう! まずは今日のゴールを言語化するところから",
  "\u{1f9ed} 実装の前にPlanning、これだけで成果物の質が段違いになる",
  "\u{1f3af} 「何を・どこを・どうなればOK」の3点を最初に渡すと一発で通る確率が跳ね上がる",
  "\u{1f4cb} 大きなタスクは小さく分割、1指示=1ゴールに絞ると精度が上がる",
  "\u{1f4ce} ファイル名・関数名を1つ書くだけで、AIの探索コストが半分になる",
  "\u{1f50d} 曖昧な「直して」より、エラーメッセージをそのまま貼るのが最速の解決ルート",
  "⚖️ 「やらないこと」を先に伝えると、スコープ拡大事故を防げる",
  "\u{1f9ea} 完了条件を1つ書くだけで、やり直し率が大幅に下がる",
  "\u{1f504} 同じ指示を繰り返しても結果は変わらない。前提か制約を変えて伝え直そう",
  "\u{1f4ac} 迷ったらまず「現状」を書く。状況共有が指示の精度を底上げする",
  "\u{1f9d0} 提案を受けたら「なぜそう判断したか」を聞くと、AIの思考が透けて見える",
  "\u{1f9f9} 長くなってきたら/clearでリセット。コンテキストは有限資源、軽い方が精度は上がる",
];

export const COMMENTS: Readonly<Record<Mood, readonly string[]>> = COMMENTS_DATA;

export type Tip = {
  headline: string;
  before: string | null;
  after: string | null;
};

export const TIPS: readonly Tip[] = TIPS_DATA;

export function gradeColor(g: string): string {
  const map: Record<string, string> = {
    S: ANSI.EVO_ACCENT,
    A: ANSI.EVO_GREEN,
    B: ANSI.EVO_INFO,
    C: ANSI.EVO_WARN,
    D: ANSI.EVO_RED,
  };
  return map[g] ?? ANSI.EVO_INFO;
}

export function gradeLabel(g: string): string {
  const map: Record<string, string> = {
    S: "✨S 神",
    A: "⭐A 上手",
    B: "● B 良好",
    C: "○ C 標準",
    D: "△ D がんばろう",
  };
  return map[g] ?? g;
}

export const POSITIVE_SIGNALS: ReadonlySet<string> = new Set([
  "good_structure",
  "first_pass_success",
  "improving_trend",
]);

export const NEGATIVE_SIGNALS: ReadonlySet<string> = new Set([
  "prompt_too_vague",
  "same_file_revisit",
  "same_function_revisit",
  "scope_creep",
  "no_success_criteria",
  "approval_fatigue",
  "error_spiral",
  "retry_loop",
  "high_tool_ratio",
]);

export const POSITIVE_GRADES: ReadonlySet<string> = new Set(["S", "A", "B"]);
export const NEGATIVE_GRADES: ReadonlySet<string> = new Set(["D"]);

/** Suppress grade label when grade polarity contradicts signal polarity. */
export function gradeContradicts(grade: string, signal: string): boolean {
  return (
    (POSITIVE_GRADES.has(grade) && NEGATIVE_SIGNALS.has(signal)) ||
    (NEGATIVE_GRADES.has(grade) && POSITIVE_SIGNALS.has(signal))
  );
}

export function pickMoodPool(ctx: number): readonly string[] {
  if (ctx >= 80) return COMMENTS.critical;
  if (ctx >= 60) return COMMENTS.busy;
  if (ctx >= 30) return COMMENTS.working;
  if (ctx >= 10) return COMMENTS.early;
  return COMMENTS.start;
}
