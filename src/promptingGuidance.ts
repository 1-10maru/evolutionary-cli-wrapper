/**
 * Model-aware prompting guidance.
 *
 * Loads the bundled `data/prompting-guidance.json` asset (regenerated weekly
 * from Anthropic's official JA prompt-engineering docs by
 * scripts/sync-claude-docs.mjs — rule-based, zero LLM cost) and exposes the
 * model-appropriate tips to EvoPet's comment surfaces.
 *
 * Selection layers the base best-practices tips (always eligible) with the
 * tips for the user's current model. Model sections are GENERATION-SPECIFIC
 * (`opus-5` and `opus-4-8` are separate pages); a model that matches no
 * pattern — or matches a section missing from the asset — gets base tips only.
 * A generation NEVER inherits another generation's page: mislabelled advice
 * ("[Opus 4.8向け]" shown to an Opus 5 user) is worse than no advice. Adding a
 * future model is a pure data change in the JSON's `modelPatterns` table.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import guidanceData from "./data/prompting-guidance.json";

/** Provenance of a statusline tip, used to render a `[…]` source tag so the
 *  user can tell model-tuned advice from generic/official advice at a glance. */
export type TipSource = "official" | "model" | "generic";

export interface GuidanceTip {
  headline: string;
  detail: string;
  /** "official" = Anthropic base best-practices docs; "model" = tuned to the
   *  user's current model (see `audience`). */
  source: TipSource;
  /** Model label for `source === "model"` (e.g. "Fable 5"); drives `[<audience>向け]`. */
  audience?: string;
  /** Set on "what changed vs the previous release" tips (e.g. "Fable 5.1→5.2",
   *  from the official "What's new" page's 動作の違い section). Rendered
   *  verbatim as the tag `[Fable 5.1→5.2]` instead of `[<audience>向け]`. */
  changeLabel?: string;
}

/** Strip the "のコツ" suffix from a section label to get the bare model name. */
export function guidanceAudienceFromLabel(label: string): string {
  return label.replace(/のコツ$/u, "").trim();
}

/**
 * Render the bracketed provenance tag for a tip line:
 *   model    → `[<audience>向け]` (e.g. `[Fable 5向け]`)
 *   official → `[公式]`
 *   generic  → `[汎用]`
 * Keeps model-tuned advice visually distinct from the static/official libraries.
 */
export function tipTag(
  source: TipSource,
  audience?: string,
  changeLabel?: string,
): string {
  // A change tip names both releases so the user sees at a glance that this is
  // what is DIFFERENT on their model, not general advice.
  if (source === "model" && changeLabel) return `[${changeLabel}]`;
  // A model tip whose section carries no label has no trustworthy audience, so
  // fall back to the neutral official tag rather than inventing one — the tip
  // still came from an official Anthropic doc page.
  if (source === "model") return audience ? `[${audience}向け]` : "[公式]";
  if (source === "official") return "[公式]";
  return "[汎用]";
}

interface GuidanceSectionChanges {
  /** "<from>→<to>", e.g. "Fable 5.1→5.2". */
  label: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  tips: Array<{ headline: string; detail: string }>;
}

interface GuidanceSection {
  label: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  tips: GuidanceTip[];
  /** Optional behaviour differences versus the previous release. */
  changes?: GuidanceSectionChanges;
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
 * pattern wins, so order the table specific-first. Patterns are anchored to a
 * generation, so an unknown/future model id resolves to null by design.
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
 * Model-specific tips for a model: the "what changed vs the previous release"
 * tips first (`changeLabel` set), then the model page's own tips. Empty when
 * the model matches no section (unknown/aliased/future model) or the matched
 * section is missing/empty in the asset — never another version's tips.
 */
export function getModelSpecificGuidanceTips(
  model: string | null | undefined,
): GuidanceTip[] {
  const out: GuidanceTip[] = [];
  // Fail-open: an unmatched model, or a matched section that is missing/empty
  // in the asset, yields nothing. Never substitute another version's section,
  // and never throw — this feeds the statusline renderer.
  const sectionName = resolveModelSection(model);
  if (!sectionName || sectionName === "base") return out;
  const sec = GUIDANCE.sections[sectionName];
  if (!sec) return out;
  const rawLabel = typeof sec.label === "string" ? sec.label : "";
  const audienceRaw = rawLabel ? guidanceAudienceFromLabel(rawLabel) : "";
  const audience = audienceRaw || undefined;
  const ch = sec.changes;
  if (ch && typeof ch.label === "string" && ch.label && Array.isArray(ch.tips)) {
    for (const t of ch.tips) {
      if (typeof t?.headline !== "string" || typeof t?.detail !== "string") continue;
      out.push({
        headline: t.headline,
        detail: t.detail,
        source: "model",
        audience,
        changeLabel: ch.label,
      });
    }
  }
  if (Array.isArray(sec.tips)) {
    for (const t of sec.tips) {
      out.push({ headline: t.headline, detail: t.detail, source: "model", audience });
    }
  }
  return out;
}

/**
 * Eligible tips for a model: base tips always, plus the model-specific tips
 * (change tips + model page tips) when a section matches. Headlines are kept
 * CLEAN (no inline label prefix); provenance travels in the
 * `source`/`audience`/`changeLabel` fields so the renderer can prepend a
 * `[…]` tag (see `tipTag`). Returns a fresh array; callers may reorder/rotate.
 */
export function getEligibleGuidanceTips(
  model: string | null | undefined,
): GuidanceTip[] {
  const out: GuidanceTip[] = [];
  const base = GUIDANCE.sections.base;
  if (base && Array.isArray(base.tips)) {
    for (const t of base.tips) {
      out.push({ headline: t.headline, detail: t.detail, source: "official" });
    }
  }
  out.push(...getModelSpecificGuidanceTips(model));
  return out;
}

/**
 * Rotation that keeps model-specific advice visible. The general pool (static
 * library + official base tips) is large — 200+ entries in the statusline
 * dictionary — so a uniform rotation shows a model's own tips only a few
 * percent of the time, which reads as "EvoPet never says anything about my
 * model". When model-specific tips exist, EVEN rotation indices draw from them
 * (cycling change tips first) and ODD indices from the general pool; with none,
 * the general pool rotates exactly as before. Pure and deterministic in
 * `index`, so a given turn/tick always shows the same tip.
 */
export function pickRotatingTip<T>(
  index: number,
  generalPool: readonly T[],
  modelPool: readonly T[],
): T | undefined {
  const i = Math.abs(Math.trunc(Number.isFinite(index) ? index : 0));
  if (modelPool.length === 0) {
    return generalPool.length > 0 ? generalPool[i % generalPool.length] : undefined;
  }
  if (generalPool.length === 0 || i % 2 === 0) {
    return modelPool[Math.floor(i / 2) % modelPool.length];
  }
  return generalPool[Math.floor(i / 2) % generalPool.length];
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
