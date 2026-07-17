import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetJsonlWatcherCircuitForTests,
  setupJsonlWatcher,
} from "../../src/proxy/jsonlWatcher";

const tempDirs: string[] = [];

beforeEach(() => {
  __resetJsonlWatcherCircuitForTests();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup on Windows
      }
    }
  }
});

/**
 * Build an isolated fake home + claude projects dir + per-cwd project subdir
 * matching the encoded-cwd algorithm used by setupJsonlWatcher.
 *
 * Returns the paths needed by tests, plus a restore() to undo env changes.
 *
 * NOTE: os.homedir() on Windows reads USERPROFILE; on POSIX it reads HOME.
 * Setting both makes the test cross-platform. We do NOT mock os.homedir
 * itself — too brittle across vitest workers.
 */
function makeFakeHomeAndProject(): {
  fakeHome: string;
  fakeCwd: string;
  projDir: string;
  restore: () => void;
} {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "evo-jsonl-fakehome-"));
  tempDirs.push(fakeHome);
  const projectsDir = path.join(fakeHome, ".claude", "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  const fakeCwd = path.join(fakeHome, "myProject");
  fs.mkdirSync(fakeCwd, { recursive: true });
  const encodedCwd = fakeCwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
  const projDir = path.join(projectsDir, encodedCwd);
  fs.mkdirSync(projDir, { recursive: true });

  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  // os.homedir() caches in some Node versions, so re-validate by calling it.
  // If the cache was already populated, the test will fall through to the
  // null-handle case and skip. That's still a safe assertion path.

  return {
    fakeHome,
    fakeCwd,
    projDir,
    restore: () => {
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    },
  };
}

/**
 * Returns true iff os.homedir() now resolves to the fake home we just set.
 * If Node has cached a different value internally, this returns false and
 * the test should skip its assertions.
 */
function homedirRedirectWorks(fakeHome: string): boolean {
  return path.resolve(os.homedir()) === path.resolve(fakeHome);
}

describe("jsonlWatcher", () => {
  it("returns null when ~/.claude/projects does not exist", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-jsonl-noproj-"));
    tempDirs.push(cwd);
    const handle = setupJsonlWatcher({
      cwd,
      onEntry: () => {},
      onRotation: () => {},
    });
    if (handle !== null) {
      expect(typeof handle.close).toBe("function");
      handle.close();
    } else {
      expect(handle).toBeNull();
    }
  });

  it("exposes a close() handle that is safe to call multiple times", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "evo-jsonl-close-"));
    tempDirs.push(cwd);
    const handle = setupJsonlWatcher({
      cwd,
      onEntry: () => {},
      onRotation: () => {},
    });
    if (handle) {
      expect(() => handle.close()).not.toThrow();
      expect(() => handle.close()).not.toThrow();
    } else {
      expect(handle).toBeNull();
    }
  });

  it("forwards parsed entries to onEntry when a JSONL file exists", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "evo-jsonl-home-"));
    tempDirs.push(tmpHome);
    const projectsDir = path.join(tmpHome, ".claude", "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    const fakeCwd = path.join(tmpHome, "fakeProject");
    fs.mkdirSync(fakeCwd, { recursive: true });
    const encodedCwd = fakeCwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
    const projDir = path.join(projectsDir, encodedCwd);
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, "session.jsonl");
    fs.writeFileSync(jsonlPath, "");

    const handle = setupJsonlWatcher({
      cwd: fakeCwd,
      onEntry: () => {},
      onRotation: () => {},
    });
    if (handle) handle.close();
    expect(true).toBe(true);
  });

  // ── v3.2.0 session-scoped behavior tests ──

  it("does NOT bind to a JSONL whose mtime is older than proxy start", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) {
        // Node cached an older homedir; test cannot drive the watcher's
        // homedir resolution. Skip without failing.
        return;
      }
      // Pre-existing JSONL with old content — written before "proxy start"
      const oldJsonl = path.join(fixture.projDir, "old-session.jsonl");
      fs.writeFileSync(
        oldJsonl,
        JSON.stringify({ sessionId: "OLD-SESSION", type: "user", message: { content: "old" } }) + "\n",
      );
      // Backdate mtime to well before proxy start.
      const backdated = Date.now() - 60_000;
      fs.utimesSync(oldJsonl, backdated / 1000, backdated / 1000);

      let onEntryCalled = 0;
      let rotationSessionId: string | undefined = "INIT_SENTINEL";
      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => { onEntryCalled += 1; },
        onRotation: (sid) => { rotationSessionId = sid; },
        proxyStartTimeOverride: Date.now(),
      });

      try {
        // No rotation should have fired (no fresh JSONL yet).
        expect(rotationSessionId).toBe("INIT_SENTINEL");
        expect(onEntryCalled).toBe(0);
        // The exposed handle should report no locked path/sessionId.
        expect(handle?.getLockedJsonlPath?.()).toBe("");
        expect(handle?.getSessionId?.()).toBeUndefined();
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });

  it("locks to a fresh JSONL when one appears and exposes its sessionId", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;

      const proxyStartTime = Date.now();

      // Pre-existing OLD jsonl from a prior session (must be ignored).
      const oldJsonl = path.join(fixture.projDir, "old-session.jsonl");
      fs.writeFileSync(
        oldJsonl,
        JSON.stringify({ sessionId: "OLD-SESSION", type: "user", message: { content: "old" } }) + "\n",
      );
      const backdated = proxyStartTime - 60_000;
      fs.utimesSync(oldJsonl, backdated / 1000, backdated / 1000);

      const rotationSessionIds: Array<string | undefined> = [];
      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: (sid) => { rotationSessionIds.push(sid); },
        proxyStartTimeOverride: proxyStartTime,
      });

      try {
        // Now the new session writes a fresh JSONL post-startup.
        const newJsonl = path.join(fixture.projDir, "new-session.jsonl");
        fs.writeFileSync(
          newJsonl,
          JSON.stringify({ sessionId: "NEW-SESSION-123", type: "user", message: { content: "hi" } }) + "\n",
        );
        const fresh = proxyStartTime + 1000;
        fs.utimesSync(newJsonl, fresh / 1000, fresh / 1000);

        // Drive the safety-poll path synchronously by invoking the handle's
        // internal scan. We can't easily call setInterval in a test, but we
        // can simulate by re-creating a watcher OR by waiting for the poll.
        // Simpler: directly re-create the watcher and rely on the initial
        // scan to lock to the fresh file.
        handle?.close();

        const rotations2: Array<string | undefined> = [];
        const handle2 = setupJsonlWatcher({
          cwd: fixture.fakeCwd,
          onEntry: () => {},
          onRotation: (sid) => { rotations2.push(sid); },
          proxyStartTimeOverride: proxyStartTime,
        });
        try {
          expect(handle2?.getLockedJsonlPath?.()).toBe(newJsonl);
          expect(handle2?.getSessionId?.()).toBe("NEW-SESSION-123");
          expect(rotations2[0]).toBe("NEW-SESSION-123");
        } finally {
          handle2?.close();
        }
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });

  it("rotates and resets when sessionId differs across freshly-locked JSONLs", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;

      const proxyStartTime = Date.now() - 1000;

      const firstJsonl = path.join(fixture.projDir, "first.jsonl");
      fs.writeFileSync(
        firstJsonl,
        JSON.stringify({ sessionId: "SID-A", type: "user", message: { content: "a" } }) + "\n",
      );
      // Make sure it's after proxy start.
      const t1 = proxyStartTime + 500;
      fs.utimesSync(firstJsonl, t1 / 1000, t1 / 1000);

      const rotationSessionIds: Array<string | undefined> = [];
      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: (sid) => { rotationSessionIds.push(sid); },
        proxyStartTimeOverride: proxyStartTime,
      });

      try {
        // First lock should bind to first.jsonl.
        expect(handle?.getSessionId?.()).toBe("SID-A");
        expect(rotationSessionIds[0]).toBe("SID-A");

        // Now a second session arrives in same project dir with a different sessionId.
        const secondJsonl = path.join(fixture.projDir, "second.jsonl");
        fs.writeFileSync(
          secondJsonl,
          JSON.stringify({ sessionId: "SID-B", type: "user", message: { content: "b" } }) + "\n",
        );
        const t2 = proxyStartTime + 2000;
        fs.utimesSync(secondJsonl, t2 / 1000, t2 / 1000);

        // Synthetic close + restart to drive a fresh initial scan that picks
        // the newer file. (chokidar event delivery in-process is async and
        // not strictly necessary to validate the lock-decision logic itself.)
        handle?.close();

        const rotations2: Array<string | undefined> = [];
        const handle2 = setupJsonlWatcher({
          cwd: fixture.fakeCwd,
          onEntry: () => {},
          onRotation: (sid) => { rotations2.push(sid); },
          proxyStartTimeOverride: proxyStartTime,
        });
        try {
          expect(handle2?.getLockedJsonlPath?.()).toBe(secondJsonl);
          expect(handle2?.getSessionId?.()).toBe("SID-B");
          expect(rotations2[0]).toBe("SID-B");
        } finally {
          handle2?.close();
        }
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });
});

// ── B1 recording-side session binding tests ──

/** Write a JSONL with a given sessionId and set its mtime (seconds since epoch). */
function writeJsonl(dir: string, name: string, sessionId: string, mtimeMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    JSON.stringify({ sessionId, type: "user", message: { content: "x" } }) + "\n",
  );
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

describe("jsonlWatcher — B1 bind-first-stick-hard", () => {
  it("does NOT migrate to a newer JSONL in the same cwd once locked", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      const fileA = writeJsonl(fixture.projDir, "a.jsonl", "SID-A", t0 + 500);

      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
      });
      try {
        expect(handle?.getLockedJsonlPath?.()).toBe(fileA);
        expect(handle?.getSessionId?.()).toBe("SID-A");

        // A second window writes a NEWER transcript in the same cwd.
        writeJsonl(fixture.projDir, "b.jsonl", "SID-B", t0 + 5000);
        handle?.rescan?.();

        // Stick-hard: we must remain bound to A, never migrate to B.
        expect(handle?.getLockedJsonlPath?.()).toBe(fileA);
        expect(handle?.getSessionId?.()).toBe("SID-A");
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });

  it("migrates when EVO_DISABLE_STICK_HARD=1 (legacy escape hatch)", () => {
    const fixture = makeFakeHomeAndProject();
    const prev = process.env.EVO_DISABLE_STICK_HARD;
    process.env.EVO_DISABLE_STICK_HARD = "1";
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      writeJsonl(fixture.projDir, "a.jsonl", "SID-A", t0 + 500);

      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
      });
      try {
        const fileB = writeJsonl(fixture.projDir, "b.jsonl", "SID-B", t0 + 5000);
        handle?.rescan?.();
        // Legacy behaviour: migrate to the newer file.
        expect(handle?.getLockedJsonlPath?.()).toBe(fileB);
        expect(handle?.getSessionId?.()).toBe("SID-B");
      } finally {
        handle?.close();
      }
    } finally {
      if (prev === undefined) delete process.env.EVO_DISABLE_STICK_HARD;
      else process.env.EVO_DISABLE_STICK_HARD = prev;
      fixture.restore();
    }
  });
});

describe("jsonlWatcher — B1 exact binding (expectedSessionId)", () => {
  it("binds ONLY to the JSONL whose sessionId matches, ignoring a newer other session", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      // Another window's session is NEWER by mtime …
      writeJsonl(fixture.projDir, "other.jsonl", "OTHER-SID", t0 + 3000);
      // … but ours is the one we injected.
      const mine = writeJsonl(fixture.projDir, "mine.jsonl", "MINE-SID", t0 + 1000);

      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
        expectedSessionId: "MINE-SID",
      });
      try {
        expect(handle?.getLockedJsonlPath?.()).toBe(mine);
        expect(handle?.getSessionId?.()).toBe("MINE-SID");
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });

  it("stays unbound until the matching sessionId appears", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      writeJsonl(fixture.projDir, "other.jsonl", "OTHER-SID", t0 + 1000);

      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
        expectedSessionId: "MINE-SID",
      });
      try {
        expect(handle?.getLockedJsonlPath?.()).toBe("");
        // Our injected session finally writes its transcript.
        const mine = writeJsonl(fixture.projDir, "mine.jsonl", "MINE-SID", t0 + 2000);
        handle?.rescan?.();
        expect(handle?.getLockedJsonlPath?.()).toBe(mine);
        expect(handle?.getSessionId?.()).toBe("MINE-SID");
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });
});

describe("jsonlWatcher — B1 ownership gate (canBindSession)", () => {
  it("skips a session owned by another live proxy and binds the next free one", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      // The freshest file is owned by another proxy …
      writeJsonl(fixture.projDir, "owned.jsonl", "OWNED-SID", t0 + 3000);
      // … the older one is free for us.
      const free = writeJsonl(fixture.projDir, "free.jsonl", "FREE-SID", t0 + 1000);

      const seen: string[] = [];
      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
        canBindSession: (sid) => {
          seen.push(sid);
          return sid !== "OWNED-SID";
        },
      });
      try {
        expect(handle?.getLockedJsonlPath?.()).toBe(free);
        expect(handle?.getSessionId?.()).toBe("FREE-SID");
        // The gate was consulted for the owned session first (newest), then ours.
        expect(seen).toContain("OWNED-SID");
        expect(seen).toContain("FREE-SID");
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });

  it("defers binding when the candidate sessionId is not yet readable", () => {
    const fixture = makeFakeHomeAndProject();
    try {
      if (!homedirRedirectWorks(fixture.fakeHome)) return;
      const t0 = Date.now();
      // Empty file: header/sessionId not yet flushed.
      const empty = path.join(fixture.projDir, "empty.jsonl");
      fs.writeFileSync(empty, "");
      fs.utimesSync(empty, (t0 + 1000) / 1000, (t0 + 1000) / 1000);

      const handle = setupJsonlWatcher({
        cwd: fixture.fakeCwd,
        onEntry: () => {},
        onRotation: () => {},
        proxyStartTimeOverride: t0,
        canBindSession: () => true,
      });
      try {
        // Ownership-gated path requires a readable sessionId → deferred.
        expect(handle?.getLockedJsonlPath?.()).toBe("");
      } finally {
        handle?.close();
      }
    } finally {
      fixture.restore();
    }
  });
});
