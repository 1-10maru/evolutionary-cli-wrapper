import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { ChangedFile, FileSnapshot, WorkspaceSnapshot } from "./types";
import { hashText } from "./utils/hash";

const DEFAULT_IGNORES = [
  ".git/**",
  ".evo/**",
  "node_modules/**",
  "dist/**",
  "coverage/**",
  ".next/**",
  ".turbo/**",
  "target/**",
  "build/**",
];

const MAX_FILE_SIZE = 1024 * 1024;

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
  return code === "EPERM" || code === "EACCES" || code === "ENOENT";
}

function getIgnorePatterns(cwd: string): string[] {
  const patterns = [...DEFAULT_IGNORES];
  const homeDir = path.resolve(os.homedir());
  if (path.resolve(cwd) === homeDir) {
    patterns.push(
      "AppData/**",
      "Application Data/**",
      "Local Settings/**",
      "NTUSER*",
      "OneDrive/**",
    );
  }
  return patterns;
}

function isTextBuffer(buffer: Buffer): boolean {
  const slice = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const value of slice) {
    if (value === 0) return false;
  }
  return true;
}

function countChangedLines(beforeText: string, afterText: string): number {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  let changed = Math.abs(beforeLines.length - afterLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (beforeLines[index] !== afterLines[index]) changed += 1;
  }
  return changed;
}

export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const ig = ignore().add(getIgnorePatterns(cwd));
  const relativePaths = await fg("**/*", {
    cwd,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });

  const files: FileSnapshot[] = [];
  for (const relativePath of relativePaths) {
    if (ig.ignores(relativePath)) continue;
    const absolutePath = path.join(cwd, relativePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch (error) {
      if (isPermissionError(error)) continue;
      throw error;
    }
    if (stat.size > MAX_FILE_SIZE) continue;
    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(absolutePath);
    } catch (error) {
      if (isPermissionError(error)) continue;
      throw error;
    }
    const isText = isTextBuffer(buffer);
    const content = isText ? buffer.toString("utf8") : undefined;
    files.push({
      path: absolutePath,
      relativePath,
      contentHash: isText ? hashText(content ?? "") : hashText(buffer.toString("base64")),
      lineCount: content ? content.split(/\r?\n/).length : 0,
      size: stat.size,
      isText,
      extension: path.extname(relativePath).toLowerCase(),
      content,
    });
  }

  return {
    files,
    byRelativePath: new Map(files.map((file) => [file.relativePath, file])),
  };
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ChangedFile[] {
  const paths = new Set<string>([
    ...before.byRelativePath.keys(),
    ...after.byRelativePath.keys(),
  ]);

  const changes: ChangedFile[] = [];
  for (const relativePath of paths) {
    const beforeFile = before.byRelativePath.get(relativePath);
    const afterFile = after.byRelativePath.get(relativePath);

    if (!beforeFile && afterFile) {
      changes.push({
        relativePath,
        changeKind: "added",
        after: afterFile,
        changedLines: afterFile.lineCount,
      });
      continue;
    }

    if (beforeFile && !afterFile) {
      changes.push({
        relativePath,
        changeKind: "deleted",
        before: beforeFile,
        changedLines: beforeFile.lineCount,
      });
      continue;
    }

    if (!beforeFile || !afterFile) continue;
    if (beforeFile.contentHash === afterFile.contentHash) continue;

    changes.push({
      relativePath,
      changeKind: "modified",
      before: beforeFile,
      after: afterFile,
      changedLines: countChangedLines(beforeFile.content ?? "", afterFile.content ?? ""),
    });
  }

  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
