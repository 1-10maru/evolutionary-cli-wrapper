import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The QA-round-3 crash is a classic SQLite upgrade-deadlock: a DEFERRED
// transaction reads (taking a read snapshot) then writes (upgrade). If another
// connection committed in between, the upgrade fails with SQLITE_BUSY — and the
// busy handler is bypassed for deadlocks, so busy_timeout does NOT help. BEGIN
// IMMEDIATE takes the write lock up front, so the read is always current and the
// write proceeds; concurrent writers serialize via busy_timeout instead.
//
// better-sqlite3 is synchronous, so the two contending connections run in
// worker threads.

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
});

function makeKvDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-concurrency-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "kv.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)");
  db.close();
  return dbPath;
}

// Worker: run `iters` read-then-write transactions on the shared key, in either
// DEFERRED (default call) or IMMEDIATE mode. Reports how many raised SQLITE_BUSY.
const RMW_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const db = new Database(workerData.dbPath);
db.pragma("busy_timeout = 5000");
const select = db.prepare("SELECT v FROM kv WHERE k = ?");
const upsert = db.prepare("INSERT INTO kv (k, v) VALUES (@k, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1");
const txn = db.transaction((k) => { select.get(k); upsert.run({ k }); });
let busy = 0, ok = 0;
for (let i = 0; i < workerData.iters; i++) {
  try {
    if (workerData.mode === "immediate") txn.immediate(workerData.key);
    else txn(workerData.key);
    ok++;
  } catch (e) {
    if (e.code === "SQLITE_BUSY" || /database is locked/i.test(String(e.message))) busy++;
    else { db.close(); throw e; }
  }
}
db.close();
parentPort.postMessage({ busy, ok });
`;

async function runTwoWorkers(
  dbPath: string,
  mode: "deferred" | "immediate",
  iters: number,
): Promise<Array<{ busy: number; ok: number }>> {
  const spawn = (): Promise<{ busy: number; ok: number }> =>
    new Promise((resolve, reject) => {
      const w = new Worker(RMW_WORKER, {
        eval: true,
        workerData: { dbPath, mode, iters, key: "shared" },
      });
      w.once("message", (m: { busy: number; ok: number }) => resolve(m));
      w.once("error", reject);
    });
  return Promise.all([spawn(), spawn()]);
}

describe("DB concurrency: deferred deadlock vs immediate", () => {
  it("DEFERRED read-then-write transactions cross-deadlock (SQLITE_BUSY) — the bug", async () => {
    const dbPath = makeKvDb();
    const [a, b] = await runTwoWorkers(dbPath, "deferred", 400);
    // With deferred begins, the crossed upgrade deterministically raises
    // SQLITE_BUSY under this contention.
    expect(a.busy + b.busy).toBeGreaterThan(0);
  }, 30_000);

  it("IMMEDIATE read-then-write transactions never raise SQLITE_BUSY and lose no updates", async () => {
    const dbPath = makeKvDb();
    const iters = 400;
    const [a, b] = await runTwoWorkers(dbPath, "immediate", iters);
    expect(a.busy + b.busy).toBe(0);
    expect(a.ok + b.ok).toBe(iters * 2);

    const db = new Database(dbPath);
    const value = (db.prepare("SELECT v FROM kv WHERE k = ?").get("shared") as { v: number }).v;
    db.close();
    // Every increment landed — no lost updates from the read-modify-write.
    expect(value).toBe(iters * 2);
  }, 30_000);
});

// ensureColumn is check-then-act (PRAGMA table_info -> ALTER TABLE ADD COLUMN).
// Two proxies first-opening the same UNMIGRATED db both observe the column
// missing and both ALTER; the loser throws SQLITE_ERROR "duplicate column name".
// The guard swallows exactly that race. This worker mirrors ensureColumn's guard
// and a barrier ('ready' -> 'go') forces both connections to ALTER concurrently.
const MIGRATE_RACE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const db = new Database(workerData.dbPath);
db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)");
// Check phase (before the barrier), so BOTH connections decide "missing".
const cols = db.prepare("PRAGMA table_info(t)").all();
const missing = !cols.some((c) => c.name === "extra");
parentPort.postMessage("ready");
parentPort.on("message", (m) => {
  if (m !== "go") return;
  let result;
  try {
    if (missing) db.exec("ALTER TABLE t ADD COLUMN extra TEXT");
    result = { ok: true, altered: !!missing };
  } catch (e) {
    if (/duplicate column name/i.test(String(e.message))) result = { ok: true, raced: true };
    else result = { ok: false, err: String(e.message), code: e.code };
  }
  db.close();
  parentPort.postMessage(result);
});
`;

describe("DB migration race: concurrent ensureColumn-style ALTER", () => {
  it("two connections racing the same ADD COLUMN both succeed (duplicate-column swallowed)", async () => {
    const dbPath = makeKvDb(); // fresh db; table `t` has no `extra` column yet

    const workers = [0, 1].map(() => new Worker(MIGRATE_RACE_WORKER, { eval: true, workerData: { dbPath } }));
    const results: Array<{ ok: boolean; altered?: boolean; raced?: boolean; err?: string }> = [];

    await new Promise<void>((resolve, reject) => {
      let ready = 0;
      let done = 0;
      for (const w of workers) {
        w.on("error", reject);
        w.on("message", (m: unknown) => {
          if (m === "ready") {
            ready += 1;
            if (ready === workers.length) workers.forEach((x) => x.postMessage("go"));
            return;
          }
          results.push(m as { ok: boolean });
          done += 1;
          if (done === workers.length) resolve();
        });
      }
    });
    await Promise.all(workers.map((w) => w.terminate()));

    // Neither connection threw; exactly one added the column, the other raced.
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.some((r) => r.altered)).toBe(true);

    // The column exists exactly once.
    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info(t)").all() as Array<{ name: string }>;
    db.close();
    expect(cols.filter((c) => c.name === "extra").length).toBe(1);
  }, 30_000);
});
