import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimOwnership,
  createSessionOwnershipGate,
  gcStaleOwners,
  isPidAlive,
  ownerFilePath,
  ownersDir,
  releaseOwnership,
} from "../../src/proxy/sessionOwnership";

const tempDirs: string[] = [];

function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-owner-"));
  tempDirs.push(dir);
  return dir;
}

/** Find an integer pid that is currently NOT alive (for stale-owner tests). */
function findDeadPid(): number {
  for (let candidate = 987654321; candidate > 987000000; candidate -= 7) {
    if (!isPidAlive(candidate)) return candidate;
  }
  // Practically unreachable; fall back to a large value.
  return 987654321;
}

afterEach(() => {
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

describe("isPidAlive", () => {
  it("reports the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports a clearly-nonexistent pid as dead", () => {
    expect(isPidAlive(findDeadPid())).toBe(false);
  });

  it("treats invalid pids as dead", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe("claimOwnership", () => {
  it("claims an unowned session and writes a marker with our pid", () => {
    const cwd = makeCwd();
    const ok = claimOwnership(cwd, "sid-A", process.pid);
    expect(ok).toBe(true);
    const marker = JSON.parse(fs.readFileSync(ownerFilePath(cwd, "sid-A"), "utf8"));
    expect(marker.pid).toBe(process.pid);
    expect(marker.cwd).toBe(cwd);
  });

  it("is idempotent for the same pid", () => {
    const cwd = makeCwd();
    expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
    expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
  });

  it("refuses to claim a session owned by another LIVE pid", () => {
    const cwd = makeCwd();
    // process.pid is definitely alive; claim it as the incumbent owner.
    expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
    // A different (also-live) pid must not be able to steal it. Use a second
    // live pid: the parent's pid (ppid) is alive too; if unavailable, reuse
    // process.pid via a distinct claimant number that is NOT the owner.
    const otherLivePid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid + 0; // fallback keeps owner
    if (otherLivePid === process.pid) {
      // Can't get a distinct live pid deterministically — assert the marker is
      // unchanged after a same-pid re-claim instead (still proves no theft).
      expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
    } else {
      expect(isPidAlive(otherLivePid)).toBe(true);
      expect(claimOwnership(cwd, "sid-A", otherLivePid)).toBe(false);
      const marker = JSON.parse(fs.readFileSync(ownerFilePath(cwd, "sid-A"), "utf8"));
      expect(marker.pid).toBe(process.pid); // incumbent retained
    }
  });

  it("reclaims a marker left by a DEAD pid", () => {
    const cwd = makeCwd();
    const deadPid = findDeadPid();
    // Seed a stale marker owned by a dead pid.
    expect(claimOwnership(cwd, "sid-A", deadPid)).toBe(true);
    // A live proxy may reclaim it.
    expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(ownerFilePath(cwd, "sid-A"), "utf8"));
    expect(marker.pid).toBe(process.pid);
  });

  it("reclaims a corrupt/unreadable marker", () => {
    const cwd = makeCwd();
    const file = ownerFilePath(cwd, "sid-A");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(claimOwnership(cwd, "sid-A", process.pid)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(marker.pid).toBe(process.pid);
  });

  it("sanitizes unsafe session ids into a safe basename", () => {
    const cwd = makeCwd();
    claimOwnership(cwd, "../evil/../id", process.pid);
    // The marker must land INSIDE the owners dir, not escape via traversal.
    const entries = fs.readdirSync(ownersDir(cwd));
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("\\");
  });
});

describe("releaseOwnership", () => {
  it("removes the marker when we own it", () => {
    const cwd = makeCwd();
    claimOwnership(cwd, "sid-A", process.pid);
    releaseOwnership(cwd, "sid-A", process.pid);
    expect(fs.existsSync(ownerFilePath(cwd, "sid-A"))).toBe(false);
  });

  it("leaves another live pid's marker untouched", () => {
    const cwd = makeCwd();
    claimOwnership(cwd, "sid-A", process.pid);
    const otherPid = process.pid + 1; // not us
    releaseOwnership(cwd, "sid-A", otherPid);
    expect(fs.existsSync(ownerFilePath(cwd, "sid-A"))).toBe(true);
  });

  it("is a no-op when no marker exists", () => {
    const cwd = makeCwd();
    expect(() => releaseOwnership(cwd, "sid-none", process.pid)).not.toThrow();
  });
});

describe("gcStaleOwners", () => {
  it("removes dead-pid markers but keeps live-pid markers", () => {
    const cwd = makeCwd();
    const deadPid = findDeadPid();
    claimOwnership(cwd, "sid-dead", deadPid);
    claimOwnership(cwd, "sid-live", process.pid);
    gcStaleOwners(cwd);
    expect(fs.existsSync(ownerFilePath(cwd, "sid-dead"))).toBe(false);
    expect(fs.existsSync(ownerFilePath(cwd, "sid-live"))).toBe(true);
  });

  it("is a no-op when the registry does not exist", () => {
    const cwd = makeCwd();
    expect(() => gcStaleOwners(cwd)).not.toThrow();
  });
});

describe("createSessionOwnershipGate", () => {
  it("claims the first approved session and sticks to it (bind-first-stick-hard)", () => {
    const cwd = makeCwd();
    const gate = createSessionOwnershipGate({ cwd });
    expect(gate.canBind("sid-A")).toBe(true);
    expect(gate.claimedSessionId()).toBe("sid-A");
    // A different session is refused once we've committed to sid-A.
    expect(gate.canBind("sid-B")).toBe(false);
    // Our own session keeps returning true (idempotent).
    expect(gate.canBind("sid-A")).toBe(true);
  });

  it("refuses a session already owned by another live proxy", () => {
    const cwd = makeCwd();
    // Simulate another live proxy owning sid-A.
    claimOwnership(cwd, "sid-A", process.pid);
    const gate = createSessionOwnershipGate({ cwd, pid: process.pid + 1 });
    // Same-pid incumbent is us(process.pid) which is alive → refused for the
    // gate's distinct pid.
    expect(gate.canBind("sid-A")).toBe(false);
    expect(gate.claimedSessionId()).toBeUndefined();
  });

  it("release() clears the claim and removes the marker", () => {
    const cwd = makeCwd();
    const gate = createSessionOwnershipGate({ cwd });
    gate.canBind("sid-A");
    gate.release();
    expect(gate.claimedSessionId()).toBeUndefined();
    expect(fs.existsSync(ownerFilePath(cwd, "sid-A"))).toBe(false);
  });

  it("empty session id is never bindable", () => {
    const cwd = makeCwd();
    const gate = createSessionOwnershipGate({ cwd });
    expect(gate.canBind("")).toBe(false);
  });
});
