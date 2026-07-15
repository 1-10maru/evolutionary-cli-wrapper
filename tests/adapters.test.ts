import { describe, expect, it } from "vitest";
import { detectCli, extractEventsFromLine, parseUsageObservation } from "../src/adapters";

describe("adapters", () => {
  it("always detects 'claude' (claude-only build)", () => {
    expect(detectCli("claude")).toBe("claude");
    expect(detectCli("custom-wrapper")).toBe("claude");
  });

  it("parses token usage lines when available", () => {
    const usage = parseUsageObservation(
      "claude",
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

describe("extractEventsFromLine — long-line / ReDoS safety", () => {
  // The old unbounded FILE_PATH_RE backtracks quadratically on a long run of
  // word chars: 16KB measured ~297ms, so a multi-MB newline-sparse line pegged
  // the CPU and the wrapper stalled mid-stream. Bounded quantifier + head cap
  // make this linear.
  it("processes a 16KB single line well under the backtracking threshold", () => {
    const line = "a".repeat(16 * 1024); // dotless word-run, no extension → worst case
    const start = performance.now();
    const events = extractEventsFromLine(line);
    const elapsed = performance.now() - start;
    expect(events).toEqual([]);
    // Real target is <50ms; assert <500ms so CI timing jitter can't flake it.
    expect(elapsed).toBeLessThan(500);
  });

  it("does not stall on a multi-MB garbage line (parser stays bounded)", () => {
    const bigLine = "a".repeat(2 * 1024 * 1024); // ~2MB single line
    const start = performance.now();
    // A handful of passes stands in for a streaming child; the old regex would
    // not finish even one pass in any reasonable time.
    for (let i = 0; i < 4; i += 1) {
      expect(extractEventsFromLine(bigLine)).toEqual([]);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it("still extracts a real path that appears within a long noisy line", () => {
    // Noise stays within the head-scan window so the real path is still found.
    const line = `${"x".repeat(1000)} Read src/index.ts done`;
    const events = extractEventsFromLine(line);
    expect(events.map((e) => e.type)).toContain("file_read");
    expect(events.find((e) => e.type === "file_read")?.details.path).toBe("src/index.ts");
  });
});
