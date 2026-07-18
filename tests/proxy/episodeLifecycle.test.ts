import { describe, expect, it } from "vitest";
import {
  buildLiveStatePayload,
  createEmptyTurn,
  createEvent,
  processJsonlEntry,
  refreshLiveAdvice,
  resetLiveStateOnRotation,
  shouldSuppressTurnFeedback,
  type ProxyLiveState,
} from "../../src/proxy/episodeLifecycle";
import type { MascotProfile, EvoConfig } from "../../src/types";

function makeLiveState(): ProxyLiveState {
  return {
    turns: 0,
    userMessages: 0,
    toolCalls: 0,
    lastTool: "",
    lastFile: "",
    sessionStartMs: Date.now(),
    advice: "",
    adviceDetail: "",
    signalKind: "",
    beforeExample: "",
    afterExample: "",
    sessionGrade: "C",
    promptScore: 0,
    efficiencyScore: 0,
    comboCount: 0,
    filePatchCounts: new Map(),
    symbolTouchCounts: new Map(),
    lastPromptLength: 0,
    lastHasFileRefs: false,
    lastHasSymbolRefs: false,
    lastHasAcceptanceRef: false,
    lastHasTestRef: false,
    lastStructureScore: 0,
    lastFirstPassGreen: true,
    lastExitCode: null,
    lastExitSignal: null,
    lastExitAt: null,
    lastSubcommand: null,
  };
}

function makeMascot(): MascotProfile {
  return {
    speciesId: "egg",
    nickname: "Test",
    stage: "egg",
    exp: 0,
    hp: 100,
    mood: "neutral",
    comboCount: 0,
    sessionsTotal: 0,
    sessionsGood: 0,
    skillExp: 0,
    skillTier: 0,
    skillTitle: "",
    relations: { trust: 0, growth: 0 },
    lastEpisodeAt: null,
    lastUpdated: new Date().toISOString(),
  } as unknown as MascotProfile;
}

function makeConfig(): EvoConfig {
  return {
    advice: {
      vaguePromptThreshold: 30,
      sameFileRevisitThreshold: 3,
      scopeCreepFileThreshold: 5,
      scopeCreepEntropyThreshold: 0.85,
      showBeforeAfterExamples: true,
    },
  } as unknown as EvoConfig;
}

describe("createEmptyTurn", () => {
  it("returns a fresh turn skeleton with empty buffers and current timestamps", () => {
    const t = createEmptyTurn();
    expect(t.inputText).toBe("");
    expect(t.outputText).toBe("");
    expect(t.events).toEqual([]);
    expect(typeof t.startedAt).toBe("string");
    expect(t.lastActivityAt).toBeGreaterThan(0);
  });
});

describe("createEvent", () => {
  it("produces a well-formed EpisodeEvent", () => {
    const e = createEvent("turn_closed", "proxy", { turnIndex: 1 });
    expect(e.type).toBe("turn_closed");
    expect(e.source).toBe("proxy");
    expect(e.details).toEqual({ turnIndex: 1 });
    expect(typeof e.timestamp).toBe("string");
  });
});

describe("shouldSuppressTurnFeedback", () => {
  it("does not suppress when output is empty", () => {
    const t = createEmptyTurn();
    expect(shouldSuppressTurnFeedback(t)).toBe(false);
  });

  it("suppresses when output is only known-noise patterns and input is empty", () => {
    const t = createEmptyTurn();
    t.outputText = "no stdin data received in 5s\n";
    expect(shouldSuppressTurnFeedback(t)).toBe(true);
  });

  it("does not suppress when meaningful input is present even if output is noise", () => {
    const t = createEmptyTurn();
    t.inputText = "hello";
    t.outputText = "no stdin data received in 5s\n";
    expect(shouldSuppressTurnFeedback(t)).toBe(false);
  });
});

describe("processJsonlEntry", () => {
  it("increments turns and userMessages on a real user entry, and triggers state-changed callback", () => {
    const liveState = makeLiveState();
    let changed = 0;
    processJsonlEntry(
      { type: "user", message: { content: "tell me about path/to/file.ts" } as unknown as { content?: unknown[] } },
      { liveState, config: makeConfig(), onStateChanged: () => { changed += 1; } },
    );
    expect(liveState.turns).toBe(1);
    expect(liveState.userMessages).toBe(1);
    expect(changed).toBeGreaterThanOrEqual(1);
  });

  it("does NOT count tool_result-only user entries as real user messages", () => {
    const liveState = makeLiveState();
    processJsonlEntry(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "ok" }] as unknown as unknown[],
        },
      },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    expect(liveState.turns).toBe(1); // turns still increments
    expect(liveState.userMessages).toBe(0); // but userMessages does not
  });

  it("counts assistant tool_use blocks as toolCalls and tracks Edit file paths", () => {
    const liveState = makeLiveState();
    processJsonlEntry(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/abs/foo.ts" } },
          ] as unknown as unknown[],
        },
      },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    expect(liveState.toolCalls).toBe(1);
    expect(liveState.lastTool).toBe("Edit");
    expect(liveState.lastFile).toBe("/abs/foo.ts");
    expect(liveState.filePatchCounts.get("/abs/foo.ts")).toBe(1);
  });
});

describe("resetLiveStateOnRotation", () => {
  it("clears all per-session counters and refreshes sessionStartMs", () => {
    const liveState = makeLiveState();
    liveState.turns = 5;
    liveState.userMessages = 3;
    liveState.toolCalls = 12;
    liveState.lastTool = "Edit";
    liveState.lastFile = "/x";
    liveState.filePatchCounts.set("/x", 3);
    const before = liveState.sessionStartMs;
    // Advance the clock just enough to differentiate.
    const t0 = Date.now();
    while (Date.now() === t0) { /* spin */ }
    resetLiveStateOnRotation(liveState);
    expect(liveState.turns).toBe(0);
    expect(liveState.userMessages).toBe(0);
    expect(liveState.toolCalls).toBe(0);
    expect(liveState.lastTool).toBe("");
    expect(liveState.lastFile).toBe("");
    expect(liveState.filePatchCounts.size).toBe(0);
    expect(liveState.sessionStartMs).toBeGreaterThanOrEqual(before);
  });
});

describe("buildLiveStatePayload", () => {
  it("includes the canonical keys consumed by the statusline", () => {
    const liveState = makeLiveState();
    const mascot = makeMascot();
    const payload = buildLiveStatePayload(liveState, mascot);
    expect(payload).toHaveProperty("turns");
    expect(payload).toHaveProperty("userMessages");
    expect(payload).toHaveProperty("toolCalls");
    expect(payload).toHaveProperty("advice");
    expect(payload).toHaveProperty("mood");
    expect(payload).toHaveProperty("avatar");
    expect(payload).toHaveProperty("nickname");
    expect(payload).toHaveProperty("bond");
    expect(payload).toHaveProperty("idealStateGauge");
    expect(payload).toHaveProperty("updatedAt");
    expect(payload).toHaveProperty("sessionGrade");
    expect(payload).toHaveProperty("promptScore");
    expect(payload).toHaveProperty("efficiencyScore");
    expect(payload).toHaveProperty("comboCount");
    expect(payload).toHaveProperty("lastExitCode");
    expect(payload).toHaveProperty("lastSubcommand");
  });

  it("live idealStateGauge is -1 (測定中) with no window and no episodes", () => {
    const liveState = makeLiveState();
    const payload = buildLiveStatePayload(liveState, makeMascot());
    expect(payload.idealStateGauge).toBe(-1);
  });

  it("live idealStateGauge reflects the in-session promptScore window", () => {
    const liveState = makeLiveState();
    liveState.promptScoreWindow = [80, 80, 80];
    const payload = buildLiveStatePayload(liveState, makeMascot());
    // No finalized episodes, but the live window pulls the gauge to ~80 (never
    // a stale 0 beside a high live 指示の質).
    expect(payload.idealStateGauge).toBe(80);
  });
});

describe("advice fire memory (escalation, v3.7 B3)", () => {
  function reviseTarget(liveState: ProxyLiveState, file: string): void {
    // Force a same_file_revisit signal for `file` (>= threshold of 3).
    liveState.filePatchCounts = new Map([[file, 3]]);
    liveState.lastFile = file;
  }

  it("escalates the same target through levels 1 → 2 → 3 and only suppresses at the 7th fire", () => {
    const liveState = makeLiveState();
    const config = makeConfig();
    reviseTarget(liveState, "/abs/a.ts");

    // Fires 1-2: level 1 (normal copy).
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("same_file_revisit");
    expect(liveState.adviceEscalationLevel).toBe(1);
    const level1Advice = liveState.advice;
    refreshLiveAdvice(liveState, config);
    expect(liveState.adviceEscalationLevel).toBe(1);
    expect(liveState.advice).toBe(level1Advice);

    // Fires 3-4: level 2 ("this keeps happening" frame) — still advice, NOT a tip.
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("same_file_revisit");
    expect(liveState.adviceEscalationLevel).toBe(2);
    expect(liveState.advice).not.toBe(level1Advice);
    expect(liveState.advice).toContain("続いてる");
    const level2Advice = liveState.advice;
    refreshLiveAdvice(liveState, config);
    expect(liveState.adviceEscalationLevel).toBe(2);
    expect(liveState.advice).toBe(level2Advice);

    // Fires 5-6: level 3 (strongest copy).
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("same_file_revisit");
    expect(liveState.adviceEscalationLevel).toBe(3);
    expect(liveState.advice).not.toBe(level2Advice);
    refreshLiveAdvice(liveState, config);
    expect(liveState.adviceEscalationLevel).toBe(3);

    // 7th+ fire: finally suppressed → rotating tip (anti-nagging).
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("tip");
    expect(liveState.adviceEscalationLevel).toBe(0);
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("tip");
  });

  it("keeps before/after examples through escalated levels", () => {
    const liveState = makeLiveState();
    const config = makeConfig();
    reviseTarget(liveState, "/abs/a.ts");
    refreshLiveAdvice(liveState, config); // #1
    const baseBefore = liveState.beforeExample;
    refreshLiveAdvice(liveState, config); // #2
    refreshLiveAdvice(liveState, config); // #3 → level 2
    expect(liveState.adviceEscalationLevel).toBe(2);
    expect(liveState.beforeExample).toBe(baseBefore);
    expect(liveState.afterExample).not.toBe("");
  });

  it("tracks a DIFFERENT target with its own counter (starts back at level 1)", () => {
    const liveState = makeLiveState();
    const config = makeConfig();

    reviseTarget(liveState, "/abs/a.ts");
    refreshLiveAdvice(liveState, config); // a.ts #1
    refreshLiveAdvice(liveState, config); // a.ts #2
    refreshLiveAdvice(liveState, config); // a.ts #3 → level 2
    expect(liveState.adviceEscalationLevel).toBe(2);

    // A different file starts its own count → back to normal phrasing.
    reviseTarget(liveState, "/abs/b.ts");
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("same_file_revisit");
    expect(liveState.adviceEscalationLevel).toBe(1);
  });

  it("resets fire memory AND escalation level on JSONL rotation", () => {
    const liveState = makeLiveState();
    const config = makeConfig();
    reviseTarget(liveState, "/abs/a.ts");
    for (let i = 0; i < 7; i++) refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("tip"); // suppressed at 7th

    resetLiveStateOnRotation(liveState);
    expect(liveState.adviceEscalationLevel).toBe(0);
    reviseTarget(liveState, "/abs/a.ts"); // rotation cleared filePatchCounts
    refreshLiveAdvice(liveState, config);
    expect(liveState.signalKind).toBe("same_file_revisit"); // fires again
    expect(liveState.adviceEscalationLevel).toBe(1); // back to normal phrasing
  });

  it("praise kinds do NOT escalate and keep the legacy suppress-at-3", () => {
    const liveState = makeLiveState();
    const config = makeConfig();
    // Base state fires first_pass_success (turns=0, firstPassGreen=true).
    refreshLiveAdvice(liveState, config); // #1
    expect(liveState.signalKind).toBe("first_pass_success");
    expect(liveState.adviceEscalationLevel).toBe(1);
    const praise = liveState.advice;
    refreshLiveAdvice(liveState, config); // #2 — same copy, no escalation
    expect(liveState.signalKind).toBe("first_pass_success");
    expect(liveState.adviceEscalationLevel).toBe(1);
    expect(liveState.advice).toBe(praise);
    refreshLiveAdvice(liveState, config); // #3 → suppressed (legacy)
    expect(liveState.signalKind).toBe("tip");
    expect(liveState.adviceEscalationLevel).toBe(0);
  });

  it("drops the raw N回目 counter from the same_file_revisit headline", () => {
    const liveState = makeLiveState();
    reviseTarget(liveState, "/abs/a.ts");
    refreshLiveAdvice(liveState, makeConfig());
    expect(liveState.signalKind).toBe("same_file_revisit");
    expect(liveState.advice).not.toMatch(/回目/);
  });

  it("exposes adviceEscalationLevel in the live-state payload", () => {
    const liveState = makeLiveState();
    const config = makeConfig();
    reviseTarget(liveState, "/abs/a.ts");
    refreshLiveAdvice(liveState, config);
    refreshLiveAdvice(liveState, config);
    refreshLiveAdvice(liveState, config); // level 2
    const payload = buildLiveStatePayload(liveState, makeMascot());
    expect(payload.adviceEscalationLevel).toBe(2);
  });

  it("payload defaults adviceEscalationLevel to 0 before any advice refresh", () => {
    const payload = buildLiveStatePayload(makeLiveState(), makeMascot());
    expect(payload.adviceEscalationLevel).toBe(0);
  });
});
