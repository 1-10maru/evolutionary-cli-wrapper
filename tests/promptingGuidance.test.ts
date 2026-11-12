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
  getModelSpecificGuidanceTips,
  pickRotatingTip,
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
    // (opus-5-1 / fable-5-3 / opus-4-8-1 pages verified 404 on 2026-11-12.)
    expect(resolveModelSection("claude-opus-5-1")).toBeNull();
    expect(resolveModelSection("claude-fable-5-3")).toBeNull();
    expect(resolveModelSection("claude-opus-4-8-1")).toBeNull();
    expect(resolveModelSection("claude-sonnet-5-1")).toBeNull();
    expect(resolveModelSection("claude-haiku-5")).toBeNull();
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
    expect(resolveModelSection("claude-haiku-4-5")).toBeNull();
    // A bare settings alias names no version → base tips only (this is what
    // ~/.claude/settings.json "model" commonly holds, so the proxy must not
    // guess a version from it).
    expect(resolveModelSection("opus[1m]")).toBeNull();
    expect(resolveModelSection("opus")).toBeNull();
    expect(resolveModelSection("fable")).toBeNull();
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

describe("resolveModelSection — 5.x lineup exact-version separation", () => {
  it("separates Fable 5.2 / 5.1 / 5 (ids, [1m], display names, mythos alias)", () => {
    for (const m of ["claude-fable-5-2", "claude-fable-5-2[1m]", "Fable 5.2", "Claude Fable 5.2", "claude-mythos-5-2"]) {
      expect(resolveModelSection(m)).toBe("fable-5-2");
    }
    for (const m of ["claude-fable-5-1", "Fable 5.1", "claude-mythos-5-1"]) {
      expect(resolveModelSection(m)).toBe("fable-5-1");
    }
    for (const m of ["claude-fable-5", "Fable 5", "claude-mythos-5"]) {
      expect(resolveModelSection(m)).toBe("fable-5");
    }
  });
  it("a point-release pattern never swallows a longer number or a date", () => {
    expect(resolveModelSection("claude-fable-5-10")).toBeNull();
    expect(resolveModelSection("claude-fable-5-21")).toBeNull();
    // Fable 5 with a date stamp is Fable 5, not 5.2.
    expect(resolveModelSection("claude-fable-5-20261001")).toBe("fable-5");
    expect(resolveModelSection("claude-fable-5-2-20261101")).toBe("fable-5-2");
  });
  it("separates Opus 5.5 / Opus 5 / Opus 4.8", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5-5[1m]", "Opus 5.5", "Claude Opus 5.5"]) {
      expect(resolveModelSection(m)).toBe("opus-5-5");
    }
    expect(resolveModelSection("claude-opus-5")).toBe("opus-5");
    expect(resolveModelSection("claude-opus-4-8")).toBe("opus-4-8");
    expect(resolveModelSection("claude-opus-5-5")).not.toBe("opus-5");
    expect(resolveModelSection("claude-opus-5-5")).not.toBe("opus-4-8");
  });
  it("separates Sonnet 5.5 / Sonnet 5, and maps Haiku 5.5", () => {
    expect(resolveModelSection("claude-sonnet-5-5")).toBe("sonnet-5-5");
    expect(resolveModelSection("Sonnet 5.5")).toBe("sonnet-5-5");
    expect(resolveModelSection("claude-sonnet-5")).toBe("sonnet-5");
    expect(resolveModelSection("claude-haiku-5-5")).toBe("haiku-5-5");
    expect(resolveModelSection("Haiku 5.5")).toBe("haiku-5-5");
  });
});

describe("what-changed tips (official 動作の違い, previous release → this one)", () => {
  it("Fable 5.2 gets [Fable 5.1→5.2] change tips first, then [Fable 5.2向け] tips", () => {
    const tips = getModelSpecificGuidanceTips("claude-fable-5-2");
    expect(tips.length).toBeGreaterThan(0);
    expect(tips[0].changeLabel).toBe("Fable 5.1→5.2");
    expect(tipTag(tips[0].source, tips[0].audience, tips[0].changeLabel)).toBe("[Fable 5.1→5.2]");
    expect(tips.some((t) => !t.changeLabel && t.audience === "Fable 5.2")).toBe(true);
    // Never another version's labels.
    expect(tips.every((t) => t.audience === "Fable 5.2")).toBe(true);
  });
  it("Fable 5.1 and Fable 5 never see the 5.2 change tips", () => {
    for (const m of ["claude-fable-5-1", "claude-fable-5"]) {
      const tips = getModelSpecificGuidanceTips(m);
      expect(tips.some((t) => t.changeLabel)).toBe(false);
      expect(tips.some((t) => t.audience === "Fable 5.2")).toBe(false);
    }
  });
  it("Opus 5.5 gets [Opus 5→5.5]; Opus 5 / 4.8 do not", () => {
    const t55 = getModelSpecificGuidanceTips("claude-opus-5-5");
    expect(t55.some((t) => t.changeLabel === "Opus 5→5.5")).toBe(true);
    expect(t55.every((t) => t.audience === "Opus 5.5")).toBe(true);
    for (const m of ["claude-opus-5", "claude-opus-4-8"]) {
      expect(getModelSpecificGuidanceTips(m).some((t) => t.changeLabel)).toBe(false);
    }
  });
  it("an unknown model / settings alias gets no model-specific tips at all", () => {
    for (const m of ["opus[1m]", "claude-opus-6", "", undefined, null]) {
      expect(getModelSpecificGuidanceTips(m as string | undefined)).toEqual([]);
    }
  });
  it("every change tip's detail is non-trivial and its section cites a whats-new page", () => {
    const g = getPromptingGuidance() as unknown as {
      sections: Record<string, { changes?: { sourceUrl: string; tips: { detail: string }[] } }>;
    };
    for (const sec of Object.values(g.sections)) {
      if (!sec.changes) continue;
      expect(sec.changes.sourceUrl).toMatch(/\/whats-new-[a-z0-9-]+\.md$/);
      for (const t of sec.changes.tips) expect(t.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("pickRotatingTip (model-specific tips stay visible)", () => {
  const general = ["g0", "g1", "g2", "g3", "g4"];
  const model = ["m0", "m1"];
  it("with no model tips, rotates the general pool exactly as before", () => {
    for (let i = 0; i < 12; i++) expect(pickRotatingTip(i, general, [])).toBe(general[i % 5]);
  });
  it("even indices draw model tips, odd indices the general pool", () => {
    expect([0, 2, 4, 6].map((i) => pickRotatingTip(i, general, model))).toEqual(["m0", "m1", "m0", "m1"]);
    expect([1, 3, 5, 7, 9, 11].map((i) => pickRotatingTip(i, general, model))).toEqual([
      "g0", "g1", "g2", "g3", "g4", "g0",
    ]);
  });
  it("is total: negative/NaN index and empty pools never throw", () => {
    expect(pickRotatingTip(-3, general, model)).toBeDefined();
    expect(pickRotatingTip(Number.NaN, general, model)).toBe("m0");
    expect(pickRotatingTip(3, [], [])).toBeUndefined();
    expect(pickRotatingTip(3, [], model)).toBe("m1");
  });
  it("pickTipForModel: a Fable 5.2 session sees a 5.1→5.2 change tip on turn 0", () => {
    expect(pickTipForModel(0, "claude-fable-5-2").headline.startsWith("[Fable 5.1→5.2] ")).toBe(true);
    expect(pickTipForModel(0, "claude-fable-5-1").headline.startsWith("[Fable 5.1向け] ")).toBe(true);
  });
});

describe("getEligibleGuidanceTips", () => {
  const base = getPromptingGuidance().sections.base.tips;

  it("returns only base (official) tips for an unknown model", () => {
    // (claude-sonnet-5 has its own page since 2026-11-12; use an unpublished id.)
    const tips = getEligibleGuidanceTips("claude-haiku-4-5");
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
  it("renders a what-changed tag verbatim when changeLabel is set", () => {
    expect(tipTag("model", "Fable 5.2", "Fable 5.1→5.2")).toBe("[Fable 5.1→5.2]");
    // changeLabel only applies to model tips.
    expect(tipTag("official", undefined, "x→y")).toBe("[公式]");
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
      // claude-sonnet-5 used to be "unknown"; it now has its own page, so use a
      // genuinely unpublished version.
      seen.add(pickTipForModel(i, "claude-opus-6").headline);
    }
    const headlines = [...seen];
    expect(headlines.some((h) => /^\[[^\]]*(向け|→)[^\]]*\] /u.test(h))).toBe(false);
  });
});
