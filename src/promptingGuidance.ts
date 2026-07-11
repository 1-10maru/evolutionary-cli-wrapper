/**
 * Model-aware prompting guidance.
 *
 * Loads the bundled `data/prompting-guidance.json` asset (regenerated weekly
 * from Anthropic's official JA prompt-engineering docs by
 * scripts/sync-claude-docs.mjs — rule-based, zero LLM cost) and exposes the
 * model-appropriate tips to EvoPet's comment surfaces.
 *
 * Selection layers the base best-practices tips (always eligible) with the
 * tips for the user's current model (Fable/Mythos → the Fable section, Opus →
 * the Opus section, anything else → base only). Adding a future model is a
 * pure data change in the JSON's `modelPatterns` table — no code edit needed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import guidanceData from "./data/prompting-guidance.json";

export interface GuidanceTip {
  headline: string;
  detail: string;
}

interface GuidanceSection {
  label: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  tips: GuidanceTip[];
}

interface ModelPattern {
  pattern: string;
  flags?: string;
  section: string;
}

export interface PromptingGuidance {
  version: number;
  generatedAt: string;
  modelPatterns: ModelPattern[];
  sections: Record<string, GuidanceSection>;
}

const GUIDANCE = guidanceData as unknown as PromptingGuidance;

/**
 * Resolve a model id/name to its guidance section, or null when no
 * model-specific page applies (falls back to base-only tips). First matching
 * pattern wins, so order the table specific-first.
 */
export function resolveModelSection(
  model: string | null | undefined,
): string | null {
  if (!model || typeof model !== "string") return null;
  for (const mp of GUIDANCE.modelPatterns) {
    try {
      const re = new RegExp(mp.pattern, mp.flags ?? "");
      if (re.test(model)) return mp.section;
    } catch {
      // A malformed pattern in the data asset must never throw at runtime.
    }
  }
  return null;
}

/**
 * Eligible tips for a model: base tips always, plus the model-specific section
 * when one matches. Model-specific headlines are prefixed with the section
 * label (e.g. "Fable 5のコツ: …") so the user can see which tips are tuned to
 * their model. Returns a fresh array; callers may reorder/rotate freely.
 */
export function getEligibleGuidanceTips(
  model: string | null | undefined,
): GuidanceTip[] {
  const out: GuidanceTip[] = [];
  const base = GUIDANCE.sections.base;
  if (base && Array.isArray(base.tips)) {
    for (const t of base.tips) out.push({ headline: t.headline, detail: t.detail });
  }
  const sectionName = resolveModelSection(model);
  if (sectionName && sectionName !== "base") {
    const sec = GUIDANCE.sections[sectionName];
    if (sec && Array.isArray(sec.tips)) {
      const prefix = sec.label ? `${sec.label}: ` : "";
      for (const t of sec.tips) {
        out.push({ headline: `${prefix}${t.headline}`, detail: t.detail });
      }
    }
  }
  return out;
}

/** The loaded guidance object (metadata access for diagnostics/tests). */
export function getPromptingGuidance(): PromptingGuidance {
  return GUIDANCE;
}

// ── Proxy-session model resolution ────────────────────────────────────────
// The proxy wraps the real Claude CLI, so the model is not on the statusline
// stdin payload it never sees. Resolve it from the forwarded `--model` flag
// first (most authoritative for this invocation), then the configured default
// in ~/.claude/settings.json, else unknown (base-only tips).

/** Extract a `--model <value>` / `--model=<value>` from an argv-like array. */
export function resolveModelFromArgs(
  argv: readonly string[] | null | undefined,
): string | null {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    if (a === "--model" || a === "-m") {
      const next = argv[i + 1];
      if (typeof next === "string" && next && !next.startsWith("-")) {
        return next.trim();
      }
    } else if (a.startsWith("--model=")) {
      const v = a.slice("--model=".length).trim();
      if (v) return v;
    }
  }
  return null;
}

/** Read the `model` key from a parsed settings.json object. */
export function resolveModelFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return null;
  const m = (settings as Record<string, unknown>).model;
  return typeof m === "string" && m.trim() ? m.trim() : null;
}

/**
 * Resolve the model for the current proxy session. Order: forwarded `--model`
 * arg > ~/.claude/settings.json "model" key > null (unknown). Deps are
 * injectable for tests; defaults read process.argv and the real settings file.
 */
export function resolveProxyModel(opts?: {
  argv?: readonly string[];
  settingsPath?: string;
}): string | null {
  const argv = opts?.argv ?? process.argv;
  const fromArgs = resolveModelFromArgs(argv);
  if (fromArgs) return fromArgs;

  const settingsPath =
    opts?.settingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    return resolveModelFromSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}
