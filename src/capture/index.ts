import { createClaudeCaptureAdapter, FrictionCaptureAdapter } from "./claudeCapture";

export type { FrictionCaptureAdapter } from "./claudeCapture";

export function createFrictionCaptureAdapter(): FrictionCaptureAdapter {
  return createClaudeCaptureAdapter();
}
