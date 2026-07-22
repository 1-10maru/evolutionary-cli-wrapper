// Unit tests for the token-half renderer (C1) — the `model · usage · cwd`
// line that lets `evo statusline --full` render the complete statusline in
// parity with statusline.py's token portion.

import { describe, expect, it } from "vitest";
import { collapseCwd, renderTokenLine, TOKEN_SEP } from "../../src/cli/statuslineToken";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const deps = { homeDir: "/home/u", fallbackCwd: "/fallback/here" };

describe("collapseCwd", () => {
  it("collapses $HOME to ~ and keeps short paths whole", () => {
    expect(collapseCwd("/home/u/proj", "/home/u")).toBe("~/proj");
    expect(collapseCwd("/home/u", "/home/u")).toBe("~");
  });

  it("elides to the last two segments when deeper than 3", () => {
    expect(collapseCwd("/a/b/c/d/e", "/home/u")).toBe("…/d/e");
    // `~/proj/app` is exactly 3 segments → kept whole.
    expect(collapseCwd("/home/u/proj/app", "/home/u")).toBe("~/proj/app");
    // one deeper → elided.
    expect(collapseCwd("/home/u/proj/app/sub", "/home/u")).toBe("…/app/sub");
  });

  it("normalizes backslashes (Windows paths)", () => {
    expect(collapseCwd("C:\\Users\\me\\proj", "C:\\Users\\me")).toBe("~/proj");
  });
});

describe("renderTokenLine", () => {
  it("renders model + cwd with no usage chips when none are present", () => {
    const out = strip(renderTokenLine({ model: { display_name: "Claude" }, cwd: "/home/u/proj" }, deps));
    // model · cwd  (no usage segment)
    expect(out).toBe("Claude · ~/proj");
  });

  it("includes ctx / 5h / 7d chips in order with rounded percentages", () => {
    const out = strip(
      renderTokenLine(
        {
          model: { display_name: "Claude" },
          cwd: "/home/u/proj",
          context_window: { used_percentage: 20 },
          rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 7 } },
        },
        deps,
      ),
    );
    expect(out).toBe("Claude · ctx ● 20% · 5h ● 40% · 7d ● 7% · ~/proj");
  });

  it("omits only the missing chips", () => {
    const out = strip(
      renderTokenLine(
        {
          model: { display_name: "Claude" },
          cwd: "/home/u/proj",
          rate_limits: { seven_day: { used_percentage: 55 } },
        },
        deps,
      ),
    );
    expect(out).toBe("Claude · 7d ● 55% · ~/proj");
  });

  it("uses the gradient color bands from the Python renderer", () => {
    // <50 → green-ish rgb(pct*5.1, 200, 80); ≥50 → rgb(255, 200-(pct-50)*4, 60)
    const low = renderTokenLine(
      { model: { display_name: "M" }, cwd: "/x", context_window: { used_percentage: 20 } },
      deps,
    );
    expect(low).toContain("\x1b[38;2;102;200;80m"); // 20*5.1 = 102
    const high = renderTokenLine(
      { model: { display_name: "M" }, cwd: "/x", context_window: { used_percentage: 75 } },
      deps,
    );
    expect(high).toContain("\x1b[38;2;255;100;60m"); // 200-(75-50)*4 = 100
  });

  it("rounds half-to-even like Python round()", () => {
    const half = strip(
      renderTokenLine(
        { model: { display_name: "M" }, cwd: "/x", context_window: { used_percentage: 2.5 } },
        deps,
      ),
    );
    // 2.5 → 2 (round-half-to-even), not 3.
    expect(half).toContain("ctx ● 2%");
  });

  it("falls back to Claude + workspace.current_dir + fallbackCwd", () => {
    const out = strip(renderTokenLine({ workspace: { current_dir: "/home/u/ws" } }, deps));
    expect(out).toBe("Claude · ~/ws");
    const out2 = strip(renderTokenLine({}, deps));
    expect(out2).toBe("Claude · /fallback/here");
  });

  it("joins with the dim ` · ` separator", () => {
    const out = renderTokenLine({ model: { display_name: "M" }, cwd: "/x" }, deps);
    expect(out).toContain(TOKEN_SEP);
  });
});
