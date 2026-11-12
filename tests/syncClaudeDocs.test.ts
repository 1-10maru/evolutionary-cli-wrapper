import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// The sync script is a plain .mjs (no type declarations). It only runs main()
// when invoked directly, so importing it here just exposes the pure functions.
// @ts-ignore -- untyped .mjs module
import {
  extractPromptingGuidance,
  extractBehaviorChanges,
  validateGuidance,
  guidanceContentSignature,
  buildPromptingGuidance,
} from "../scripts/sync-claude-docs.mjs";

const FIXTURE = [
  "# タイトル",
  "",
  "前書きの段落。",
  "",
  "## Claude Fable 5",
  "",
  "このガイダンスは専用ページにあります：[リンク](/x)。",
  "",
  "## 一般原則",
  "",
  "以下は現行のすべてのモデルに適用されます。",
  "",
  "### 明確かつ直接的に",
  "",
  "Claudeは明確で具体的な指示によく反応します。望む出力について具体的に指定してください。",
  "",
  "```text",
  "Create a dashboard",
  "```",
  "",
  "### 例を効果的に使用する",
  "",
  "例は出力形式を誘導する最も信頼性の高い方法の一つです。",
  "",
  "* 関連性を持たせること。",
  "* 多様性を持たせること。",
  "",
  "## サブエージェント生成の制御",
  "",
  "Claudeはデフォルトで生成数が少なめです。明示的なガイダンスを与えてください。簡単な例：",
  "",
  "```text",
  "spawn subagents",
  "```",
].join("\n");

describe("extractPromptingGuidance (fixture)", () => {
  const tips = extractPromptingGuidance(FIXTURE);

  it("skips cross-link pointer sections (専用ページ)", () => {
    expect(tips.some((t: { headline: string }) => t.headline === "Claude Fable 5")).toBe(
      false,
    );
  });

  it("skips container headings that only nest deeper headings", () => {
    expect(tips.some((t: { headline: string }) => t.headline === "一般原則")).toBe(false);
  });

  it("extracts a leaf H3 section and excludes the English code block", () => {
    const t = tips.find((x: { headline: string }) => x.headline === "明確かつ直接的に");
    expect(t).toBeTruthy();
    expect(t.detail).toContain("明確で具体的な指示");
    expect(t.detail).not.toContain("Create a dashboard");
  });

  it("appends the following bullet list to the intro paragraph", () => {
    const t = tips.find((x: { headline: string }) => x.headline === "例を効果的に使用する");
    expect(t).toBeTruthy();
    expect(t.detail).toContain("関連性");
    expect(t.detail).toContain("多様性");
  });

  it("trims a trailing colon lead-in but keeps the full sentence", () => {
    const t = tips.find(
      (x: { headline: string }) => x.headline === "サブエージェント生成の制御",
    );
    expect(t).toBeTruthy();
    expect(t.detail.endsWith("：")).toBe(false);
    expect(t.detail).toContain("明示的なガイダンス");
  });
});

describe("buildPromptingGuidance + validateGuidance", () => {
  const stubMd =
    "# X\n\n## 応答の長さと冗長性\n\nタスクの複雑さに基づいて応答の長さを調整します。十分に説明的な長さを確保してください。\n";

  it("builds a schema-valid guidance object from an injected fetcher", async () => {
    const fetchImpl = async () => stubMd;
    const { guidance, anyOk } = await buildPromptingGuidance(fetchImpl);
    expect(anyOk).toBe(true);
    expect(() => validateGuidance(guidance)).not.toThrow();
    expect(guidance.sections.base.tips.length).toBeGreaterThan(0);
  });

  it("content signature ignores timestamps (stable across identical runs)", async () => {
    const fetchImpl = async () => stubMd;
    const a = await buildPromptingGuidance(fetchImpl);
    const b = await buildPromptingGuidance(fetchImpl);
    expect(guidanceContentSignature(a.guidance)).toBe(
      guidanceContentSignature(b.guidance),
    );
  });

  it("rejects an oversized detail via validateGuidance", () => {
    const bad = {
      version: 1,
      generatedAt: "now",
      modelPatterns: [{ pattern: "fable", flags: "i", section: "fable" }],
      sections: {
        base: {
          label: "",
          sourceUrl: "x",
          fetchedAt: "now",
          contentHash: "abc",
          tips: [{ headline: "h", detail: "あ".repeat(1000) }],
        },
      },
    };
    expect(() => validateGuidance(bad)).toThrow();
  });
});

describe("committed prompting-guidance asset", () => {
  it("parses and passes validateGuidance (schema + size cap)", () => {
    const assetPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "data",
      "prompting-guidance.json",
    );
    const guidance = JSON.parse(readFileSync(assetPath, "utf-8"));
    expect(() => validateGuidance(guidance)).not.toThrow();
    expect(guidance.sections.base.tips.length).toBeGreaterThan(0);
  });
});

describe("extractBehaviorChanges (What's new → 動作の違い)", () => {
  const BULLETS = [
    "# Claude Fable 5.2の新機能",
    "",
    "## 破壊的変更",
    "",
    "* **これは破壊的変更なので拾わない。** 本文はここにあります。十分な長さです。",
    "",
    "## 動作の違い",
    "",
    "Claude Fable 5.2のいくつかの動作は、コードを変更しなくても現れます。",
    "",
    "* **思考を減らすよう求めるプロンプトの記述では、`medium`以上のeffortでモデルの思考は止まりません。** Claude Fable 5.1は通常、[記述](/x)に従います。エフォートを下げてください。[エフォートを調整する](/y)を参照してください。",
    "* **作業が完了する前にターンが終わることがあります。** 長いタスクでは残作業を示して止まることがあります。",
    "",
    "```text",
    "* **コード内の箇条書きは拾わない。** 説明説明説明説明。",
    "```",
    "",
    "## 料金",
    "",
    "* **料金の箇条書きも拾わない。** 本文はここにあります。十分な長さです。",
  ].join("\n");

  it("takes only the 動作の違い bullets, bold lead = headline", () => {
    const tips = extractBehaviorChanges(BULLETS);
    expect(tips.map((t: { headline: string }) => t.headline)).toEqual([
      "思考を減らすよう求めるプロンプトの記述では、medium以上のeffortでモデルの思考は止まり…",
      "作業が完了する前にターンが終わることがあります",
    ]);
  });

  it("strips links/backticks and the dangling 「…を参照してください。」 pointer", () => {
    const [first] = extractBehaviorChanges(BULLETS);
    expect(first.detail).toContain("Claude Fable 5.1は通常、記述に従います。");
    expect(first.detail).not.toContain("](");
    expect(first.detail).not.toContain("参照してください");
  });

  it("handles the ### sub-heading shape (動作の変更)", () => {
    const md = [
      "## 新機能",
      "",
      "### 何か新しい",
      "",
      "これは新機能の説明で、動作の変更ではありません。十分な長さの本文を持っています。",
      "",
      "## 動作の変更",
      "",
      "### 応答が思考ブロックで始まる場合があります",
      "",
      "適応型思考はデフォルトでオンになっているため、応答が思考ブロックで始まる場合があります。最初のブロックを前提にしないでください。",
      "",
      "## 次のステップ",
    ].join("\n");
    const tips = extractBehaviorChanges(md);
    expect(tips).toHaveLength(1);
    expect(tips[0].headline).toBe("応答が思考ブロックで始まる場合があります");
  });

  it("returns [] when the page has no 動作の違い section", () => {
    expect(extractBehaviorChanges("# X\n\n## 料金\n\n* **a** b\n")).toEqual([]);
  });
});

describe("validateGuidance — changes block", () => {
  const sec = (extra: object = {}) => ({
    label: "Fable 5.2のコツ",
    sourceUrl: "u",
    fetchedAt: "now",
    contentHash: "h",
    tips: [{ headline: "h", detail: "d".repeat(20) }],
    ...extra,
  });
  const mk = (changes: unknown) => ({
    version: 1,
    generatedAt: "now",
    modelPatterns: [{ pattern: "fable-5-2", flags: "i", section: "fable-5-2" }],
    sections: { base: sec(), "fable-5-2": sec({ changes }) },
  });
  const good = {
    label: "Fable 5.1→5.2",
    sourceUrl: "https://x/whats-new-fable-5-2.md",
    fetchedAt: "now",
    contentHash: "h",
    tips: [{ headline: "h", detail: "d".repeat(20) }],
  };

  it("accepts a well-formed changes block", () => {
    expect(() => validateGuidance(mk(good))).not.toThrow();
  });
  it("rejects a label without the → separator", () => {
    expect(() => validateGuidance(mk({ ...good, label: "Fable 5.2" }))).toThrow();
  });
  it("rejects an empty or oversized changes block", () => {
    expect(() => validateGuidance(mk({ ...good, tips: [] }))).toThrow();
    expect(() =>
      validateGuidance(mk({ ...good, tips: Array.from({ length: 7 }, () => good.tips[0]) })),
    ).toThrow();
  });
});

describe("committed guidance asset — 5.x lineup", () => {
  const asset = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "prompting-guidance.json"),
      "utf-8",
    ),
  );
  it("carries a Fable 5.1→5.2 changes block sourced from the official What's new page", () => {
    const ch = asset.sections["fable-5-2"].changes;
    expect(ch.label).toBe("Fable 5.1→5.2");
    expect(ch.sourceUrl).toBe(
      "https://platform.claude.com/docs/ja/models/fable-5-2/whats-new-fable-5-2.md",
    );
    expect(ch.tips.length).toBeGreaterThan(0);
  });
  it("orders every point-release pattern above its generation pattern", () => {
    const order = asset.modelPatterns.map((p: { section: string }) => p.section);
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before("fable-5-2", "fable-5");
    before("fable-5-1", "fable-5");
    before("opus-5-5", "opus-5");
    before("sonnet-5-5", "sonnet-5");
  });
});
