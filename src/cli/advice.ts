/**
 * `evo advice` — print the full EvoPet advice for this directory.
 *
 * The statusline truncates advice/detail/before-after to fit one or two lines
 * and points here (`→ 続きは \`evo advice\``) for the untruncated text.
 *
 * CAVEAT: this command has no session_id of its own, so it shows the advice of
 * the MOST RECENTLY ACTIVE session in this directory — it picks the newest
 * per-session file in <cwd>/.evo/sessions by modification time (then falls back
 * to the legacy shared sinks). With multiple concurrent sessions in the same
 * cwd, that is normally the one you just interacted with, but not guaranteed to
 * be a specific pane. It prints the full headline, detail, and before/after.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface LiveAdvice {
  advice?: string;
  adviceDetail?: string;
  beforeExample?: string;
  afterExample?: string;
  signalKind?: string;
  updatedAt?: number;
}

function readJson(filePath: string): LiveAdvice | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LiveAdvice;
  } catch {
    return null;
  }
}

/** Candidate live-state paths, newest per-session file first, then shared sinks. */
function candidatePaths(cwd: string): string[] {
  const out: string[] = [];
  const sessionsDir = path.join(cwd, ".evo", "sessions");
  try {
    const entries = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(sessionsDir, f))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const e of entries) out.push(e.p);
  } catch {
    // no sessions dir — fall through to shared sinks
  }
  out.push(path.join(cwd, ".evo", "live-state.json"));
  out.push(path.join(os.homedir(), ".claude", ".evo-live.json"));
  return out;
}

export function runAdviceCommand(options: { cwd?: string } = {}): void {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let data: LiveAdvice | null = null;
  for (const c of candidatePaths(cwd)) {
    const d = readJson(c);
    if (d && (d.advice || d.adviceDetail)) {
      data = d;
      break;
    }
  }

  if (!data || !(data.advice || data.adviceDetail)) {
    console.log(
      "いま表示できるアドバイスはありません。EvoPet 記録中のセッションで、直近の指示に対する助言がここに出ます。",
    );
    return;
  }

  const lines: string[] = [];
  if (data.advice) lines.push(data.advice);
  if (data.adviceDetail) {
    if (lines.length) lines.push("");
    lines.push(data.adviceDetail);
  }
  if (data.beforeExample && data.afterExample) {
    lines.push("");
    lines.push(`❌ ${data.beforeExample}`);
    lines.push(`✅ ${data.afterExample}`);
  }
  console.log(lines.join("\n"));
}
