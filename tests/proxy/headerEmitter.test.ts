import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitTrackingHeader } from "../../src/proxy/headerEmitter";

describe("headerEmitter", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured = "";

  beforeEach(() => {
    captured = "";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("emits the canonical 'Evo tracking ON' line in normal mode", () => {
    emitTrackingHeader({
      cli: "claude",
      cwd: "/tmp/proj",
      mode: "auto",
      lightweightTracking: false,
    });
    expect(captured).toBe("Evo tracking ON | cli=claude | dir=/tmp/proj | mode=auto\n");
  });

  it("appends ' | light' suffix when lightweightTracking is true", () => {
    emitTrackingHeader({
      cli: "codex",
      cwd: "/home/user",
      mode: "minimal",
      lightweightTracking: true,
    });
    expect(captured).toBe("Evo tracking ON | cli=codex | dir=/home/user | mode=minimal | light\n");
  });

  it("does not emit anything to stdout (header is stderr-only)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitTrackingHeader({
      cli: "generic",
      cwd: "/x",
      mode: "auto",
      lightweightTracking: false,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
