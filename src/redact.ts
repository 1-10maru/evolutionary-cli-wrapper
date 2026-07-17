// redact — shared secret-redaction helpers.
//
// Two callers need to strip secret-looking values out of persisted text:
//   1. `evo logs --bundle` (src/cli/logs.ts) redacts log LINES before zipping.
//   2. The tracked-turn store (src/db.ts) redacts the captured prompt/output
//      text before it is written to the SQLite `turns` table.
//
// Both previously would have needed their own patterns; centralizing them here
// keeps the assignment-style patterns in one place and lets the free-text path
// layer on a few standalone high-entropy token shapes (AWS keys, GitHub PATs,
// `sk-...` API keys, etc.) that appear in prose without a `KEY=` prefix.

const REDACTED = "[REDACTED]";

/**
 * Pattern 1 — JSON-style: `"KEY":"value"` or `"KEY": "value"`.
 * Captures the key (with surrounding quotes) and the value-opening quote so
 * the replacement preserves the syntactic structure.
 */
const SECRET_JSON_RE = /("(?:\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*)"\s*:\s*)"([^"]*)"/gi;
/**
 * Pattern 2 — quoted bare assignment: `KEY="multi word value"`.
 * Reads through to the closing quote so multi-word values are fully masked
 * (a `\S+` pattern stops at the first whitespace and leaks the tail).
 */
const SECRET_QUOTED_RE = /(\b\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*\s*=\s*)"([^"]*)"/gi;
/**
 * Pattern 3 — unquoted assignment: `KEY=value` or `KEY: value` (no quotes).
 * Value is a non-whitespace, non-quote run. The leading `(?!["'])` lookahead
 * prevents this pattern from eating quoted values (those belong to Pattern 1
 * or Pattern 2). Without it, `KEY="abc def"` would be matched as
 * `KEY=` + `"abc` and leak the rest.
 */
const SECRET_BARE_RE = /(\b\w*(?:TOKEN|KEY|SECRET|PASSWORD)\w*\s*[:=]\s*)(?!["'])([^\s"']+)/gi;

/**
 * Redact secret values in a single line/string. Applies three assignment
 * patterns in order from most-specific to least-specific so a single value is
 * only masked once:
 *   1. JSON-style `"KEY":"value"` → `"KEY":"[REDACTED]"`
 *   2. quoted bare `KEY="value"` → `KEY="[REDACTED]"`
 *   3. unquoted `KEY=value` / `KEY: value` → `KEY=[REDACTED]`
 *
 * Exported for unit testing and reused by both the log bundler and the turn
 * store.
 */
export function redactSecrets(line: string): string {
  let out = line;
  // Pattern 1: JSON-quoted (most specific) — must run first so the quoted
  // value isn't matched by Pattern 3 as `"value"` (non-whitespace run).
  out = out.replace(SECRET_JSON_RE, '$1"[REDACTED]"');
  // Pattern 2: quoted bare assignment (KEY="value with spaces")
  out = out.replace(SECRET_QUOTED_RE, '$1"[REDACTED]"');
  // Pattern 3: unquoted (KEY=value, no surrounding quotes)
  out = out.replace(SECRET_BARE_RE, "$1[REDACTED]");
  return out;
}

// ── Standalone high-entropy token shapes ──────────────────────────────────
// These match well-known credential formats that appear in free-form prose
// WITHOUT a `KEY=` prefix (a user pasting a token into a prompt). They are
// deliberately specific so ordinary words are never masked: each shape has a
// fixed provider prefix plus a minimum body length. Order does not matter —
// the shapes do not overlap.
const STANDALONE_SECRET_RES: RegExp[] = [
  // AWS access key IDs (AKIA…, ASIA… temporary) — prefix + 16 base32-ish chars.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // GitHub personal access / OAuth / app tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // OpenAI / Anthropic style keys: sk-…, sk-ant-…, sk-proj-…, sk-svcacct-…
  // Requires a >=24-char body after an optional known provider prefix, so short
  // benign `sk-` words (e.g. "sk-cli", "sk-based") are not masked while real
  // keys (which are far longer) still are.
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g,
  // Google API keys: AIza + 35 url-safe chars.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- + dash-delimited body.
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
];
// `Bearer <token>` / `Authorization: Bearer <token>` — mask the token, keep the
// `Bearer ` marker so the shape stays readable.
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
// PEM private-key blocks — mask the whole block (or the header if truncated).
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g;

/**
 * Redact secrets in free-form text (a captured prompt or CLI output preview).
 * Applies the assignment patterns AND the standalone high-entropy token shapes,
 * so a pasted `AKIA…`, `ghp_…`, `sk-…`, `Bearer …`, or PEM key is masked even
 * without a `KEY=` prefix. Used by the turn store before persisting text.
 */
export function redactSecretText(text: string): string {
  if (!text) return text;
  let out = redactSecrets(text);
  out = out.replace(PEM_PRIVATE_KEY_RE, REDACTED);
  out = out.replace(BEARER_RE, `$1${REDACTED}`);
  for (const re of STANDALONE_SECRET_RES) {
    out = out.replace(re, REDACTED);
  }
  return out;
}
