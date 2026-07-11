import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// The sync script is a plain .mjs (no type declarations). It only runs main()
// when invoked directly, so importing it here just exposes the pure functions.
// @ts-ignore -- untyped .mjs module
import {
  extractPromptingGuidance,
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
