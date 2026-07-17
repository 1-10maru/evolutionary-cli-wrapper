import stripAnsi from "strip-ansi";
import { getLogger } from "./logger";
import { redactSecretText } from "./redact";
import { EpisodeEvent, SupportedCli, UsageObservation } from "./types";

const log = getLogger().child("adapters.detect");

const USAGE_PATTERNS = [
  /prompt tokens:\s*(?<prompt>\d+).*completion tokens:\s*(?<completion>\d+).*total tokens:\s*(?<total>\d+)/i,
  /input tokens:\s*(?<prompt>\d+).*output tokens:\s*(?<completion>\d+).*total(?: tokens)?:\s*(?<total>\d+)/i,
  /prompt:\s*(?<prompt>\d+).*completion:\s*(?<completion>\d+).*total:\s*(?<total>\d+)/i,
  /total tokens:\s*(?<total>\d+)/i,
];

// Bounded quantifier (`{1,512}` rather than `+`): a real file-path token never
// approaches 512 chars, and the bound caps per-position backtracking so a long
// run of word chars can no longer make this regex backtrack quadratically.
const FILE_PATH_RE = /(?<path>[\w./\\-]{1,512}\.(?:ts|tsx|js|jsx|py|json|md|log|txt|sh|yaml|yml|toml))/i;

// Only scan the head of a line for a file path. Combined with the bounded
// quantifier this makes path detection linear regardless of line length, so a
// child emitting megabytes of newline-sparse garbage can never peg the CPU and
// stall the stream (which previously prevented the wrapper from tearing down).
const MAX_PATH_SCAN = 4096;

function buildEvent(
  type: EpisodeEvent["type"],
  details: Record<string, unknown>,
): EpisodeEvent {
  return {
    type,
    source: "adapter",
    timestamp: new Date().toISOString(),
    details,
  };
}

export function detectCli(command: string, cliOverride?: SupportedCli): SupportedCli {
  // After dropping codex/generic, the wrapper only supports claude. detectCli still
  // accepts the original argv0 for logging fidelity but always returns "claude".
  log.debug("cli detected", {
    argv0: command,
    detectedCli: "claude",
    source: cliOverride ? "override" : "claude-only",
  });
  return "claude";
}

export function parseUsageObservation(
  cli: SupportedCli,
  source: "stdout" | "stderr",
  rawLine: string,
): UsageObservation | null {
  const line = stripAnsi(rawLine);
  for (const pattern of USAGE_PATTERNS) {
    const match = pattern.exec(line);
    if (!match?.groups) continue;
    return {
      cli,
      promptTokens: match.groups.prompt ? Number(match.groups.prompt) : null,
      completionTokens: match.groups.completion ? Number(match.groups.completion) : null,
      totalTokens: match.groups.total ? Number(match.groups.total) : null,
      source,
      rawLine: line.trim(),
      confidence: match.groups.prompt && match.groups.completion ? 0.95 : 0.65,
    };
  }
  return null;
}

export function extractEventsFromLine(line: string): EpisodeEvent[] {
  const cleanLine = stripAnsi(line).trim();
  if (!cleanLine) return [];

  const events: EpisodeEvent[] = [];
  // Detection runs on cleanLine, but any snippet PERSISTED into
  // episode_events.details_json is secret-masked (CLI output can echo tokens).
  const maskedSnippet = redactSecretText(cleanLine.slice(0, 300));
  const pathScanLine = cleanLine.length > MAX_PATH_SCAN ? cleanLine.slice(0, MAX_PATH_SCAN) : cleanLine;
  const fileMatch = FILE_PATH_RE.exec(pathScanLine)?.groups?.path ?? null;

  if (/(?:read|open|view|get-content|cat)\b/i.test(cleanLine) && fileMatch) {
    events.push(buildEvent("file_read", { path: fileMatch }));
  }

  if (/(?:rg|grep|search|find|select-string)\b/i.test(cleanLine)) {
    events.push(buildEvent("search", { line: maskedSnippet }));
  }

  if (/(?:log|traceback|stack trace|error log)\b/i.test(cleanLine)) {
    events.push(buildEvent("log_read", { line: maskedSnippet }));
  }

  if (/(?:apply_patch|updated file|created file|deleted file|edited|writing to)\b/i.test(cleanLine)) {
    events.push(buildEvent("patch_applied", { path: fileMatch }));
  }

  if (/(?:npm test|pnpm test|yarn test|vitest|pytest|cargo test|go test)\b/i.test(cleanLine)) {
    events.push(buildEvent("test_run", { command: maskedSnippet }));
  }

  if (/(?:npm run build|pnpm build|yarn build|cargo build|tsc\b|vite build)\b/i.test(cleanLine)) {
    events.push(buildEvent("build_run", { command: maskedSnippet }));
  }

  if (/(?:clarify|question|need more info|which option|確認したい|質問です)\b/i.test(cleanLine)) {
    events.push(buildEvent("clarification_prompt", { line: maskedSnippet }));
  }

  if (/(?:no changes|did not change|unable to modify|変更なし|見送り)\b/i.test(cleanLine)) {
    events.push(buildEvent("no_code_change_response", { line: maskedSnippet }));
  }

  return events;
}
