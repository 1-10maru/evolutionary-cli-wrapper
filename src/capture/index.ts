import { SupportedCli } from "../types";
import { createClaudeCaptureAdapter, FrictionCaptureAdapter } from "./claudeCapture";

export type { FrictionCaptureAdapter } from "./claudeCapture";

// Single supported CLI: Claude. Parameter retained so call sites stay stable
// if other CLIs are ever reintroduced; for now it is unused at runtime.
export function createFrictionCaptureAdapter(_cli: SupportedCli): FrictionCaptureAdapter {
  return createClaudeCaptureAdapter();
}
