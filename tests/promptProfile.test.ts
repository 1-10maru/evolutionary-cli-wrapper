import { describe, expect, it } from "vitest";
import {
  bucketPromptLength,
  createCounterfactualPromptProfile,
  extractPromptProfile,
} from "../src/promptProfile";

describe("prompt profiling", () => {
  it("extracts structure features from a structured prompt", () => {
    const profile = extractPromptProfile(`
- update src/index.ts
- keep formatMessage() behavior
- add tests in tests/index.test.ts
done when vitest passes
    `);

    expect(profile.hasBullets).toBe(true);
    expect(profile.hasFileRefs).toBe(true);
    expect(profile.hasSymbolRefs).toBe(true);
    expect(profile.hasAcceptanceRef).toBe(true);
    expect(profile.hasTestRef).toBe(true);
    expect(profile.structureScore).toBeGreaterThanOrEqual(4);
  });

  it("buckets prompt length deterministically", () => {
    expect(bucketPromptLength(5)).toBe("0-14");
    expect(bucketPromptLength(20)).toBe("15-39");
    expect(bucketPromptLength(60)).toBe("40-79");
    expect(bucketPromptLength(120)).toBe("80+");
  });

  it("creates stronger counterfactual profiles", () => {
    const base = extractPromptProfile("fix it");
    const structured = createCounterfactualPromptProfile(base, "structured_baseline");
    const moreSpecific = createCounterfactualPromptProfile(base, "plus_10_chars_specificity");

    expect(structured.structureScore).toBeGreaterThan(base.structureScore);
    expect(structured.hasBullets).toBe(true);
    expect(moreSpecific.promptLength).toBe(base.promptLength + 10);
  });
});
