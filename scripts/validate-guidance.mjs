// validate-guidance.mjs
//
// CI guard for the committed model-aware prompting-guidance asset. Parses
// src/data/prompting-guidance.json and runs the exact same schema + size checks
// used when the asset is generated (validateGuidance, reused from the sync
// script). Run by the weekly sync workflow after regeneration, and safe to run
// manually: `node scripts/validate-guidance.mjs`.
//
// Exit codes: 0 valid, 1 invalid/missing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateGuidance } from './sync-claude-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetPath = join(__dirname, '..', 'src', 'data', 'prompting-guidance.json');

try {
  const raw = readFileSync(assetPath, 'utf-8');
  const guidance = JSON.parse(raw);
  validateGuidance(guidance);
  const tips = Object.values(guidance.sections).reduce((n, s) => n + s.tips.length, 0);
  console.log(
    `guidance OK: ${Buffer.byteLength(raw, 'utf-8')}B, sections=` +
      `${Object.keys(guidance.sections).join(',')}, tips=${tips}`,
  );
} catch (e) {
  console.error('guidance INVALID: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
