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
import threading

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

# Claude Code pipes the payload and closes stdin at once. A stdin that is still
# open after this long is never going to deliver: a bare json.load(sys.stdin)
# then blocks forever and the process outlives its parent as an orphan.
STDIN_DEADLINE_S = 1.5


def read_stdin(deadline=STDIN_DEADLINE_S):
    """Return stdin decoded as sys.stdin would, '' for a terminal or no stdin,
    or None if it did not reach EOF within `deadline` seconds."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return ''
        fd = sys.stdin.fileno()
        encoding, errors = sys.stdin.encoding, sys.stdin.errors
    except Exception:
        return ''
    chunks = []

    def pump():
        try:
            while True:
                b = os.read(fd, 65536)
                if not b:
                    return
                chunks.append(b)
        except Exception:
            pass

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    t.join(deadline)
    if t.is_alive():
        return None
    try:
        return b''.join(chunks).decode(encoding, errors).replace('\r\n', '\n')
    except Exception:
        return ''


raw = read_stdin()
if raw is None:
    # os._exit: a normal shutdown can block behind the read still pending in
    # the reader thread.
    os._exit(0)
try:
    data = json.loads(raw)
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
ctx = (data.get('context_window') or {}).get('used_percentage')
if ctx is not None:
    usage.append(f'ctx {dot(ctx)}')
five = ((data.get('rate_limits') or {}).get('five_hour') or {}).get('used_percentage')
if five is not None:
    usage.append(f'5h {dot(five)}')
week = ((data.get('rate_limits') or {}).get('seven_day') or {}).get('used_percentage')
if week is not None:
    usage.append(f'7d {dot(week)}')
usage_str = SEP.join(usage)
parts = [f'{BOLD}{model}{R}']
if usage_str:
    parts.append(usage_str)
parts.append(f'{CYAN}{cwd_display}{R}')

print(SEP.join(parts), end='')
