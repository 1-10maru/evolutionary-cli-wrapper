// sessionIdInjection — opt-in `claude --session-id <id>` injection.
//
// Problem (B1): the JSONL watcher normally learns a session's id only after
// Claude Code writes the first transcript line. In a multi-window cwd that
// leaves a small window where binding must be inferred from mtime/ownership.
// If we instead choose the session id up front and pass it to the spawned
// `claude` via `--session-id`, the transcript filename/header id is known
// deterministically before the child even starts, so the watcher can bind to
// exactly the right file with zero ambiguity.
//
// This is strictly OPT-IN via the `EVO_BIND_SESSION_ID` env var and only ever
// applies to the `claude` CLI. If it is disabled, targets a different CLI, the
// user already passed their own `--session-id`, or the invocation resumes an
// existing session (`--continue` / `--resume`), we return the args untouched
// and the proxy falls back to the pre-B1 ownership-guided binding. Injection
// never silently changes behaviour for a user who has not opted in.

import { randomUUID } from "node:crypto";

const SESSION_ID_FLAG = "--session-id";

/** Flags that resume/reuse an existing session id — injecting would conflict. */
const RESUME_FLAGS = new Set(["-c", "--continue", "-r", "--resume"]);

/** Immediate-exit flags: never worth injecting a session id for. */
const IMMEDIATE_EXIT_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionIdInjectionResult {
  /** The args to actually spawn with (original args when not injected). */
  args: string[];
  /** The injected session id, if injection occurred. */
  sessionId?: string;
  /** Whether a `--session-id` flag was injected. */
  injected: boolean;
  /** Machine-readable reason (for logs/tests). */
  reason:
    | "injected"
    | "disabled"
    | "not_claude"
    | "user_session_id"
    | "resume_flag"
    | "immediate_exit"
    | "bad_id";
}

/** True when the opt-in env flag is set to a truthy value. */
export function isSessionIdInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.EVO_BIND_SESSION_ID ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Decide whether to inject `--session-id <uuid>` into the spawned command.
 * Pure and side-effect free (aside from generating a UUID); safe to unit-test.
 */
export function maybeInjectSessionId(opts: {
  cli: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Test seam: override id generation. */
  generateId?: () => string;
}): SessionIdInjectionResult {
  const { cli, args } = opts;
  const env = opts.env ?? process.env;
  const generateId = opts.generateId ?? randomUUID;

  if (!isSessionIdInjectionEnabled(env)) return { args, injected: false, reason: "disabled" };
  if (cli !== "claude") return { args, injected: false, reason: "not_claude" };

  // Respect an explicit user `--session-id` (bare or `=`-joined): never override.
  if (args.some((a) => a === SESSION_ID_FLAG || a.startsWith(`${SESSION_ID_FLAG}=`))) {
    return { args, injected: false, reason: "user_session_id" };
  }
  // Resuming/continuing reuses an existing id — a fresh id would conflict.
  if (args.some((a) => RESUME_FLAGS.has(a))) {
    return { args, injected: false, reason: "resume_flag" };
  }
  // --help / --version etc: pointless to inject.
  if (args.some((a) => IMMEDIATE_EXIT_FLAGS.has(a.toLowerCase()))) {
    return { args, injected: false, reason: "immediate_exit" };
  }

  const sessionId = generateId();
  if (typeof sessionId !== "string" || !isValidUuid(sessionId)) {
    // Never inject a malformed id — fall back to default behaviour.
    return { args, injected: false, reason: "bad_id" };
  }

  // Insert at the front so it is parsed as a global option before any prompt.
  return {
    args: [SESSION_ID_FLAG, sessionId, ...args],
    sessionId,
    injected: true,
    reason: "injected",
  };
}
