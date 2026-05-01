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
 * Disabled when EVO_NO_UPDATE_CHECK=1.
 *
 * Zero new dependencies: relies on Node 22 global fetch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PKG_NAME = "evolutionary-cli-wrapper";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1500;

interface CacheShape {
  checkedAt: number;
  latest: string;
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
    if (
      typeof parsed.checkedAt === "number" &&
      Number.isFinite(parsed.checkedAt) &&
      typeof parsed.latest === "string" &&
      parsed.latest.length > 0
    ) {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(filePath: string, data: CacheShape): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch {
    // Best-effort
  }
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
        writeCache(filePath, { checkedAt: Date.now(), latest: body.version });
      }
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
  const isStale = !cached || now - cached.checkedAt >= CACHE_TTL_MS;

  if (isStale) {
    // Trigger background refresh; do NOT await.
    try {
      doFetch(filePath);
    } catch {
      // ignore — fire-and-forget by contract
    }
  }

  // Render decision uses cached value (if any). On the first ever run there
  // is no cache, so we return null this tick; the next tick (after fetch
  // completes) will see fresh data.
  if (!cached) return null;

  const cmp = compareSemver(cached.latest, current);
  if (cmp === null) return null;
  if (cmp <= 0) return null;

  return `⚠ update: ${current} → ${cached.latest} (npm update -g ${PKG_NAME})`;
}
