#!/usr/bin/env node
// sync-claude-docs.mjs
//
// Fetch Anthropic's public Claude Code docs, extract bullets, and rewrite
// AUTO-GENERATED marker blocks inside statusline.py. Rule-based only - no LLM,
// no Claude API. Designed to run weekly via GitHub Actions.
//
// Usage:
//   node scripts/sync-claude-docs.mjs           # fetch + rewrite
//   node scripts/sync-claude-docs.mjs --dry-run # show diff, no write
//   node scripts/sync-claude-docs.mjs --self-test # use built-in HTML stubs
//
// Exit codes:
//   0  success (whether or not statusline.py changed)
//   1  ALL sources failed to fetch (CI fail-closed)
//   2  unexpected internal error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import TurndownService from 'turndown';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const STATUSLINE_PATH = join(REPO_ROOT, 'statusline.py');

const SOURCES = [
  {
    url: 'https://code.claude.com/docs/en/best-practices',
    kind: 'best-practices',
    maxEntries: 30,
  },
  {
    url: 'https://code.claude.com/docs/en/commands',
    kind: 'slash-commands',
    maxEntries: 30,
  },
];

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

// Escape for inclusion in a Python single-quoted string literal.
function pyEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// A bullet whose entire content is a single markdown link, e.g.
//   [Give Claude a way to verify](#give-claude-a-way-to-verify)
// These are TOC entries, not real tips. Drop them.
const TOC_LINK_ONLY_RE = /^\[[^\]]+\]\([^)]+\)$/;

function extractBestPractices(markdown, maxEntries) {
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
    if (out.length >= maxEntries) break;
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

function extractSlashCommands(markdown, maxEntries) {
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

  for (let i = 0; i < lines.length && out.length < maxEntries; i++) {
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
      if (out.length >= maxEntries) break;
    }
  }

  return out;
}

// -------------------------------------------------------------
// Marker rewrite
// -------------------------------------------------------------

// EOL is preserved per-block by rewriteBlock() via the captured [\r\n]+ group,
// so no whole-file EOL detection is needed.

function buildBlockBody(indent, entries) {
  if (entries.length === 0) {
    return (
      indent +
      "{'headline': '(同期失敗: 次回 cron で再試行されます)', 'before': None, 'after': None},"
    );
  }
  return entries
    .map(
      (h) =>
        indent +
        "{'headline': '" +
        pyEscape(h) +
        "', 'before': None, 'after': None},"
    )
    .join('\n');
}

// Replace the body between START/END for a given source URL. If the source
// substring is not found, returns the original content unchanged.
function rewriteBlock(content, sourceUrl, entries, todayUtc) {
  const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '([ \\t]*)# AUTO-GENERATED:START source=' +
      escaped +
      ' fetched=([^\\r\\n]*)([\\r\\n]+)([\\s\\S]*?)([ \\t]*)# AUTO-GENERATED:END',
    'm'
  );
  const m = content.match(re);
  if (!m) {
    return { content, found: false, changed: false };
  }
  const indent = m[1];
  const eol = m[3].includes('\r\n') ? '\r\n' : '\n';
  const closingIndent = m[5];

  const body = buildBlockBody(indent, entries);
  const newBlock =
    indent +
    '# AUTO-GENERATED:START source=' +
    sourceUrl +
    ' fetched=' +
    todayUtc +
    eol +
    body +
    eol +
    closingIndent +
    '# AUTO-GENERATED:END';

  const before = content.slice(0, m.index);
  const after = content.slice(m.index + m[0].length);
  const updated = before + newBlock + after;
  return {
    content: updated,
    found: true,
    changed: updated !== content,
  };
}

// -------------------------------------------------------------
// Driver
// -------------------------------------------------------------
async function main() {
  if (!existsSync(STATUSLINE_PATH)) {
    console.error('ERROR: statusline.py not found at ' + STATUSLINE_PATH);
    process.exit(2);
  }
  const original = readFileSync(STATUSLINE_PATH, 'utf-8');
  let working = original;
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
      if (src.kind === 'best-practices') {
        entries = extractBestPractices(md, src.maxEntries);
      } else if (src.kind === 'slash-commands') {
        entries = extractSlashCommands(md, src.maxEntries);
      } else {
        entries = [];
      }
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

    const result = rewriteBlock(working, src.url, entries, today);
    if (!result.found) {
      console.warn('[skip] marker block not found for ' + src.url);
      summary.push({
        url: src.url,
        status: 'marker-missing',
        entries: entries.length,
      });
      continue;
    }
    working = result.content;
    okCount += 1;
    summary.push({
      url: src.url,
      status: 'ok',
      entries: entries.length,
      changed: result.changed,
    });
  }

  const changed = working !== original;

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
    writeFileSync(STATUSLINE_PATH, working, 'utf-8');
    console.log('Wrote ' + STATUSLINE_PATH);
  } else if (DRY_RUN && changed) {
    console.log('[dry-run] would write changes (not writing)');
  } else if (!SELF_TEST) {
    console.log('No changes to write.');
  }

  // Self-test post-validation: temporarily write, py_compile, then restore.
  if (SELF_TEST) {
    if (changed) {
      try {
        writeFileSync(STATUSLINE_PATH, working, 'utf-8');
        const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
        try {
          execFileSync(pyCmd, ['-m', 'py_compile', STATUSLINE_PATH], {
            stdio: 'inherit',
          });
          console.log('[self-test] py_compile OK');
        } catch (e) {
          console.error('[self-test] py_compile FAILED');
          writeFileSync(STATUSLINE_PATH, original, 'utf-8');
          process.exit(2);
        }
      } finally {
        writeFileSync(STATUSLINE_PATH, original, 'utf-8');
        console.log('[self-test] restored statusline.py to pre-self-test state');
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

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(2);
});
