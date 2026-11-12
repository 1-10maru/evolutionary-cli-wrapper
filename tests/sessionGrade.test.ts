// Live-grade windowing (approved plan item #3): the grade's prompt half must
// reflect the SESSION (rolling promptScore window), not the latest message.
// Before this, computeLiveGrade consumed liveState.promptScore — assigned
// fresh per prompt — so a single terse message pinned the letter at D.

import { describe, expect, it } from "vitest";
import { computeLiveGrade, meanPromptScore } from "../src/sessionGrade";

function gradeFor(window: number[] | undefined, fallback = 0): string {
  const promptScore = meanPromptScore(window) ?? fallback;
  return computeLiveGrade({
    promptScore,
    turns: 20,
    toolCalls: 60,
    firstPassGreen: false,
    comboCount: 0,
  }).grade;
}

describe("meanPromptScore", () => {
  it("returns the rounded mean of the window", () => {
    expect(meanPromptScore([38, 38, 70])).toBe(49);
    expect(meanPromptScore([70])).toBe(70);
  });
  it("returns null for an empty / absent / non-array window", () => {
    expect(meanPromptScore([])).toBeNull();
    expect(meanPromptScore(undefined)).toBeNull();
    expect(meanPromptScore(null)).toBeNull();
    expect(meanPromptScore(42 as unknown as number[])).toBeNull();
  });
  it("ignores non-finite entries and clamps to 0-100", () => {
    expect(meanPromptScore([50, NaN, 70])).toBe(60);
    expect(meanPromptScore([Number.POSITIVE_INFINITY])).toBeNull();
    expect(meanPromptScore([500, 500])).toBe(100);
    expect(meanPromptScore([-40, -40])).toBe(0);
  });
});

describe("live grade reads the session window", () => {
  it("a window of low scores still earns D", () => {
    expect(gradeFor([0, 0, 5, 0])).toBe("D");
  });

  it("a window of high scores earns a letter above D", () => {
    const grade = gradeFor([90, 95, 100, 90]);
    expect(grade).not.toBe("D");
    expect(["C", "B", "A", "S"]).toContain(grade);
  });

  it("one bad message does NOT drag an otherwise good session to D", () => {
    // The user-visible symptom: the latest message scored 0, but the session
    // has been consistently strong. Grade must follow the session.
    const window = [70, 70, 70, 70, 70, 70, 0];
    const lastMessageOnly = gradeFor([window[window.length - 1]]);
    const windowed = gradeFor(window);
    expect(lastMessageOnly).toBe("D"); // old behaviour, for contrast
    expect(windowed).not.toBe("D");
  });

  it("an empty window falls back to the caller's last-message score", () => {
    // Same inputs, one via fallback and one via a single-entry window: equal.
    expect(gradeFor(undefined, 70)).toBe(gradeFor([70]));
    expect(gradeFor([], 0)).toBe(gradeFor([0]));
  });

  it("does not change the band thresholds or the efficiency half", () => {
    // Identical prompt input via either route yields an identical result object.
    const viaWindow = computeLiveGrade({
      promptScore: meanPromptScore([60, 60]) as number,
      turns: 10,
      toolCalls: 30,
      firstPassGreen: true,
      comboCount: 2,
    });
    const viaScalar = computeLiveGrade({
      promptScore: 60,
      turns: 10,
      toolCalls: 30,
      firstPassGreen: true,
      comboCount: 2,
    });
    expect(viaWindow).toEqual(viaScalar);
  });
});
