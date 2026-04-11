#!/usr/bin/env python3
"""Evo v3.0 statusline — Always-on, self-tracking. Works with or without proxy."""
import json, sys, os, time, hashlib
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
data = json.load(sys.stdin)
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
    return f'{gradient(pct)}\u25cf{R} {BOLD}{p}%{R}'

model = data.get('model', {}).get('display_name', 'Claude')
cwd = data.get('cwd') or data.get('workspace', {}).get('current_dir') or os.getcwd()
home = os.path.expanduser('~').replace('\\', '/')
cwd_norm = cwd.replace('\\', '/').replace(home, '~')
cwd_parts = cwd_norm.split('/')
cwd_display = '\u2026/' + '/'.join(cwd_parts[-2:]) if len(cwd_parts) > 3 else cwd_norm

SEP = f' {DIM}\u00b7{R} '
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

# ── EvoPet v3.0: Always-on — proxy data if available, self-tracked fallback otherwise ──

_EVO_ACCENT = '\033[38;2;180;130;255m'
_EVO_INFO   = '\033[38;2;100;200;255m'
_EVO_WARN   = '\033[38;2;255;200;80m'
_EVO_GREEN  = '\033[38;2;120;220;120m'
_EVO_RED    = '\033[38;2;255;100;100m'
_EVO_GOLD   = '\033[38;2;255;215;0m'

def _grade_color(g):
    return {'S': _EVO_ACCENT, 'A': _EVO_GREEN, 'B': _EVO_INFO, 'C': _EVO_WARN, 'D': _EVO_RED}.get(g, _EVO_INFO)

def _grade_label(g):
    return {'S': '\u2728S \u795e', 'A': '\u2b50A \u4e0a\u624b', 'B': '\u25cf B \u826f\u597d', 'C': '\u25cb C \u3082\u3046\u4e00\u606f', 'D': '\u25b3 D \u304c\u3093\u3070\u308d\u3046'}.get(g, g)

# ── Tips library (same as signalDetector.ts TIPS_LIBRARY) ──
_TIPS = [
    {
        'headline': '\u300c\u4f55\u3092\u30fb\u3069\u3053\u3092\u30fb\u3069\u3046\u306a\u308c\u3070OK\u300d\u306e3\u70b9\u30bb\u30c3\u30c8\u3067\u6307\u793a\u306e\u7cbe\u5ea6\u304c\u30b0\u30f3\u3068\u4e0a\u304c\u308b\u3088!',
        'before': '\u30ed\u30b0\u30a4\u30f3\u753b\u9762\u3092\u76f4\u3057\u3066',
        'after': 'src/Login.tsx \u306e\u30d5\u30a9\u30fc\u30e0\u9001\u4fe1\u3067\u3001\u7a7a\u30d1\u30b9\u30ef\u30fc\u30c9\u3067\u3082submit\u3067\u304d\u308b\u30d0\u30b0\u3092\u4fee\u6b63',
    },
    {
        'headline': '\u30d5\u30a1\u30a4\u30eb\u540d\u30921\u3064\u66f8\u304f\u3060\u3051\u3067\u3001AI\u306e\u63a2\u7d22\u304c\u534a\u5206\u306b\u306a\u308b\u3088!',
        'before': '\u30d0\u30ea\u30c7\u30fc\u30b7\u30e7\u30f3\u306b\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u306e\u30c1\u30a7\u30c3\u30af\u3092\u8ffd\u52a0\u3057\u3066',
        'after': 'src/validators.ts \u306b\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u306e\u30d0\u30ea\u30c7\u30fc\u30b7\u30e7\u30f3\u3092\u8ffd\u52a0',
    },
    {
        'headline': '\u7b87\u6761\u66f8\u304d\u3067\u6307\u793a\u3059\u308b\u3068\u3001AI\u304c\u898b\u843d\u3068\u3057\u306b\u304f\u304f\u306a\u308b\u3088!',
        'before': '\u30e6\u30fc\u30b6\u30fc\u767b\u9332\u306e\u6a5f\u80fd\u3092\u3064\u304f\u3063\u3066\u3001\u30e1\u30fc\u30eb\u78ba\u8a8d\u3082\u3057\u3066\u3001\u30d1\u30b9\u30ef\u30fc\u30c9\u306f8\u6587\u5b57\u4ee5\u4e0a\u306b\u3057\u3066',
        'after': '\u30e6\u30fc\u30b6\u30fc\u767b\u9332\u6a5f\u80fd\u3092\u4f5c\u6210:\n- POST /register \u30a8\u30f3\u30c9\u30dd\u30a4\u30f3\u30c8\u8ffd\u52a0\n- \u30d1\u30b9\u30ef\u30fc\u30c9\u306f8\u6587\u5b57\u4ee5\u4e0a\n- \u30c6\u30b9\u30c8\u3082\u66f8\u304f',
    },
    {
        'headline': '\u300c\u76f4\u3057\u3066\u300d\u3060\u3051\u3060\u3068\u3001AI\u306f\u4f55\u3092\u3069\u3046\u76f4\u3059\u304b\u63a8\u6e2c\u304b\u3089\u30b9\u30bf\u30fc\u30c8\u3057\u3061\u3083\u3046\u3088',
        'before': '\u306a\u3093\u304b\u30a8\u30e9\u30fc\u51fa\u308b\u3001\u76f4\u3057\u3066',
        'after': 'npm run build \u3067 TypeError: Cannot read property \'name\' of undefined \u3063\u3066\u51fa\u308b',
    },
    {
        'headline': '\u300c\u301c\u3057\u306a\u3044\u3067\u300d\u3063\u3066\u5236\u7d04\u3092\u4f1d\u3048\u308b\u306e\u3082\u5927\u4e8b!',
        'before': '\u30ea\u30d5\u30a1\u30af\u30bf\u3057\u3066',
        'after': 'src/api.ts \u306e fetchUser \u3092\u30ea\u30d5\u30a1\u30af\u30bf\u3002\u4ed6\u306e\u30d5\u30a1\u30a4\u30eb\u306f\u5909\u66f4\u3057\u306a\u3044\u3053\u3068',
    },
    {
        'headline': '\u77e5\u3063\u3066\u305f? /clear \u3067\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u3092\u30ea\u30bb\u30c3\u30c8\u3059\u308b\u3068AI\u306e\u5fdc\u7b54\u304c\u901f\u304f\u306a\u308b\u3088!',
        'before': None, 'after': None,
    },
    {
        'headline': 'CLAUDE.md \u306b\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u30eb\u30fc\u30eb\u3092\u66f8\u3044\u3066\u304a\u304f\u3068\u3001\u6bce\u56de\u8aac\u660e\u3057\u306a\u304f\u3066\u6e08\u3080\u3088!',
        'before': None, 'after': None,
    },
    {
        'headline': '\u5927\u304d\u306a\u30bf\u30b9\u30af\u306f\u5c0f\u3055\u304f\u5206\u5272! \u4e00\u5ea6\u306b\u5168\u90e8\u983c\u3080\u3068\u7cbe\u5ea6\u304c\u4e0b\u304c\u308b\u3088',
        'before': 'EC\u30b5\u30a4\u30c8\u306e\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u3092\u5168\u90e8\u4f5c\u3063\u3066',
        'after': '\u307e\u305a\u5546\u54c1\u4e00\u89a7\u306eGET /products API\u3060\u3051\u4f5c\u3063\u3066\u3002DB\u306fSQLite\u3067\u3044\u3044',
    },
    {
        'headline': '\u30a8\u30e9\u30fc\u304c\u51fa\u305f\u3089\u3001\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u305d\u306e\u307e\u307e\u8cbc\u308b\u306e\u304c\u6700\u901f\u306e\u89e3\u6c7a\u6cd5!',
        'before': '\u52d5\u304b\u306a\u3044\u3093\u3060\u3051\u3069',
        'after': '\u3053\u306e\u30a8\u30e9\u30fc\u304c\u51fa\u308b:\nTypeError: Cannot read properties of undefined',
    },
    {
        'headline': '\u5b8c\u4e86\u6761\u4ef6\u30921\u3064\u3060\u3051\u66f8\u304f\u3060\u3051\u3067\u3001\u3084\u308a\u76f4\u3057\u7387\u304c\u5927\u5e45\u306b\u4e0b\u304c\u308b\u3088!',
        'before': '\u691c\u7d22\u6a5f\u80fd\u3092\u8ffd\u52a0\u3057\u3066',
        'after': '\u691c\u7d22\u6a5f\u80fd\u3092\u8ffd\u52a0\u3002\u5b8c\u4e86\u6761\u4ef6: \u4e00\u81f4\u3059\u308b\u7d50\u679c\u3060\u3051\u304c\u8868\u793a\u3055\u308c\u308b',
    },
    {
        'headline': '\u540c\u3058\u6307\u793a\u3092\u7e70\u308a\u8fd4\u3057\u3066\u3082\u3001\u540c\u3058\u7d50\u679c\u306b\u306a\u308b\u3060\u3051\u3060\u3088!',
        'before': '\uff083\u56de\u76ee\uff09\u76f4\u3057\u3066',
        'after': '\u3055\u3063\u304dnull\u30c1\u30a7\u30c3\u30af\u3092\u8a66\u3057\u305f\u3051\u3069\u30c0\u30e1\u3060\u3063\u305f\u3002\u578b\u81ea\u4f53\u3092Optional\u306b\u3059\u308b\u65b9\u5411\u3067\u4fee\u6b63\u3057\u3066',
    },
    {
        'headline': '\u30c6\u30b9\u30c8\u3092\u5148\u306b\u66f8\u3044\u3066\u3082\u3089\u3046\u3068\u3001\u5b9f\u88c5\u306e\u54c1\u8cea\u304c\u30b0\u30f3\u3068\u4e0a\u304c\u308b\u3088!',
        'before': '\u30bd\u30fc\u30c8\u6a5f\u80fd\u3092\u8ffd\u52a0\u3057\u3066',
        'after': 'sortByDate \u95a2\u6570\u3092\u4f5c\u3063\u3066\u3002\u5148\u306b\u30c6\u30b9\u30c8\u3092\u66f8\u3044\u3066\u304b\u3089\u5b9f\u88c5\u3057\u3066',
    },
    {
        'headline': '\u3053\u3053\u307e\u3067\u9806\u8abf\u3060\u3088! \u3044\u3044\u6307\u793a\u306e\u51fa\u3057\u65b9\u3092\u7d9a\u3051\u3066\u3044\u3053\u3046!',
        'before': None, 'after': None,
    },
    {
        'headline': '\u6307\u793a\u306b\u8ff7\u3063\u305f\u3089\u3001\u307e\u305a\u300c\u4eca\u306e\u72b6\u6cc1\u300d\u3092\u66f8\u304f\u3068\u3053\u308d\u304b\u3089\u59cb\u3081\u3088\u3046!',
        'before': None, 'after': None,
    },
    {
        'headline': '\u30b3\u30fc\u30c9\u306e\u5909\u66f4\u5f8c\u306f\u3001\u52d5\u4f5c\u78ba\u8a8d\u3092\u5fd8\u308c\u305a\u306b!',
        'before': '\u30d0\u30b0\u4fee\u6b63\u3057\u3066',
        'after': '\u30d0\u30b0\u4fee\u6b63\u3057\u3066\u3001\u4fee\u6b63\u5f8c\u306bnpm test\u3092\u5b9f\u884c\u3057\u3066\u7d50\u679c\u3092\u898b\u305b\u3066',
    },
    {
        'headline': 'Git\u3067\u30b3\u30df\u30c3\u30c8\u306f\u3053\u307e\u3081\u306b\u306d! \u5dfb\u304d\u623b\u305b\u308b\u5b89\u5fc3\u611f\u304c\u5927\u4e8b\u3060\u3088',
        'before': None, 'after': None,
    },
]

# ── Data source resolution: proxy > home fallback > self-tracking ──
_evo = None
_evo_source = None
_now_ms = time.time() * 1000

# 1. Try cwd/.evo/live-state.json (proxy running, matching cwd)
for _try_path in [
    os.path.join(cwd, '.evo', 'live-state.json'),
    os.path.join(os.path.expanduser('~'), '.claude', '.evo-live.json'),
]:
    try:
        with open(_try_path, encoding='utf-8') as _f:
            _candidate = json.load(_f)
        if _now_ms - _candidate.get('updatedAt', 0) < 10000:
            _evo = _candidate
            _evo_source = 'proxy'
            break
    except Exception:
        pass

# ── Self-tracking state (always updated, used as fallback) ──
_SELF_STATE_FILE = os.path.join(os.path.expanduser('~'), '.claude', '.evo-self-state.json')

def _load_self():
    try:
        with open(_SELF_STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_self(s):
    try:
        with open(_SELF_STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(s, f)
    except Exception:
        pass

_self = _load_self()
_now_s = time.time()
# Session detection: if context usage jumped down or cwd changed, new session
_prev_ctx = _self.get('ctx_pct', 0)
_curr_ctx = ctx if ctx is not None else 0
_session_reset = (_prev_ctx > 30 and _curr_ctx < 5) or _self.get('cwd') != cwd
if not _self or _session_reset:
    _self = {'start': _now_s, 'calls': 0, 'tip_idx': _self.get('tip_idx', 0), 'cwd': cwd}
_self['calls'] = _self.get('calls', 0) + 1
_self['last'] = _now_s
_self['ctx_pct'] = _curr_ctx
_save_self(_self)

# ── Build evo display ──
_line1_bits = []
_line2 = ""

if _evo and _evo_source == 'proxy':
    # Full proxy data available
    _avatar = _evo.get('avatar', '\U0001f423')
    _nick = _evo.get('nickname', 'EvoPet')
    _turns = _evo.get('turns', 0)
    _bond = _evo.get('bond', 0)
    _combo = _evo.get('comboCount', 0)
    _grade = _evo.get('sessionGrade', '')
    _ps = _evo.get('promptScore', 0)
    _signal = _evo.get('signalKind', '')
    _advice = _evo.get('advice', '')
    _detail = _evo.get('adviceDetail', '')
    _before = _evo.get('beforeExample', '')
    _after = _evo.get('afterExample', '')

    _gc = _grade_color(_grade)
    _line1_bits = [f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}"]

    if _grade:
        _gl = _grade_label(_grade)
        _line1_bits.append(f"{_gc}{BOLD}{_gl}{R}")

    if _turns > 0:
        _line1_bits.append(f"{_EVO_INFO}{_turns}\u56de\u76ee\u306e\u4f1a\u8a71{R}")

    if _ps > 0:
        if _ps >= 80:
            _psl = f"\U0001f4dd \u6307\u793a\u306e\u8cea: {_EVO_GREEN}{BOLD}\u3068\u3066\u3082\u826f\u3044!{R}"
        elif _ps >= 60:
            _psl = f"\U0001f4dd \u6307\u793a\u306e\u8cea: {_EVO_INFO}{BOLD}\u826f\u597d{R}"
        elif _ps >= 40:
            _psl = f"\U0001f4dd \u6307\u793a\u306e\u8cea: {_EVO_WARN}{BOLD}\u3082\u3046\u5c11\u3057\u5177\u4f53\u7684\u306b{R}"
        else:
            _psl = f"\U0001f4dd \u6307\u793a\u306e\u8cea: {_EVO_RED}{BOLD}\u66d6\u6627\u3059\u304e\u308b\u304b\u3082{R}"
        _line1_bits.append(_psl)

    if _combo >= 3:
        _cc = _EVO_GOLD if _combo >= 10 else _EVO_ACCENT if _combo >= 5 else _EVO_GREEN
        _line1_bits.append(f"{_cc}{BOLD}{_combo}\u9023\u7d9a\u3044\u3044\u611f\u3058!{R}")

    if _bond < 100:
        _line1_bits.append(f"{_EVO_GREEN}\u80b2\u6210\u5ea6 {BOLD}{_bond}%{R}")

    # LINE 2: Signal-based advice or tip
    if _signal and _signal in ('prompt_too_vague', 'same_file_revisit', 'same_function_revisit',
                                'scope_creep', 'no_success_criteria', 'approval_fatigue',
                                'error_spiral', 'retry_loop', 'high_tool_ratio'):
        if _before and _after:
            _b = _before[:30] + '...' if len(_before) > 30 else _before
            _a = _after[:55] + '...' if len(_after) > 55 else _after
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice}{R}\n   {DIM}\u274c{R} {_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {_EVO_GREEN}\"{_a}\"{R}"
        elif _advice:
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice}{R}"
            if _detail:
                _d = _detail[:70] + '...' if len(_detail) > 70 else _detail
                _line2 += f"\n   {DIM}{_d}{R}"
    elif _signal in ('good_structure', 'first_pass_success', 'improving_trend'):
        _line2 = f"\u2728 {_EVO_GREEN}{BOLD}{_advice}{R}"
        if _detail:
            _d = _detail[:70] + '...' if len(_detail) > 70 else _detail
            _line2 += f"\n   {DIM}{_d}{R}"
    elif _signal == 'tip' and _advice:
        if _before and _after:
            _b = _before[:30] + '...' if len(_before) > 30 else _before
            _a = _after[:55] + '...' if len(_after) > 55 else _after
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice}{R}\n   {DIM}\u274c{R} {_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {_EVO_GREEN}\"{_a}\"{R}"
        else:
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice}{R}"
            if _detail:
                _d = _detail[:80] + '...' if len(_detail) > 80 else _detail
                _line2 += f"\n   {DIM}{_d}{R}"
    elif _advice:
        _line2 = f"\U0001f4a1 {_EVO_INFO}{_advice}{R}"

else:
    # No proxy — self-tracked fallback. ALWAYS show evo feedback.
    _avatar = '\U0001f98a'
    _nick = 'EvoPet'
    _calls = _self.get('calls', 1)
    _line1_bits = [f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}"]

    # Context-based mood
    if _curr_ctx is not None and _curr_ctx > 0:
        if _curr_ctx >= 80:
            _mood = f"{_EVO_RED}{BOLD}\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u5727\u8feb! /compact \u3092\u691c\u8a0e\u3057\u3066{R}"
        elif _curr_ctx >= 60:
            _mood = f"{_EVO_WARN}\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u305d\u308d\u305d\u308d\u6ce8\u610f{R}"
        elif _curr_ctx >= 30:
            _mood = f"{_EVO_GREEN}\u9806\u8abf\u306b\u9032\u3093\u3067\u308b\u3088!{R}"
        else:
            _mood = f"{_EVO_GREEN}\u30bb\u30c3\u30b7\u30e7\u30f3\u958b\u59cb!{R}"
        _line1_bits.append(_mood)
    else:
        _line1_bits.append(f"{_EVO_GREEN}\u6307\u793a\u3092\u5f85\u3063\u3066\u308b\u3088!{R}")

    _line1_bits.append(f"{DIM}{_calls}\u56de\u76ee\u306e\u547c\u3073\u51fa\u3057{R}")

    # Rotate through tips
    _tip = _TIPS[_calls % len(_TIPS)]
    _th = _tip['headline']
    _tb = _tip.get('before')
    _ta = _tip.get('after')
    if _tb and _ta:
        _tb_d = _tb[:30] + '...' if len(_tb) > 30 else _tb
        _ta_d = _ta[:55] + '...' if len(_ta) > 55 else _ta
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}\n   {DIM}\u274c{R} {_EVO_RED}\"{_tb_d}\"{R} \u2192 {DIM}\u2705{R} {_EVO_GREEN}\"{_ta_d}\"{R}"
    else:
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}"

# Append evo lines to output
if _line1_bits:
    parts.append('\n' + SEP.join(_line1_bits))
if _line2:
    parts.append('\n' + _line2)

print(SEP.join(parts), end='')
