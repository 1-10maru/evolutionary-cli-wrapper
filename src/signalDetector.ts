import {
  ActionableAdvice,
  AdviceConfig,
  AdviceSignal,
  AdviceSignalKind,
  EpisodeComplexity,
  EpisodeSummary,
  FrictionSummary,
  LoopSignals,
  NudgeCategory,
  NudgeSeverity,
  PromptProfile,
} from "./types";

// ── Signal detection from turn-level data ──

export interface SignalDetectionInput {
  promptProfile: PromptProfile;
  complexity: EpisodeComplexity;
  loopSignals: LoopSignals;
  friction: FrictionSummary;
  firstPassGreen: boolean;
  retryCount: number;
  turnIndex: number;
  recentStructureScores: number[];
  config: AdviceConfig;
}

export interface LiveSignalInput {
  turns: number;
  toolCalls: number;
  sessionStartMs: number;
  lastTool: string;
  lastFile: string;
  filePatchCounts: Map<string, number>;
  symbolTouchCounts: Map<string, number>;
  promptLength: number;
  hasFileRefs: boolean;
  hasSymbolRefs: boolean;
  hasAcceptanceRef: boolean;
  hasTestRef: boolean;
  structureScore: number;
  firstPassGreen: boolean;
  config: AdviceConfig;
}

function pickVariant(seed: number, variants: string[]): string {
  return variants[Math.abs(seed) % variants.length];
}

// ── Full signal detection (turn-level, used by scoring.ts) ──

export function detectSignals(input: SignalDetectionInput): AdviceSignal[] {
  const signals: AdviceSignal[] = [];
  const pp = input.promptProfile;
  const cfg = input.config;

  // prompt_too_vague
  if (
    pp.promptLength < cfg.vaguePromptThreshold &&
    !pp.hasFileRefs &&
    !pp.hasSymbolRefs
  ) {
    signals.push({
      kind: "prompt_too_vague",
      confidence: 0.9,
      severity: "medium",
      context: { promptLength: pp.promptLength },
    });
  }

  // same_file_revisit (via loop signals + complexity)
  if (input.loopSignals.editLoop) {
    const touchedIds = input.loopSignals.touchedStableSymbolIds;
    signals.push({
      kind: "same_function_revisit",
      confidence: 0.85,
      severity: "high",
      context: { symbolCount: touchedIds.length, symbols: touchedIds.slice(0, 3) },
    });
  }

  if (input.loopSignals.searchLoop) {
    signals.push({
      kind: "retry_loop",
      confidence: 0.8,
      severity: "high",
      context: {},
    });
  }

  // scope_creep
  if (
    input.complexity.changedFilesCount >= cfg.scopeCreepFileThreshold ||
    input.complexity.attentionEntropy >= cfg.scopeCreepEntropyThreshold
  ) {
    signals.push({
      kind: "scope_creep",
      confidence: 0.75,
      severity: "medium",
      context: {
        changedFiles: input.complexity.changedFilesCount,
        entropy: input.complexity.attentionEntropy,
      },
    });
  }

  // no_success_criteria
  if (
    !pp.hasAcceptanceRef &&
    !pp.hasTestRef &&
    pp.promptLength >= 40
  ) {
    signals.push({
      kind: "no_success_criteria",
      confidence: 0.7,
      severity: "low",
      context: {},
    });
  }

  // approval_fatigue
  if (input.friction.approvalBurst >= 3) {
    signals.push({
      kind: "approval_fatigue",
      confidence: 0.85,
      severity: "medium",
      context: { burst: input.friction.approvalBurst },
    });
  }

  // error_spiral
  if (input.friction.toolFailureStreak >= 2) {
    signals.push({
      kind: "error_spiral",
      confidence: 0.8,
      severity: "high",
      context: { streak: input.friction.toolFailureStreak },
    });
  }

  // good_structure (praise)
  if (pp.structureScore >= 4 && input.firstPassGreen) {
    signals.push({
      kind: "good_structure",
      confidence: 0.9,
      severity: "low",
      context: { structureScore: pp.structureScore },
    });
  }

  // first_pass_success (praise)
  if (input.retryCount === 0 && input.firstPassGreen && input.turnIndex <= 1) {
    signals.push({
      kind: "first_pass_success",
      confidence: 0.95,
      severity: "low",
      context: {},
    });
  }

  // improving_trend
  const scores = input.recentStructureScores;
  if (
    scores.length >= 3 &&
    scores[scores.length - 1] > scores[scores.length - 2] &&
    scores[scores.length - 2] > scores[scores.length - 3]
  ) {
    signals.push({
      kind: "improving_trend",
      confidence: 0.7,
      severity: "low",
      context: { recentScores: scores.slice(-3) },
    });
  }

  return signals;
}

// ── Lightweight signal detection (live JSONL-based, for proxyRuntime) ──

export function detectLiveSignals(input: LiveSignalInput): AdviceSignal[] {
  const signals: AdviceSignal[] = [];
  const elapsedMin = (Date.now() - input.sessionStartMs) / 60_000;
  const cfg = input.config;

  // prompt_too_vague
  if (
    input.promptLength > 0 &&
    input.promptLength < cfg.vaguePromptThreshold &&
    !input.hasFileRefs &&
    !input.hasSymbolRefs
  ) {
    signals.push({
      kind: "prompt_too_vague",
      confidence: 0.85,
      severity: "medium",
      context: { promptLength: input.promptLength, lastFile: input.lastFile },
    });
  }

  // same_file_revisit
  for (const [file, count] of input.filePatchCounts) {
    if (count >= cfg.sameFileRevisitThreshold) {
      signals.push({
        kind: "same_file_revisit",
        confidence: 0.8,
        severity: "high",
        context: { file, touchCount: count },
      });
      break; // one is enough
    }
  }

  // same_function_revisit
  for (const [symbol, count] of input.symbolTouchCounts) {
    if (count >= 2) {
      signals.push({
        kind: "same_function_revisit",
        confidence: 0.85,
        severity: "high",
        context: { symbol, touchCount: count },
      });
      break;
    }
  }

  // high_tool_ratio
  if (input.turns >= 8 && input.toolCalls / Math.max(input.turns, 1) > 5) {
    signals.push({
      kind: "high_tool_ratio",
      confidence: 0.7,
      severity: "medium",
      context: { turns: input.turns, toolCalls: input.toolCalls },
    });
  }

  // scope_creep
  if (input.filePatchCounts.size >= cfg.scopeCreepFileThreshold) {
    signals.push({
      kind: "scope_creep",
      confidence: 0.7,
      severity: "medium",
      context: { fileCount: input.filePatchCounts.size },
    });
  }

  // no_success_criteria
  if (
    !input.hasAcceptanceRef &&
    !input.hasTestRef &&
    input.promptLength >= 40
  ) {
    signals.push({
      kind: "no_success_criteria",
      confidence: 0.65,
      severity: "low",
      context: {},
    });
  }

  // long_session_no_commit
  if (elapsedMin > 30) {
    signals.push({
      kind: "long_session_no_commit",
      confidence: 0.6,
      severity: "low",
      context: { elapsedMin: Math.round(elapsedMin) },
    });
  }

  // good_structure (praise)
  if (input.structureScore >= 4 && input.firstPassGreen) {
    signals.push({
      kind: "good_structure",
      confidence: 0.85,
      severity: "low",
      context: { structureScore: input.structureScore },
    });
  }

  // first_pass_success
  if (input.firstPassGreen && input.turns <= 1) {
    signals.push({
      kind: "first_pass_success",
      confidence: 0.9,
      severity: "low",
      context: {},
    });
  }

  return signals;
}

// ── Priority: higher severity signals first, then higher confidence ──

function signalPriority(signal: AdviceSignal): number {
  const severityWeight: Record<NudgeSeverity, number> = { high: 3, medium: 2, low: 1 };
  return severityWeight[signal.severity] * 10 + signal.confidence * 10;
}

export function pickTopSignal(signals: AdviceSignal[]): AdviceSignal | null {
  if (signals.length === 0) return null;
  return [...signals].sort((a, b) => signalPriority(b) - signalPriority(a))[0];
}

// ── Before/After example generation ──

interface BeforeAfterPair {
  before: string;
  after: string;
}

function generateBeforeAfter(signal: AdviceSignal): BeforeAfterPair | null {
  const ctx = signal.context;
  const lastFile = typeof ctx.lastFile === "string" ? ctx.lastFile : "";
  const file = typeof ctx.file === "string" ? ctx.file : lastFile;
  const symbol = typeof ctx.symbol === "string" ? ctx.symbol : "";
  const touchCount = typeof ctx.touchCount === "number" ? ctx.touchCount : 0;

  switch (signal.kind) {
    case "prompt_too_vague":
      return {
        before: "直して",
        after: file
          ? `${file} の該当関数でエラーになるケースを修正。現状: ○○が起きる / 期待: ○○になるべき`
          : "対象ファイルと関数を指定して、現状/期待/NG条件を分けて伝える",
      };

    case "same_file_revisit":
      return {
        before: `${file || "対象ファイル"} を直して`,
        after: `${file || "対象ファイル"} の修正。現状: ○○ / 期待: ○○ / NG: 他の処理に影響しないこと`,
      };

    case "same_function_revisit":
      return {
        before: `${file || "ファイル"} のバグ直して`,
        after: `${file || "ファイル"} の ${symbol || "関数名"} で ○○ が ${touchCount} 回直らない。現状: ○○ / 期待: ○○ / 試したこと: ○○`,
      };

    case "scope_creep":
      return {
        before: "全体的にリファクタして",
        after: "まず ○○.ts の △△関数だけリファクタ。他のファイルは次のターンで",
      };

    case "no_success_criteria":
      return {
        before: "APIに認証を追加して",
        after: "APIに認証追加。完了条件: POST /login がJWT返す、GET /protected がトークンなしで401、テスト通る",
      };

    case "approval_fatigue":
      return {
        before: "（毎回ツール承認を手動でクリック）",
        after: "allowlist に追加するか、指示を1つにまとめて承認回数を減らす",
      };

    case "high_tool_ratio":
      return {
        before: "バグ直して（→AIが10ファイル読んで探索）",
        after: "src/api.ts:42 の getUserById で null を返すバグを修正して（→直接対象へ）",
      };

    default:
      return null;
  }
}

// ── Headline generation (replaces mood labels) ──

function signalHeadline(signal: AdviceSignal): string {
  const ctx = signal.context;
  const file = typeof ctx.file === "string" ? shortPath(ctx.file) : "";
  const touchCount = typeof ctx.touchCount === "number" ? ctx.touchCount : 0;

  switch (signal.kind) {
    case "prompt_too_vague":
      return "ファイル名を足そう — 曖昧だと探索が広がるよ";
    case "same_file_revisit":
      return file
        ? `${file} ${touchCount}回目 — 現状/期待/NGで整理しよう`
        : "同じファイルを何度も修正中 — 整理して伝えよう";
    case "same_function_revisit":
      return "同じ関数にまた来たよ — 現状/期待/NGで切り直そう";
    case "scope_creep":
      return "散らばりすぎ — 1ファイルに絞ろう";
    case "no_success_criteria":
      return "完了条件を1行足そう";
    case "approval_fatigue":
      return "承認ラッシュ — allowlistか指示整理";
    case "error_spiral":
      return "エラー連鎖中 — 別アプローチを試そう";
    case "retry_loop":
      return "ぐるぐるリトライ中 — 切り直そう";
    case "good_structure":
      return "この頼み方、かなりハマってる!";
    case "first_pass_success":
      return "一発で通った! その調子!";
    case "improving_trend":
      return "上達してる! いい傾向!";
    case "long_session_no_commit":
      return "30分超 — そろそろコミットしよう";
    case "high_tool_ratio":
      return "ツール多用中 — 対象を具体的に指定しよう";
  }
}

function signalDetail(signal: AdviceSignal): string {
  const ctx = signal.context;
  const file = typeof ctx.file === "string" ? ctx.file : "";
  const touchCount = typeof ctx.touchCount === "number" ? ctx.touchCount : 0;

  switch (signal.kind) {
    case "prompt_too_vague":
      return "プロンプトが短すぎて、AIが何を直すか推測する必要があります。対象ファイルと関数を指定するだけで、探索の寄り道を大幅に減らせます。";
    case "same_file_revisit":
      return `${file || "同じファイル"} を${touchCount}回修正しています。「現状: Xが起きる / 期待: Yになるべき / NG: Zは変えない」の形で伝えると、ループから抜けやすくなります。`;
    case "same_function_revisit":
      return "同じ関数を複数回修正しているのは、AIに伝わっていないサインです。「試したこと」「なぜダメだったか」を含めて再指示してみてください。";
    case "scope_creep":
      return "変更が多くのファイルに散らばっています。1ファイルずつ区切って依頼すると、各ステップの精度が上がります。";
    case "no_success_criteria":
      return "完了条件がないと、AIは「いつ終わりか」を判断できません。「○○が通ればOK」を1行足すだけで、無駄なやり直しを減らせます。";
    case "approval_fatigue":
      return "承認が連続しています。allowlistに追加するか、1つの指示にまとめることで作業フローがスムーズになります。";
    case "error_spiral":
      return "エラーが連続しています。同じアプローチを繰り返すより、一度立ち止まって別の方法を試す方が早く解決できます。";
    case "retry_loop":
      return "リトライが続いています。問題を「現状 / 期待 / NG条件」に分解して、新しいアプローチで切り直してみてください。";
    case "good_structure":
      return "構造化された指示が一発で通りました。箇条書き + 完了条件の形がうまく機能しています。この調子で!";
    case "first_pass_success":
      return "最初のターンで一発成功! プロンプトの具体性と構造がちょうどいいバランスです。";
    case "improving_trend":
      return "直近のプロンプトで構造スコアが上昇傾向です。意識して構造化するほど、AIの応答精度が上がっています。";
    case "long_session_no_commit":
      return "長時間作業しています。こまめにコミットしておくと、問題が起きた時の巻き戻しが楽になります。";
    case "high_tool_ratio":
      return "ターンあたりのツール使用量が多いです。対象ファイルや関数を具体的に指定すると、AIの探索が絞られてトークン消費を抑えられます。";
  }
}

function signalCategory(kind: AdviceSignalKind): NudgeCategory {
  switch (kind) {
    case "prompt_too_vague":
      return "specificity";
    case "same_file_revisit":
    case "same_function_revisit":
    case "retry_loop":
    case "error_spiral":
      return "recovery";
    case "scope_creep":
      return "exploration_focus";
    case "no_success_criteria":
      return "verification";
    case "approval_fatigue":
      return "scope_control";
    case "good_structure":
    case "first_pass_success":
    case "improving_trend":
      return "praise";
    case "long_session_no_commit":
    case "high_tool_ratio":
      return "structure";
  }
}

function shortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : filePath;
}

// ── Main entry: convert signals to actionable advice ──

export function generateActionableAdvice(
  signals: AdviceSignal[],
): ActionableAdvice[] {
  return signals.map((signal) => {
    const pair = generateBeforeAfter(signal);
    return {
      signal,
      headline: signalHeadline(signal),
      detail: signalDetail(signal),
      beforeExample: pair?.before,
      afterExample: pair?.after,
      category: signalCategory(signal.kind),
    };
  });
}

export function generateTopAdvice(
  signals: AdviceSignal[],
): ActionableAdvice | null {
  const top = pickTopSignal(signals);
  if (!top) return null;
  const pair = generateBeforeAfter(top);
  return {
    signal: top,
    headline: signalHeadline(top),
    detail: signalDetail(top),
    beforeExample: pair?.before,
    afterExample: pair?.after,
    category: signalCategory(top.kind),
  };
}
