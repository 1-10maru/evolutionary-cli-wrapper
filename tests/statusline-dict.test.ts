// B4: single-source-of-truth pinning for the EvoPet dictionary.
//
// `src/data/statusline-dict.json` is the canonical hand-curated dictionary.
// Two consumers must stay byte-identical to it:
//   • the TypeScript renderer — imports the JSON directly
//     (src/cli/statusline-data.ts), and
//   • the Python renderer — statusline.py embeds the JSON text verbatim in a
//     generated `json.loads(r'''…''')` section maintained by
//     scripts/gen-statusline-dict.mjs.
// These tests pin TS data == JSON == Python's effective dict, and run the
// generator's --check so any drift fails CI.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { COMMENTS, TIPS, STATUSLINE_DICT } from "../src/cli/statusline-data";

const REPO_ROOT = join(__dirname, "..");
const DICT_PATH = join(REPO_ROOT, "src", "data", "statusline-dict.json");
const STATUSLINE_PY = join(REPO_ROOT, "statusline.py");
const GEN_SCRIPT = join(REPO_ROOT, "scripts", "gen-statusline-dict.mjs");

const MOODS = ["start", "early", "working", "busy", "critical"] as const;

function readDictRaw(): string {
  return readFileSync(DICT_PATH, "utf-8");
}

/** Extract the embedded JSON text from statusline.py's generated section. */
function extractEmbeddedJson(): string {
  const py = readFileSync(STATUSLINE_PY, "utf-8");
  const m = py.match(/json\.loads\(r'''\n([\s\S]*?)\n'''\)/);
  expect(m, "statusline.py must embed the dictionary via json.loads(r''' … ''')").toBeTruthy();
  return m![1] + "\n";
}

describe("statusline-dict.json (canonical asset)", () => {
  it("parses and has all five mood pools plus non-empty tip groups", () => {
    const dict = JSON.parse(readDictRaw());
    for (const mood of MOODS) {
      expect(Array.isArray(dict.comments[mood])).toBe(true);
      expect(dict.comments[mood].length).toBeGreaterThan(0);
    }
    expect(dict.tipGroups.length).toBeGreaterThanOrEqual(1);
    for (const g of dict.tipGroups) {
      expect(g.entries.length).toBeGreaterThan(0);
      for (const e of g.entries) {
        expect(typeof e.headline).toBe("string");
        expect(e.headline.length).toBeGreaterThan(0);
        // before/after must be present (string or null) — the renderers read
        // them unconditionally.
        expect("before" in e).toBe(true);
        expect("after" in e).toBe(true);
      }
    }
  });

  it("is embedding-safe for the Python r''' literal (no ''' / CRLF, trailing NL)", () => {
    const raw = readDictRaw();
    expect(raw.includes("'''")).toBe(false);
    expect(raw.includes("\r")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("TS data == JSON", () => {
  it("COMMENTS deep-equals the JSON comments", () => {
    const dict = JSON.parse(readDictRaw());
    expect(COMMENTS).toEqual(dict.comments);
  });

  it("TIPS deep-equals the flattened JSON tip groups, in order", () => {
    const dict = JSON.parse(readDictRaw());
    const flattened = dict.tipGroups.flatMap((g: { entries: unknown[] }) => g.entries);
    expect(TIPS).toEqual(flattened);
  });

  it("exposes the typed dict asset itself", () => {
    const dict = JSON.parse(readDictRaw());
    expect(STATUSLINE_DICT).toEqual(dict);
  });
});

describe("Python effective dict == JSON", () => {
  it("statusline.py embeds the committed JSON text byte-for-byte", () => {
    // Byte equality of the embedded literal implies json.loads() in Python
    // yields exactly the data the TS side imports — no Python needed in CI.
    expect(extractEmbeddedJson()).toBe(readDictRaw());
  });

  it("statusline.py derives _COMMENTS and _TIPS from the embedded dict", () => {
    const py = readFileSync(STATUSLINE_PY, "utf-8");
    expect(py).toContain("_COMMENTS = _STATUSLINE_DICT['comments']");
    expect(py).toContain(
      "_TIPS = [_t for _g in _STATUSLINE_DICT['tipGroups'] for _t in _g['entries']]",
    );
    // Exactly one generated section.
    expect(py.match(/# STATUSLINE-DICT:START/g)?.length).toBe(1);
    expect(py.match(/# STATUSLINE-DICT:END/g)?.length).toBe(1);
  });
});

describe("generator drift gate", () => {
  it("`gen-statusline-dict.mjs --check` reports in-sync", () => {
    const res = spawnSync(process.execPath, [GEN_SCRIPT, "--check"], {
      encoding: "utf8",
    });
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
  });
});
