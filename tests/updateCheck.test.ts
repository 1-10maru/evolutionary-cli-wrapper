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

// ── Negative caching: the offline retry storm ───────────────────────────────
// `latest` is only written by a SUCCESSFUL fetch, so without a record of failed
// attempts an offline machine re-fires on every single call. Harmless on sparse
// event-driven ticks; a storm once statusLine.refreshInterval re-runs the
// statusline on a timer (12 requests/minute at 5s, indefinitely).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function readRaw(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

/** A fetch that never succeeds — offline, DNS down, proxy, abort. */
function failingFetch(counter: { n: number }) {
  return () => {
    counter.n += 1;
    // Writes nothing, exactly like the real fetch on every non-success path.
  };
}

describe("getUpdateNotice — negative caching / retry throttle", () => {
  it("records a failed attempt so the retry window is armed", () => {
    const cache = tmpCachePath();
    const now = Date.now();
    const calls = { n: 0 };
    getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now,
      fetchFn: failingFetch(calls),
    });
    expect(calls.n).toBe(1);
    // A record now exists even though the fetch produced nothing.
    expect(fs.existsSync(cache)).toBe(true);
    expect(readRaw(cache).lastAttemptAt).toBe(now);
    expect(readRaw(cache).latest).toBeUndefined();
  });

  it("does NOT fetch again within the retry window (this is the storm fix)", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    const tick = (at: number) =>
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: at,
        fetchFn: failingFetch(calls),
      });

    tick(t0);
    expect(calls.n).toBe(1);
    // Simulate a statusline refreshing every 5s for 10 minutes while offline.
    for (let dt = 5000; dt <= 10 * 60 * 1000; dt += 5000) tick(t0 + dt);
    // Before the fix this was 121 requests; now the first attempt is the only one.
    expect(calls.n).toBe(1);
  });

  it("DOES fetch again once the retry window has elapsed", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    const tick = (at: number) =>
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: at,
        fetchFn: failingFetch(calls),
      });

    tick(t0);
    expect(calls.n).toBe(1);
    tick(t0 + HOUR - 1); // still inside the window
    expect(calls.n).toBe(1);
    tick(t0 + HOUR); // window elapsed
    expect(calls.n).toBe(2);
    tick(t0 + HOUR + 5000); // and it re-arms immediately
    expect(calls.n).toBe(2);
    tick(t0 + 2 * HOUR); // ~one attempt per hour, not 720
    expect(calls.n).toBe(3);
  });

  it("a SUCCESSFUL fetch still uses the 24h window, not the retry window", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    // A success record carries all three fields.
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(
      cache,
      JSON.stringify({ checkedAt: t0, latest: "9.9.9", lastAttemptAt: t0 }),
    );
    const tick = (at: number) =>
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: at,
        fetchFn: failingFetch(calls),
      });

    // Well past the 1h retry window but inside the 24h success window: the
    // shorter window must NOT drag a good cache into refetching hourly.
    expect(tick(t0 + 2 * HOUR)).toContain("9.9.9");
    expect(calls.n).toBe(0);
    expect(tick(t0 + 23 * HOUR)).toContain("9.9.9");
    expect(calls.n).toBe(0);
    // Past 24h it refreshes, still serving the old value meanwhile.
    expect(tick(t0 + DAY)).toContain("9.9.9");
    expect(calls.n).toBe(1);
  });

  it("a failed refresh never destroys a good cached answer", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ checkedAt: t0 - 2 * DAY, latest: "9.9.9" }));
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: t0,
      fetchFn: failingFetch(calls),
    });
    expect(calls.n).toBe(1);
    expect(notice).toContain("9.9.9"); // still rendered from the stale cache
    const raw = readRaw(cache);
    expect(raw.latest).toBe("9.9.9"); // preserved through the attempt stamp
    expect(raw.lastAttemptAt).toBe(t0);
  });

  it("reads a PRE-CHANGE cache file (no lastAttemptAt) as never attempted", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    // Exactly the old on-disk format, stale.
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ checkedAt: t0 - 2 * DAY, latest: "9.9.9" }));
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: t0,
      fetchFn: failingFetch(calls),
    });
    // Behaves exactly as before the change: renders the old value, refetches.
    expect(notice).toContain("9.9.9");
    expect(calls.n).toBe(1);

    // And an old FRESH record is still honoured without a fetch.
    const cache2 = tmpCachePath();
    const calls2 = { n: 0 };
    fs.mkdirSync(path.dirname(cache2), { recursive: true });
    fs.writeFileSync(cache2, JSON.stringify({ checkedAt: t0, latest: "9.9.9" }));
    expect(
      getUpdateNotice({
        cachePath: cache2,
        currentVersion: "2.2.4",
        now: t0 + HOUR,
        fetchFn: failingFetch(calls2),
      }),
    ).toContain("9.9.9");
    expect(calls2.n).toBe(0);
  });

  it("an attempt stamp from the FUTURE does not wedge the retry off forever", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    // Clock skew or a restored backup.
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ lastAttemptAt: t0 + 10 * DAY }));
    getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: t0,
      fetchFn: failingFetch(calls),
    });
    expect(calls.n).toBe(1);
    expect(readRaw(cache).lastAttemptAt).toBe(t0); // corrected forward
  });

  it("still honours EVO_NO_UPDATE_CHECK=1 and writes nothing at all", () => {
    const cache = tmpCachePath();
    process.env.EVO_NO_UPDATE_CHECK = "1";
    const calls = { n: 0 };
    expect(
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: Date.now(),
        fetchFn: failingFetch(calls),
      }),
    ).toBeNull();
    expect(calls.n).toBe(0);
    expect(fs.existsSync(cache)).toBe(false); // no stamp when disabled
  });

  it("FAILS CLOSED when the stamp cannot be persisted (S-U1)", () => {
    // A directory squatting on the cache path — also reachable via a read-only
    // home, a full disk, or a permission problem. writeCache cannot land, so
    // the retry window is never armed; fetching anyway reproduces the storm in
    // full (measured 1,441 ticks over 2h -> 1,441 requests).
    const dir = makeTempDir();
    const cache = path.join(dir, "update-check.json");
    fs.mkdirSync(cache, { recursive: true }); // occupy the path with a directory
    const t0 = Date.now();
    const calls = { n: 0 };
    // Two hours of 5s ticks.
    for (let dt = 0; dt <= 2 * HOUR; dt += 5000) {
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now: t0 + dt,
        fetchFn: failingFetch(calls),
      });
    }
    // Missing an update notice is far cheaper than 12 requests a minute.
    expect(calls.n).toBe(0);
  });

  it("a FUTURE-dated success record does not silence update checks forever (S-U2)", () => {
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    // Clock skew or a restored backup: checkedAt a year ahead.
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(
      cache,
      JSON.stringify({ checkedAt: t0 + 365 * DAY, latest: "9.9.9" }),
    );
    getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: t0,
      fetchFn: failingFetch(calls),
    });
    // Both clocks are bounded the same way, so the skewed record is not "fresh".
    expect(calls.n).toBe(1);
    expect(readRaw(cache).lastAttemptAt).toBe(t0);
  });

  it("keeps a clockless record that still carries `latest`", () => {
    // Hand-edited or interrupted write. Dropping it made noteAttempt overwrite
    // the file with {lastAttemptAt} alone and destroy a good cached version.
    const cache = tmpCachePath();
    const t0 = Date.now();
    const calls = { n: 0 };
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ latest: "9.9.9" }));
    const notice = getUpdateNotice({
      cachePath: cache,
      currentVersion: "2.2.4",
      now: t0,
      fetchFn: failingFetch(calls),
    });
    expect(notice).toContain("9.9.9"); // still usable
    expect(calls.n).toBe(1); // no clock -> refresh
    expect(readRaw(cache).latest).toBe("9.9.9"); // and NOT destroyed
  });

  it("a throwing fetchFn is still swallowed, and the attempt is still stamped", () => {
    const cache = tmpCachePath();
    const now = Date.now();
    expect(() =>
      getUpdateNotice({
        cachePath: cache,
        currentVersion: "2.2.4",
        now,
        fetchFn: () => {
          throw new Error("simulated offline");
        },
      }),
    ).not.toThrow();
    expect(readRaw(cache).lastAttemptAt).toBe(now);
  });
});
