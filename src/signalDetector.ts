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

// ── Tips Library: always-on friendly advice for when no signal fires ──
// These rotate based on turn number so the user always sees something new.
// Mix of: official Claude Code tips (JP), common beginner mistakes, prompt patterns, encouragement

export const TIPS_LIBRARY: Array<{
  headline: string;
  detail: string;
  beforeExample?: string;
  afterExample?: string;
}> = [
  // ── プロンプトの書き方 ──
  {
    headline: "「何を・どこを・どうなればOK」の3点セットで指示の精度がグンと上がるよ!",
    detail: "AIは超能力者じゃないから、あなたの頭の中は見えないの。でも「何を変えたいか」「どのファイルか」「どうなれば完了か」の3つを書くだけで、一発で通る確率がめちゃくちゃ上がるよ!",
    beforeExample: "ログイン画面を直して",
    afterExample: "src/Login.tsx のフォーム送信で、空パスワードでもsubmitできるバグを修正。空欄ならボタンをdisabledにして。",
  },
  {
    headline: "ファイル名を1つ書くだけで、AIの探索が半分になるって知ってた?",
    detail: "ファイル名がないと、AIは「どのファイルの話?」ってまずプロジェクト全体を探しに行くの。ファイル名を1つ書くだけで、その探索がまるごと省けるよ。時間もトークンも節約!",
    beforeExample: "バリデーションにメールアドレスのチェックを追加して",
    afterExample: "src/validators.ts にメールアドレスのバリデーションを追加して。@を含まない文字列はエラーにする",
  },
  {
    headline: "箇条書きで指示すると、AIが見落としにくくなるよ!",
    detail: "長い文章で指示すると、AIも人間と同じで後半の条件を見落とすことがあるの。箇条書きで「1. これして 2. これも 3. これはしない」って書くと、漏れが減ってやり直しも減るよ!",
    beforeExample: "ユーザー登録の機能をつくって、メール確認もして、パスワードは8文字以上にして",
    afterExample: "ユーザー登録機能を作成:\n- POST /register エンドポイント追加\n- パスワードは8文字以上でバリデーション\n- 登録後にメール確認リンクを送信\n- テストも書く",
  },
  {
    headline: "「直して」だけだと、AIは何をどう直すかを推測するところからスタートしちゃうよ",
    detail: "「直して」「なんかおかしい」みたいな指示だと、AIはまず「何が壊れてるんだろう?」って調査フェーズに入るの。エラーメッセージやどんな状況で起きるかを一言添えるだけで、調査がスキップできてめちゃ速くなるよ!",
    beforeExample: "なんかエラー出る、直して",
    afterExample: "npm run build で TypeError: Cannot read property 'name' of undefined って出る。src/utils.ts の getUser 関数が null を返してるっぽい",
  },
  {
    headline: "「〜しないで」って制約を伝えるのも大事だよ!",
    detail: "AIは良かれと思って余計なことをしがちなの。「既存のテストは変えないで」「他のファイルは触らないで」って書くだけで、思わぬ変更を防げるよ。",
    beforeExample: "リファクタして",
    afterExample: "src/api.ts の fetchUser 関数をリファクタして。他のファイルは変更しないこと。既存テストが通ること。",
  },
  // ── Claude Code Tips (公式) ──
  {
    headline: "知ってた? /clear でコンテキストをリセットすると、AIの応答が速くなるよ!",
    detail: "会話が長くなると、AIは過去の全部を読み返しながら答えるの。タスクが変わったら /clear でリセットすると、新鮮な状態で高速に応答してくれるよ。トークンの節約にもなる!",
  },
  {
    headline: "CLAUDE.md にプロジェクトのルールを書いておくと、毎回説明しなくて済むよ!",
    detail: "「TypeScriptで書いて」「テストはvitest使って」みたいなお決まりのルールは、プロジェクトのCLAUDE.mdに書いておけばAIが最初から知ってる状態でスタートするよ。毎回言う手間が省ける!",
  },
  {
    headline: "大きなタスクは小さく分割! 一度に全部頼むと精度が下がるよ",
    detail: "「認証機能を全部作って」より「まずログインAPIだけ作って」の方が、AIの出力精度がずっと高いの。1つずつ確認しながら進めると、手戻りが激減するよ!",
    beforeExample: "ECサイトのバックエンドを全部作って",
    afterExample: "まず商品一覧のGET /products APIだけ作って。DBはSQLiteでいい。他の機能は次のターンで頼む",
  },
  {
    headline: "Claudeに「なぜそうしたか」を聞くと、理解が深まるよ!",
    detail: "AIが書いたコードの意図がわからない時は「なんでこの実装にしたの?」って聞いてみて。説明を読むことでコードの理解も深まるし、間違いにも気づきやすくなるよ!",
  },
  {
    headline: "エラーが出たら、エラーメッセージをそのまま貼るのが最速の解決法だよ!",
    detail: "「動かない」より「TypeError: xxx at line 42」って貼る方が、AIは原因に直行できるの。ターミナルのエラーをコピペするだけでOK!",
    beforeExample: "動かないんだけど",
    afterExample: "このエラーが出る:\nTypeError: Cannot read properties of undefined (reading 'map')\n  at UserList (src/UserList.tsx:15:23)",
  },
  {
    headline: "1つの指示で1つのこと。欲張ると精度が落ちるよ!",
    detail: "「あれもこれもそれも」って1つの指示に詰め込むと、AIは全部を同時にやろうとして、どれも中途半端になりがちなの。1つずつ順番にお願いする方が、結果的に速くて確実だよ!",
  },
  // ── よくある失敗パターン ──
  {
    headline: "同じ指示を繰り返しても、同じ結果になるだけだよ!",
    detail: "「直して」→失敗→「直して」→失敗…ってなってない? 同じ言い方を繰り返しても、AIは同じアプローチを取りがち。「さっき○○を試したけどダメだった。△△を試して」って、前回の失敗を伝えると別のルートで解決してくれるよ!",
    beforeExample: "（3回目）直して",
    afterExample: "さっきnullチェックを追加する方法を試したけど、別の箇所でまたnullが出る。getUserById の戻り値の型自体を Optional にする方向で修正して",
  },
  {
    headline: "AIに長いコードを読ませるより、該当箇所を教える方が効率的!",
    detail: "「このファイル全部見て」より「42行目あたりの関数」って指定する方が、AIはピンポイントで対応できるの。行番号やエラーメッセージの行数を添えるだけで、無駄な読み込みが減るよ!",
  },
  {
    headline: "テストを先に書いてもらうと、実装の品質がグンと上がるよ!",
    detail: "「テスト書いて→実装して」の順番で頼むと、AIは先にゴールを理解してから実装するから精度が高くなるの。TDD (テスト駆動開発) をAIにもやらせてみて!",
    beforeExample: "ソート機能を追加して",
    afterExample: "配列をソートする sortByDate 関数を作って。先にテストを書いてから実装して。昇順/降順の両方のケースをカバーすること",
  },
  // ── 励まし・モチベーション系 ──
  {
    headline: "ここまで順調だよ! いい指示の出し方を続けていこう!",
    detail: "プロンプトを意識して書くだけで、AIとの作業効率は劇的に変わるの。最初は面倒に感じるかもしれないけど、慣れると自然にできるようになるよ。その分、もっと難しいことにAIを使えるようになる!",
  },
  {
    headline: "AIは道具じゃなくて、ペアプロのパートナーだよ!",
    detail: "一方的に「やれ」って命令するより、「こういう問題があるんだけど、どう思う?」って相談する方が、AIは良い提案を出しやすいの。質問と指示をうまく混ぜて使ってみて!",
  },
  {
    headline: "指示に迷ったら、まず「今の状況」を書くところから始めよう!",
    detail: "何を頼んでいいかわからない時は、「いまこうなってる」「こうしたい」「でもこれが邪魔してる」の3つを書くだけでOK。AIがそこから最適な方法を提案してくれるよ!",
  },
  {
    headline: "コードの変更後は、動作確認を忘れずに!",
    detail: "AIが「修正しました!」って言っても、実際に動かしてみないと本当に直ったかはわからないの。テスト実行や手動確認をセットで依頼すると安心だよ!",
    beforeExample: "バグ修正して",
    afterExample: "バグ修正して、修正後にnpm testを実行して結果を見せて",
  },
  {
    headline: "わからないことは「わからない」って言っていいんだよ!",
    detail: "AIへの指示で専門用語を使わなくても大丈夫。「ユーザーが登録するやつ」みたいな平易な言い方でもAIは理解できるよ。ただし「どのファイルの」「どの画面の」は具体的に!",
  },
  {
    headline: "完了条件を1つだけ書くだけで、やり直し率が大幅に下がるよ!",
    detail: "「〇〇が通ればOK」「〇〇が表示されれば完了」みたいに、ゴールを1行だけ足すだけでいいの。AIが「いつ止まるか」を判断できて、余計なことをしなくなるよ!",
    beforeExample: "検索機能を追加して",
    afterExample: "検索機能を追加して。完了条件: 検索窓にキーワードを入力したら、一致する結果だけが表示される",
  },
  {
    headline: "Gitでコミットはこまめにね! 巻き戻せる安心感が大事だよ",
    detail: "AIに大きな変更を頼む前に、今の状態をコミットしておくと安心。もし変更がうまくいかなくても、すぐ元に戻せるよ。",
  },
];

/** Pick a tip based on turn number (rotates through the library) */
export function pickTip(turnIndex: number): ActionableAdvice {
  const tip = TIPS_LIBRARY[turnIndex % TIPS_LIBRARY.length];
  return {
    signal: { kind: "first_pass_success", confidence: 0, severity: "low", context: {} },
    headline: tip.headline,
    detail: tip.detail,
    beforeExample: tip.beforeExample,
    afterExample: tip.afterExample,
    category: "praise",
  };
}
