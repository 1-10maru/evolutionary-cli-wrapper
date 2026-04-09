import { describe, expect, it } from "vitest";
import { detectCli, extractEventsFromLine, parseUsageObservation } from "../src/adapters";

describe("adapters", () => {
  it("detects supported CLI families", () => {
    expect(detectCli("codex")).toBe("codex");
    expect(detectCli("claude")).toBe("claude");
    expect(detectCli("custom-wrapper")).toBe("generic");
  });

  it("parses token usage lines when available", () => {
    const usage = parseUsageObservation(
      "codex",
      "stdout",
      "prompt tokens: 120 completion tokens: 34 total tokens: 154",
    );

    expect(usage).not.toBeNull();
    expect(usage?.promptTokens).toBe(120);
    expect(usage?.completionTokens).toBe(34);
    expect(usage?.totalTokens).toBe(154);
  });

  it("extracts attention and verification events from tool output", () => {
    const readEvents = extractEventsFromLine("Read src/index.ts and then run npm test");
    const types = readEvents.map((event) => event.type);

    expect(types).toContain("file_read");
    expect(types).toContain("test_run");
  });
});
