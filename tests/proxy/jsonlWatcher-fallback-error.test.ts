// Regression test for the fs.watch fallback watcher losing the whole proxy
// process to an unhandled 'error' event.
//
// On Windows, ReadDirectoryChangesW can fail asynchronously and libuv surfaces
// it as an 'error' event carrying errno -4094 (UV_UNKNOWN). The try/catch
// around fs.watch() only guards synchronous init, so before this fix the
// fallback watcher had no 'error' listener and Node terminated the proxy —
// killing the user's live CLI session mid-conversation.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chokidar from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupJsonlWatcher } from "../../src/proxy/jsonlWatcher";

const FAKE_CWD = path.join("C:", "evo-test", "proj");
const ENCODED_CWD = FAKE_CWD.replace(/[\\/]/g, "-").replace(/:/g, "-");

describe("jsonlWatcher fs.watch fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("survives an async UV_UNKNOWN (-4094) instead of crashing the proxy", () => {
    // Hermetic ~/.claude/projects/<encoded cwd> so setupJsonlWatcher gets past
    // its filesystem preconditions without depending on the real HOME.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "evo-jsonl-"));
    const projectDir = path.join(home, ".claude", "projects", ENCODED_CWD);
    fs.mkdirSync(projectDir, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);

    // Force the chokidar → fs.watch fallback.
    vi.spyOn(chokidar, "watch").mockImplementation(() => {
      throw new Error("chokidar unavailable");
    });

    const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void };
    fakeWatcher.close = () => {};
    vi.spyOn(fs, "watch").mockReturnValue(fakeWatcher as unknown as fs.FSWatcher);

    const handle = setupJsonlWatcher({
      cwd: FAKE_CWD,
      onEntry: () => {},
      onRotation: () => {},
    });

    try {
      // The fallback watcher must have an 'error' listener; without one Node
      // rethrows the event and takes the process down.
      expect(fakeWatcher.listenerCount("error")).toBeGreaterThan(0);

      const uvUnknown = Object.assign(new Error(`watch ${projectDir} UNKNOWN`), {
        errno: -4094,
        code: "UNKNOWN",
        syscall: "watch",
      });
      expect(() => fakeWatcher.emit("error", uvUnknown)).not.toThrow();
    } finally {
      handle?.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
