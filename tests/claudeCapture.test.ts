import { describe, expect, it } from "vitest";
import { createClaudeCaptureAdapter } from "../src/capture/claudeCapture";

describe("claudeCapture — secret masking in persisted event details", () => {
  it("masks a secret echoed in a tool-lifecycle output line", () => {
    const adapter = createClaudeCaptureAdapter();
    // Built from parts so no scannable literal is in source.
    const secret = "AKIA" + "IOSFODNN7" + "EXAMPLE";
    const events = adapter.consumeOutputLine("stdout", `bash: exporting ${secret} then running`);
    const started = events.find((e) => e.type === "tool_call_started");
    expect(started).toBeDefined();
    expect(String(started?.details.line)).toContain("[REDACTED]");
    expect(String(started?.details.line)).not.toContain(secret);
  });

  it("preserves the y/n approval decision through the defensive mask (no-op on safe tokens)", () => {
    const adapter = createClaudeCaptureAdapter();
    // Prime a pending approval so consumeInputChunk emits a decision event.
    adapter.consumeOutputLine("stdout", "bash: this command requires approval to run");
    const events = adapter.consumeInputChunk("yes\n");
    const granted = events.find((e) => e.type === "tool_approval_granted");
    // The decision is always a y/n word; the redaction wrapper must not alter it.
    expect(granted).toBeDefined();
    expect(granted?.details.input).toBe("yes");
  });
});
