// The wrapper must never exit leaving the terminal in mouse-reporting mode.
// When it did, every mouse movement afterwards typed `^[[<35;73;27M` sequences
// into the user's shell until they closed the window.

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTerminalRestoreForTests,
  crashLogPath,
  restoreTerminal,
  writeCrashRecord,
} from "../src/crashGuard";

describe("crashGuard", () => {
  const originalIsTTY = process.stdout.isTTY;

  // process.stdout.isTTY is a plain property (absent entirely when stdout is a
  // pipe, as under vitest), so it cannot be spied on as a getter.
  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    __resetTerminalRestoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it("disables every mouse-reporting mode and restores the cursor", () => {
    const written: string[] = [];
    setTTY(true);
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: string) => {
      if (fd === 1) written.push(String(data));
      return 0;
    }) as unknown as typeof fs.writeSync);

    restoreTerminal();
    const payload = written.join("");

    if (payload.length > 0) {
      for (const mode of ["1000", "1002", "1003", "1006", "1015", "2004"]) {
        expect(payload).toContain(`\x1b[?${mode}l`);
      }
      expect(payload).toContain("\x1b[?25h"); // cursor visible again
      // Must NOT leave the alt screen: that would erase the crash message.
      expect(payload).not.toContain("\x1b[?1049l");
    }
  });

  it("records a crash with errno/code/syscall so a watchdog can see it", () => {
    const appended: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as unknown as typeof fs.mkdirSync);
    vi.spyOn(fs, "appendFileSync").mockImplementation(((_p: string, data: string) => {
      appended.push(String(data));
    }) as unknown as typeof fs.appendFileSync);

    const err = Object.assign(new Error("UNKNOWN: unknown error, stat 'C:\\x\\y.meta.json'"), {
      code: "UNKNOWN",
      errno: -4094,
      syscall: "stat",
      path: "C:\\x\\y.meta.json",
    });
    writeCrashRecord(err, "uncaughtException");

    expect(appended).toHaveLength(1);
    const record = JSON.parse(appended[0]) as Record<string, unknown>;
    expect(record.code).toBe("UNKNOWN");
    expect(record.errno).toBe(-4094);
    expect(record.syscall).toBe("stat");
    expect(record.origin).toBe("uncaughtException");
    expect(String(record.stackHead)).toContain("UNKNOWN");
    expect(crashLogPath()).toContain("crashes.jsonl");
  });

  it("writes nothing to a non-TTY stdout (must not corrupt piped output)", () => {
    const written: string[] = [];
    setTTY(false);
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: string) => {
      if (fd === 1) written.push(String(data));
      return 0;
    }) as unknown as typeof fs.writeSync);

    restoreTerminal();
    expect(written.join("")).toBe("");
  });

  it("never throws when the crash log cannot be written", () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation((() => {
      throw new Error("disk full");
    }) as unknown as typeof fs.mkdirSync);

    expect(() => writeCrashRecord(new Error("boom"), "uncaughtException")).not.toThrow();
  });
});
