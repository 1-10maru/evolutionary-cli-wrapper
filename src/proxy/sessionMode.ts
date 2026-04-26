// sessionMode — pre-spawn decisions for the proxy:
//   - whether to passthrough stdio interactively
//   - whether to use lightweight tracking (no chokidar workspace watcher)
//   - the missing-original-command error string
//
// Pure refactor of the inline helpers previously in src/proxyRuntime.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLogger } from "../logger";
import type { SupportedCli, WorkspaceSnapshot } from "../types";

const proxyModeLog = getLogger().child("proxy.mode");

const NON_INTERACTIVE_FLAGS = new Set([
  "--print",
  "-p",
  "--version",
  "-v",
  "--help",
  "-h",
  "--json",
]);

export function shouldUseInteractivePassthrough(args: string[]): boolean {
  let result: boolean;
  let reason: string;
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    result = false;
    reason = "non-tty std streams";
  } else if (args.length === 0) {
    result = true;
    reason = "tty stdin/stdout/stderr with no args";
  } else {
    const flagged = args.find((arg) => NON_INTERACTIVE_FLAGS.has(arg.toLowerCase()));
    if (flagged) {
      result = false;
      reason = `non-interactive flag detected: ${flagged.toLowerCase()}`;
    } else {
      result = true;
      reason = "tty std streams; no non-interactive flag in args";
    }
  }
  proxyModeLog.info("interactive passthrough decision", {
    interactivePassthrough: result,
    reason,
  });
  return result;
}

function hasProjectMarkers(cwd: string): boolean {
  const markers = [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
  ];
  return markers.some((marker) => fs.existsSync(path.join(cwd, marker)));
}

export function shouldUseLightweightTracking(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  let result: boolean;
  let reason: string;
  if (resolved === path.resolve(os.homedir())) {
    result = true;
    reason = "cwd is user home directory";
  } else if (hasProjectMarkers(resolved)) {
    result = false;
    reason = "project marker file present";
  } else {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      proxyModeLog.info("lightweight tracking decision", {
        lightweight: true,
        reason: "readdir failed; assuming non-project",
      });
      return true;
    }

    const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
    const directoryCount = visibleEntries.filter((entry) => entry.isDirectory()).length;
    const fileCount = visibleEntries.filter((entry) => entry.isFile()).length;

    if (directoryCount >= 8) {
      result = true;
      reason = `directoryCount=${directoryCount} >= 8 (looks like aggregate parent dir)`;
    } else if (directoryCount >= 5 && visibleEntries.length >= 15 && fileCount <= 6) {
      result = true;
      reason = `dirs=${directoryCount}, total=${visibleEntries.length}, files=${fileCount} (sparse aggregate)`;
    } else {
      result = false;
      reason = `dirs=${directoryCount}, total=${visibleEntries.length}, files=${fileCount} (looks like project)`;
    }
  }
  proxyModeLog.info("lightweight tracking decision", { lightweight: result, reason });
  return result;
}

export function formatMissingOriginalCommandMessage(cli: SupportedCli): string {
  return `Could not resolve the original ${cli} command. Evo checked PATH after excluding its own shim, but no live ${cli} install was found. Reinstall the upstream ${cli} CLI, then run npm run setup again if needed.`;
}

export function createEmptySnapshot(): WorkspaceSnapshot {
  return {
    files: [],
    byRelativePath: new Map(),
  };
}
