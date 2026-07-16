import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFileSync,
  readJsonFileWithRetrySync,
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
