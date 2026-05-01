import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareSemver, getUpdateNotice } from "../src/updateCheck";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-updchk-"));
  tempDirs.push(dir);
  return dir;
}

function tmpCachePath(): string {
  return path.join(makeTempDir(), "update-check.json");
}

function writeCache(filePath: string, checkedAt: number, latest: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ checkedAt, latest }));
}

afterEach(() => {
  delete process.env.EVO_NO_UPDATE_CHECK;
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("compareSemver", () => {
  it("returns 1 when a > b", () => {
    expect(compareSemver("2.2.10", "2.2.9")).toBe(1);
    expect(compareSemver("3.0.0", "2.99.99")).toBe(1);
    expect(compareSemver("2.3.0", "2.2.99")).toBe(1);
  });
  it("returns -1 when a < b", () => {
    expect(compareSemver("2.2.4", "2.2.5")).toBe(-1);
    expect(compareSemver("1.99.99", "2.0.0")).toBe(-1);
  });
  it("returns 0 when equal", () => {
    expect(compareSemver("2.2.4", "2.2.4")).toBe(0);
    expect(compareSemver("v2.2.4", "2.2.4")).toBe(0);
  });
  it("handles double-digit patch correctly (2.2.10 > 2.2.9)", () => {
    expect(compareSemver("2.2.10", "2.2.9")).toBe(1);
    expect(compareSemver("2.2.9", "2.2.10")).toBe(-1);
  });
  it("returns null on garbage input", () => {
    expect(compareSemver("not-a-version", "2.2.4")).toBe(null);
    expect(compareSemver("2.2", "2.2.4")).toBe(null);
  });
  it("ignores prerelease suffix in patch", () => {
    expect(compareSemver("2.2.10-beta", "2.2.9")).toBe(1);
  });
});

describe("getUpdateNotice", () => {
  it("returns notice when cached latest > current (fresh cache)", () => {
    const cache = tmpCachePath();
    writeCache(cache, Date.now(), "9.9.9");
    let fetched = false;
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: Date.now(),
      fetchFn: () => {
        fetched = true;
      },
    });
    expect(notice).not.toBeNull();
    expect(notice).toContain("9.9.9");
    expect(notice).toContain("2.2.4");
    expect(notice).toContain("npm update -g evolutionary-cli-wrapper");
    expect(fetched).toBe(false); // fresh cache → no refetch
  });

  it("returns null when cached latest == current", () => {
    const cache = tmpCachePath();
    writeCache(cache, Date.now(), "2.2.4");
    expect(
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: Date.now(),
        fetchFn: () => {},
      }),
    ).toBeNull();
  });

  it("returns null when cached latest < current (e.g. local dev ahead)", () => {
    const cache = tmpCachePath();
    writeCache(cache, Date.now(), "2.2.0");
    expect(
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: Date.now(),
        fetchFn: () => {},
      }),
    ).toBeNull();
  });

  it("triggers background fetch and uses old cached comparison when stale (offline-safe)", () => {
    const cache = tmpCachePath();
    const old = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    writeCache(cache, old, "9.9.9");
    let fetched = false;
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: Date.now(),
      // simulate offline — fetch throws, must not crash
      fetchFn: () => {
        fetched = true;
        throw new Error("simulated offline");
      },
    });
    // Render uses OLD cached value despite stale.
    expect(notice).not.toBeNull();
    expect(notice).toContain("9.9.9");
    expect(fetched).toBe(true);
  });

  it("returns null on first run (no cache exists)", () => {
    const cache = tmpCachePath(); // file does not exist
    let fetched = false;
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: Date.now(),
      fetchFn: () => {
        fetched = true;
      },
    });
    expect(notice).toBeNull();
    expect(fetched).toBe(true); // first run schedules a refresh
  });

  it("respects EVO_NO_UPDATE_CHECK=1", () => {
    const cache = tmpCachePath();
    writeCache(cache, Date.now(), "9.9.9");
    process.env.EVO_NO_UPDATE_CHECK = "1";
    let fetched = false;
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: Date.now(),
      fetchFn: () => {
        fetched = true;
      },
    });
    expect(notice).toBeNull();
    expect(fetched).toBe(false);
  });

  it("handles 2.2.10 > 2.2.9 in the notice path (not a string compare)", () => {
    const cache = tmpCachePath();
    writeCache(cache, Date.now(), "2.2.10");
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.9",
      now: Date.now(),
      fetchFn: () => {},
    });
    expect(notice).not.toBeNull();
    expect(notice).toContain("2.2.10");
  });

  it("returns null when cache is corrupt", () => {
    const cache = tmpCachePath();
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, "{not json");
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: Date.now(),
      fetchFn: () => {},
    });
    expect(notice).toBeNull();
  });
});
