import { describe, expect, it } from "vitest";
import { createCodexCaptureAdapter } from "../src/capture/codexCapture";

describe("codex friction capture", () => {
  it("tracks approval requests and granted confirmations", () => {
    const adapter = createCodexCaptureAdapter();
    const outputEvents = adapter.consumeOutputLine("stdout", "approval required to run shell_command");
    const inputEvents = adapter.consumeInputChunk("y\n");

    expect(outputEvents.map((event) => event.type)).toContain("tool_approval_requested");
    expect(inputEvents.map((event) => event.type)).toContain("tool_approval_granted");
  });

  it("tracks edit failure followed by retry recovery", () => {
    const adapter = createCodexCaptureAdapter();
    const first = adapter.consumeOutputLine("stderr", "apply_patch failed with permission denied");
    const second = adapter.consumeOutputLine("stdout", "retrying apply_patch");
    const third = adapter.consumeOutputLine("stdout", "updated file successfully");

    const all = [...first, ...second, ...third].map((event) => event.type);

    expect(all).toContain("edit_attempt_failed");
    expect(all).toContain("tool_retry_requested");
    expect(all).toContain("edit_attempt_recovered");
  });
});
