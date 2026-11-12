/**
 * Non-blocking npm-registry update check for the statusline.
 *
 * Stale-while-revalidate semantics:
 *   - Cache lives at <evoHome>/update-check.json (default: ~/.evo).
 *   - If cache is fresh (< 24h), use the cached `latest` synchronously.
 *   - If cache is stale (>= 24h) or missing, fire a fire-and-forget fetch
 *     against registry.npmjs.org to refresh it. The CURRENT statusline render
 *     uses the OLD cached `latest` (or null on first ever run); the next
 *     render after the background fetch completes will see the new value.
 *   - Network failures are silently ignored.
 *
 * NEGATIVE CACHING (why `lastAttemptAt` exists):
 *   `latest` is only ever written by a SUCCESSFUL fetch. Without a record of
 *   failed attempts, an offline machine never refreshes the cache, so the entry
 *   stays stale, so the next call fires another request — forever. That is
 *   harmless when the statusline renders on sparse event-driven ticks, and a
 *   retry storm once `statusLine.refreshInterval` re-runs it on a timer (at 5s:
 *   12 requests/minute, 720/hour, each with a 1.5s abort timer, for as long as
 *   the machine is offline).
 *
 *   So every ATTEMPT is stamped, not just every success, and there are two
 *   windows: CACHE_TTL_MS after a success, RETRY_AFTER_FAILURE_MS after a bare
 *   attempt. A transient failure therefore delays a genuine update notice by at
 *   most the retry window; a permanently offline machine tries once an hour.
 *
 *   Deliberately flat — no exponential backoff, no jitter, no circuit breaker.
 *
 * Disabled when EVO_NO_UPDATE_CHECK=1.
 *
 * Zero new dependencies: relies on Node 22 global fetch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PKG_NAME = "evolutionary-cli-wrapper";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h after a SUCCESSFUL fetch
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000; // 1h after a bare attempt
const FETCH_TIMEOUT_MS = 1500;

interface CacheShape {
  /** When a fetch last SUCCEEDED. Absent if one never has. */
  checkedAt?: number;
  /** Latest version from that successful fetch. Absent if one never succeeded. */
  latest?: string;
  /**
   * When a fetch was last ATTEMPTED, whatever the outcome. Absent in records
   * written by the pre-negative-caching format, which is read as "never
   * attempted" so those callers behave exactly as they did before.
   */
  lastAttemptAt?: number;
}

function getCachePath(): string {
  const fromEnv = process.env.EVO_HOME;
  const home =
    fromEnv && fromEnv.trim().length > 0
      ? path.resolve(fromEnv)
      : os.homedir();
  return path.join(home, ".evo", "update-check.json");
}

function readCache(filePath: string): CacheShape | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    const out: CacheShape = {};
    if (typeof parsed.checkedAt === "number" && Number.isFinite(parsed.checkedAt)) {
      out.checkedAt = parsed.checkedAt;
    }
    if (typeof parsed.latest === "string" && parsed.latest.length > 0) {
      out.latest = parsed.latest;
    }
    if (
      typeof parsed.lastAttemptAt === "number" &&
      Number.isFinite(parsed.lastAttemptAt)
    ) {
      out.lastAttemptAt = parsed.lastAttemptAt;
    }
    // A record with neither clock AND no `latest` carries no information —
    // treat it as absent so the caller behaves as it does for a missing file.
    // But a clockless record that DOES carry `latest` must still be returned:
    // dropping it made noteAttempt overwrite the file with {lastAttemptAt}
    // alone, destroying a perfectly good cached version.
    if (
      out.checkedAt === undefined &&
      out.lastAttemptAt === undefined &&
      out.latest === undefined
    ) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Persist the cache. Returns whether it actually landed — the caller needs to
 * know, because an unarmed retry window means a request on every tick.
 *
 * Atomic (tmp + rename), matching safeWriteJson in cli/statusline.ts: with
 * refreshInterval 5 and several concurrent sessions, two statuslines can write
 * this file at the same moment, and a torn read parses as corrupt, drops
 * `latest`, and fires a fetch.
 */
function writeCache(filePath: string, data: CacheShape): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json = JSON.stringify(data);
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, filePath);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      fs.writeFileSync(filePath, json);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Stamp "we are attempting a fetch right now", preserving any known `latest`
 * so a failed refresh never destroys a good cached answer. Best-effort: a
 * failed write means the retry window is NOT armed, so the caller must not
 * fetch — see the fail-closed branch in getUpdateNotice.
 */
function noteAttempt(
  filePath: string,
  cached: CacheShape | null,
  now: number,
): boolean {
  return writeCache(filePath, { ...(cached ?? {}), lastAttemptAt: now });
}

/**
 * Compare two semver-like strings ("MAJOR.MINOR.PATCH" with optional prerelease
 * suffix that we IGNORE — anything after the first non-numeric in patch is
 * treated as the numeric portion only). Returns:
 *   1  if a > b
 *   0  if a == b
 *  -1  if a < b
 *  null if either side is unparseable.
 */
export function compareSemver(a: string, b: string): number | null {
  const parse = (s: string): [number, number, number] | null => {
    if (typeof s !== "string") return null;
    const cleaned = s.trim().replace(/^v/i, "");
    const parts = cleaned.split(".");
    if (parts.length < 3) return null;
    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      // Strip any non-digit suffix (e.g. "10-beta" -> "10").
      const m = parts[i].match(/^(\d+)/);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n)) return null;
      nums.push(n);
    }
    return [nums[0], nums[1], nums[2]];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function fetchLatestAsync(filePath: string): void {
  // Fire-and-forget. Never await this in the statusline path.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  // Do not let this fire-and-forget timeout keep the event loop alive; the
  // statusline/CLI must be free to exit while the background fetch is pending.
  timer.unref?.();
  // Node 22 global fetch.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string" && body.version.length > 0) {
        const at = Date.now();
        // Success record: opens the 24h window and re-stamps the attempt.
        writeCache(filePath, { checkedAt: at, latest: body.version, lastAttemptAt: at });
      }
      // Every non-success path (non-ok status, missing/blank version, thrown
      // error, abort) falls through WITHOUT writing — deliberately. The attempt
      // was already stamped synchronously by getUpdateNotice before this fetch
      // was fired, so the retry window is armed no matter how this ends, or
      // whether it ends at all. See noteAttempt().
    } catch {
      // Silently ignore network/parse errors.
    } finally {
      clearTimeout(timer);
    }
  })();
}

function getCurrentVersion(): string {
  try {
    // require() is fine here — package.json is bundled at build time and
    // resolveJsonModule is enabled in tsconfig.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json") as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // ignore
  }
  return "0.0.0";
}

/**
 * Returns a single-line update notice if a newer version is known to be on
 * npm, or null otherwise. Never throws. Never blocks on network — stale cache
 * triggers a background refresh whose result is consumed by the NEXT call.
 */
export function getUpdateNotice(opts?: {
  cachePath?: string;
  currentVersion?: string;
  now?: number;
  fetchFn?: (filePath: string) => void;
}): string | null {
  if (process.env.EVO_NO_UPDATE_CHECK === "1") return null;

  const filePath = opts?.cachePath ?? getCachePath();
  const current = opts?.currentVersion ?? getCurrentVersion();
  const now = opts?.now ?? Date.now();
  const doFetch = opts?.fetchFn ?? fetchLatestAsync;

  const cached = readCache(filePath);

  // Fresh SUCCESS: a known `latest` inside the 24h window. The lower bound
  // matters for the same reason it does on the attempt clock below — a
  // future-dated record (clock skew, restored backup) would otherwise read as
  // "fresh" for as long as the skew lasts and silence update checks entirely.
  // That fails safe rather than loudly, but it is still the wedge we guard
  // against next door, so both clocks are bounded the same way.
  const successAge =
    cached?.checkedAt !== undefined ? now - cached.checkedAt : undefined;
  const hasFreshSuccess =
    cached?.latest !== undefined &&
    successAge !== undefined &&
    successAge >= 0 &&
    successAge < CACHE_TTL_MS;

  // Recent ATTEMPT, successful or not. The lower bound matters here: a stamp
  // from the future (clock skew, restored backup) must not wedge the retry off
  // permanently, so it is treated as "not recent" and we attempt again now.
  const sinceAttempt =
    cached?.lastAttemptAt !== undefined ? now - cached.lastAttemptAt : undefined;
  const attemptedRecently =
    sinceAttempt !== undefined &&
    sinceAttempt >= 0 &&
    sinceAttempt < RETRY_AFTER_FAILURE_MS;

  if (!hasFreshSuccess && !attemptedRecently) {
    // Record the attempt BEFORE firing it, so the retry window is armed even
    // if this process never observes the outcome — the statusline exits as soon
    // as it has written stdout, and Claude Code cancels an in-flight script
    // when a new update triggers. Stamping only in the fetch's failure branch
    // would leave the window unarmed in exactly those cases, which is the retry
    // storm this guards against.
    // FAIL CLOSED. If the stamp did not land — read-only home, full disk, a
    // directory squatting on the cache path, a permission problem — then the
    // retry window is not armed, and fetching anyway reproduces the storm in
    // full (measured: 1,441 ticks over 2h => 1,441 requests). Missing an update
    // notice is far cheaper than 12 requests a minute, so we skip the fetch.
    if (noteAttempt(filePath, cached, now)) {
      // Trigger background refresh; do NOT await.
      try {
        doFetch(filePath);
      } catch {
        // ignore — fire-and-forget by contract
      }
    }
  }

  // Render decision uses cached value (if any). On the first ever run there
  // is no cache, so we return null this tick; the next tick (after fetch
  // completes) will see fresh data. A record holding only a failed attempt has
  // no `latest` to compare, so it renders nothing either.
  if (!cached?.latest) return null;

  const cmp = compareSemver(cached.latest, current);
  if (cmp === null) return null;
  if (cmp <= 0) return null;

  return `⚠ update: ${current} → ${cached.latest} (npm update -g ${PKG_NAME})`;
}
