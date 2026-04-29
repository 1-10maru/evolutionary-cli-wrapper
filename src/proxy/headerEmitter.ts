// headerEmitter — emits the "Evo tracking ON | cli=... | dir=... | mode=..." startup line.
//
// Pure refactor: lifted verbatim from src/proxyRuntime.ts. Honors the same
// inputs as before: cli, cwd, mode (config.proxy.defaultMode), and the
// lightweightTracking flag which appends " | light" to the mode segment.

import { readCurrentMode } from "../cli/display";
import { getLogger } from "../logger";
import type { SupportedCli } from "../types";

const proxyStartupLog = getLogger().child("proxy.startup");

export interface EmitTrackingHeaderOptions {
  cli: SupportedCli;
  cwd: string;
  mode: string;
  lightweightTracking: boolean;
  mascotSpecies?: string;
}

export function emitTrackingHeader(options: EmitTrackingHeaderOptions): void {
  const { cli, cwd, mode, lightweightTracking, mascotSpecies } = options;
  const fullMode = `${mode}${lightweightTracking ? " | light" : ""}`;
  // Skip the stderr header in "minimum" display mode so the user sees only Claude Code's baseline output.
  if (readCurrentMode() !== "minimum") {
    process.stderr.write(
      `Evo tracking ON | cli=${cli} | dir=${cwd} | mode=${mode}${lightweightTracking ? " | light" : ""}\n`,
    );
  }
  proxyStartupLog.info("session header emitted", {
    cli,
    mode: fullMode,
    mascotSpecies,
  });
}
