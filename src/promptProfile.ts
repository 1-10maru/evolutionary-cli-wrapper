import { PromptProfile } from "./types";
import { hashText } from "./utils/hash";

const FILE_REF_RE =
  /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|sh|yaml|yml|toml|rs|go|java|rb)\b/g;
const SYMBOL_REF_RE =
  /(?:`?[A-Za-z_][A-Za-z0-9_]*`?\s*(?:\(|::|#|\.))|(?:\b[A-Za-z_][A-Za-z0-9_]*\(\))/g;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+/m;
const CONSTRAINT_RE = /\b(must|should|only|without|avoid|don't|do not|required|必ず|のみ|禁止|避け|使わない)\b/i;
const ACCEPTANCE_RE = /\b(done when|success|acceptance|ship when|完了条件|成功条件|受け入れ条件)\b/i;
const TEST_RE = /\b(test|tests|pytest|vitest|jest|spec|unit test|integration test|テスト)\b/i;

export function bucketPromptLength(length: number): string {
  if (length < 15) return "0-14";
  if (length < 40) return "15-39";
  if (length < 80) return "40-79";
  return "80+";
}

export function extractPromptProfile(promptText?: string): PromptProfile {
  const prompt = (promptText ?? "").trim();
  const hasBullets = BULLET_RE.test(prompt);
  const fileMatches = prompt.match(FILE_REF_RE) ?? [];
  const symbolMatches = prompt.match(SYMBOL_REF_RE) ?? [];
  const hasConstraintRef = CONSTRAINT_RE.test(prompt);
  const hasAcceptanceRef = ACCEPTANCE_RE.test(prompt);
  const hasTestRef = TEST_RE.test(prompt);

  const structureScore = [
    hasBullets,
    fileMatches.length > 0,
    symbolMatches.length > 0,
    hasConstraintRef,
    hasAcceptanceRef || hasTestRef,
  ].filter(Boolean).length;

  return {
    promptHash: hashText(prompt),
    promptLength: prompt.length,
    promptLengthBucket: bucketPromptLength(prompt.length),
    structureScore,
    hasBullets,
    hasFileRefs: fileMatches.length > 0,
    hasSymbolRefs: symbolMatches.length > 0,
    hasConstraintRef,
    hasAcceptanceRef,
    hasTestRef,
    targetSpecificityScore: fileMatches.length + symbolMatches.length + Number(hasConstraintRef),
    preview: prompt.slice(0, 160),
  };
}

export function createCounterfactualPromptProfile(
  profile: PromptProfile,
  kind: "structured_baseline" | "plus_10_chars_specificity" | "with_test_intent",
): PromptProfile {
  if (kind === "structured_baseline") {
    const promptLength = Math.max(profile.promptLength, 60);
    return {
      ...profile,
      promptHash: hashText(`${profile.promptHash}:${kind}`),
      promptLength,
      promptLengthBucket: bucketPromptLength(promptLength),
      structureScore: Math.max(profile.structureScore, 4),
      hasBullets: true,
      hasFileRefs: true,
      hasAcceptanceRef: true,
      targetSpecificityScore: Math.max(profile.targetSpecificityScore, 3),
    };
  }

  if (kind === "plus_10_chars_specificity") {
    const promptLength = profile.promptLength + 10;
    return {
      ...profile,
      promptHash: hashText(`${profile.promptHash}:${kind}`),
      promptLength,
      promptLengthBucket: bucketPromptLength(promptLength),
      structureScore: Math.min(5, profile.structureScore + 1),
      hasFileRefs: profile.hasFileRefs || profile.hasSymbolRefs,
      targetSpecificityScore: profile.targetSpecificityScore + 1,
    };
  }

  return {
    ...profile,
    promptHash: hashText(`${profile.promptHash}:${kind}`),
    structureScore: Math.min(5, profile.structureScore + 1),
    hasTestRef: true,
    hasAcceptanceRef: true,
    targetSpecificityScore: profile.targetSpecificityScore + 1,
  };
}
