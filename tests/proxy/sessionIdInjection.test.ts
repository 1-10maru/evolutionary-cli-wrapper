import { describe, expect, it } from "vitest";
import {
  isSessionIdInjectionEnabled,
  maybeInjectSessionId,
} from "../../src/proxy/sessionIdInjection";

const FIXED_UUID = "11111111-2222-4333-8444-555555555555";
const gen = () => FIXED_UUID;

describe("isSessionIdInjectionEnabled", () => {
  it("is off by default (unset env)", () => {
    expect(isSessionIdInjectionEnabled({})).toBe(false);
  });

  it("accepts truthy tokens case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(isSessionIdInjectionEnabled({ EVO_BIND_SESSION_ID: v })).toBe(true);
    }
  });

  it("rejects non-truthy tokens", () => {
    for (const v of ["0", "false", "no", "off", ""]) {
      expect(isSessionIdInjectionEnabled({ EVO_BIND_SESSION_ID: v })).toBe(false);
    }
  });
});

describe("maybeInjectSessionId", () => {
  it("does NOT inject when disabled (default)", () => {
    const r = maybeInjectSessionId({ cli: "claude", args: [], env: {}, generateId: gen });
    expect(r.injected).toBe(false);
    expect(r.reason).toBe("disabled");
    expect(r.args).toEqual([]);
    expect(r.sessionId).toBeUndefined();
  });

  it("injects --session-id at the front when enabled for claude", () => {
    const r = maybeInjectSessionId({
      cli: "claude",
      args: ["--foo", "bar"],
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: gen,
    });
    expect(r.injected).toBe(true);
    expect(r.reason).toBe("injected");
    expect(r.sessionId).toBe(FIXED_UUID);
    expect(r.args).toEqual(["--session-id", FIXED_UUID, "--foo", "bar"]);
  });

  it("injects for a bare `claude` (no args)", () => {
    const r = maybeInjectSessionId({
      cli: "claude",
      args: [],
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: gen,
    });
    expect(r.args).toEqual(["--session-id", FIXED_UUID]);
  });

  it("does NOT inject for a non-claude CLI", () => {
    const r = maybeInjectSessionId({
      cli: "codex",
      args: [],
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: gen,
    });
    expect(r.injected).toBe(false);
    expect(r.reason).toBe("not_claude");
    expect(r.args).toEqual([]);
  });

  it("respects a user-provided --session-id (bare form)", () => {
    const args = ["--session-id", "user-abc"];
    const r = maybeInjectSessionId({
      cli: "claude",
      args,
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: gen,
    });
    expect(r.injected).toBe(false);
    expect(r.reason).toBe("user_session_id");
    expect(r.args).toBe(args);
  });

  it("respects a user-provided --session-id=... (joined form)", () => {
    const r = maybeInjectSessionId({
      cli: "claude",
      args: ["--session-id=user-abc"],
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: gen,
    });
    expect(r.injected).toBe(false);
    expect(r.reason).toBe("user_session_id");
  });

  it.each(["-c", "--continue", "-r", "--resume"])(
    "does NOT inject when resuming (%s)",
    (flag) => {
      const r = maybeInjectSessionId({
        cli: "claude",
        args: [flag],
        env: { EVO_BIND_SESSION_ID: "1" },
        generateId: gen,
      });
      expect(r.injected).toBe(false);
      expect(r.reason).toBe("resume_flag");
    },
  );

  it.each(["--help", "-h", "--version", "-v"])(
    "does NOT inject for immediate-exit flag (%s)",
    (flag) => {
      const r = maybeInjectSessionId({
        cli: "claude",
        args: [flag],
        env: { EVO_BIND_SESSION_ID: "1" },
        generateId: gen,
      });
      expect(r.injected).toBe(false);
      expect(r.reason).toBe("immediate_exit");
    },
  );

  it("does NOT inject a malformed (non-UUID) generated id", () => {
    const r = maybeInjectSessionId({
      cli: "claude",
      args: [],
      env: { EVO_BIND_SESSION_ID: "1" },
      generateId: () => "not-a-uuid",
    });
    expect(r.injected).toBe(false);
    expect(r.reason).toBe("bad_id");
  });

  it("generates a real UUID by default (no generateId override)", () => {
    const r = maybeInjectSessionId({
      cli: "claude",
      args: [],
      env: { EVO_BIND_SESSION_ID: "1" },
    });
    expect(r.injected).toBe(true);
    expect(r.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
