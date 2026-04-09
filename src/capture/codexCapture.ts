import { EpisodeEvent } from "../types";

export interface FrictionCaptureAdapter {
  consumeOutputLine(source: "stdout" | "stderr", line: string): EpisodeEvent[];
  consumeInputChunk(text: string): EpisodeEvent[];
}

function createEvent(type: EpisodeEvent["type"], details: Record<string, unknown>): EpisodeEvent {
  return {
    type,
    source: "proxy",
    timestamp: new Date().toISOString(),
    details,
  };
}

const TOOL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "shell_command", regex: /\b(shell_command|powershell|cmd(?:\.exe)?|bash|pytest|npm|pnpm|yarn)\b/i },
  { name: "apply_patch", regex: /\b(apply_patch|begin patch|writing file|updated file|created file|deleted file)\b/i },
  { name: "search", regex: /\b(search_query|image_query|open\b|click\b|find\b|select-string|rg\b|grep\b)\b/i },
  { name: "agent", regex: /\b(spawn_agent|wait_agent|send_input|resume_agent|close_agent)\b/i },
];

const APPROVAL_REQUEST_RE =
  /(approval required|requires approval|requesting approval|needs approval|allow this|do you want to run|permission required|confirm to run)/i;
const APPROVAL_DENIED_RE = /(approval denied|declined|denied by user|not approved|cancelled by user)/i;
const RETRY_RE = /\b(retrying|retry requested|trying again|attempt \d+\/\d+|re-attempting)\b/i;
const RETRY_FAIL_RE = /\b(retry failed|failed again|still failing)\b/i;
const SUCCESS_RE = /\b(done|completed|succeeded|success|finished)\b/i;
const FAILURE_RE =
  /\b(failed|error|exception|traceback|permission denied|access is denied|enoent|eperm|non-zero exit)\b/i;
const RECOVERY_RE = /\b(recovering|fallback|working around|trying alternative|switching approach)\b/i;
const EDIT_RE = /\b(apply_patch|patch|edit(?:ing)?|writing to|updated file|created file|deleted file)\b/i;
const EDIT_RECOVERED_RE = /\b(updated file|created file|deleted file|patch applied)\b/i;
const YES_RE = /^(y|yes|approve|allow|ok)$/i;
const NO_RE = /^(n|no|deny|cancel)$/i;

function detectToolName(line: string): string | null {
  for (const tool of TOOL_PATTERNS) {
    if (tool.regex.test(line)) return tool.name;
  }
  return null;
}

export function createCodexCaptureAdapter(): FrictionCaptureAdapter {
  let currentTool: string | null = null;
  let pendingApprovalTool: string | null = null;
  let lastEditFailed = false;
  let retryPending = false;

  return {
    consumeOutputLine(_source, rawLine) {
      const line = rawLine.trim();
      if (!line) return [];

      const events: EpisodeEvent[] = [];
      const detectedTool = detectToolName(line);
      if (detectedTool && detectedTool !== currentTool) {
        currentTool = detectedTool;
        events.push(createEvent("tool_call_started", { toolName: detectedTool, line: line.slice(0, 300) }));
      }

      if (EDIT_RE.test(line)) {
        events.push(createEvent("edit_attempt_started", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (APPROVAL_REQUEST_RE.test(line)) {
        pendingApprovalTool = currentTool;
        events.push(createEvent("tool_approval_requested", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (APPROVAL_DENIED_RE.test(line)) {
        pendingApprovalTool = null;
        events.push(createEvent("tool_approval_denied", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (RETRY_RE.test(line)) {
        retryPending = true;
        events.push(createEvent("tool_retry_requested", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (RECOVERY_RE.test(line)) {
        events.push(createEvent("error_recovery_started", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (FAILURE_RE.test(line)) {
        events.push(createEvent("tool_call_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        if (retryPending) {
          events.push(createEvent("tool_retry_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        }
        if (EDIT_RE.test(line)) {
          lastEditFailed = true;
          events.push(createEvent("edit_attempt_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        }
      }

      if (SUCCESS_RE.test(line)) {
        events.push(createEvent("tool_call_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
        if (retryPending) {
          retryPending = false;
          events.push(createEvent("tool_retry_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
        }
        if (lastEditFailed && EDIT_RE.test(line)) {
          lastEditFailed = false;
          events.push(createEvent("edit_attempt_recovered", { toolName: currentTool, line: line.slice(0, 300) }));
        }
        if (RECOVERY_RE.test(line) || /recovered/i.test(line)) {
          events.push(createEvent("error_recovery_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
        }
      }

      if (lastEditFailed && EDIT_RECOVERED_RE.test(line)) {
        lastEditFailed = false;
        events.push(createEvent("edit_attempt_recovered", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      return events;
    },

    consumeInputChunk(text) {
      if (!pendingApprovalTool) return [];
      const decisions = text
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const lastDecision = decisions[decisions.length - 1];
      if (!lastDecision) return [];
      if (YES_RE.test(lastDecision)) {
        const toolName = pendingApprovalTool;
        pendingApprovalTool = null;
        return [createEvent("tool_approval_granted", { toolName, input: lastDecision })];
      }
      if (NO_RE.test(lastDecision)) {
        const toolName = pendingApprovalTool;
        pendingApprovalTool = null;
        return [createEvent("tool_approval_denied", { toolName, input: lastDecision })];
      }
      return [];
    },
  };
}
