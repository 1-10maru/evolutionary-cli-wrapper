import { SupportedCli } from "../types";
import { createCodexCaptureAdapter, FrictionCaptureAdapter } from "./codexCapture";
import { createGenericCaptureAdapter } from "./genericCapture";

export function createFrictionCaptureAdapter(cli: SupportedCli): FrictionCaptureAdapter {
  if (cli === "codex") return createCodexCaptureAdapter();
  return createGenericCaptureAdapter();
}
