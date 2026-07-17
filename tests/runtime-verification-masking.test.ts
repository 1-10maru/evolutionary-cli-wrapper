import os from "node:os";
import { describe, expect, it } from "vitest";
import { runShellCommand } from "../src/runtime";

// #34 — the verification event's persisted `command` field must be
// secret-masked, mirroring the stdoutPreview/stderrPreview masking added in
// v3.6.5–3.6.7. The RAW command is still what gets executed; only the copy
// persisted into episode_events.details_json is masked.
describe("runShellCommand — verification event masking (#34)", () => {
  it("masks a secret in the persisted command field (and its echo in stdout)", async () => {
    const secret = "supersecretvalue123";
    const { exitCode, event } = await runShellCommand(
      os.tmpdir(),
      `echo MY_TOKEN=${secret}`,
      "test_run",
    );

    expect(exitCode).toBe(0);
    expect(event.type).toBe("test_run");
    expect(event.source).toBe("verification");

    const details = event.details as { command: string; stdoutPreview: string };
    // The persisted command is masked…
    expect(details.command).toContain("[REDACTED]");
    expect(details.command).not.toContain(secret);
    // …and the raw command still EXECUTED (echo ran → the secret hit stdout),
    // where the existing output masking catches it.
    expect(details.stdoutPreview).toContain("[REDACTED]");
    expect(details.stdoutPreview).not.toContain(secret);
  });

  it("leaves an ordinary command untouched", async () => {
    const { event } = await runShellCommand(os.tmpdir(), "echo plain build output", "build_run");
    const details = event.details as { command: string };
    expect(details.command).toBe("echo plain build output");
    expect(details.command).not.toContain("[REDACTED]");
  });
});
