import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseLiveStateCandidate,
  readFreshestLiveState,
} from "../../src/proxy/liveStateReader";
import {
  __resetLiveStateSeqForTests,
  writeLiveStateDual,
} from "../../src/proxy/liveState";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-lsreader-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a JSON payload file and return its path. */
function seed(dir: string, name: string, payload: unknown): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof payload === "string" ? payload : JSON.stringify(payload));
  return p;
}

const alive = () => true;
const dead = () => false;

afterEach(() => {
  __resetLiveStateSeqForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort on Windows
      }
    }
  }
});

describe("parseLiveStateCandidate", () => {
  it("parses a valid B2 payload and extracts protocol fields", () => {
    const dir = makeDir();
    const p = seed(dir, "a.json", { turns: 3, seq: 7, writerPid: 1234, writtenAt: 111 });
    const c = parseLiveStateCandidate(p);
    expect(c).toBeDefined();
    expect(c?.seq).toBe(7);
    expect(c?.writerPid).toBe(1234);
    expect(c?.writtenAt).toBe(111);
    expect(c?.payload.turns).toBe(3);
  });

  it("returns undefined for a missing file", () => {
    const dir = makeDir();
    expect(parseLiveStateCandidate(path.join(dir, "nope.json"))).toBeUndefined();
  });

  it("returns undefined for corrupt / truncated JSON", () => {
    const dir = makeDir();
    const p = seed(dir, "torn.json", '{"turns": 3, "seq"');
    expect(parseLiveStateCandidate(p)).toBeUndefined();
  });

  it("returns undefined for empty and non-object JSON", () => {
    const dir = makeDir();
    expect(parseLiveStateCandidate(seed(dir, "empty.json", ""))).toBeUndefined();
    expect(parseLiveStateCandidate(seed(dir, "num.json", "42"))).toBeUndefined();
    expect(parseLiveStateCandidate(seed(dir, "arr.json", "[1,2]"))).toBeUndefined();
    expect(parseLiveStateCandidate(seed(dir, "null.json", "null"))).toBeUndefined();
  });

  it("falls back to legacy updatedAt when writtenAt is absent", () => {
    const dir = makeDir();
    const p = seed(dir, "legacy.json", { turns: 1, updatedAt: 555 });
    const c = parseLiveStateCandidate(p);
    expect(c?.writtenAt).toBe(555);
    expect(c?.seq).toBeUndefined();
    expect(c?.writerPid).toBeUndefined();
  });

  it("ignores invalid protocol field types instead of failing", () => {
    const dir = makeDir();
    const p = seed(dir, "weird.json", {
      turns: 1,
      seq: "9",
      writerPid: -5,
      writtenAt: "yesterday",
    });
    const c = parseLiveStateCandidate(p);
    expect(c).toBeDefined();
    expect(c?.seq).toBeUndefined();
    expect(c?.writerPid).toBeUndefined();
    expect(c?.writtenAt).toBeUndefined();
  });
});

describe("readFreshestLiveState — freshness ordering", () => {
  it("returns undefined when no candidate is usable", () => {
    const dir = makeDir();
    const corrupt = seed(dir, "bad.json", "{oops");
    expect(
      readFreshestLiveState([path.join(dir, "missing.json"), corrupt], { isPidAliveFn: alive }),
    ).toBeUndefined();
  });

  it("picks the higher seq among same-writer candidates (mixed-generation sinks)", () => {
    const dir = makeDir();
    // Same writer: sink A already has generation 6, sink B still has 5 —
    // and the OLDER generation carries a LATER wall clock (clock step) to
    // prove seq is authoritative within one writer.
    const a = seed(dir, "a.json", { turns: 6, seq: 6, writerPid: 100, writtenAt: 1_000 });
    const b = seed(dir, "b.json", { turns: 5, seq: 5, writerPid: 100, writtenAt: 2_000 });
    const c = readFreshestLiveState([b, a], { isPidAliveFn: alive });
    expect(c?.path).toBe(a);
    expect(c?.payload.turns).toBe(6);
  });

  it("uses writtenAt across different writers", () => {
    const dir = makeDir();
    const older = seed(dir, "older.json", { turns: 1, seq: 50, writerPid: 100, writtenAt: 1_000 });
    const newer = seed(dir, "newer.json", { turns: 2, seq: 3, writerPid: 200, writtenAt: 9_000 });
    const c = readFreshestLiveState([older, newer], { isPidAliveFn: alive });
    expect(c?.path).toBe(newer);
  });

  it("tolerates corrupt sinks and still picks the surviving one", () => {
    const dir = makeDir();
    const corrupt = seed(dir, "corrupt.json", '{"turns": 9, "seq": 99, "writerP');
    const good = seed(dir, "good.json", { turns: 4, seq: 4, writerPid: 100, writtenAt: 500 });
    const c = readFreshestLiveState([corrupt, good], { isPidAliveFn: alive });
    expect(c?.path).toBe(good);
  });

  it("first listed path wins an exact tie (caller sink preference)", () => {
    const dir = makeDir();
    const pref = seed(dir, "pref.json", { turns: 1, seq: 2, writerPid: 100, writtenAt: 700 });
    const other = seed(dir, "other.json", { turns: 1, seq: 2, writerPid: 100, writtenAt: 700 });
    const c = readFreshestLiveState([pref, other], { isPidAliveFn: alive });
    expect(c?.path).toBe(pref);
  });

  it("legacy payloads (no seq) compare by updatedAt fallback", () => {
    const dir = makeDir();
    const oldLegacy = seed(dir, "old.json", { turns: 1, updatedAt: 100 });
    const newLegacy = seed(dir, "new.json", { turns: 2, updatedAt: 200 });
    const c = readFreshestLiveState([oldLegacy, newLegacy], { isPidAliveFn: alive });
    expect(c?.path).toBe(newLegacy);
  });
});

describe("readFreshestLiveState — live-pid preference", () => {
  it("prefers a live writer over a dead writer with fresher fields", () => {
    const dir = makeDir();
    const livePid = process.pid;
    const deadCandidate = seed(dir, "dead.json", {
      turns: 9,
      seq: 999,
      writerPid: 999999999,
      writtenAt: 9_999_999,
    });
    const liveCandidate = seed(dir, "live.json", {
      turns: 2,
      seq: 2,
      writerPid: livePid,
      writtenAt: 1_000,
    });
    const c = readFreshestLiveState([deadCandidate, liveCandidate], {
      isPidAliveFn: (pid) => pid === livePid,
    });
    expect(c?.path).toBe(liveCandidate);
  });

  it("prefers a live writer over a legacy (pid-less) payload", () => {
    const dir = makeDir();
    const legacy = seed(dir, "legacy.json", { turns: 9, updatedAt: 9_999_999 });
    const live = seed(dir, "live.json", { turns: 1, seq: 1, writerPid: 100, writtenAt: 10 });
    const c = readFreshestLiveState([legacy, live], { isPidAliveFn: alive });
    expect(c?.path).toBe(live);
  });

  it("prefers a legacy (pid-less) payload over a confirmed-dead writer", () => {
    const dir = makeDir();
    const deadCandidate = seed(dir, "dead.json", {
      turns: 9,
      seq: 50,
      writerPid: 100,
      writtenAt: 9_999,
    });
    const legacy = seed(dir, "legacy.json", { turns: 1, updatedAt: 10 });
    const c = readFreshestLiveState([deadCandidate, legacy], { isPidAliveFn: dead });
    expect(c?.path).toBe(legacy);
  });

  it("falls back to freshest among dead writers when nothing is live", () => {
    const dir = makeDir();
    const a = seed(dir, "a.json", { turns: 1, seq: 1, writerPid: 100, writtenAt: 100 });
    const b = seed(dir, "b.json", { turns: 2, seq: 2, writerPid: 100, writtenAt: 200 });
    const c = readFreshestLiveState([a, b], { isPidAliveFn: dead });
    expect(c?.path).toBe(b);
  });

  it("treats a throwing liveness probe as unknown (not dead)", () => {
    const dir = makeDir();
    const p = seed(dir, "p.json", { turns: 1, seq: 1, writerPid: 100, writtenAt: 100 });
    const c = readFreshestLiveState([p], {
      isPidAliveFn: () => {
        throw new Error("probe exploded");
      },
    });
    expect(c?.path).toBe(p);
  });
});

describe("readFreshestLiveState — end-to-end with the real writer", () => {
  it("selects the newest generation when sinks are split across generations", () => {
    const dir = makeDir();
    const cwdTarget = path.join(dir, "cwd.json");
    const homeTarget = path.join(dir, "home.json");
    const sessionTarget = path.join(dir, "sessions", "sid-1.json");

    // Generation 1 lands everywhere; generation 2 only reaches homeTarget
    // (simulates a reader racing the fan-out mid-generation).
    writeLiveStateDual({ cwdTarget, homeTarget, sessionTarget, payload: { turns: 1 } });
    const gen1Cwd = fs.readFileSync(cwdTarget, "utf8");
    const gen1Session = fs.readFileSync(sessionTarget, "utf8");
    writeLiveStateDual({ cwdTarget, homeTarget, sessionTarget, payload: { turns: 2 } });
    fs.writeFileSync(cwdTarget, gen1Cwd); // roll two sinks back to gen 1
    fs.writeFileSync(sessionTarget, gen1Session);

    const c = readFreshestLiveState([sessionTarget, cwdTarget, homeTarget]);
    expect(c?.path).toBe(homeTarget);
    expect(c?.payload.turns).toBe(2);
    expect(c?.seq).toBe(2);
    expect(c?.writerPid).toBe(process.pid);
  });
});
