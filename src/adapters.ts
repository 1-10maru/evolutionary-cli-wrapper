import path from "node:path";
import stripAnsi from "strip-ansi";
import { getLogger } from "./logger";
import { EpisodeEvent, SupportedCli, UsageObservation } from "./types";

const log = getLogger().child("adapters.detect");

const USAGE_PATTERNS = [
  /prompt tokens:\s*(?<prompt>\d+).*completion tokens:\s*(?<completion>\d+).*total tokens:\s*(?<total>\d+)/i,
  /input tokens:\s*(?<prompt>\d+).*output tokens:\s*(?<completion>\d+).*total(?: tokens)?:\s*(?<total>\d+)/i,
  /prompt:\s*(?<prompt>\d+).*completion:\s*(?<completion>\d+).*total:\s*(?<total>\d+)/i,
  /total tokens:\s*(?<total>\d+)/i,
];

const FILE_PATH_RE = /(?<path>[\w./\\-]+\.(?:ts|tsx|js|jsx|py|json|md|log|txt|sh|yaml|yml|toml))/i;

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
  if (cliOverride) {
    log.debug("cli detected", { argv0: command, detectedCli: cliOverride, source: "override" });
    return cliOverride;
  }
  const base = path.basename(command).toLowerCase();
  let detectedCli: SupportedCli;
  if (base.includes("codex")) detectedCli = "codex";
  else if (base.includes("claude")) detectedCli = "claude";
  else detectedCli = "generic";
  log.debug("cli detected", { argv0: command, detectedCli });
  return detectedCli;
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
  const fileMatch = FILE_PATH_RE.exec(cleanLine)?.groups?.path ?? null;

  if (/(?:read|open|view|get-content|cat)\b/i.test(cleanLine) && fileMatch) {
    events.push(buildEvent("file_read", { path: fileMatch }));
  }

  if (/(?:rg|grep|search|find|select-string)\b/i.test(cleanLine)) {
    events.push(buildEvent("search", { line: cleanLine.slice(0, 300) }));
  }

  if (/(?:log|traceback|stack trace|error log)\b/i.test(cleanLine)) {
    events.push(buildEvent("log_read", { line: cleanLine.slice(0, 300) }));
  }

  if (/(?:apply_patch|updated file|created file|deleted file|edited|writing to)\b/i.test(cleanLine)) {
    events.push(buildEvent("patch_applied", { path: fileMatch }));
  }

  if (/(?:npm test|pnpm test|yarn test|vitest|pytest|cargo test|go test)\b/i.test(cleanLine)) {
    events.push(buildEvent("test_run", { command: cleanLine.slice(0, 300) }));
  }

  if (/(?:npm run build|pnpm build|yarn build|cargo build|tsc\b|vite build)\b/i.test(cleanLine)) {
    events.push(buildEvent("build_run", { command: cleanLine.slice(0, 300) }));
  }

  if (/(?:clarify|question|need more info|which option|確認したい|質問です)\b/i.test(cleanLine)) {
    events.push(buildEvent("clarification_prompt", { line: cleanLine.slice(0, 300) }));
  }

  if (/(?:no changes|did not change|unable to modify|変更なし|見送り)\b/i.test(cleanLine)) {
    events.push(buildEvent("no_code_change_response", { line: cleanLine.slice(0, 300) }));
  }

  return events;
}
