import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveModelSection,
  getEligibleGuidanceTips,
  resolveModelFromArgs,
  resolveModelFromSettings,
  resolveProxyModel,
  getPromptingGuidance,
  tipTag,
} from "../src/promptingGuidance";
import { pickTip, pickTipForModel, TIPS_LIBRARY } from "../src/signalDetector";

describe("resolveModelSection", () => {
  it("maps fable ids (incl. [1m] and display name) to the fable-5 section", () => {
    expect(resolveModelSection("claude-fable-5")).toBe("fable-5");
    expect(resolveModelSection("claude-fable-5[1m]")).toBe("fable-5");
    expect(resolveModelSection("Claude Fable 5")).toBe("fable-5");
  });
  it("maps mythos to the fable-5 section (shared model)", () => {
    expect(resolveModelSection("claude-mythos-5")).toBe("fable-5");
  });
  it("routes point releases to their EXACT page, not the base generation", () => {
    // Anthropic publishes a Fable 5.1 page whose content differs materially
    // from Fable 5; sending a 5.1 user to the 5.0 page is the previous model's
    // guidance. These patterns must stay ABOVE the fable-5 pattern.
    expect(resolveModelSection("claude-fable-5-1")).toBe("fable-5-1");
    expect(resolveModelSection("claude-fable-5-1[1m]")).toBe("fable-5-1");
    expect(resolveModelSection("Claude Fable 5.1")).toBe("fable-5-1");
    expect(resolveModelSection("claude-mythos-5-1")).toBe("fable-5-1");
  });
  it("keeps plain 5 on the 5 page", () => {
    expect(resolveModelSection("claude-fable-5")).not.toBe("fable-5-1");
  });
  it("a point release NEVER falls back to its base generation's page", () => {
    // Uniform rule, no special cases: no exact page means base tips only.
    // Silent beats mislabelled.
    expect(resolveModelSection("claude-opus-5-1")).toBeNull();
    expect(resolveModelSection("claude-fable-5-2")).toBeNull();
    expect(resolveModelSection("claude-opus-4-8-1")).toBeNull();
  });
  it("a DATE suffix is not a point release", () => {
    // Anthropic ships date-stamped ids (claude-haiku-4-5-20251001), and those
    // are the same model — they must keep resolving to their generation page.
    expect(resolveModelSection("claude-opus-4-8-20260101")).toBe("opus-4-8");
    expect(resolveModelSection("claude-opus-5-20260101")).toBe("opus-5");
  });
  it("mythos is anchored to its generation (no bare-family fallback)", () => {
    // A bare `mythos` alternative would hand claude-mythos-6 the Fable 5 page:
    // the same defect class as the bare `opus` pattern removed earlier.
    expect(resolveModelSection("claude-mythos-5")).toBe("fable-5");
    expect(resolveModelSection("claude-mythos-6")).toBeNull();
  });
  it("maps opus 4.8 ids to the opus-4-8 section", () => {
    expect(resolveModelSection("claude-opus-4-8")).toBe("opus-4-8");
    expect(resolveModelSection("claude-opus-4-8[1m]")).toBe("opus-4-8");
    expect(resolveModelSection("Claude Opus 4.8")).toBe("opus-4-8");
  });
  it("maps opus 5 ids to the opus-5 section, never to opus-4-8", () => {
    expect(resolveModelSection("claude-opus-5")).toBe("opus-5");
    expect(resolveModelSection("claude-opus-5[1m]")).toBe("opus-5");
    expect(resolveModelSection("Claude Opus 5")).toBe("opus-5");
  });
  it("returns null for other/unknown models and empty input", () => {
    expect(resolveModelSection("claude-sonnet-5")).toBeNull();
    expect(resolveModelSection("claude-haiku-4-5")).toBeNull();
    expect(resolveModelSection("")).toBeNull();
    expect(resolveModelSection(undefined)).toBeNull();
    expect(resolveModelSection(null)).toBeNull();
  });
  it("returns null for an unreleased generation (no bare `opus`/`fable` fallback)", () => {
    // A future model must NOT inherit an older generation's page.
    expect(resolveModelSection("claude-opus-6")).toBeNull();
    expect(resolveModelSection("claude-fable-6")).toBeNull();
    expect(resolveModelSection("claude-opus-4-1")).toBeNull();
  });
});

describe("getEligibleGuidanceTips", () => {
  const base = getPromptingGuidance().sections.base.tips;

  it("returns only base (official) tips for an unknown model", () => {
    const tips = getEligibleGuidanceTips("claude-sonnet-5");
    expect(tips.length).toBe(base.length);
    // No model-tuned tips; all base tips carry official provenance.
    expect(tips.some((t) => t.source === "model")).toBe(false);
    expect(tips.every((t) => t.source === "official")).toBe(true);
  });

  it("gives a Fable 5.1 model Fable 5.1 tips, never Fable 5 tips", () => {
    const tips = getEligibleGuidanceTips("claude-fable-5-1");
    expect(tips.some((t) => t.source === "model" && t.audience === "Fable 5.1")).toBe(true);
    expect(tips.some((t) => t.audience === "Fable 5")).toBe(false);
    const fable5 = new Set(
      getPromptingGuidance().sections["fable-5"].tips.map((t) => t.headline + "|" + t.detail),
    );
    expect(tips.some((t) => fable5.has(t.headline + "|" + t.detail))).toBe(false);
  });

  it("layers model-tagged fable tips (clean headline + audience field)", () => {
    const tips = getEligibleGuidanceTips("claude-fable-5[1m]");
    expect(tips.length).toBeGreaterThan(base.length);
    expect(tips.some((t) => t.source === "model" && t.audience === "Fable 5")).toBe(true);
    expect(tips.some((t) => t.audience === "Opus 4.8")).toBe(false);
    // Headlines stay clean (provenance travels in the source/audience fields).
    expect(tips.some((t) => t.headline.startsWith("Fable 5のコツ"))).toBe(false);
  });

  it("layers model-tagged opus tips for an Opus 4.8 model", () => {
    const tips = getEligibleGuidanceTips("claude-opus-4-8");
    expect(tips.some((t) => t.source === "model" && t.audience === "Opus 4.8")).toBe(true);
    expect(tips.some((t) => t.audience === "Fable 5")).toBe(false);
    expect(tips.some((t) => t.audience === "Opus 5")).toBe(false);
  });

  it("gives an Opus 5 model Opus 5 tips only — no Opus 4.8 text anywhere", () => {
    const tips = getEligibleGuidanceTips("claude-opus-5[1m]");
    expect(tips.length).toBeGreaterThan(base.length);
    expect(tips.some((t) => t.source === "model" && t.audience === "Opus 5")).toBe(true);
    // The whole point of the generation split: no 4.8-sourced advice, no 4.8
    // tag. (We do NOT assert the literal string "Opus 4.8" is absent — the
    // official Opus 5 page itself compares the model to Opus 4.8 in its own
    // prose, which is legitimate Opus 5 content.)
    expect(tips.some((t) => t.audience === "Opus 4.8")).toBe(false);
    expect(tips.every((t) => tipTag(t.source, t.audience) !== "[Opus 4.8向け]")).toBe(
      true,
    );
    expect(
      tips.some((t) => t.source === "model" && tipTag(t.source, t.audience) === "[Opus 5向け]"),
    ).toBe(true);
    // Not one tip may come from the opus-4-8 section's tip set.
    const opus48 = new Set(
      getPromptingGuidance().sections["opus-4-8"].tips.map((t) => t.headline + "|" + t.detail),
    );
    expect(tips.some((t) => opus48.has(t.headline + "|" + t.detail))).toBe(false);
  });

  it("gives an unreleased generation base tips only (no wrong-generation advice)", () => {
    for (const model of ["claude-opus-6", "claude-opus-5-1", "claude-mythos-6"]) {
      const tips = getEligibleGuidanceTips(model);
      expect(tips.length).toBe(base.length);
      expect(tips.every((t) => t.source === "official")).toBe(true);
    }
  });

  it("yields non-empty headline + detail for every eligible tip", () => {
    for (const t of getEligibleGuidanceTips("claude-fable-5")) {
      expect(t.headline.length).toBeGreaterThan(1);
      expect(t.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("tipTag", () => {
  it("renders the audience tag for a labelled model section", () => {
    expect(tipTag("model", "Opus 5")).toBe("[Opus 5向け]");
  });
  it("falls back to [公式] for a model tip with no audience (unlabelled section)", () => {
    // A model section with an empty label must never invent a […向け] tag; the
    // tip still came from an official page, so it reads as [公式].
    expect(tipTag("model", undefined)).toBe("[公式]");
    expect(tipTag("model", "")).toBe("[公式]");
  });
  it("keeps the official / generic tags unchanged", () => {
    expect(tipTag("official")).toBe("[公式]");
    expect(tipTag("generic")).toBe("[汎用]");
  });
});

describe("resolveModelFromArgs", () => {
  it("parses --model <value>", () => {
    expect(resolveModelFromArgs(["node", "evo", "--model", "claude-fable-5"])).toBe(
      "claude-fable-5",
    );
  });
  it("parses --model=<value>", () => {
    expect(resolveModelFromArgs(["--model=claude-opus-4-8"])).toBe("claude-opus-4-8");
  });
  it("parses -m <value>", () => {
    expect(resolveModelFromArgs(["-m", "claude-fable-5"])).toBe("claude-fable-5");
  });
  it("ignores a flag-like value after --model", () => {
    expect(resolveModelFromArgs(["--model", "--verbose"])).toBeNull();
  });
  it("returns null when absent or input is not an array", () => {
    expect(resolveModelFromArgs(["--foo", "bar"])).toBeNull();
    expect(resolveModelFromArgs(null)).toBeNull();
    expect(resolveModelFromArgs(undefined)).toBeNull();
  });
});

describe("resolveModelFromSettings", () => {
  it("reads the model key", () => {
    expect(resolveModelFromSettings({ model: "claude-fable-5[1m]" })).toBe(
      "claude-fable-5[1m]",
    );
  });
  it("returns null for missing / non-string / non-object", () => {
    expect(resolveModelFromSettings({})).toBeNull();
    expect(resolveModelFromSettings({ model: 5 })).toBeNull();
    expect(resolveModelFromSettings(null)).toBeNull();
    expect(resolveModelFromSettings("nope")).toBeNull();
  });
});

describe("resolveProxyModel", () => {
  function tmpSettings(model: string): string {
    const p = path.join(
      os.tmpdir(),
      `evo-settings-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
    );
    fs.writeFileSync(p, JSON.stringify({ model }));
    return p;
  }

  it("prefers the --model arg over settings.json", () => {
    const settingsPath = tmpSettings("claude-opus-4-8");
    try {
      expect(
        resolveProxyModel({
          argv: ["node", "evo", "--model", "claude-fable-5"],
          settingsPath,
        }),
      ).toBe("claude-fable-5");
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  });

  it("falls back to the settings.json model when no arg", () => {
    const settingsPath = tmpSettings("claude-opus-4-8");
    try {
      expect(resolveProxyModel({ argv: ["node", "evo"], settingsPath })).toBe(
        "claude-opus-4-8",
      );
    } finally {
      fs.rmSync(settingsPath, { force: true });
    }
  });

  it("returns null when neither source resolves", () => {
    expect(
      resolveProxyModel({
        argv: ["node", "evo"],
        settingsPath: path.join(os.tmpdir(), "evo-no-such-settings-xyz.json"),
      }),
    ).toBeNull();
  });
});

describe("pickTip / pickTipForModel rotation", () => {
  it("pickTip low indices carry the [汎用] tag on the static library headlines", () => {
    for (let i = 0; i < Math.min(5, TIPS_LIBRARY.length); i++) {
      expect(pickTip(i).headline).toBe(`[汎用] ${TIPS_LIBRARY[i].headline}`);
    }
  });

  it("a fable model rotation surfaces at least one [Fable 5向け] tip and no opus tip", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(pickTipForModel(i, "claude-fable-5").headline);
    }
    const headlines = [...seen];
    expect(headlines.some((h) => h.startsWith("[Fable 5向け] "))).toBe(true);
    expect(headlines.some((h) => h.startsWith("[Opus 4.8向け] "))).toBe(false);
  });

  it("an unknown model rotation never surfaces model-tagged tips", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(pickTipForModel(i, "claude-sonnet-5").headline);
    }
    const headlines = [...seen];
    expect(
      headlines.some(
        (h) => h.startsWith("[Fable 5向け] ") || h.startsWith("[Opus 4.8向け] "),
      ),
    ).toBe(false);
  });
});
