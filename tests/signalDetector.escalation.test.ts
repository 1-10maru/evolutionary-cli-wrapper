import { describe, expect, it } from "vitest";
import {
  ESCALATION_LEVEL2_AT,
  ESCALATION_LEVEL3_AT,
  ESCALATION_SUPPRESS_AT,
  PRAISE_SUPPRESS_AT,
  escalateAdvice,
  generateTopAdvice,
  resolveEscalation,
} from "../src/signalDetector";
import type { ActionableAdvice, AdviceSignal, AdviceSignalKind } from "../src/types";

function makeSignal(kind: AdviceSignalKind, context: Record<string, unknown> = {}): AdviceSignal {
  return { kind, confidence: 0.8, severity: "high", context };
}

function adviceFor(kind: AdviceSignalKind, context: Record<string, unknown> = {}): ActionableAdvice {
  const advice = generateTopAdvice([makeSignal(kind, context)]);
  if (!advice) throw new Error(`no advice generated for ${kind}`);
  return advice;
}

const COACHING_KINDS: AdviceSignalKind[] = [
  "prompt_too_vague",
  "same_file_revisit",
  "same_function_revisit",
  "scope_creep",
  "no_success_criteria",
  "approval_fatigue",
  "error_spiral",
  "retry_loop",
  "long_session_no_commit",
  "high_tool_ratio",
];

const PRAISE_KINDS: AdviceSignalKind[] = [
  "good_structure",
  "first_pass_success",
  "improving_trend",
];

describe("resolveEscalation (level transitions)", () => {
  it("maps coaching-kind fire counts to level bands 1/1, 2/2, 3/3, then suppress", () => {
    const kind = "same_file_revisit";
    expect(resolveEscalation(kind, 1)).toEqual({ level: 1, suppress: false });
    expect(resolveEscalation(kind, 2)).toEqual({ level: 1, suppress: false });
    expect(resolveEscalation(kind, 3)).toEqual({ level: 2, suppress: false });
    expect(resolveEscalation(kind, 4)).toEqual({ level: 2, suppress: false });
    expect(resolveEscalation(kind, 5)).toEqual({ level: 3, suppress: false });
    expect(resolveEscalation(kind, 6)).toEqual({ level: 3, suppress: false });
    expect(resolveEscalation(kind, 7)).toEqual({ level: 3, suppress: true });
    expect(resolveEscalation(kind, 20)).toEqual({ level: 3, suppress: true });
  });

  it("threshold constants stay ordered (2 < 3 < suppress)", () => {
    expect(ESCALATION_LEVEL2_AT).toBeLessThan(ESCALATION_LEVEL3_AT);
    expect(ESCALATION_LEVEL3_AT).toBeLessThan(ESCALATION_SUPPRESS_AT);
  });

  it("praise kinds never escalate and keep legacy suppress-at-3", () => {
    for (const kind of PRAISE_KINDS) {
      expect(resolveEscalation(kind, 1)).toEqual({ level: 1, suppress: false });
      expect(resolveEscalation(kind, PRAISE_SUPPRESS_AT - 1)).toEqual({
        level: 1,
        suppress: false,
      });
      expect(resolveEscalation(kind, PRAISE_SUPPRESS_AT)).toEqual({
        level: 1,
        suppress: true,
      });
      expect(resolveEscalation(kind, 10)).toEqual({ level: 1, suppress: true });
    }
  });
});

describe("escalateAdvice (copy selection)", () => {
  it("returns the input unchanged at level 1", () => {
    const advice = adviceFor("same_file_revisit", { file: "/abs/a.ts", touchCount: 3 });
    expect(escalateAdvice(advice, 1)).toBe(advice);
  });

  it("every coaching kind has distinct level-1/2/3 copy", () => {
    for (const kind of COACHING_KINDS) {
      const base = adviceFor(kind, { file: "/abs/a.ts", touchCount: 3 });
      const l2 = escalateAdvice(base, 2);
      const l3 = escalateAdvice(base, 3);
      // Escalated copy exists and differs from base and from each other.
      expect(l2.headline, kind).not.toBe(base.headline);
      expect(l3.headline, kind).not.toBe(base.headline);
      expect(l3.headline, kind).not.toBe(l2.headline);
      expect(l2.detail, kind).not.toBe(base.detail);
      expect(l3.detail, kind).not.toBe(base.detail);
      expect(l3.detail, kind).not.toBe(l2.detail);
      // Signal / category / examples pass through untouched.
      expect(l2.signal).toBe(base.signal);
      expect(l2.category).toBe(base.category);
      expect(l2.beforeExample).toBe(base.beforeExample);
      expect(l2.afterExample).toBe(base.afterExample);
    }
  });

  it("level-2 copy carries the 'this keeps happening' frame", () => {
    for (const kind of COACHING_KINDS) {
      const l2 = escalateAdvice(adviceFor(kind, { file: "/abs/a.ts" }), 2);
      expect(`${l2.headline}${l2.detail}`, kind).toMatch(/続いて|繰り返|重なって/);
    }
  });

  it("praise kinds fall back to base copy at escalated levels", () => {
    for (const kind of PRAISE_KINDS) {
      const base = adviceFor(kind);
      const l2 = escalateAdvice(base, 2);
      expect(l2.headline).toBe(base.headline);
      expect(l2.detail).toBe(base.detail);
    }
  });

  it("same_file_revisit escalated copy keeps the shortened file path", () => {
    const base = adviceFor("same_file_revisit", { file: "C:/very/deep/dir/target.ts", touchCount: 4 });
    const l2 = escalateAdvice(base, 2);
    expect(l2.headline).toContain("dir/target.ts");
    expect(l2.headline).not.toContain("C:/very");
    const l3 = escalateAdvice(base, 3);
    expect(l3.detail).toContain("dir/target.ts");
  });

  it("escalated copy never leaks a raw fire counter (no 回目)", () => {
    for (const kind of COACHING_KINDS) {
      for (const level of [2, 3] as const) {
        const a = escalateAdvice(adviceFor(kind, { file: "/abs/a.ts", touchCount: 5 }), level);
        expect(a.headline, `${kind} L${level}`).not.toMatch(/回目/);
      }
    }
  });
});
