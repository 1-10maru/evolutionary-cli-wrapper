#!/usr/bin/env python3
"""Evo token-only statusline — model + context/rate-limit chips + cwd path.

Deployed to ~/.claude/base_statusline.py by `npm run setup` (scripts/setup.mjs).
Renders ONLY the token/model/cwd line. The EvoPet block is rendered separately
by `evo statusline` (TypeScript). Keeping THIS script EvoPet-free is exactly
what prevents the double-EvoPet render when a statusline wrapper runs both this
script and `evo statusline` on the same stdin.

Extracted verbatim from the token portion of the repo-root statusline.py — do
not add EvoPet rendering here.
"""
import json
import os
import sys

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}

R = '\033[0m'
DIM = '\033[2m'
BOLD = '\033[1m'
CYAN = '\033[38;2;255;185;80m'


def gradient(pct):
    if pct < 50:
        r = int(pct * 5.1)
        return f'\033[38;2;{r};200;80m'
    else:
        g = int(200 - (pct - 50) * 4)
        return f'\033[38;2;255;{max(g, 0)};60m'


def dot(pct):
    p = round(pct)
    return f'{gradient(pct)}●{R} {BOLD}{p}%{R}'


_model = data.get('model') if isinstance(data.get('model'), dict) else {}
model = _model.get('display_name', 'Claude')
_ws = data.get('workspace') if isinstance(data.get('workspace'), dict) else {}
cwd = data.get('cwd') or _ws.get('current_dir') or os.getcwd()
home = os.path.expanduser('~').replace('\\', '/')
cwd_norm = cwd.replace('\\', '/').replace(home, '~')
cwd_parts = cwd_norm.split('/')
cwd_display = '…/' + '/'.join(cwd_parts[-2:]) if len(cwd_parts) > 3 else cwd_norm

SEP = f' {DIM}·{R} '
usage = []
ctx = data.get('context_window', {}).get('used_percentage')
if ctx is not None:
    usage.append(f'ctx {dot(ctx)}')
five = data.get('rate_limits', {}).get('five_hour', {}).get('used_percentage')
if five is not None:
    usage.append(f'5h {dot(five)}')
week = data.get('rate_limits', {}).get('seven_day', {}).get('used_percentage')
if week is not None:
    usage.append(f'7d {dot(week)}')
usage_str = SEP.join(usage)
parts = [f'{BOLD}{model}{R}']
if usage_str:
    parts.append(usage_str)
parts.append(f'{CYAN}{cwd_display}{R}')

print(SEP.join(parts), end='')
