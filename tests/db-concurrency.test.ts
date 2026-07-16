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

// Deterministic upgrade-deadlock harness. Each worker holds a DEFERRED
// transaction open ACROSS message turns (manual BEGIN/COMMIT, not db.transaction,
// which would run to completion synchronously), so the parent can latch the exact
// interleaving: both take a read snapshot at the same db version, then one commits
// and the other upgrades from its now-stale snapshot. That second upgrade fails
// with SQLITE_BUSY_SNAPSHOT every time — SQLite bypasses the busy handler for it,
// which is precisely why busy_timeout does not save a DEFERRED read-then-write.
const DEADLOCK_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const db = new Database(workerData.dbPath);
db.pragma("busy_timeout = 5000");
const read = db.prepare("SELECT v FROM kv WHERE k = ?");
const write = db.prepare("INSERT INTO kv (k, v) VALUES (@k, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1");
parentPort.on("message", (cmd) => {
  try {
    if (cmd === "read") {
      db.exec("BEGIN DEFERRED");
      read.get("shared"); // establishes the read snapshot
      parentPort.postMessage({ ev: "read-done" });
    } else if (cmd === "write") {
      write.run({ k: "shared" }); // upgrade read -> write
      db.exec("COMMIT");
      parentPort.postMessage({ ev: "write-done", busy: false });
    }
  } catch (e) {
    const code = String((e && e.code) || "");
    const busy = code.indexOf("SQLITE_BUSY") === 0 || /database is locked|snapshot/i.test(String(e && e.message));
    try { db.exec("ROLLBACK"); } catch (_) {}
    parentPort.postMessage({ ev: "write-done", busy: busy, code: code, msg: String(e && e.message) });
  }
});
`;

function nextMessage(w: Worker, pred: (m: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMsg = (m: any) => {
      if (!pred(m)) return;
      w.off("message", onMsg);
      w.off("error", reject);
      resolve(m);
    };
    w.on("message", onMsg);
    w.on("error", reject);
  });
}

describe("DB concurrency: deferred deadlock vs immediate", () => {
  it("DEFERRED read-then-write deterministically deadlocks (SQLITE_BUSY) when a writer commits in between — the bug", async () => {
    const dbPath = makeKvDb();
    const committer = new Worker(DEADLOCK_WORKER, { eval: true, workerData: { dbPath } });
    const victim = new Worker(DEADLOCK_WORKER, { eval: true, workerData: { dbPath } });

    try {
      // 1. Both open a DEFERRED transaction and read at the SAME db version.
      victim.postMessage("read");
      await nextMessage(victim, (m) => m.ev === "read-done");
      committer.postMessage("read");
      await nextMessage(committer, (m) => m.ev === "read-done");

      // 2. The committer upgrades its read to a write and COMMITs — no contender
      //    has written since its snapshot, so this one always wins.
      committer.postMessage("write");
      const c = await nextMessage(committer, (m) => m.ev === "write-done");
      expect(c.busy).toBe(false);

      // 3. The victim now upgrades from its now-stale snapshot: deterministic
      //    upgrade-deadlock. busy_timeout is bypassed, so it fails immediately.
      victim.postMessage("write");
      const v = await nextMessage(victim, (m) => m.ev === "write-done");
      expect(v.busy).toBe(true);
    } finally {
      await Promise.all([committer.terminate(), victim.terminate()]);
    }
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

// The constructor's `PRAGMA journal_mode = WAL` (src/db.ts) takes a brief
// EXCLUSIVE lock and, unlike ordinary writes, can return SQLITE_BUSY IMMEDIATELY
// without invoking the busy handler when two connections switch a brand-new db
// at the same instant — so busy_timeout does not cover it (QA saw ~2/25 two-way
// fresh-db launches crash exactly here). This worker mirrors the constructor:
// open, set busy_timeout, then the wrapped WAL switch. On retry the winner has
// finished and the db is already WAL, so the pragma returns "wal" uncontended.
const WAL_RACE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
// Mirror of src/db.ts withBusyRetry (kept in sync intentionally).
function withBusyRetry(fn) {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try { return fn(); }
    catch (e) {
      const code = String((e && e.code) || "");
      if (code !== "SQLITE_BUSY" || attempt >= maxAttempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}
const db = new Database(workerData.dbPath); // brand-new file -> rollback mode
db.pragma("busy_timeout = 5000");
parentPort.postMessage("ready");
parentPort.on("message", (m) => {
  if (m !== "go") return;
  try {
    withBusyRetry(() => db.pragma("journal_mode = WAL"));
    const mode = db.pragma("journal_mode", { simple: true });
    db.close();
    parentPort.postMessage({ ok: true, mode: mode });
  } catch (e) {
    try { db.close(); } catch (_) {}
    parentPort.postMessage({ ok: false, code: String(e && e.code), msg: String(e && e.message) });
  }
});
`;

function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-wal-"));
  tempDirs.push(dir);
  return path.join(dir, "fresh.db"); // does not exist yet: both workers create/open it
}

describe("DB WAL-switch race: concurrent first-open journal_mode=WAL", () => {
  it("two connections switching a brand-new db to WAL both succeed (SQLITE_BUSY retried)", async () => {
    // Hammer the fresh-db 2-way race many times: the collision is probabilistic
    // (QA ~2/25), but WITH the retry every worker succeeds on every iteration.
    const iterations = 25;
    for (let i = 0; i < iterations; i += 1) {
      const dbPath = freshDbPath();
      const workers = [0, 1].map(() => new Worker(WAL_RACE_WORKER, { eval: true, workerData: { dbPath } }));
      const results: Array<{ ok: boolean; mode?: string; code?: string; msg?: string }> = [];

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

      const failed = results.filter((r) => !r.ok);
      expect(failed, `iteration ${i}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(results.every((r) => r.mode === "wal")).toBe(true);
    }
  }, 60_000);
});
