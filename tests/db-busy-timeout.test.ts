import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvoDatabase } from "../src/db";

// A concurrent same-cwd proxy scenario: one connection holds the WAL write lock
// (BEGIN IMMEDIATE) while another writes. Without busy_timeout the second writer
// errors SQLITE_BUSY immediately; with it set, it waits its short turn and
// succeeds. better-sqlite3 is synchronous, so the lock holder MUST run in a
// separate thread (a worker) — otherwise the main thread would deadlock.

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

function makeDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-busy-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "t.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
  db.close();
  return dbPath;
}

// Worker: grabs the write lock (BEGIN IMMEDIATE + insert), tells the parent, then
// holds it for holdMs before committing and releasing.
const LOCK_HOLDER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO t (v) VALUES (?)").run("from-worker");
parentPort.postMessage("locked");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  parentPort.postMessage("released");
}, workerData.holdMs);
`;

async function withHeldLock(dbPath: string, holdMs: number): Promise<Worker> {
  const worker = new Worker(LOCK_HOLDER_SRC, { eval: true, workerData: { dbPath, holdMs } });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", (m) => (m === "locked" ? resolve() : undefined));
    worker.once("error", reject);
  });
  return worker;
}

describe("SQLITE_BUSY / busy_timeout under concurrent writers", () => {
  it("a writer with busy_timeout set waits for the lock and succeeds (does not throw)", async () => {
    const dbPath = makeDbFile();
    const holdMs = 500;
    const worker = await withHeldLock(dbPath, holdMs);

    const db = new Database(dbPath);
    db.pragma("busy_timeout = 3000");
    const start = Date.now();
    // Contends with the worker's write lock; should block until the worker
    // commits (~holdMs) rather than throwing.
    expect(() => db.prepare("INSERT INTO t (v) VALUES (?)").run("from-main")).not.toThrow();
    const elapsed = Date.now() - start;
    const count = (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
    db.close();
    await worker.terminate();

    expect(count).toBe(2); // both writes landed
    expect(elapsed).toBeGreaterThan(holdMs - 150); // it actually waited for the lock
    expect(elapsed).toBeLessThan(3000); // and finished before the timeout
  }, 20_000);

  it("a writer with a too-short busy_timeout still errors SQLITE_BUSY (control)", async () => {
    const dbPath = makeDbFile();
    const worker = await withHeldLock(dbPath, 800);

    const db = new Database(dbPath);
    db.pragma("busy_timeout = 50"); // far shorter than the 800ms hold
    let caught: unknown;
    try {
      db.prepare("INSERT INTO t (v) VALUES (?)").run("from-main");
    } catch (err) {
      caught = err;
    }
    db.close();
    await worker.terminate();

    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).toMatch(/SQLITE_BUSY|database is locked/i);
  }, 20_000);

  it("EvoDatabase sets busy_timeout = 5000 on its connection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-busy-pragma-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"demo"}');
    const evo = new EvoDatabase(dir);
    const value = evo.db.pragma("busy_timeout", { simple: true });
    evo.close();
    expect(value).toBe(5000);
  });
});
