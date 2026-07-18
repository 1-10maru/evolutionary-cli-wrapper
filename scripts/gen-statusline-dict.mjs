// gen-statusline-dict.mjs
//
// B4: `src/data/statusline-dict.json` is the SINGLE SOURCE OF TRUTH for the
// hand-curated EvoPet dictionary (the `_COMMENTS` mood lines and the `_TIPS`
// rotation). This script regenerates the marked section inside the Python
// renderer (`statusline.py`) from that JSON, embedding the JSON text verbatim
// inside a `json.loads(r'''…''')` literal — so the Python effective dictionary
// is byte-for-byte the same data the TypeScript renderer imports directly from
// the JSON file.
//
// Usage:
//   node scripts/gen-statusline-dict.mjs           # regenerate statusline.py section
//   node scripts/gen-statusline-dict.mjs --check   # verify no drift (CI/test gate)
//
// Exit codes:
//   0  success / in sync
//   1  drift detected (--check) — regenerate and commit
//   2  invalid input (bad JSON, missing markers, unsafe content)
//
// Why generation instead of a runtime JSON load in Python: the single-file
// statusline construction deploys exactly ONE file (`~/.claude/base_statusline.py`,
// see src/cli/installStatusline.ts). Loading a sidecar JSON at runtime would
// turn that into a two-file deployment with a partial-deploy failure mode and
// a silent divergence window (stale sidecar next to a fresh script). Embedding
// the JSON at generation time keeps the deployment contract single-file, keeps
// old installs untouched, and this script's --check (run by the vitest suite)
// makes drift structurally impossible in the repo.

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
export const DICT_PATH = join(REPO_ROOT, 'src', 'data', 'statusline-dict.json');
export const STATUSLINE_PATH = join(REPO_ROOT, 'statusline.py');

const START_MARKER = '# STATUSLINE-DICT:START';
const END_MARKER = '# STATUSLINE-DICT:END';

/** Validate the dictionary JSON (schema + embedding safety). Throws on error. */
export function validateDict(raw) {
  let dict;
  try {
    dict = JSON.parse(raw);
  } catch (e) {
    throw new Error('statusline-dict.json is not valid JSON: ' + e.message);
  }
  if (!dict || typeof dict !== 'object') throw new Error('dict root must be an object');
  const moods = ['start', 'early', 'working', 'busy', 'critical'];
  if (!dict.comments || typeof dict.comments !== 'object') {
    throw new Error('dict.comments missing');
  }
  for (const mood of moods) {
    const pool = dict.comments[mood];
    if (!Array.isArray(pool) || pool.length === 0 || pool.some((s) => typeof s !== 'string' || !s)) {
      throw new Error(`dict.comments.${mood} must be a non-empty array of strings`);
    }
  }
  if (!Array.isArray(dict.tipGroups) || dict.tipGroups.length === 0) {
    throw new Error('dict.tipGroups must be a non-empty array');
  }
  for (const g of dict.tipGroups) {
    if (typeof g.name !== 'string' || !g.name) throw new Error('every tipGroup needs a name');
    if (!Array.isArray(g.entries) || g.entries.length === 0) {
      throw new Error(`tipGroup "${g.name}" must have a non-empty entries array`);
    }
    for (const e of g.entries) {
      if (typeof e.headline !== 'string' || !e.headline) {
        throw new Error(`tipGroup "${g.name}" has an entry without a headline`);
      }
      if (!('before' in e) || !('after' in e)) {
        throw new Error(`tipGroup "${g.name}" entry "${e.headline.slice(0, 30)}" must carry before/after keys (null allowed)`);
      }
    }
  }
  // Embedding safety: the JSON text is spliced into a Python r''' … ''' literal.
  if (raw.includes("'''")) throw new Error("dict JSON must not contain a triple quote (''')");
  if (raw.includes('\r')) throw new Error('dict JSON must use LF line endings');
  if (!raw.endsWith('\n')) throw new Error('dict JSON must end with a trailing newline');
  return dict;
}

/** Build the generated Python section (markers included) from the raw JSON text. */
export function buildSection(raw) {
  return [
    START_MARKER + ' generated from src/data/statusline-dict.json — do not edit by hand.',
    '# Single source of truth for the hand-curated EvoPet dictionary: the',
    '# _COMMENTS mood lines and the _TIPS rotation (hand-written groups plus the',
    '# AUTO-synced official-docs groups maintained by scripts/sync-claude-docs.mjs).',
    '# Edit src/data/statusline-dict.json, then:',
    '#   regenerate:  node scripts/gen-statusline-dict.mjs',
    '#   drift check: node scripts/gen-statusline-dict.mjs --check   (CI-enforced)',
    '# The TS renderer (src/cli/statusline-data.ts) imports the SAME JSON file, so',
    '# the Python and TypeScript dictionaries cannot drift apart.',
    "_STATUSLINE_DICT = json.loads(r'''",
    raw.replace(/\n$/, ''),
    "''')",
    "_COMMENTS = _STATUSLINE_DICT['comments']",
    "_TIPS = [_t for _g in _STATUSLINE_DICT['tipGroups'] for _t in _g['entries']]",
    END_MARKER,
  ].join('\n');
}

/** Replace the marked section in the statusline.py source text. Throws if the
 *  markers are missing or duplicated. */
export function spliceSection(pySource, section) {
  const startIdx = pySource.indexOf(START_MARKER);
  const endIdx = pySource.indexOf(END_MARKER);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error('STATUSLINE-DICT markers not found in statusline.py');
  }
  if (pySource.indexOf(START_MARKER, startIdx + 1) >= 0 || pySource.indexOf(END_MARKER, endIdx + 1) >= 0) {
    throw new Error('duplicate STATUSLINE-DICT markers in statusline.py');
  }
  if (endIdx < startIdx) throw new Error('STATUSLINE-DICT markers out of order');
  return pySource.slice(0, startIdx) + section + pySource.slice(endIdx + END_MARKER.length);
}

export function generate({ check = false } = {}) {
  const raw = readFileSync(DICT_PATH, 'utf-8');
  validateDict(raw);
  const pySource = readFileSync(STATUSLINE_PATH, 'utf-8');
  const section = buildSection(raw);
  const updated = spliceSection(pySource, section);
  if (check) {
    if (updated !== pySource) {
      return { changed: true, updated };
    }
    return { changed: false, updated };
  }
  if (updated !== pySource) {
    writeFileSync(STATUSLINE_PATH, updated, 'utf-8');
    return { changed: true, updated };
  }
  return { changed: false, updated };
}

const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const { changed } = generate({ check });
    if (check) {
      if (changed) {
        console.error(
          'DRIFT: statusline.py dictionary section does not match src/data/statusline-dict.json.\n' +
            'Run: node scripts/gen-statusline-dict.mjs  (then commit statusline.py)',
        );
        process.exit(1);
      }
      console.log('statusline.py dictionary section is in sync with statusline-dict.json');
    } else {
      console.log(changed ? 'Regenerated statusline.py dictionary section' : 'Already in sync; nothing to write');
    }
    process.exit(0);
  } catch (e) {
    console.error('ERROR: ' + (e && e.message ? e.message : e));
    process.exit(2);
  }
}
