import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCurrentMode, runDisplayCommand } from "../src/cli/display";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-cli-display-"));
  tempDirs.push(dir);
  return dir;
}

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureStdio(): CapturedIo {
  let stdout = "";
  let stderr = "";
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  (process.stderr as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore: () => {
      (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
      (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
    },
  } as CapturedIo;
}

const ORIGINAL_MODE_FILE = process.env.EVO_DISPLAY_MODE_FILE;
const ORIGINAL_EXIT_CODE = process.exitCode;

beforeEach(() => {
  delete process.env.EVO_DISPLAY_MODE_FILE;
  process.exitCode = ORIGINAL_EXIT_CODE;
});

afterEach(() => {
  if (ORIGINAL_MODE_FILE === undefined) delete process.env.EVO_DISPLAY_MODE_FILE;
  else process.env.EVO_DISPLAY_MODE_FILE = ORIGINAL_MODE_FILE;
  process.exitCode = ORIGINAL_EXIT_CODE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

describe("cli/display", () => {
  it("defaults to minimum when the mode file is absent", async () => {
    const dir = makeTempDir();
    process.env.EVO_DISPLAY_MODE_FILE = path.join(dir, "missing-file");
    expect(readCurrentMode()).toBe("minimum");

    const io = captureStdio();
    try {
      await runDisplayCommand();
    } finally {
      io.restore();
    }
    expect(io.stdout).toContain("EvoPet display: minimum");
    expect(io.stdout).toContain("Usage: evo display");
    expect(process.exitCode).not.toBe(1);
  });

  it("writes 'minimum' and 'expansion' via the CLI command", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, ".evo-display-mode");
    process.env.EVO_DISPLAY_MODE_FILE = file;

    {
      const io = captureStdio();
      try {
        await runDisplayCommand("expansion");
      } finally {
        io.restore();
      }
      expect(io.stdout).toContain("EvoPet display: expansion");
      expect(io.stdout).toContain("statusline will refresh");
    }
    expect(fs.readFileSync(file, "utf8").trim()).toBe("expansion");
    expect(readCurrentMode()).toBe("expansion");

    {
      const io = captureStdio();
      try {
        await runDisplayCommand("minimum");
      } finally {
        io.restore();
      }
      expect(io.stdout).toContain("EvoPet display: minimum");
    }
    expect(fs.readFileSync(file, "utf8").trim()).toBe("minimum");
    expect(readCurrentMode()).toBe("minimum");
  });

  it("flips between minimum and expansion via 'toggle'", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, ".evo-display-mode");
    process.env.EVO_DISPLAY_MODE_FILE = file;

    // No file yet → defaults to minimum, so first toggle should produce expansion.
    {
      const io = captureStdio();
      try {
        await runDisplayCommand("toggle");
      } finally {
        io.restore();
      }
      expect(io.stdout).toContain("EvoPet display: expansion");
    }
    expect(readCurrentMode()).toBe("expansion");

    // Second toggle → back to minimum.
    {
      const io = captureStdio();
      try {
        await runDisplayCommand("toggle");
      } finally {
        io.restore();
      }
      expect(io.stdout).toContain("EvoPet display: minimum");
    }
    expect(readCurrentMode()).toBe("minimum");
  });

  it("rejects an invalid mode arg with a non-zero exit code", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, ".evo-display-mode");
    process.env.EVO_DISPLAY_MODE_FILE = file;
    // Pre-populate so we can confirm the file is NOT overwritten on error.
    fs.writeFileSync(file, "expansion");

    const io = captureStdio();
    try {
      await runDisplayCommand("loud");
    } finally {
      io.restore();
    }
    expect(io.stderr).toMatch(/invalid display mode/i);
    expect(process.exitCode).toBe(1);
    // File untouched.
    expect(fs.readFileSync(file, "utf8").trim()).toBe("expansion");
  });
});
