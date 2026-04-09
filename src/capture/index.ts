import { SupportedCli } from "../types";
import { createClaudeCaptureAdapter } from "./claudeCapture";
import { createCodexCaptureAdapter, FrictionCaptureAdapter } from "./codexCapture";
import { createGenericCaptureAdapter } from "./genericCapture";

export function createFrictionCaptureAdapter(cli: SupportedCli): FrictionCaptureAdapter {
  if (cli === "codex") return createCodexCaptureAdapter();
  if (cli === "claude") return createClaudeCaptureAdapter();
  return createGenericCaptureAdapter();
}
