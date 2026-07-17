import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { quickHealthReport, type HealthCheck, type HealthReport } from "../health";

export interface DoctorOptions {
  json?: boolean;
  cwd?: string;
  quick?: boolean;
}

interface VersionInfo {
  evo: string;
  node: string;
  npm: string | null;
  os: string;
  arch: string;
  python: string | null;
}

interface EnvVarEntry {
  key: string;
  value: string; // may be "[REDACTED]"
}

interface FileCheck {
  label: string;
  path: string;
  status: "ok" | "missing" | "error";
  detail?: string;
}

interface LogSummary {
  recentLines: string[]; // last 50 lines from today's log, WARN+ only
  errorCount24h: number;
  warnCount24h: number;
}

interface LiveStateInfo {
  path: string;
  found: boolean;
  updatedAt?: number;
  ageSeconds?: number;
  raw?: Record<string, unknown>;
}

export interface DoctorReport {
  versions: VersionInfo;
  env: EnvVarEntry[];
  files: FileCheck[];
  recentLogs: LogSummary;
  errorSummary: { errors24h: number; warns24h: number };
  liveState: LiveStateInfo;
  criticalIssues: string[];
}

const SENSITIVE_KEY_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;
const SESSION_FILE_RE = /^session-(\d{8})\.log$/;
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (ERROR|WARN|INFO|DEBUG)/;

// ANSI helpers
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }

// ── Version collection ─────────────────────────────────────────────────────

function getEvoVersion(): string {
  try {
    // Walk up from current file to find package.json
    const candidates = [
      path.join(__dirname, "..", "..", "package.json"),
      path.join(__dirname, "..", "package.json"),
      path.join(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string; name?: string };
        if (parsed.name === "evolutionary-cli-wrapper" || parsed.version) {
          return parsed.version ?? "unknown";
        }
      }
    }
  } catch {
    // ignore
  }
  return "unknown";
}

function runVersion(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim().replace(/^v/, "") || null;
  } catch {
    return null;
  }
}

function collectVersions(): VersionInfo {
  const npm = runVersion("npm", ["--version"]);
  const python = runVersion("python", ["--version"]) ?? runVersion("python3", ["--version"]);
  return {
    evo: getEvoVersion(),
    node: process.version.replace(/^v/, ""),
    npm,
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    python,
  };
}

// ── Env var collection ─────────────────────────────────────────────────────

function collectEnvVars(): EnvVarEntry[] {
  const result: EnvVarEntry[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("EVO_")) continue;
    const masked = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : (value ?? "");
    result.push({ key, value: masked });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

// ── File checks ────────────────────────────────────────────────────────────

function checkReadable(label: string, filePath: string): FileCheck {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return { label, path: filePath, status: "ok" };
  } catch {
    return {
      label,
      path: filePath,
      status: fs.existsSync(filePath) ? "error" : "missing",
      detail: fs.existsSync(filePath) ? "not readable" : "not found",
    };
  }
}

function checkDirExists(label: string, dirPath: string): FileCheck {
  try {
    const stat = fs.statSync(dirPath);
    if (stat.isDirectory()) return { label, path: dirPath, status: "ok" };
    return { label, path: dirPath, status: "error", detail: "exists but is not a directory" };
  } catch {
    return { label, path: dirPath, status: "missing", detail: "not found" };
  }
}

function findOnPath(names: string[]): string | null {
  const pathDirs = (process.env.Path ?? process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // try next
      }
    }
  }
  return null;
}

function collectFileChecks(cwd: string): FileCheck[] {
  const home = os.homedir();
  const evoHome = process.env.EVO_HOME ?? path.join(home, ".claude");
  const checks: FileCheck[] = [];

  // .evo/ in EVO_HOME
  checks.push(checkDirExists(".evo/ (global home)", path.join(evoHome, ".evo")));

  // statusline.py
  const statuslineCandidates = [
    path.join(home, ".claude", "base_statusline.py"),
    path.join(evoHome, "base_statusline.py"),
  ];
  const statuslineFound = statuslineCandidates.find((p) => fs.existsSync(p));
  if (statuslineFound) {
    checks.push(checkReadable("statusline.py", statuslineFound));
  } else {
    checks.push({ label: "statusline.py", path: statuslineCandidates[0], status: "missing", detail: "run evo install-statusline" });
  }

  // ~/.claude/projects/
  checks.push(checkDirExists("~/.claude/projects/", path.join(home, ".claude", "projects")));

  // shim on PATH
  const shimNames = ["evo", "evo.cmd", "evo.ps1"];
  const shimPath = findOnPath(shimNames);
  if (shimPath) {
    checks.push({ label: "evo shim on PATH", path: shimPath, status: "ok" });
  } else {
    checks.push({ label: "evo shim on PATH", path: "(not found)", status: "missing", detail: "run npm run setup" });
  }

  // local .evo/logs dir for the cwd
  const logDir = process.env.EVO_LOG_DIR
    ? (process.env.EVO_LOG_DIR)
    : path.join(cwd, ".evo", "logs");
  checks.push(checkDirExists(".evo/logs/ (cwd)", logDir));

  return checks;
}

// ── Log reading ────────────────────────────────────────────────────────────

function todayUtcStamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

function collectLogs(cwd: string): LogSummary {
  const logDir = process.env.EVO_LOG_DIR
    ? (process.env.EVO_LOG_DIR)
    : path.join(cwd, ".evo", "logs");

  // today's log — last 50 lines, WARN+ only
  const todayFile = path.join(logDir, `session-${todayUtcStamp()}.log`);
  let recentLines: string[] = [];
  try {
    if (fs.existsSync(todayFile)) {
      const raw = fs.readFileSync(todayFile, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      // keep last 50
      const tail = lines.slice(-50);
      // filter WARN+ (only lines with WARN or ERROR in level position)
      recentLines = tail.filter((l) => {
        const m = ISO_TS_RE.exec(l);
        if (!m) return false;
        return m[2] === "ERROR" || m[2] === "WARN";
      });
    }
  } catch {
    // ignore
  }

  // error/warn count in last 24h across all rotated logs
  let errorCount24h = 0;
  let warnCount24h = 0;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = fs.readdirSync(logDir).filter((n) => SESSION_FILE_RE.test(n));
    for (const name of entries) {
      try {
        const raw = fs.readFileSync(path.join(logDir, name), "utf8");
        for (const line of raw.split("\n")) {
          const m = ISO_TS_RE.exec(line);
          if (!m) continue;
          const ts = Date.parse(m[1]);
          if (!Number.isFinite(ts) || ts < cutoff24h) continue;
          if (m[2] === "ERROR") errorCount24h++;
          else if (m[2] === "WARN") warnCount24h++;
        }
      } catch {
        // skip unreadable file
      }
    }
  } catch {
    // ignore missing dir
  }

  return { recentLines, errorCount24h, warnCount24h };
}

// ── live-state.json ────────────────────────────────────────────────────────

function collectLiveState(cwd: string): LiveStateInfo {
  const liveStatePath = path.join(cwd, ".evo", "live-state.json");
  try {
    const raw = fs.readFileSync(liveStatePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined;
    const ageSeconds = updatedAt !== undefined ? Math.floor((Date.now() - updatedAt) / 1000) : undefined;
    return { path: liveStatePath, found: true, updatedAt, ageSeconds, raw: parsed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path: liveStatePath, found: false };
    }
    return { path: liveStatePath, found: false, raw: { error: String(err) } };
  }
}

// ── Report assembly ────────────────────────────────────────────────────────

function computeCritical(report: Omit<DoctorReport, "criticalIssues">): string[] {
  const issues: string[] = [];
  const shimCheck = report.files.find((f) => f.label === "evo shim on PATH");
  const evoHomeCheck = report.files.find((f) => f.label.startsWith(".evo/ (global home)"));
  const statuslineCheck = report.files.find((f) => f.label === "statusline.py");

  const shimMissing = shimCheck?.status === "missing";
  const evoHomeMissing = evoHomeCheck?.status === "missing";
  const statuslineMissing = statuslineCheck?.status === "missing";

  if (shimMissing && statuslineMissing && evoHomeMissing) {
    issues.push("Evo appears not to be installed: shim not on PATH, statusline.py missing, .evo/ home missing. Run: npm install -g evolutionary-cli-wrapper && evo install-statusline");
  }

  return issues;
}

export function buildReport(opts: DoctorOptions): DoctorReport {
  const cwd = opts.cwd ?? process.cwd();
  const versions = collectVersions();
  const env = collectEnvVars();
  const files = collectFileChecks(cwd);
  const logs = collectLogs(cwd);
  const liveState = collectLiveState(cwd);

  const partial: Omit<DoctorReport, "criticalIssues"> = {
    versions,
    env,
    files,
    recentLogs: logs,
    errorSummary: { errors24h: logs.errorCount24h, warns24h: logs.warnCount24h },
    liveState,
  };
  const criticalIssues = computeCritical(partial);
  return { ...partial, criticalIssues };
}

// ── Text rendering ─────────────────────────────────────────────────────────

function pad(label: string, width: number): string {
  return label.padEnd(width, " ");
}

function statusSymbol(status: FileCheck["status"]): string {
  if (status === "ok") return green("✓");
  if (status === "missing") return yellow("?");
  return red("✗");
}

function renderText(report: DoctorReport): string {
  const lines: string[] = [];
  const sep = dim("─".repeat(60));

  lines.push(bold("── evo doctor ──────────────────────────────────────────────"));
  lines.push("");

  // Versions
  lines.push(bold("Versions"));
  lines.push(sep);
  const vw = 12;
  const { versions: v } = report;
  lines.push(`  ${pad("evo", vw)} ${v.evo}`);
  lines.push(`  ${pad("node", vw)} ${v.node}`);
  lines.push(`  ${pad("npm", vw)} ${v.npm ?? dim("(not found)")}`);
  lines.push(`  ${pad("python", vw)} ${v.python ?? dim("(not found)")}`);
  lines.push(`  ${pad("os", vw)} ${v.os}`);
  lines.push(`  ${pad("arch", vw)} ${v.arch}`);
  lines.push("");

  // Env
  lines.push(bold("EVO_* Environment"));
  lines.push(sep);
  if (report.env.length === 0) {
    lines.push(dim("  (no EVO_* env vars set)"));
  } else {
    const maxKey = Math.max(...report.env.map((e) => e.key.length));
    for (const { key, value } of report.env) {
      lines.push(`  ${pad(key, maxKey + 2)} ${value}`);
    }
  }
  lines.push("");

  // Files
  lines.push(bold("File Checks"));
  lines.push(sep);
  const fw = Math.max(...report.files.map((f) => f.label.length)) + 2;
  for (const fc of report.files) {
    const sym = statusSymbol(fc.status);
    const detail = fc.detail ? dim(` (${fc.detail})`) : "";
    lines.push(`  ${sym} ${pad(fc.label, fw)} ${dim(fc.path)}${detail}`);
  }
  lines.push("");

  // Error summary
  lines.push(bold("Error Summary (last 24h)"));
  lines.push(sep);
  const ec = report.errorSummary;
  const errStr = ec.errors24h > 0 ? red(String(ec.errors24h)) : green(String(ec.errors24h));
  const warnStr = ec.warns24h > 0 ? yellow(String(ec.warns24h)) : green(String(ec.warns24h));
  lines.push(`  errors  ${errStr}`);
  lines.push(`  warns   ${warnStr}`);
  lines.push("");

  // Recent WARN+ lines
  if (report.recentLogs.recentLines.length > 0) {
    lines.push(bold("Recent WARN+ (today's log)"));
    lines.push(sep);
    for (const l of report.recentLogs.recentLines.slice(-10)) {
      lines.push(`  ${dim(l)}`);
    }
    lines.push("");
  }

  // live-state
  lines.push(bold("Live State"));
  lines.push(sep);
  if (report.liveState.found) {
    const age = report.liveState.ageSeconds;
    const ageStr = age !== undefined ? `${age}s ago` : "(unknown)";
    const fresh = age !== undefined && age < 120;
    lines.push(`  ${pad("found", 10)} ${green("yes")}`);
    lines.push(`  ${pad("updatedAt", 10)} ${fresh ? green(ageStr) : yellow(ageStr)}`);
  } else {
    lines.push(`  ${pad("found", 10)} ${dim("no (no active proxy session)")}`);
  }
  lines.push("");

  // Critical
  if (report.criticalIssues.length > 0) {
    lines.push(bold("⚠ Critical Issues"));
    lines.push(sep);
    for (const issue of report.criticalIssues) {
      lines.push(`  ${red("!")} ${issue}`);
    }
    lines.push("");
  }

  lines.push(bold("────────────────────────────────────────────────────────────"));
  return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────

// ── Quick health check (evo doctor --quick) ────────────────────────────────

/**
 * The same fast self-check the wrapper runs at proxy startup: bundle present,
 * native runtime closure present, natives loadable, and the real (wrapped) CLI
 * resolvable ("proxy round-trip"). No log scanning, no disk writes. Exits 0 when
 * healthy, 1 when any check fails — usable as a fast release/CI preflight and by
 * users to diagnose a broken wrapper.
 */
function buildQuickReport(cwd: string): HealthReport {
  const report = quickHealthReport();
  const checks: HealthCheck[] = [...report.checks];

  // Proxy round-trip: can we resolve the real claude the proxy would wrap?
  // Resolution is pure-JS (a `where`/PATH probe), so it runs even when the
  // native addons are broken.
  let claudeCheck: HealthCheck;
  try {
    // Lazy require so a load failure here cannot break the rest of the report.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveOriginalCommand } = require("../shellIntegration") as typeof import("../shellIntegration");
    const resolved = resolveOriginalCommand(cwd, "claude");
    claudeCheck = resolved
      ? { name: "claude-resolve", ok: true, detail: resolved }
      : { name: "claude-resolve", ok: false, detail: "no live claude found on PATH" };
  } catch (err) {
    claudeCheck = {
      name: "claude-resolve",
      ok: false,
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
  checks.push(claudeCheck);

  return { ok: checks.every((c) => c.ok), checks };
}

function renderQuickText(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(bold("── evo doctor --quick ──────────────────────────────────────"));
  const width = Math.max(...report.checks.map((c) => c.name.length)) + 2;
  for (const c of report.checks) {
    const sym = c.ok ? green("✓") : red("✗");
    const detail = c.detail ? dim(c.detail) : "";
    lines.push(`  ${sym} ${pad(c.name, width)} ${detail}`);
  }
  lines.push(report.ok ? green("PASS") : red("FAIL"));
  return lines.join("\n");
}

async function runQuickDoctor(opts: DoctorOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const report = buildQuickReport(cwd);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderQuickText(report) + "\n");
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  if (opts.quick) {
    await runQuickDoctor(opts);
    return;
  }

  const report = buildReport(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(report) + "\n");
  }

  if (report.criticalIssues.length > 0) {
    process.exitCode = 1;
  }
}
