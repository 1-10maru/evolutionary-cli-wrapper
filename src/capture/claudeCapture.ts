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
  { name: "bash", regex: /\b(bash|shell|command)\b/i },
  { name: "edit", regex: /\b(edit|patch|write|update(?:d)? file|create(?:d)? file|delete(?:d)? file)\b/i },
  { name: "search", regex: /\b(search|find|grep|rg|glob|read file|open file)\b/i },
];

const APPROVAL_REQUEST_RE =
  /(permission required|requires permission|requires approval|allow claude|confirm to run|approve this|do you want to allow|can i run)/i;
const APPROVAL_DENIED_RE = /(permission denied by user|approval denied|declined|not approved|cancelled)/i;
const RETRY_RE = /\b(retrying|trying again|attempting again|one more try|attempt \d+\/\d+)\b/i;
const RETRY_SUCCESS_RE = /\b(retry succeeded|worked on retry|second attempt succeeded)\b/i;
const SUCCESS_RE = /\b(done|completed|finished|success(?:fully)?|applied|updated file|created file|deleted file)\b/i;
const FAILURE_RE =
  /\b(failed|error|exception|traceback|permission denied|access is denied|enoent|eperm|non-zero exit)\b/i;
const RECOVERY_START_RE = /\b(recovering|fallback|working around|switching approach|different approach|alternative approach)\b/i;
const RECOVERY_SUCCESS_RE = /\b(recovered|fixed now|worked after|resolved after)\b/i;
const EDIT_RE = /\b(edit|patch|write|update(?:d)? file|create(?:d)? file|delete(?:d)? file)\b/i;
const EDIT_RECOVERED_RE = /\b(updated file|created file|deleted file|patch applied|edit complete)\b/i;
const YES_RE = /^(y|yes|ok|allow|approve)$/i;
const NO_RE = /^(n|no|deny|cancel)$/i;

function detectToolName(line: string): string | null {
  for (const tool of TOOL_PATTERNS) {
    if (tool.regex.test(line)) return tool.name;
  }
  return null;
}

export function createClaudeCaptureAdapter(): FrictionCaptureAdapter {
  let currentTool: string | null = null;
  let pendingApprovalTool: string | null = null;
  let retryPending = false;
  let editFailed = false;

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

      if (RECOVERY_START_RE.test(line)) {
        events.push(createEvent("error_recovery_started", { toolName: currentTool, line: line.slice(0, 300) }));
      }

      if (FAILURE_RE.test(line)) {
        events.push(createEvent("tool_call_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        if (retryPending) {
          events.push(createEvent("tool_retry_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        }
        if (EDIT_RE.test(line)) {
          editFailed = true;
          events.push(createEvent("edit_attempt_failed", { toolName: currentTool, line: line.slice(0, 300) }));
        }
      }

      if (SUCCESS_RE.test(line)) {
        events.push(createEvent("tool_call_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
      }
      if (RETRY_SUCCESS_RE.test(line) || (retryPending && SUCCESS_RE.test(line))) {
        retryPending = false;
        events.push(createEvent("tool_retry_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
      }
      if (editFailed && (EDIT_RECOVERED_RE.test(line) || (EDIT_RE.test(line) && SUCCESS_RE.test(line)))) {
        editFailed = false;
        events.push(createEvent("edit_attempt_recovered", { toolName: currentTool, line: line.slice(0, 300) }));
      }
      if (RECOVERY_SUCCESS_RE.test(line)) {
        events.push(createEvent("error_recovery_succeeded", { toolName: currentTool, line: line.slice(0, 300) }));
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
