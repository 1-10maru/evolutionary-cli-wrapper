// sync-claude-docs.mjs
//
// Fetch Anthropic's public Claude Code docs, extract bullets, and rewrite the
// AUTO-synced tip groups inside src/data/statusline-dict.json (the single
// source of truth for the EvoPet dictionary — B4). After updating the JSON it
// regenerates the embedded dictionary section of statusline.py via
// scripts/gen-statusline-dict.mjs, so the Python renderer and the TypeScript
// renderer (which imports the JSON directly) stay byte-identical. Rule-based
// only - no LLM, no Claude API. Designed to run weekly via GitHub Actions.
//
// Usage:
//   node scripts/sync-claude-docs.mjs           # fetch + rewrite
//   node scripts/sync-claude-docs.mjs --dry-run # show diff, no write
//   node scripts/sync-claude-docs.mjs --self-test # use built-in HTML stubs
//
// Exit codes:
//   0  success (whether or not the dictionary changed)
//   1  ALL sources failed to fetch (CI fail-closed)
//   2  unexpected internal error

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import TurndownService from 'turndown';
import { generate as regenerateStatuslineDict, DICT_PATH, STATUSLINE_PATH } from './gen-statusline-dict.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
// Bundled, committed model-aware prompting guidance asset (loaded at runtime by
// src/promptingGuidance.ts). Regenerated deterministically from the official
// Anthropic JA prompt-engineering docs — no LLM involved.
const GUIDANCE_PATH = join(REPO_ROOT, 'src', 'data', 'prompting-guidance.json');

const SOURCES = [
  {
    url: 'https://code.claude.com/docs/en/best-practices',
    kind: 'best-practices',
  },
  {
    url: 'https://code.claude.com/docs/en/commands',
    kind: 'slash-commands',
  },
];

// ─── Model-aware prompting guidance (v3.6.0) ───
// Anthropic publishes clean markdown at each doc URL + ".md". The base page
// applies to every current model; the model-specific pages layer on top and
// are selected at runtime by matching the user's model id against
// MODEL_PATTERNS. Adding a future model is a pure data change: append a source
// + a pattern here, re-run, and commit the regenerated JSON.
const GUIDANCE_DOC_BASE =
  'https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/';
const PROMPTING_SOURCES = [
  { url: GUIDANCE_DOC_BASE + 'claude-prompting-best-practices.md', section: 'base' },
  { url: GUIDANCE_DOC_BASE + 'prompting-claude-fable-5.md', section: 'fable' },
  { url: GUIDANCE_DOC_BASE + 'prompting-claude-opus-4-8.md', section: 'opus' },
];
// Section labels prepended to model-specific tip headlines so the user can see
// which tips are tuned to their current model. Base tips carry no label.
const SECTION_LABELS = {
  base: '',
  fable: 'Fable 5のコツ',
  opus: 'Opus 4.8のコツ',
};
// model id (or display name) → guidance section. First match wins, so more
// specific patterns come first. Fable and Mythos share the same model, so both
// map to the "fable" section.
const MODEL_PATTERNS = [
  { pattern: 'mythos', flags: 'i', section: 'fable' },
  { pattern: 'fable', flags: 'i', section: 'fable' },
  { pattern: 'opus', flags: 'i', section: 'opus' },
];
// Size guards keep the bundled asset (and the statusline it feeds) light.
const GUIDANCE_MAX_TIPS_PER_SECTION = 12;
const GUIDANCE_MAX_DETAIL_CHARS = 220;
const GUIDANCE_MAX_HEADLINE_CHARS = 48;
const GUIDANCE_MAX_JSON_BYTES = 80 * 1024;

// ─── Tier classification (v3.0.0) ───
// Tier 1 = core daily-use; Tier 3 = niche/diagnostic; Tier 2 = default (everything else).
const SC_TIER1 = new Set([
  '/clear', '/compact', '/context', '/help', '/agents', '/permissions',
  '/hooks', '/effort', '/model', '/usage', '/init', '/memory', '/mcp',
  '/skill', '/review', '/feedback', '/exit', '/quit'
]);
const SC_TIER3 = new Set([
  '/heapdump', '/debug', '/doctor', '/migrate-installer', '/desktop',
  '/chrome', '/copy', '/export', '/color', '/config', '/extra-usage',
  '/fewer-permission-prompts'
]);
const BP_TIER1_KEYWORDS = [
  '@', 'reference files', 'image', 'paste', 'url', 'context', 'verify',
  'test', 'permission', 'claude.md', 'subagent', 'todo', 'specific'
];
const BP_TIER3_KEYWORDS = [
  'kebab-case', 'camelcase', 'json properties', 'url paths', 'pagination'
];

// v3.1: Category tagging — lets statusline.py filter tips by detected signal
// (e.g., `prompt_too_vague` -> `specificity` tips). Categories mirror the
// adviceMessage categories used elsewhere in the codebase.
function inferCategory(headline, kind) {
  const lower = headline.toLowerCase();
  if (kind === 'slash-commands') {
    const m = headline.match(/^(\/[a-z][a-z0-9_-]*)/i);
    if (m) {
      const cmd = m[1].toLowerCase();
      if (['/clear', '/compact', '/context', '/memory'].includes(cmd)) return 'context';
      if (['/permissions', '/hooks', '/agents'].includes(cmd)) return 'permissions';
      if (['/debug', '/doctor', '/heapdump'].includes(cmd)) return 'recovery';
      if (['/review', '/diff', '/branch'].includes(cmd)) return 'verification';
      if (['/skill', '/init', '/mcp'].includes(cmd)) return 'exploration';
    }
    return 'general';
  }
  if (kind === 'best-practices') {
    if (lower.includes('@') || lower.includes('reference file') || lower.includes('specific') || lower.includes('explicit')) return 'specificity';
    if (lower.includes('verify') || lower.includes(' test') || lower.includes('check') || lower.includes('success criteria')) return 'verification';
    if (lower.includes('permission') || lower.includes('allowlist') || lower.includes('sandbox')) return 'permissions';
    if (lower.includes('context') || lower.includes('compact') || lower.includes('memory') || lower.includes('token')) return 'context';
    if (lower.includes('fix ') || lower.includes('debug') || lower.includes('error')) return 'recovery';
    if (lower.includes('search') || lower.includes('agent') || lower.includes('subagent') || lower.includes('batch')) return 'exploration';
    return 'general';
  }
  return 'general';
}

function assignTier(headline, kind) {
  if (kind === 'slash-commands') {
    const m = headline.match(/^(\/[a-z][a-z0-9_-]*)/i);
    if (m) {
      const cmd = m[1].toLowerCase();
      if (SC_TIER1.has(cmd)) return 1;
      if (SC_TIER3.has(cmd)) return 3;
    }
    return 2;
  }
  if (kind === 'best-practices') {
    const lower = headline.toLowerCase();
    for (const kw of BP_TIER3_KEYWORDS) {
      if (lower.includes(kw)) return 3;
    }
    for (const kw of BP_TIER1_KEYWORDS) {
      if (lower.includes(kw)) return 1;
    }
    return 2;
  }
  return 2;
}

const SELF_TEST_STUBS = {
  'https://code.claude.com/docs/en/best-practices':
    '<html><body><ul>' +
    // TOC anchor link (should be filtered out)
    '<li><a href="#give-claude-a-way-to-verify">Give Claude a way to verify its work</a></li>' +
    // Real prose tips
    "<li><strong>Reference files with <code>@</code></strong> instead of describing where code lives. Claude reads the file before responding.</li>" +
    '<li><strong>Paste images directly</strong>. Copy/paste or drag and drop images into the prompt.</li>' +
    "<li>Ask Claude questions you'd ask a senior engineer who just joined the team.</li>" +
    // Short navigation crumb (should be filtered)
    '<li>Auto mode</li>' +
    // Pure code (should be filtered)
    '<li><code>/clear</code></li>' +
    '</ul></body></html>',
  'https://code.claude.com/docs/en/commands':
    '<html><body><table><thead><tr><th>Command</th><th>Purpose</th></tr></thead><tbody>' +
    '<tr><td><code>/clear</code></td><td>Start a new conversation with empty context.</td></tr>' +
    '<tr><td><code>/compact [instructions]</code></td><td>Free up context by summarizing the conversation so far.</td></tr>' +
    '<tr><td><code>/help</code></td><td>Show help and available commands.</td></tr>' +
    '<tr><td><code>/agents</code></td><td>Manage agent configurations.</td></tr>' +
    '<tr><td><code>/diff</code></td><td>Open an interactive diff viewer showing uncommitted changes.</td></tr>' +
    '</tbody></table></body></html>',
};

// Markdown stubs mirroring the real docs' shape (## / ### headings, prose
// paragraph, then a fenced English example prompt to be skipped).
const PROMPTING_SELF_TEST_STUBS = {
  [GUIDANCE_DOC_BASE + 'claude-prompting-best-practices.md']:
    '# ベストプラクティス\n\n## Claude Fable 5\n\nこのガイダンスは専用ページにあります。\n\n## 一般原則\n\n以下は現行の全モデルに適用されます。\n\n### 明確かつ直接的に\n\nClaudeは明確で具体的な指示によく反応します。望む出力について具体的に指定することで結果を向上させられます。\n\n```text\nCreate an analytics dashboard\n```\n\n### 例を効果的に使用する\n\n例はClaudeの出力形式やトーンを誘導する最も信頼性の高い方法の一つです。3〜5個の例を含めてください。\n',
  [GUIDANCE_DOC_BASE + 'prompting-claude-fable-5.md']:
    '# Fable 5\n\n## デフォルトでより長いターン\n\n難しいタスクに対する個々のリクエストは、より高いエフォート設定では何分も実行されることがあります。\n\n```text wrap\nWhen you have enough information to act, act.\n```\n\n## 境界を明示する\n\nClaude Fable 5 は要求されていないアクションを実行することがあります。すべきこととすべきでないことについて明示的な制約を定義してください。\n',
  [GUIDANCE_DOC_BASE + 'prompting-claude-opus-4-8.md']:
    '# Opus 4.8\n\n## 応答の長さと冗長性\n\nClaude Opus 4.8 は簡潔さと徹底性のバランスを取ります。望む長さを明示的に伝えてください。\n\n```text\nBe concise.\n```\n\n## より文字通りの指示追従\n\nClaude Opus 4.8 は指示をより文字通りに解釈します。暗黙の期待に頼らず明示してください。\n',
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SELF_TEST = args.includes('--self-test');

// -------------------------------------------------------------
// Fetch with timeout
// -------------------------------------------------------------
async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'evolutionary-cli-wrapper-docsync/1.0' },
    });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// -------------------------------------------------------------
// HTML -> Markdown
// -------------------------------------------------------------
function htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  return td.turndown(html);
}

// -------------------------------------------------------------
// Extraction rules (rule-based, no LLM)
// -------------------------------------------------------------

// Strip leading bullet markers and trim. Returns null for non-bullet lines.
function bulletText(line) {
  const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
  if (!m) return null;
  return m[1];
}

// Strip control chars below 0x20 except tab. Collapse internal whitespace.
function sanitize(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Allow tab (0x09); replace other ctrl chars (<0x20) and DEL (0x7F) with space.
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      out += ' ';
    } else {
      out += s[i];
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

// A bullet whose entire content is a single markdown link, e.g.
//   [Give Claude a way to verify](#give-claude-a-way-to-verify)
// These are TOC entries, not real tips. Drop them.
const TOC_LINK_ONLY_RE = /^\[[^\]]+\]\([^)]+\)$/;

function extractBestPractices(markdown) {
  const seen = new Set();
  const out = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const text = bulletText(raw);
    if (!text) continue;
    const cleaned = sanitize(text);
    if (!cleaned) continue;
    // Filter: TOC anchor-link-only bullets (entire bullet is a single markdown link)
    if (TOC_LINK_ONLY_RE.test(cleaned)) continue;
    // Filter: too short to be a real tip (navigation crumbs, single words)
    if (cleaned.length < 20) continue;
    // Filter: bullets that start with backtick (pure code-only items)
    if (cleaned.startsWith('`')) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

// Strip markdown link syntax `[text](url)` -> `text`, leaving plain prose.
function stripMarkdownLinks(s) {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// Strip inline code wrapper backticks but keep contents readable.
function stripBackticks(s) {
  return s.replace(/`([^`]+)`/g, '$1');
}

// Take the first sentence (up to a period followed by space or end-of-string).
// Falls back to the whole input if no sentence boundary is found.
function firstSentence(s) {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}

function extractSlashCommands(markdown) {
  const seen = new Set();
  const out = [];
  const lines = markdown.split(/\r?\n/);

  // Patterns that indicate a slash-command definition line.
  //   `/cmd ...`            - inline-code wrapper (turndown output for table cells)
  //   ### /cmd              - heading-style (alternative renderings)
  //   **/cmd**              - bold (rare)
  // We capture the canonical "/name" from each.
  const codeLineRe = /^\s*`(\/[a-z][a-z0-9_-]*)\b[^`]*`\s*$/i;
  const headingLineRe = /^\s*#{1,6}\s+(\/[a-z][a-z0-9_-]*)\b/i;
  const boldLineRe = /^\s*\*\*\s*(\/[a-z][a-z0-9_-]*)\b[^*]*\*\*\s*$/i;
  // Bullet pattern used as fallback (matches existing extraction style).
  const bulletSlashRe = /^(?:[*_`]+)?(\/[a-z][a-z0-9_-]*)(?:[*_`]+)?(.*)$/i;

  function pickDescription(startIdx) {
    // Look ahead up to 5 lines for the first non-blank, non-definition paragraph.
    for (let j = startIdx; j < Math.min(startIdx + 5, lines.length); j++) {
      const ln = lines[j];
      if (!ln || !ln.trim()) continue;
      // Skip if next line is itself another command definition.
      if (codeLineRe.test(ln) || headingLineRe.test(ln) || boldLineRe.test(ln)) {
        return null;
      }
      return ln.trim();
    }
    return null;
  }

  function record(name, descRaw) {
    let headline;
    if (descRaw) {
      let desc = stripMarkdownLinks(descRaw);
      desc = stripBackticks(desc);
      // Strip leading bold markers like "**[Skill]...**"
      desc = desc.replace(/^\*\*[^*]*\*\*\s*\.?\s*/, '');
      desc = sanitize(desc);
      desc = firstSentence(desc);
      headline = name + ' — ' + desc;
    } else {
      headline = name;
    }
    if (!headline || headline.length < 2) return;
    const key = headline.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(headline);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // 1) Heading-style command entries: lines like "### /clear" or "## /compact"
    let m = raw.match(headingLineRe);
    if (m) {
      const name = m[1];
      const desc = pickDescription(i + 1);
      record(name, desc);
      continue;
    }

    // 2) Inline-code-wrapped command line (turndown table-cell rendering):
    //    `/clear` on its own line, with description in the next non-blank line.
    m = raw.match(codeLineRe);
    if (m) {
      const name = m[1];
      const desc = pickDescription(i + 1);
      record(name, desc);
      continue;
    }

    // 3) Bold-wrapped command line.
    m = raw.match(boldLineRe);
    if (m) {
      const name = m[1];
      const desc = pickDescription(i + 1);
      record(name, desc);
      continue;
    }
  }

  // Fallback: bullet-style "- /cmd description" if nothing else matched.
  if (out.length === 0) {
    for (const raw of lines) {
      const text = bulletText(raw);
      if (!text) continue;
      const m = text.match(bulletSlashRe);
      if (!m) continue;
      const name = m[1];
      let rest = (m[2] || '').replace(/^[\s—–:\-]+/, '').trim();
      rest = rest.replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '').trim();
      record(name, rest || null);
    }
  }

  return out;
}

// -------------------------------------------------------------
// Prompting-guidance extraction (rule-based, no LLM)
// -------------------------------------------------------------
//
// The official docs are already markdown (URL + ".md"). We treat each
// "leaf" heading (## or ### with no deeper heading nested under it) as one
// tip: the heading becomes the tip headline, the first prose paragraph after
// it becomes the detail. Fenced code blocks (the English example prompts) and
// JSX/HTML component tags (<Note>, <Tip>, <Accordion>, <CodeGroup>) are
// skipped. Cross-link pointer sections ("… は専用ページにあります") are dropped.

// Collapse a heading title into a short, clean headline.
function cleanGuidanceHeading(title) {
  let t = stripMarkdownLinks(title);
  t = stripBackticks(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_#]+/g, '');
  // Drop a trailing "のプロンプト作成" / colon noise but keep the core phrase.
  t = sanitize(t);
  if (t.length > GUIDANCE_MAX_HEADLINE_CHARS) {
    t = t.slice(0, GUIDANCE_MAX_HEADLINE_CHARS).trimEnd() + '…';
  }
  return t;
}

// Cap to maxChars, preferring a sentence boundary (。 or ". ").
function capGuidanceLength(s, maxChars) {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const jpEnd = slice.lastIndexOf('。');
  const enEnd = slice.lastIndexOf('. ');
  const cut = Math.max(jpEnd, enEnd);
  if (cut > maxChars * 0.5) return slice.slice(0, cut + 1);
  return slice.trimEnd() + '…';
}

// Classify each body line, ignoring fenced code (the English example prompts).
function classifyGuidanceRows(body) {
  const rows = [];
  let inCode = false;
  for (const raw of body) {
    const ln = raw.trim();
    if (/^(```|~~~)/.test(ln)) {
      inCode = !inCode;
      rows.push({ kind: 'fence' });
      continue;
    }
    if (inCode) {
      rows.push({ kind: 'code' });
      continue;
    }
    if (/^<\/?[A-Za-z][A-Za-z0-9]*(\s[^>]*)?\/?>?/.test(ln)) {
      rows.push({ kind: 'tag' });
      continue;
    }
    if (ln === '') { rows.push({ kind: 'blank' }); continue; }
    if (ln === '---') { rows.push({ kind: 'hr' }); continue; }
    if (/^[-*]\s+/.test(ln)) {
      rows.push({ kind: 'bullet', text: ln.replace(/^[-*]\s+/, '') });
      continue;
    }
    rows.push({ kind: 'prose', text: ln });
  }
  return rows;
}

// Extract the first prose paragraph from a section body, plus the bullet list
// that immediately follows it (many sections are "intro sentence + bullets").
function distillGuidanceBody(body) {
  const rows = classifyGuidanceRows(body);
  const collected = [];
  let started = false;
  let boundary = false;
  let bulletCount = 0;
  for (const r of rows) {
    if (r.kind === 'code' || r.kind === 'fence' || r.kind === 'tag' || r.kind === 'hr') {
      if (started) break;
      continue;
    }
    if (r.kind === 'blank') {
      if (started) boundary = true;
      continue;
    }
    if (r.kind === 'prose') {
      // A new prose paragraph after our first block ends the excerpt; bullets
      // are the only thing allowed to continue past the blank line.
      if (boundary && collected.length) break;
      collected.push(r.text);
      started = true;
    } else if (r.kind === 'bullet') {
      if (bulletCount >= 3) break; // keep the excerpt bounded
      collected.push(r.text);
      started = true;
      bulletCount += 1;
    }
    boundary = false;
  }

  let text = collected.join(' ');
  text = stripMarkdownLinks(text);
  text = stripBackticks(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/[*_]{1,3}/g, '');
  text = sanitize(text);
  // Drop a trailing lead-in clause that only introduced a (skipped) code block,
  // e.g. "…簡単な例：" or "…as follows:". Keep everything up to the last full
  // sentence; if nothing full remains the caller's length filter drops it.
  if (/[：:]\s*$/.test(text)) {
    const cut = Math.max(text.lastIndexOf('。'), text.lastIndexOf('. '));
    text = cut >= 0 ? text.slice(0, cut + 1) : '';
  }
  return capGuidanceLength(text, GUIDANCE_MAX_DETAIL_CHARS);
}

function extractPromptingGuidance(markdown) {
  const lines = markdown.split(/\r?\n/);
  // Locate headings, ignoring those inside fenced code blocks.
  const headings = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^\s*```/.test(ln) || /^\s*~~~/.test(ln)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = ln.match(/^(#{2,3})\s+(.*\S)\s*$/);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), line: i });
  }

  const tips = [];
  const seen = new Set();
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h];
    const next = headings[h + 1];
    // A heading is a container (skip it) if the very next heading is deeper.
    const isLeaf = !next || next.level <= cur.level;
    if (!isLeaf) continue;
    const endLine = next ? next.line : lines.length;
    const detail = distillGuidanceBody(lines.slice(cur.line + 1, endLine));
    if (!detail || detail.length < 40) continue;
    // Cross-reference pointer sections carry no real guidance.
    if (/専用ページ|専用のページ/.test(detail)) continue;
    const headline = cleanGuidanceHeading(cur.title);
    if (!headline || headline.length < 2) continue;
    const key = headline.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tips.push({ headline, detail });
    if (tips.length >= GUIDANCE_MAX_TIPS_PER_SECTION) break;
  }
  return tips;
}

function loadExistingGuidance() {
  try {
    if (!existsSync(GUIDANCE_PATH)) return null;
    return JSON.parse(readFileSync(GUIDANCE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// Build the guidance object. `fetchImpl(url, timeoutMs) -> markdown`. On a
// per-source failure we fail open: reuse the previous snapshot for that
// section if one exists. Returns { guidance, warnings, anyOk }.
async function buildPromptingGuidance(fetchImpl) {
  const prev = loadExistingGuidance();
  const sections = {};
  const warnings = [];
  let anyOk = false;

  for (const src of PROMPTING_SOURCES) {
    try {
      const md = await fetchImpl(src.url, 20000);
      if (!md || !md.trim()) throw new Error('empty response');
      const tips = extractPromptingGuidance(md);
      if (tips.length === 0) throw new Error('no tips extracted');
      sections[src.section] = {
        label: SECTION_LABELS[src.section] ?? '',
        sourceUrl: src.url,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(md).digest('hex').slice(0, 16),
        tips,
      };
      anyOk = true;
    } catch (e) {
      const kept = prev && prev.sections && prev.sections[src.section];
      if (kept) {
        sections[src.section] = prev.sections[src.section];
        warnings.push(`${src.section}: fetch/extract failed (${e.message}) — kept previous snapshot`);
      } else {
        warnings.push(`${src.section}: fetch/extract failed (${e.message}) — no previous snapshot to keep`);
      }
    }
  }

  const guidance = {
    version: 1,
    generatedAt: new Date().toISOString(),
    modelPatterns: MODEL_PATTERNS,
    sections,
  };
  return { guidance, warnings, anyOk };
}

// Schema + size sanity. Throws on violation. Used before writing and in CI.
function validateGuidance(guidance) {
  if (!guidance || typeof guidance !== 'object') throw new Error('guidance is not an object');
  if (typeof guidance.version !== 'number') throw new Error('missing version');
  if (!Array.isArray(guidance.modelPatterns) || guidance.modelPatterns.length === 0) {
    throw new Error('modelPatterns must be a non-empty array');
  }
  for (const mp of guidance.modelPatterns) {
    if (typeof mp.pattern !== 'string' || typeof mp.section !== 'string') {
      throw new Error('modelPattern entries need string pattern + section');
    }
    // Ensure the regex compiles.
    new RegExp(mp.pattern, mp.flags ?? '');
  }
  if (!guidance.sections || typeof guidance.sections !== 'object') {
    throw new Error('sections must be an object');
  }
  if (!guidance.sections.base) throw new Error('base section is required');
  for (const [name, sec] of Object.entries(guidance.sections)) {
    if (!Array.isArray(sec.tips) || sec.tips.length === 0) {
      throw new Error(`section ${name} has no tips`);
    }
    if (sec.tips.length > GUIDANCE_MAX_TIPS_PER_SECTION) {
      throw new Error(`section ${name} exceeds tip cap`);
    }
    for (const tip of sec.tips) {
      if (typeof tip.headline !== 'string' || typeof tip.detail !== 'string') {
        throw new Error(`section ${name} has a malformed tip`);
      }
      if (tip.detail.length > GUIDANCE_MAX_DETAIL_CHARS + 4) {
        throw new Error(`section ${name} tip detail exceeds length cap`);
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(guidance), 'utf-8');
  if (bytes > GUIDANCE_MAX_JSON_BYTES) {
    throw new Error(`guidance JSON ${bytes}B exceeds ${GUIDANCE_MAX_JSON_BYTES}B cap`);
  }
}

// Stable serialization: keys in a fixed order, 2-space indent, trailing NL.
function serializeGuidance(guidance) {
  return JSON.stringify(guidance, null, 2) + '\n';
}

// Content fingerprint that ignores volatile timestamps (generatedAt,
// per-section fetchedAt). Two runs over identical upstream docs produce the
// same signature, so the weekly job only opens a PR when tips actually change.
function guidanceContentSignature(guidance) {
  if (!guidance || !guidance.sections) return '';
  const sections = {};
  for (const [name, sec] of Object.entries(guidance.sections)) {
    sections[name] = {
      label: sec.label ?? '',
      sourceUrl: sec.sourceUrl,
      contentHash: sec.contentHash,
      tips: sec.tips,
    };
  }
  return JSON.stringify({
    version: guidance.version,
    modelPatterns: guidance.modelPatterns,
    sections,
  });
}

// -------------------------------------------------------------
// Dictionary tip-group rewrite (src/data/statusline-dict.json)
// -------------------------------------------------------------

// Serialize the dictionary exactly as committed (2-space indent, trailing NL,
// LF) so a no-change sync produces a byte-identical file.
function serializeDict(dict) {
  return JSON.stringify(dict, null, 2) + '\n';
}

// Replace the entries of the tipGroup whose `source` matches sourceUrl. The
// group's `fetched` stamp only advances when the entries actually changed, so
// a content-identical weekly run produces no diff (and no PR).
function rewriteDictGroup(dict, sourceUrl, entries, todayUtc) {
  const group = (dict.tipGroups || []).find((g) => g.source === sourceUrl);
  if (!group) {
    return { found: false, changed: false };
  }
  const nextEntries = entries.map((e) => ({
    headline: e.headline,
    tier: e.tier,
    category: e.category || 'general',
    before: null,
    after: null,
  }));
  const changed = JSON.stringify(group.entries) !== JSON.stringify(nextEntries);
  if (changed) {
    group.entries = nextEntries;
    group.fetched = todayUtc;
  }
  return { found: true, changed };
}

// -------------------------------------------------------------
// Driver
// -------------------------------------------------------------
async function main() {
  if (!existsSync(DICT_PATH)) {
    console.error('ERROR: statusline-dict.json not found at ' + DICT_PATH);
    process.exit(2);
  }
  if (!existsSync(STATUSLINE_PATH)) {
    console.error('ERROR: statusline.py not found at ' + STATUSLINE_PATH);
    process.exit(2);
  }
  const originalDictText = readFileSync(DICT_PATH, 'utf-8');
  const originalPy = readFileSync(STATUSLINE_PATH, 'utf-8');
  let dict;
  try {
    dict = JSON.parse(originalDictText);
  } catch (e) {
    console.error('ERROR: statusline-dict.json is not valid JSON: ' + e.message);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  let okCount = 0;
  let failCount = 0;
  const summary = [];

  for (const src of SOURCES) {
    let html;
    try {
      if (SELF_TEST) {
        html = SELF_TEST_STUBS[src.url];
        if (!html) throw new Error('no stub for ' + src.url);
      } else {
        html = await fetchWithTimeout(src.url, 15000);
      }
    } catch (e) {
      failCount += 1;
      console.warn('[skip] fetch failed for ' + src.url + ': ' + e.message);
      summary.push({ url: src.url, status: 'fetch-failed', entries: 0 });
      continue;
    }

    let entries;
    try {
      const md = htmlToMarkdown(html);
      let rawHeadlines;
      if (src.kind === 'best-practices') {
        rawHeadlines = extractBestPractices(md);
      } else if (src.kind === 'slash-commands') {
        rawHeadlines = extractSlashCommands(md);
      } else {
        rawHeadlines = [];
      }
      entries = rawHeadlines.map((h) => ({
        headline: h,
        tier: assignTier(h, src.kind),
        category: inferCategory(h, src.kind),
      }));
    } catch (e) {
      failCount += 1;
      console.warn('[skip] parse failed for ' + src.url + ': ' + e.message);
      summary.push({ url: src.url, status: 'parse-failed', entries: 0 });
      continue;
    }

    if (entries.length === 0) {
      // Treat as failure to avoid wiping out existing block with empty content.
      failCount += 1;
      console.warn('[skip] no entries extracted for ' + src.url);
      summary.push({ url: src.url, status: 'empty', entries: 0 });
      continue;
    }

    const result = rewriteDictGroup(dict, src.url, entries, today);
    if (!result.found) {
      console.warn('[skip] no tipGroup with source=' + src.url + ' in statusline-dict.json');
      summary.push({
        url: src.url,
        status: 'group-missing',
        entries: entries.length,
      });
      continue;
    }
    okCount += 1;
    summary.push({
      url: src.url,
      status: 'ok',
      entries: entries.length,
      changed: result.changed,
    });
  }

  const workingDictText = serializeDict(dict);
  const changed = workingDictText !== originalDictText;

  console.log('--- sync-claude-docs summary ---');
  for (const s of summary) {
    console.log('  ' + s.url);
    console.log(
      '    status=' +
        s.status +
        ' entries=' +
        s.entries +
        (s.changed === undefined ? '' : ' changed=' + s.changed)
    );
  }
  console.log(
    'ok=' +
      okCount +
      ' fail=' +
      failCount +
      ' fileChanged=' +
      changed +
      ' dryRun=' +
      DRY_RUN +
      ' selfTest=' +
      SELF_TEST
  );

  if (changed && !DRY_RUN && !SELF_TEST) {
    writeFileSync(DICT_PATH, workingDictText, 'utf-8');
    console.log('Wrote ' + DICT_PATH);
    // Regenerate the embedded dictionary section of statusline.py from the
    // updated JSON so the Python renderer stays byte-identical to the asset.
    regenerateStatuslineDict();
    console.log('Regenerated ' + STATUSLINE_PATH + ' dictionary section');
    // GitHub Actions only: pre-stage the dictionary asset. The weekly workflow
    // (.github/workflows/sync-claude-docs.yml) still runs a fixed
    // `git add statusline.py src/data/prompting-guidance.json`; without staging
    // the JSON here, the sync PR would commit the regenerated statusline.py
    // WITHOUT its source asset and fail the CI drift gate. The workflow's
    // `git checkout -B` keeps the index, so this staged path lands in the sync
    // commit. TODO(follow-up): add src/data/statusline-dict.json to the
    // workflow's diff/add lists and drop this block — workflow-file edits need
    // a `workflow`-scoped token, which the automation account currently lacks.
    if (process.env.GITHUB_ACTIONS === 'true') {
      try {
        execFileSync('git', ['add', DICT_PATH], { cwd: REPO_ROOT, stdio: 'inherit' });
        console.log('[ci] pre-staged src/data/statusline-dict.json for the sync commit');
      } catch (e) {
        console.warn('[ci] failed to pre-stage statusline-dict.json: ' + e.message);
      }
    }
  } else if (DRY_RUN && changed) {
    console.log('[dry-run] would write changes (not writing)');
  } else if (!SELF_TEST) {
    console.log('No changes to write.');
  }

  // ── Model-aware prompting guidance regeneration (fail-open) ──
  const guidanceFetch = SELF_TEST
    ? async (url) => {
        const stub = PROMPTING_SELF_TEST_STUBS[url];
        if (!stub) throw new Error('no guidance stub for ' + url);
        return stub;
      }
    : (url, timeoutMs) => fetchWithTimeout(url, timeoutMs);

  let guidanceChanged = false;
  try {
    const { guidance, warnings, anyOk } = await buildPromptingGuidance(guidanceFetch);
    validateGuidance(guidance);
    for (const w of warnings) console.warn('[guidance] ' + w);
    const prevGuidance = loadExistingGuidance();
    const sameContent =
      prevGuidance &&
      guidanceContentSignature(prevGuidance) === guidanceContentSignature(guidance);
    guidanceChanged = !sameContent;
    const tipTotal = Object.values(guidance.sections).reduce(
      (n, s) => n + s.tips.length,
      0,
    );
    console.log(
      '[guidance] sections=' +
        Object.keys(guidance.sections).join(',') +
        ' tips=' +
        tipTotal +
        ' anyFetched=' +
        anyOk +
        ' changed=' +
        guidanceChanged
    );
    if (SELF_TEST) {
      // Round-trip parse proves the emitted asset is valid JSON.
      JSON.parse(serializeGuidance(guidance));
      console.log('[self-test] guidance JSON valid');
    } else if (!sameContent && !DRY_RUN) {
      mkdirSync(dirname(GUIDANCE_PATH), { recursive: true });
      writeFileSync(GUIDANCE_PATH, serializeGuidance(guidance), 'utf-8');
      console.log('Wrote ' + GUIDANCE_PATH);
    } else if (DRY_RUN && !sameContent) {
      console.log('[dry-run] would write ' + GUIDANCE_PATH);
    } else {
      console.log('[guidance] no changes to write.');
    }
  } catch (e) {
    // Fail-open: guidance problems must never abort the statusline sync job.
    console.error(
      '[guidance] generation failed (kept existing asset): ' +
        (e && e.message ? e.message : e)
    );
  }

  // Self-test post-validation: temporarily write the JSON, regenerate the
  // statusline.py section, py_compile it, then restore both files.
  if (SELF_TEST) {
    if (changed) {
      try {
        writeFileSync(DICT_PATH, workingDictText, 'utf-8');
        regenerateStatuslineDict();
        const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
        try {
          execFileSync(pyCmd, ['-m', 'py_compile', STATUSLINE_PATH], {
            stdio: 'inherit',
          });
          console.log('[self-test] py_compile OK');
        } catch (e) {
          console.error('[self-test] py_compile FAILED');
          writeFileSync(DICT_PATH, originalDictText, 'utf-8');
          writeFileSync(STATUSLINE_PATH, originalPy, 'utf-8');
          process.exit(2);
        }
      } finally {
        writeFileSync(DICT_PATH, originalDictText, 'utf-8');
        writeFileSync(STATUSLINE_PATH, originalPy, 'utf-8');
        console.log('[self-test] restored statusline-dict.json + statusline.py to pre-self-test state');
      }
    } else {
      console.log('[self-test] no changes generated; nothing to validate');
    }
  }

  // Fail-closed: if BOTH sources failed (and not in self-test), exit 1
  if (!SELF_TEST && okCount === 0 && failCount === SOURCES.length) {
    console.error('ERROR: all sources failed; exiting 1');
    process.exit(1);
  }

  process.exit(0);
}

// Only auto-run when executed directly (e.g. `node scripts/sync-claude-docs.mjs`
// or the CI workflow). When imported by tests, expose the pure functions
// without running main(). realpath comparison is robust to relative-vs-absolute
// argv and symlinked node installs.
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
  main().catch((e) => {
    console.error('FATAL:', e && e.stack ? e.stack : e);
    process.exit(2);
  });
}

export {
  extractPromptingGuidance,
  distillGuidanceBody,
  buildPromptingGuidance,
  validateGuidance,
  guidanceContentSignature,
  MODEL_PATTERNS,
};
