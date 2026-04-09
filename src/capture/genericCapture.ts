import { EpisodeEvent } from "../types";
import { FrictionCaptureAdapter } from "./codexCapture";

function createEvent(type: EpisodeEvent["type"], details: Record<string, unknown>): EpisodeEvent {
  return {
    type,
    source: "proxy",
    timestamp: new Date().toISOString(),
    details,
  };
}

const APPROVAL_RE = /(approval required|confirm to run|do you want to run|permission required)/i;
const FAILURE_RE = /\b(failed|error|traceback|exception|permission denied|enoent|eperm)\b/i;
const RETRY_RE = /\b(retrying|trying again|attempt \d+\/\d+)\b/i;
const EDIT_FAIL_RE = /\b(patch|edit|write).*(failed|error)\b/i;

export function createGenericCaptureAdapter(): FrictionCaptureAdapter {
  let awaitingApproval = false;
  return {
    consumeOutputLine(_source, rawLine) {
      const line = rawLine.trim();
      if (!line) return [];
      const events: EpisodeEvent[] = [];
      if (APPROVAL_RE.test(line)) {
        awaitingApproval = true;
        events.push(createEvent("tool_approval_requested", { line: line.slice(0, 300) }));
      }
      if (RETRY_RE.test(line)) {
        events.push(createEvent("tool_retry_requested", { line: line.slice(0, 300) }));
      }
      if (FAILURE_RE.test(line)) {
        events.push(createEvent("tool_call_failed", { line: line.slice(0, 300) }));
      }
      if (EDIT_FAIL_RE.test(line)) {
        events.push(createEvent("edit_attempt_failed", { line: line.slice(0, 300) }));
      }
      return events;
    },
    consumeInputChunk(text) {
      if (!awaitingApproval) return [];
      const trimmed = text.trim();
      if (!trimmed) return [];
      if (/^(y|yes|ok)$/i.test(trimmed)) {
        awaitingApproval = false;
        return [createEvent("tool_approval_granted", { input: trimmed })];
      }
      if (/^(n|no|cancel)$/i.test(trimmed)) {
        awaitingApproval = false;
        return [createEvent("tool_approval_denied", { input: trimmed })];
      }
      return [];
    },
  };
}
