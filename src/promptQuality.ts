/**
 * Prompt-quality scoring for conversational Japanese direction.
 *
 * WHY THIS EXISTS
 * ---------------
 * EvoPet's own advice tells the user
 * 「何を・どこを・どうなればOKの3点セットで指示の精度がグンと上がるよ!」 — but the
 * previous rubric measured whether a `/` or a `.ts` appeared, with two 30-or-0
 * cliffs. Real messages therefore piled at exactly 0 and 38, and a precise,
 * well-scoped instruction written in plain Japanese scored zero. The advice and
 * the measure disagreed. This scores the three axes the product actually
 * teaches, plus structure as a minor term.
 *
 * DESIGN RULES (do not regress these)
 *  - Every axis is GRADED (0 -> partial -> full). No all-or-nothing terms: they
 *    are what produced the bimodal 0/38 distribution.
 *  - There is NO raw length term. A long rambling message must not out-score a
 *    short precise one, so target evidence is counted as DISTINCT referents
 *    (deduped), never as mentions.
 *  - Vague input must still score near zero. 「なおして」「これおかしい」「やって」
 *    carry no referent, no done-condition and no reason, so they land at 0.
 *  - Symbols are evidence, not the definition. Katakana product nouns and kanji
 *    compounds count as referents so that symbol-free Japanese can score high.
 *  - TONE IS NOT SCORED, EVER. This measures instruction quality, not
 *    politeness. A message that opens with an insult and continues into a
 *    precise correction is a GOOD instruction and must score as one. Do not add
 *    a civility/sentiment term here — that decision is deliberate, not an
 *    oversight (team ruling, kept explicit so nobody "fixes" it later).
 *  - Fail-open: any regex/parse failure degrades to the legacy score path and
 *    never throws (this runs on the statusline hot path).
 *
 * CALIBRATION CAVEAT (carry this forward — it bounds every number quoted in
 * this file): the calibration corpus is one project dir, one user, 80 scored
 * messages, mostly Japanese. The 46-47% contamination figure is sound for that
 * sample, not a general rate.
 */

/** Axis sub-scores, each 0..1. Multiplied by the weights below. */
export interface PromptQualityAxes {
  /** 何を / どこを — is the thing to act on identified? */
  target: number;
  /** どうなればOK — done-condition, bound, or explicit constraint. */
  acceptance: number;
  /** なぜ — stated reason / intent. */
  context: number;
  /** Structural formatting. Deliberately minor: prose can be excellent. */
  structure: number;
}

export interface PromptQuality {
  /** 0-100, same scale and bands as before. */
  score: number;
  axes: PromptQualityAxes;
  /** Distinct referents found (deduped, for tests and diagnostics). */
  targetTokens: string[];
  // Legacy feature booleans consumed by signalDetector.
  hasFileRefs: boolean;
  hasSymbolRefs: boolean;
  hasAcceptanceRef: boolean;
  hasTestRef: boolean;
  /** 0-5, preserved because signalDetector tests `structureScore >= 4`. */
  structureScore: number;
}

/** Hard input bound — see the note in computePromptQuality. */
export const MAX_SCORED_CHARS = 8000;

export const AXIS_WEIGHTS = {
  target: 35,
  acceptance: 35,
  context: 15,
  structure: 15,
} as const;

/**
 * Generic words that name no particular thing. Without this list,
 * 「エラーを直して」 would read as a specified target — it is not, it is
 * 「なおして」 with a generic noun attached.
 */
const GENERIC_NOUNS = new Set([
  "エラー", "テスト", "コード", "ファイル", "データ", "システム", "ツール", "バグ",
  "メッセージ", "ログ", "モード", "サイト", "ページ", "アプリ", "デザイン",
  "問題", "場合", "状態", "内容", "方法", "部分", "今回", "全部", "自分", "確認",
  "対応", "修正", "作業", "実装", "感じ", "説明", "結果", "状況",
  "必要", "可能", "使用", "利用", "追加", "削除", "変更", "処理", "表示",
]);

const EN_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "not", "but",
  "from", "have", "has", "was", "were", "are", "can", "will", "should", "would",
  "please", "make", "made", "use", "used", "all", "any", "get", "got", "let",
  "its", "into", "out", "now", "then", "than", "when", "what", "why",
  "how", "who", "which", "them", "they", "there", "here", "some", "more",
]);

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.length > 0))];
}

function matches(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const rx = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const captured = m.slice(1).find((g) => typeof g === "string" && g.length > 0);
    out.push((captured ?? m[0]).trim());
    if (m.index === rx.lastIndex) rx.lastIndex += 1; // guard zero-width matches
  }
  return out;
}

/** Graded step: map an evidence count to a 0..1 axis score. */
function grade(count: number, steps: readonly number[]): number {
  if (count <= 0) return 0;
  return steps[Math.min(count, steps.length) - 1];
}

// 何を / どこを
const RE_PATH = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[a-z]{1,5}\b/;
const RE_BACKTICK = /`([^`]{1,60})`/;
const RE_QUOTED = /「([^」]{1,60})」|"([^"]{1,60})"/;
const RE_SYMBOL = /[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z][a-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*\(\)/;
const RE_NUMERIC = /#\d+|\d+\s*(?:件|個|回|行|文字|秒|分|時間|%|ms|px|MB|KB)|v?\d+\.\d+(?:\.\d+)?/;
const RE_KATAKANA = /[ァ-ヶ][ァ-ヶー]{2,}/;
const RE_ASCII_WORD = /[A-Za-z][A-Za-z0-9_.-]{2,}/;
/** Kanji compound acting as a noun (followed by a case particle). */
const RE_KANJI_NOUN = /([一-鿿]{2,})(?:の|を|が|は|に|へ|で)/;
/** Deixis: pointing at something instead of naming it. */
const RE_DEMONSTRATIVE = /(これ|それ|あれ|この|その|あの|さっき|例の|ここ)/;
/**
 * Course correction. 「AではなくB」 narrows what was meant, so it sharpens the
 * target rather than merely expressing disagreement — steering an agent off a
 * wrong path is direction, and the old rubric scored it as noise.
 */
const RE_CORRECTION = /(?:違う|ちがう|そうじゃなく|じゃなくて|ではなく|でなく|逆で)/;
/** A quoted line (＞ or >), i.e. material the user is citing rather than writing. */
const RE_QUOTE_LINE = /^\s*[>＞]/;

/**
 * How much of a message is quoted material, 0..1 by non-space character count,
 * plus the original (non-quoted) remainder.
 *
 * Quoting a specific line back IS targeting — "this line, here" is the clearest
 * possible referent — so quotes count. But a message that is mostly quotation
 * with no independent referent of its own is scoring on the other party's
 * words, so the caller caps the axis rather than awarding it in full.
 */
function splitQuoted(text: string): { quotedRatio: number; original: string } {
  const lines = text.split(/\r?\n/);
  let quoted = 0;
  let total = 0;
  const originalLines: string[] = [];
  for (const line of lines) {
    const n = line.replace(/\s/g, "").length;
    total += n;
    if (RE_QUOTE_LINE.test(line)) quoted += n;
    else originalLines.push(line);
  }
  return {
    quotedRatio: total > 0 ? quoted / total : 0,
    original: originalLines.join("\n"),
  };
}

function collectTargets(text: string): {
  tokens: string[];
  hasFileRefs: boolean;
  hasSymbolRefs: boolean;
} {
  const paths = matches(text, RE_PATH);
  const symbols = matches(text, RE_SYMBOL);
  // Strong referents: unambiguous names. Collected first so that weaker
  // evidence overlapping them can be discarded.
  const strong = uniq([
    ...paths,
    ...matches(text, RE_BACKTICK),
    ...matches(text, RE_QUOTED),
    ...symbols,
    ...matches(text, RE_NUMERIC),
  ]);
  // Weak referents: nouns that name something only in context.
  const weak = uniq([
    ...matches(text, RE_KATAKANA).filter((t) => !GENERIC_NOUNS.has(t)),
    ...matches(text, RE_ASCII_WORD).filter((t) => !EN_STOPWORDS.has(t.toLowerCase())),
    ...matches(text, RE_KANJI_NOUN).filter((t) => !GENERIC_NOUNS.has(t)),
  ]);
  // One referent must count ONCE. "src/foo.ts" otherwise yields three tokens
  // (the path, plus "src" and "foo.ts" as ASCII words) and a single file
  // reference reaches full target credit on its own — the exact
  // count-the-symbols failure this rubric exists to replace.
  const distinct = [
    ...strong,
    ...weak.filter((w) => !strong.some((s) => s.includes(w))),
  ];
  // A correction counts as one piece of targeting evidence: it says which of
  // two readings is meant.
  if (RE_CORRECTION.test(text)) distinct.push("__correction__");
  return {
    tokens: distinct,
    hasFileRefs: paths.length > 0,
    hasSymbolRefs: symbols.length > 0,
  };
}

// どうなればOK — a done-condition, a bound, or a constraint that bounds the work.
//
// CALIBRATION NOTE (do not re-add the bare function words): 「まで」「以上」
// 「だけ」「のみ」 were in this list and accounted for the ONLY acceptance credit
// in 11 of 35 crediting messages — none of which stated a done-condition.
// 「そこまでは分かったので…」 scored 49 against a corpus median of 35 on the
// strength of a particle. They are ordinary connectives in Japanese, not
// completion criteria. 「以内」 stays because a bound with a unit really is one,
// and the contextual forms (〜になるまで / 通るまで) stay because the surrounding
// verb is what makes them a condition.
const ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  /(?:ように|ような状態|なれば|になったら|になるまで)/,
  /(?:以内)/,
  /(?:ゼロ|0件|全部|すべて|全て|一つも|ひとつも|漏れなく|残さず|完全に)/,
  /(?:出なくなる|なくなるまで|通るまで|直るまで|通れば|落ちない|消える)/,
  /(?:したい|してほしい|ほしい|ゴールは|目標は)/,
  /(?:完了|done|passes|passing|accept|通れ|通る|OK)/i,
  /(?:するな|しないで|せずに|触るな|触らないで|禁止|以外は|変えずに)/,
];
/**
 * The subset that constitutes a real, stated done-condition or constraint —
 * used for `hasAcceptanceRef`, which gates coaching, and therefore held to a
 * stricter bar than the graded score. Currently every acceptance pattern
 * qualifies; the list is kept separate so that adding a looser pattern to the
 * score cannot silently start suppressing advice.
 */
const STRONG_ACCEPTANCE: readonly RegExp[] = ACCEPTANCE_PATTERNS;

const RE_TEST = /(?:test|テスト|spec|assert|検証|ゲート)/i;

// なぜ — a STATED reason, at full weight; a causal particle, at half.
//
// CALIBRATION NOTE: this axis fired 9 times in the corpus and all 9 came from
// 「ので/ため/だから」, zero from 「理由/目的/原因」. It was measuring a
// conjunctive particle, not an explanation, so the particle family is now
// worth half. 「そこまでは分かったので」 is a connective; 「回帰を防ぐ目的で」
// is a reason.
const RE_CONTEXT_EXPLICIT = /(?:理由|目的|なぜなら|背景|原因|意図)/;
const RE_CONTEXT_PARTICLE = /(?:ので|ため(?:に|の)?|だから)/;

// 構造
function countStructureMarkers(text: string): number {
  const lines = text.split(/\r?\n/);
  const has = (re: RegExp): number => (lines.some((l) => re.test(l)) ? 1 : 0);
  let markers = 0;
  markers += has(/^\s*[-*•・]\s+\S/);
  markers += has(/^\s*\d+[.)、]\s*\S/);
  markers += has(/^\s*#{1,6}\s+\S/);
  markers += has(/^\s*【.+】/);
  markers += lines.filter((l) => l.trim().length > 0).length >= 3 ? 1 : 0;
  return markers;
}

/**
 * Clauses that acknowledge, approve or thank — never an instruction.
 *
 * Deliberately NOT here: 「やって」「なおして」「これおかしい」. Those ARE
 * directives, just vague ones, and they must keep scoring low. If excluding
 * the unmeasurable also excused the vague, the metric would be worthless.
 * 「進めて」「続けて」 are continuations of already-agreed work, so they are
 * acknowledgements; that line is fine-grained but deliberate.
 */
const ACK_CLAUSE_PATTERNS: readonly RegExp[] = [
  /^(?:ok|okay|oki|おk|おｋ|オッケー|オーケー|オケ|了解|了解です|了解しました|承知|承知しました|わかった|わかりました|りょ|はい|うん|ええ|yes|yep|thx|thanks|thank you|ありがと[うー]?|ありがとうございます|サンキュー|どうも)$/i,
  /^(?:いいよ|いいね|いい|それでいい|大丈夫|問題ない|そうして|それで)$/,
  /^\d*\s*(?:で|が)?いい$/,
  /^(?:進めて|進めろ|続けて|続行|どうぞ|go|ゴー|再開)$/i,
  /^(?:たのむ|頼む|お願いします|お願いする|お願い|おねがい|よろしく|よろしくお願いします)$/,
];

/**
 * True when a message is an acknowledgement / approval / thanks rather than an
 * instruction. Such a message must be skipped entirely — NOT scored zero —
 * because scoring 「ok」 as a bad instruction is what dragged the session mean
 * down. Guarded two ways so it cannot swallow real direction: the message must
 * be short, and EVERY clause must match a fixed ack literal — so
 * 「了解。src/a.ts を直して」 keeps its second clause and is still scored.
 * (An earlier version also required the message to name nothing. That guard was
 * redundant — ack literals contain no names — and it misfired on 「オッケー」 and
 * 「了解です」, which the referent detector reads as nouns.)
 *
 * LIMITATION (pure local heuristics, no model): a short answer to a question
 * the assistant asked (「3番」「東京」) is indistinguishable from a terse
 * directive without dialogue state, so it is still scored. Detecting that
 * would need a model, which is forbidden.
 */
export function isNonDirective(text: string): boolean {
  try {
    const t = (typeof text === "string" ? text : "").trim();
    if (!t || t.length > 30) return false;
    const clauses = t
      .split(/[、。,.!！?？\s]+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (clauses.length === 0) return false;
    return clauses.every((c) => ACK_CLAUSE_PATTERNS.some((re) => re.test(c)));
  } catch {
    return false; // fail-open: when unsure, score it
  }
}

/**
 * Clauses that are pure praise, thanks, or a bare success report — never a
 * request. Skipped rather than scored: praise is not a bad instruction, it is
 * not an instruction.
 *
 * WHITELIST, NOT BLACKLIST — and that direction is the whole lesson here. The
 * first attempt enumerated request FORMS and excluded anything lacking one.
 * Japanese imperatives are open-class, so it silently dropped ~10 genuine
 * instructions from the real corpus: 「元に戻せクズ」 (戻せ was not in the verb
 * list), 「mdよめカス」, 「reviewer の手順: 1. gh auth switch…」. A dropped
 * instruction is invisible in every histogram — it just quietly stops counting.
 * Defaulting to SCORE and excluding only on a positive match cannot do that.
 */
const NON_REQUEST_CLAUSE_PATTERNS: readonly RegExp[] = [
  /^(?:ありがと[うー]?|ありがとうございます|ありがとうございました|感謝|助かった|助かります|thanks|thank you|thx)$/i,
  /^(?:すごい|すげえ|さすが|素晴らしい|完璧|いい感じ|よくやった|good|nice|great|perfect|excellent)$/i,
  /^(?:できました|直りました|動きました|通りました|成功しました|問題なかった|うまくいった)$/,
];

/**
 * True when a message makes no request of any kind — praise, thanks, a status
 * report, a bare observation. Such a message is excluded from the window
 * instead of scored, because it is not an instruction.
 *
 * LIMITATION, stated plainly: this gate removes NON-instructions. It cannot
 * remove a deliberately gamed instruction — a keyword salad that contains a
 * real request form and real referents is, to any purely local heuristic,
 * indistinguishable from a terse real instruction. Detecting intent would need
 * a model, which is forbidden here.
 */
export function isNonRequest(text: string): boolean {
  try {
    const t = (typeof text === "string" ? text : "").trim();
    if (!t || t.length > 60) return false;
    // An interrogative asks for something, so it is a request regardless.
    if (/[?？]/.test(t)) return false;
    const clauses = t
      .split(/[、。,.!！\s]+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (clauses.length === 0) return false;
    return clauses.every((c) => NON_REQUEST_CLAUSE_PATTERNS.some((re) => re.test(c)));
  } catch {
    return false; // fail-open: when unsure, score it
  }
}

/** The pre-v3.8 formula, kept verbatim as the fail-open fallback. */
export function legacyPromptScore(text: string): number {
  const hasFileRefs = /\.[a-z]{1,5}\b/i.test(text) || /\//g.test(text);
  const hasAcceptanceRef = /完了|done|accept|pass|通[れる]|OK/.test(text);
  const hasSymbolRefs = /[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]+|\(\)/.test(text);
  const hasTestRef = /test|テスト|spec|assert/.test(text);
  const bullets = (text.match(/^[-*•]\s/gm) ?? []).length;
  const numbered = (text.match(/^\d+\.\s/gm) ?? []).length;
  const structureScore = Math.min(
    5,
    bullets + numbered + (hasAcceptanceRef ? 1 : 0) + (hasFileRefs ? 1 : 0),
  );
  const structurePart = Math.min(40, (structureScore / 5) * 40);
  const specificityPart = hasFileRefs || hasSymbolRefs ? 30 : 0;
  const verificationPart = hasAcceptanceRef || hasTestRef ? 30 : 0;
  return Math.round(structurePart + specificityPart + verificationPart);
}

/**
 * Score one user message 0-100 across the four axes. Never throws: on any
 * internal failure it falls back to the legacy formula.
 */
export function computePromptQuality(text: string): PromptQuality {
  try {
    // Bound the input before any regex touches it. RE_PATH's `(?:[\w.-]+\/)+`
    // and RE_SYMBOL degrade quadratically on a long ASCII run with no match
    // (measured: 4k chars 50ms, 16k 950ms, 50k 7.9s) and this runs
    // SYNCHRONOUSLY on the same event loop that relays the child's stdio, so a
    // large slash-free paste would freeze the user's CLI. Truncation cannot
    // change a score by design: length is explicitly not a term in this rubric.
    const t = (typeof text === "string" ? text : "").slice(0, MAX_SCORED_CHARS);
    const { tokens, hasFileRefs, hasSymbolRefs } = collectTargets(t);

    // A message that only points ("これ直して") names nothing. Deixis does not
    // subtract, but it cannot substitute for a referent either.
    const targetCount = tokens.length;
    let target = grade(targetCount, [0.5, 0.8, 1]);
    if (target > 0 && targetCount === 1 && RE_DEMONSTRATIVE.test(t)) {
      target = 0.35; // one weak referent plus deixis: only partly specified
    }
    // Quotation cap: quoting IS targeting, but when the message is mostly the
    // other party's words and the user's own text names nothing independently,
    // the referents came from the quote. Award partial credit, not full.
    const { quotedRatio, original } = splitQuoted(t);
    if (quotedRatio >= 0.5 && collectTargets(original).tokens.length === 0) {
      target = Math.min(target, 0.5);
    }

    const acceptanceHits = ACCEPTANCE_PATTERNS.filter((re) => re.test(t)).length;
    const acceptance = grade(acceptanceHits, [0.6, 0.85, 1]);

    // Explicit reason at full weight, bare causal particle at half.
    const context = RE_CONTEXT_EXPLICIT.test(t)
      ? 1
      : RE_CONTEXT_PARTICLE.test(t)
        ? 0.5
        : 0;

    const structureMarkers = countStructureMarkers(t);
    const structure = grade(structureMarkers, [0.4, 0.7, 1]);

    const score = Math.round(
      target * AXIS_WEIGHTS.target +
        acceptance * AXIS_WEIGHTS.acceptance +
        context * AXIS_WEIGHTS.context +
        structure * AXIS_WEIGHTS.structure,
    );

    return {
      score: Math.max(0, Math.min(100, score)),
      axes: { target, acceptance, context, structure },
      targetTokens: tokens,
      hasFileRefs,
      hasSymbolRefs,
      // Must reflect a GENUINE done-condition, because signalDetector uses it
      // to suppress the `no_success_criteria` coaching. While 「まで」/「だけ」
      // were in the acceptance list, a bare particle silenced the advice that
      // tells the user to state a done-condition — for 11 of 35 messages. The
      // loose patterns are gone; this is asserted against the strong families
      // directly so a future loose addition cannot silently re-break it.
      hasAcceptanceRef: STRONG_ACCEPTANCE.some((re) => re.test(t)),
      hasTestRef: RE_TEST.test(t),
      structureScore: Math.round(structure * 5),
    };
  } catch {
    const score = legacyPromptScore(typeof text === "string" ? text : "");
    return {
      score,
      axes: { target: 0, acceptance: 0, context: 0, structure: 0 },
      targetTokens: [],
      hasFileRefs: false,
      hasSymbolRefs: false,
      hasAcceptanceRef: false,
      hasTestRef: false,
      structureScore: 0,
    };
  }
}
