import { describe, expect, it } from "vitest";
import {
  buildLiveStatePayload,
  createEmptyTurn,
  createEvent,
  extractPromptText,
  isMachinePromptText,
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

  // Regression: Claude Code writes user messages as an ARRAY of content
  // blocks, so the old string-only path never fired and promptScore stayed 0
  // (pinning the live grade at D). These lock the array shape in.
  it("scores a prompt whose content is an array of text blocks", () => {
    const liveState = makeLiveState();
    processJsonlEntry(
      {
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "- fix src/foo.ts\n- add a test\nDone when tests pass",
            },
          ] as unknown as unknown[],
        },
      },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    expect(liveState.userMessages).toBe(1);
    expect(liveState.promptScore).toBeGreaterThan(0);
    expect(liveState.promptScoreWindow?.length).toBe(1);
    expect(liveState.lastHasFileRefs).toBe(true);
  });

  it("scores the text blocks of a mixed text + tool_use array", () => {
    const liveState = makeLiveState();
    processJsonlEntry(
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "update src/bar.ts until the tests pass" },
            { type: "tool_use", name: "Edit", input: { file_path: "/x.ts" } },
          ] as unknown as unknown[],
        },
      },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    expect(liveState.promptScore).toBeGreaterThan(0);
    expect(liveState.lastPromptLength).toBe(
      "update src/bar.ts until the tests pass".length,
    );
  });

  it("does NOT score a tool_result-only entry as a prompt", () => {
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
    expect(liveState.userMessages).toBe(0);
    expect(liveState.promptScore).toBe(0);
    // The rolling window must stay empty: a tool echo is not a prompt sample.
    expect(liveState.promptScoreWindow ?? []).toHaveLength(0);
  });

  it("leaves scoring untouched when message.content is missing or odd", () => {
    const liveState = makeLiveState();
    processJsonlEntry(
      { type: "user", message: {} as unknown as { content?: unknown[] } },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    processJsonlEntry(
      {
        type: "user",
        message: { content: 42 as unknown as unknown[] },
      },
      { liveState, config: makeConfig(), onStateChanged: () => {} },
    );
    expect(liveState.promptScore).toBe(0);
    expect(liveState.promptScoreWindow ?? []).toHaveLength(0);
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

describe("extractPromptText", () => {
  it("returns a string content unchanged", () => {
    expect(extractPromptText("hello world")).toBe("hello world");
  });
  it("concatenates text blocks with newlines", () => {
    expect(
      extractPromptText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });
  it("ignores tool_use / tool_result / image / thinking and unknown blocks", () => {
    expect(
      extractPromptText([
        { type: "tool_use", name: "Edit" },
        { type: "text", text: "keep me" },
        { type: "tool_result", content: "ok" },
        { type: "image", source: {} },
        { type: "thinking", thinking: "hmm" },
        { nope: true },
        null,
        "raw",
      ]),
    ).toBe("keep me");
  });
  it("returns empty string for a tool_result-only array", () => {
    expect(extractPromptText([{ type: "tool_result", content: "ok" }])).toBe("");
  });
  it("returns empty string for missing / non-array / non-string content", () => {
    expect(extractPromptText(undefined)).toBe("");
    expect(extractPromptText(null)).toBe("");
    expect(extractPromptText(42)).toBe("");
    expect(extractPromptText({ type: "text", text: "x" })).toBe("");
    expect(extractPromptText([])).toBe("");
  });
});

describe("refreshLiveAdvice — grade reads the session window, chip reads the latest message", () => {
  it("keeps a strong session above D even when the latest message scored 0", () => {
    const liveState = makeLiveState();
    liveState.turns = 20;
    liveState.toolCalls = 60;
    liveState.promptScoreWindow = [70, 70, 70, 70, 70, 70, 0];
    liveState.promptScore = 0; // the latest message
    refreshLiveAdvice(liveState, makeConfig());
    expect(liveState.sessionGrade).not.toBe("D");
    // The 指示の質 chip must still read the LATEST message, not the mean.
    expect(liveState.promptScore).toBe(0);
  });

  it("still grades D when the whole session is weak", () => {
    const liveState = makeLiveState();
    liveState.turns = 20;
    liveState.toolCalls = 60;
    liveState.promptScoreWindow = [0, 0, 5, 0];
    liveState.promptScore = 0;
    refreshLiveAdvice(liveState, makeConfig());
    expect(liveState.sessionGrade).toBe("D");
  });

  it("falls back to the latest score when the window is empty (new session)", () => {
    const empty = makeLiveState();
    empty.turns = 20;
    empty.toolCalls = 60;
    empty.promptScoreWindow = [];
    empty.promptScore = 70;
    refreshLiveAdvice(empty, makeConfig());

    const single = makeLiveState();
    single.turns = 20;
    single.toolCalls = 60;
    single.promptScoreWindow = [70];
    single.promptScore = 70;
    refreshLiveAdvice(single, makeConfig());

    expect(empty.sessionGrade).toBe(single.sessionGrade);
  });
});

describe("harness-generated text is never scored as a user prompt", () => {
  function scored(entry: Record<string, unknown>): { userMessages: number; promptScore: number; window: number[] } {
    const liveState = makeLiveState();
    processJsonlEntry(entry as never, {
      liveState,
      config: makeConfig(),
      onStateChanged: () => {},
    });
    return {
      userMessages: liveState.userMessages,
      promptScore: liveState.promptScore,
      window: liveState.promptScoreWindow ?? [],
    };
  }

  it("does NOT score an isMeta skill-body entry (regression: it scored 70)", () => {
    // Real shape from a transcript: a skill body injected as a user turn. It is
    // long, structured and full of file paths, so the rubric loves it.
    const r = scored({
      type: "user",
      isMeta: true,
      message: {
        content: [
          {
            type: "text",
            text:
              "Base directory for this skill: C:/Users/x/.claude/skills/demo\n" +
              "- Read src/foo.ts and src/bar.ts\n" +
              "- Run the tests until they pass\n1. step one\n2. step two",
          },
        ],
      },
    });
    expect(r.promptScore).toBe(0);
    expect(r.window).toHaveLength(0);
  });

  it("does NOT score slash-command wrappers (pre-existing string-path leak)", () => {
    for (const text of [
      "<command-name>/model</command-name>",
      "<local-command-stdout>ok</local-command-stdout>",
      "<local-command-caveat>Caveat: The messages below…</local-command-caveat>",
      "<command-message>model</command-message>",
      "<command-args>opus</command-args>",
    ]) {
      const r = scored({ type: "user", message: { content: text } });
      expect(r.promptScore).toBe(0);
      expect(r.window).toHaveLength(0);
    }
  });

  it("does NOT score agent-to-agent traffic delivered on the user turn", () => {
    // Calibration caught these scoring 87 — the highest of ANY "user" message
    // in the corpus — for text the person never wrote.
    for (const text of [
      "Another Claude session sent a message:\n<teammate-message>do X</teammate-message>",
      "<teammate-message teammate_id=\"lead\">please update src/a.ts until tests pass</teammate-message>",
      "<task-notification>agent finished</task-notification>",
      "[SYSTEM NOTIFICATION] wake up",
      "[AUTO-RESUME] continue the plan in .claude/RESUME.md",
    ]) {
      const r = scored({ type: "user", message: { content: text } });
      expect(r.promptScore).toBe(0);
      expect(r.window).toHaveLength(0);
    }
  });

  it("does NOT score the `for tool use` interrupt variant (was scoring 35)", () => {
    const r = scored({
      type: "user",
      message: { content: "[Request interrupted by user for tool use]" },
    });
    expect(r.promptScore).toBe(0);
    expect(r.window).toHaveLength(0);
  });

  it("DOES score genuine prose that merely opens with a wrapper tag", () => {
    // Prefix-anchored patterns silently dropped real user text. The tag must
    // close AND the entry must be nothing but the wrapper.
    for (const text of [
      "<system-reminder>みたいなのが出るんだけど、これ止められない？",
      "Another Claude session sent a message: が会話に混ざるのを止めたい",
      "<command-name>/model</command-name> みたいな行が邪魔なので消して",
    ]) {
      const r = scored({ type: "user", message: { content: text } });
      expect(r.window).toHaveLength(1);
    }
  });

  it("does NOT score the interrupt marker", () => {
    const r = scored({
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    expect(r.window).toHaveLength(0);
  });

  it("DOES score a genuine prompt that merely mentions a command name inline", () => {
    const r = scored({
      type: "user",
      message: { content: "run /model then update src/a.ts until tests pass" },
    });
    expect(r.promptScore).toBeGreaterThan(0);
    expect(r.window).toHaveLength(1);
  });

  it("scores a mixed [tool_result, text] array on its text half only", () => {
    const r = scored({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "irrelevant output" },
          { type: "text", text: "now fix src/baz.ts and make the tests pass" },
        ],
      },
    });
    expect(r.userMessages).toBe(1);
    expect(r.promptScore).toBeGreaterThan(0);
  });
});

describe("isMachinePromptText", () => {
  it("flags wrappers, the interrupt marker, skill bodies and blank text", () => {
    expect(isMachinePromptText("<command-name>/model</command-name>")).toBe(true);
    expect(isMachinePromptText("  <local-command-caveat>x</local-command-caveat>")).toBe(true);
    expect(isMachinePromptText("[Request interrupted by user]")).toBe(true);
    expect(isMachinePromptText("Base directory for this skill: C:/x")).toBe(true);
    expect(isMachinePromptText("   ")).toBe(true);
  });
  it("does not flag ordinary prose, even when it names a command", () => {
    expect(isMachinePromptText("please run /model and report back")).toBe(false);
    expect(isMachinePromptText("fix src/a.ts")).toBe(false);
    expect(isMachinePromptText("<html> is fine too")).toBe(false);
  });
});
