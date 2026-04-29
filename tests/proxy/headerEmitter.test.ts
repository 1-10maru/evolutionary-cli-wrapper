import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitTrackingHeader } from "../../src/proxy/headerEmitter";

describe("headerEmitter", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured = "";
  let modeFile = "";
  let prevModeFileEnv: string | undefined;

  beforeEach(() => {
    captured = "";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    // Isolate the display-mode file per test so we don't read the real
    // ~/.claude/.evo-display-mode and so each test can pin the mode it expects.
    modeFile = path.join(
      os.tmpdir(),
      `evo-display-mode-headerEmitter-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    prevModeFileEnv = process.env.EVO_DISPLAY_MODE_FILE;
    process.env.EVO_DISPLAY_MODE_FILE = modeFile;
    // Default each test to "expansion" so the canonical emission behavior is exercised.
    fs.writeFileSync(modeFile, "expansion");
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    try {
      fs.unlinkSync(modeFile);
    } catch {
      // best-effort cleanup
    }
    if (prevModeFileEnv === undefined) {
      delete process.env.EVO_DISPLAY_MODE_FILE;
    } else {
      process.env.EVO_DISPLAY_MODE_FILE = prevModeFileEnv;
    }
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
      cli: "claude",
      cwd: "/home/user",
      mode: "minimal",
      lightweightTracking: true,
    });
    expect(captured).toBe("Evo tracking ON | cli=claude | dir=/home/user | mode=minimal | light\n");
  });

  it("does not emit anything to stdout (header is stderr-only)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitTrackingHeader({
      cli: "claude",
      cwd: "/x",
      mode: "auto",
      lightweightTracking: false,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("suppresses the 'Evo tracking ON' line when display mode is 'minimum'", () => {
    fs.writeFileSync(modeFile, "minimum");
    emitTrackingHeader({
      cli: "claude",
      cwd: "/tmp/proj",
      mode: "auto",
      lightweightTracking: false,
    });
    expect(captured).toBe("");
  });
});
