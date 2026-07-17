import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFileSync,
  readJsonFileWithRetrySync,
  gcStaleAtomicTmps,
  isAtomicTmpName,
} from "../../src/utils/atomicFile";

const tempDirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "evo-atomicfile-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("atomicWriteFileSync", () => {
  it("writes via a tmp file then rename (no tmp left behind)", () => {
    const dir = tmpDir();
    const target = path.join(dir, "out.json");

    const renameSpy = vi.spyOn(fs, "renameSync");
    atomicWriteFileSync(target, '{"x":1}');

    expect(fs.readFileSync(target, "utf8")).toBe('{"x":1}');
    expect(renameSpy).toHaveBeenCalledTimes(1);
    // The tmp file was renamed onto the target, so no *.tmp* siblings linger.
    const leftover = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftover).toEqual([]);
  });

  it("does not throw when the target directory is missing (best-effort)", () => {
    const dir = tmpDir();
    const target = path.join(dir, "no-such-subdir", "out.json");
    expect(() => atomicWriteFileSync(target, '{"x":1}')).not.toThrow();
  });

  it("uses a per-process-unique tmp name (parallel writers don't collide)", () => {
    const dir = tmpDir();
    const target = path.join(dir, "out.json");
    const names: string[] = [];
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === "string") names.push(p);
      return (realWrite as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.writeFileSync);
    atomicWriteFileSync(target, "{}");
    atomicWriteFileSync(target, "{}");
    const tmpNames = names.filter((n) => n.includes(".tmp."));
    expect(tmpNames.length).toBe(2);
    expect(tmpNames[0]).not.toBe(tmpNames[1]); // unique per call
  });
});

describe("readJsonFileWithRetrySync", () => {
  it("parses a valid file on the first attempt", () => {
    const dir = tmpDir();
    const p = path.join(dir, "c.json");
    fs.writeFileSync(p, '{"ok":true,"n":2}');
    expect(readJsonFileWithRetrySync(p)).toEqual({ ok: true, n: 2 });
  });

  it("retries a transient torn read, then succeeds", () => {
    const dir = tmpDir();
    const p = path.join(dir, "c.json");
    fs.writeFileSync(p, '{"ok":true}');
    // First read observes a truncated file (mid-write), second sees it whole.
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValueOnce('{"ok": tr' as unknown as Buffer)
      .mockReturnValueOnce('{"ok":true}' as unknown as Buffer);
    const result = readJsonFileWithRetrySync(p, { attempts: 3, backoffMs: 1 });
    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws the last parse error when every attempt is torn", () => {
    const dir = tmpDir();
    const p = path.join(dir, "c.json");
    fs.writeFileSync(p, "persistently { bad");
    vi.spyOn(fs, "readFileSync").mockReturnValue("persistently { bad" as unknown as Buffer);
    expect(() => readJsonFileWithRetrySync(p, { attempts: 3, backoffMs: 1 })).toThrow();
  });

  it("rethrows ENOENT immediately without retrying (absent != torn)", () => {
    const dir = tmpDir();
    const p = path.join(dir, "does-not-exist.json");
    const spy = vi.spyOn(fs, "readFileSync");
    let code: string | undefined;
    try {
      readJsonFileWithRetrySync(p, { attempts: 3, backoffMs: 1 });
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ENOENT");
    expect(spy).toHaveBeenCalledTimes(1); // no retry on a genuinely-absent file
  });
});

describe("isAtomicTmpName", () => {
  it("matches the atomic tmp shape and rejects everything else", () => {
    expect(isAtomicTmpName("config.json.tmp.1234.1699999999999.ab12cd")).toBe(true);
    expect(isAtomicTmpName("mascot.json.tmp.9.1.z")).toBe(true);
    // Real files and legacy single-suffix tmps are not matched.
    expect(isAtomicTmpName("config.json")).toBe(false);
    expect(isAtomicTmpName("live-state.json.tmp")).toBe(false);
    expect(isAtomicTmpName("notes.tmp.txt")).toBe(false);
    // Non-numeric pid/timestamp is not the shape we produce.
    expect(isAtomicTmpName("config.json.tmp.abc.def.ghi")).toBe(false);
  });
});

describe("gcStaleAtomicTmps", () => {
  it("removes stale atomic tmps, keeps fresh tmps and non-tmp files", () => {
    const dir = tmpDir();
    const stale = path.join(dir, "config.json.tmp.111.1000.aaa");
    const fresh = path.join(dir, "config.json.tmp.222.2000.bbb");
    const real = path.join(dir, "config.json");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "y");
    fs.writeFileSync(real, "{}");
    // Age the stale tmp two hours into the past (past the 1h default cutoff).
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const res = gcStaleAtomicTmps(dir);
    expect(res.scanned).toBe(2); // both tmp shapes scanned; real file ignored
    expect(res.removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true); // too new to sweep
    expect(fs.existsSync(real)).toBe(true); // not a tmp shape
  });

  it("honors a custom maxAgeMs cutoff", () => {
    const dir = tmpDir();
    const t = path.join(dir, "mascot.json.tmp.5.5.qq");
    fs.writeFileSync(t, "z");
    const tenSecAgo = new Date(Date.now() - 10_000);
    fs.utimesSync(t, tenSecAgo, tenSecAgo);
    // Cutoff of 1s → the 10s-old tmp is stale and swept.
    const res = gcStaleAtomicTmps(dir, 1000);
    expect(res.removed).toBe(1);
    expect(fs.existsSync(t)).toBe(false);
  });

  it("is a no-op on a missing directory and never throws", () => {
    const dir = tmpDir();
    const missing = path.join(dir, "no-such-dir");
    let res: { scanned: number; removed: number } | undefined;
    expect(() => {
      res = gcStaleAtomicTmps(missing);
    }).not.toThrow();
    expect(res).toEqual({ scanned: 0, removed: 0 });
  });
});
