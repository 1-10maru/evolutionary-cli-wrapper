// Regression test for the crash that killed a live user session:
//
//   Error: UNKNOWN: unknown error, stat '...\docs_cache\666fc1376162.meta.json'
//     at async snapshotWorkspace (...\dist\evo.bundle.cjs:15620:15)
//   errno: -4094, code: 'UNKNOWN', syscall: 'stat'
//
// snapshotWorkspace only tolerated EPERM/EACCES/ENOENT and rethrew everything
// else out of an async loop with no handler above it. On Windows a file being
// rewritten underneath the scan yields UNKNOWN (errno -4094), so one transient
// per-file failure took the whole wrapper — and the user's session — down.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotWorkspace } from "../src/snapshot";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-snapshot-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(dir, "b.txt"), "bravo\n", "utf8");
  fs.writeFileSync(path.join(dir, "c.txt"), "charlie\n", "utf8");
  return dir;
}

function errnoError(code: string, errno: number, syscall: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: unknown error, ${syscall} '${target}'`), {
    code,
    errno,
    syscall,
    path: target,
  });
}

describe("snapshotWorkspace per-file resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips a file whose stat fails with UNKNOWN (-4094) instead of throwing", async () => {
    const dir = makeWorkspace();
    const doomed = path.join(dir, "b.txt");
    const realStat = fs.promises.stat;

    vi.spyOn(fs.promises, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target) === doomed) {
        throw errnoError("UNKNOWN", -4094, "stat", doomed);
      }
      return (realStat as (...a: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    });

    try {
      const snapshot = await snapshotWorkspace(dir);

      // The scan completed and the healthy files are present.
      expect(snapshot.files.map((f) => f.relativePath).sort()).toEqual(["a.txt", "c.txt"]);
      // The unreadable file is reported, not silently lost.
      expect(snapshot.skipped).toEqual([{ relativePath: "b.txt", reason: "UNKNOWN" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a file whose readFile fails with EBUSY instead of throwing", async () => {
    const dir = makeWorkspace();
    const doomed = path.join(dir, "c.txt");
    const realReadFile = fs.promises.readFile;

    vi.spyOn(fs.promises, "readFile").mockImplementation(async (target, ...rest) => {
      if (String(target) === doomed) {
        throw errnoError("EBUSY", -4082, "read", doomed);
      }
      return (realReadFile as (...a: unknown[]) => Promise<Buffer>)(target, ...rest);
    });

    try {
      const snapshot = await snapshotWorkspace(dir);
      expect(snapshot.files.map((f) => f.relativePath).sort()).toEqual(["a.txt", "b.txt"]);
      expect(snapshot.skipped).toEqual([{ relativePath: "c.txt", reason: "EBUSY" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still treats EPERM/EACCES/ENOENT as ordinary quiet skips", async () => {
    const dir = makeWorkspace();
    const doomed = path.join(dir, "a.txt");
    const realStat = fs.promises.stat;

    vi.spyOn(fs.promises, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target) === doomed) {
        throw errnoError("EACCES", -4092, "stat", doomed);
      }
      return (realStat as (...a: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    });

    try {
      const snapshot = await snapshotWorkspace(dir);
      expect(snapshot.files.map((f) => f.relativePath).sort()).toEqual(["b.txt", "c.txt"]);
      // Permission skips stay quiet — they are expected, not diagnostic.
      expect(snapshot.skipped).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
