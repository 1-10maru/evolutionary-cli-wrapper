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
} from "../src/promptingGuidance";
import { pickTip, pickTipForModel, TIPS_LIBRARY } from "../src/signalDetector";

describe("resolveModelSection", () => {
  it("maps fable ids (incl. [1m] and display name) to the fable section", () => {
    expect(resolveModelSection("claude-fable-5")).toBe("fable");
    expect(resolveModelSection("claude-fable-5[1m]")).toBe("fable");
    expect(resolveModelSection("Claude Fable 5")).toBe("fable");
  });
  it("maps mythos to the fable section (shared model)", () => {
    expect(resolveModelSection("claude-mythos-5")).toBe("fable");
  });
  it("maps opus ids to the opus section", () => {
    expect(resolveModelSection("claude-opus-4-8")).toBe("opus");
    expect(resolveModelSection("claude-opus-4-8[1m]")).toBe("opus");
  });
  it("returns null for other/unknown models and empty input", () => {
    expect(resolveModelSection("claude-sonnet-5")).toBeNull();
    expect(resolveModelSection("claude-haiku-4-5")).toBeNull();
    expect(resolveModelSection("")).toBeNull();
    expect(resolveModelSection(undefined)).toBeNull();
    expect(resolveModelSection(null)).toBeNull();
  });
});

describe("getEligibleGuidanceTips", () => {
  const base = getPromptingGuidance().sections.base.tips;

  it("returns only base tips for an unknown model", () => {
    const tips = getEligibleGuidanceTips("claude-sonnet-5");
    expect(tips.length).toBe(base.length);
    expect(tips.some((t) => t.headline.startsWith("Fable"))).toBe(false);
    expect(tips.some((t) => t.headline.startsWith("Opus"))).toBe(false);
  });

  it("layers label-prefixed fable tips for a fable model", () => {
    const tips = getEligibleGuidanceTips("claude-fable-5[1m]");
    expect(tips.length).toBeGreaterThan(base.length);
    expect(tips.some((t) => t.headline.startsWith("Fable 5のコツ: "))).toBe(true);
    expect(tips.some((t) => t.headline.startsWith("Opus"))).toBe(false);
  });

  it("layers label-prefixed opus tips for an opus model", () => {
    const tips = getEligibleGuidanceTips("claude-opus-4-8");
    expect(tips.some((t) => t.headline.startsWith("Opus 4.8のコツ: "))).toBe(true);
    expect(tips.some((t) => t.headline.startsWith("Fable"))).toBe(false);
  });

  it("yields non-empty headline + detail for every eligible tip", () => {
    for (const t of getEligibleGuidanceTips("claude-fable-5")) {
      expect(t.headline.length).toBeGreaterThan(1);
      expect(t.detail.length).toBeGreaterThan(10);
    }
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
  it("pickTip low indices stay backward-compatible with the static library", () => {
    for (let i = 0; i < Math.min(5, TIPS_LIBRARY.length); i++) {
      expect(pickTip(i).headline).toBe(TIPS_LIBRARY[i].headline);
    }
  });

  it("a fable model rotation surfaces at least one fable guidance tip and no opus tip", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(pickTipForModel(i, "claude-fable-5").headline);
    }
    const headlines = [...seen];
    expect(headlines.some((h) => h.startsWith("Fable 5のコツ: "))).toBe(true);
    expect(headlines.some((h) => h.startsWith("Opus 4.8のコツ: "))).toBe(false);
  });

  it("an unknown model rotation never surfaces model-labeled tips", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(pickTipForModel(i, "claude-sonnet-5").headline);
    }
    const headlines = [...seen];
    expect(
      headlines.some(
        (h) => h.startsWith("Fable 5のコツ: ") || h.startsWith("Opus 4.8のコツ: "),
      ),
    ).toBe(false);
  });
});
