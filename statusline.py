#!/usr/bin/env python3
"""Evo v3.0 statusline — Always-on, self-tracking. Works with or without proxy."""
import json, sys, os, time
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
data = json.load(sys.stdin)
R = '\033[0m'
DIM = '\033[2m'
BOLD = '\033[1m'
CYAN = '\033[38;2;255;185;80m'
_SUBTLE = '\033[38;2;160;160;180m'

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

SEP = f' {_SUBTLE}\u00b7{R} '
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

# ══════════════════════════════════════════════════════════════
# EvoPet v3.0: Always-on — proxy data OR self-tracked fallback
# ══════════════════════════════════════════════════════════════

_EVO_ACCENT = '\033[38;2;180;130;255m'
_EVO_INFO   = '\033[38;2;100;200;255m'
_EVO_WARN   = '\033[38;2;255;200;80m'
_EVO_GREEN  = '\033[38;2;120;220;120m'
_EVO_RED    = '\033[38;2;255;100;100m'
_EVO_GOLD   = '\033[38;2;255;215;0m'

def _grade_color(g):
    return {'S': _EVO_ACCENT, 'A': _EVO_GREEN, 'B': _EVO_INFO, 'C': _EVO_WARN, 'D': _EVO_RED}.get(g, _EVO_INFO)

def _grade_label(g):
    return {
        'S': '\u2728S \u795e', 'A': '\u2b50A \u4e0a\u624b',
        'B': '\u25cf B \u826f\u597d', 'C': '\u25cb C \u3082\u3046\u4e00\u606f',
        'D': '\u25b3 D \u304c\u3093\u3070\u308d\u3046',
    }.get(g, g)

# ──────────────────────────────────────────────
# Line 1: EvoPet ひとこと（ムード/コメント）
#   ctx% + 呼び出し回数でローテーション
# ──────────────────────────────────────────────
_COMMENTS = {
    'start': [
        "\u6307\u793a\u3092\u5f85\u3063\u3066\u308b\u3088! \u30d5\u30a1\u30a4\u30eb\u540d\u3068\u300c\u4f55\u3092\u3057\u305f\u3044\u304b\u300d\u3092\u6559\u3048\u3066\u306d",
        "\u65b0\u3057\u3044\u30bb\u30c3\u30b7\u30e7\u30f3! \u4eca\u65e5\u3082\u5177\u4f53\u7684\u306a\u6307\u793a\u3067\u52b9\u7387\u3088\u304f\u3044\u3053\u3046",
        "\u6e96\u5099OK! \u300c\u3069\u306e\u30d5\u30a1\u30a4\u30eb\u306e\u4f55\u3092\u3069\u3046\u3057\u305f\u3044\u300d\u304c\u4f1d\u308f\u308b\u3068AI\u304c\u901f\u3044\u3088",
        "\u3088\u3046\u3053\u305d! \u6700\u521d\u306e\u6307\u793a\u304c\u4e00\u756a\u5927\u4e8b\u3060\u3088\u3002\u5177\u4f53\u7684\u306b\u3044\u3053\u3046",
        "\u30bb\u30c3\u30b7\u30e7\u30f3\u958b\u59cb! \u300c\u4f55\u3092\u30fb\u3069\u3053\u3092\u30fb\u3069\u3046\u306a\u308c\u3070OK\u300d\u3092\u610f\u8b58\u3057\u3066\u307f\u3066",
        "\u304a\u306f\u3088\u3046! \u30d5\u30a1\u30a4\u30eb\u540d\u30921\u3064\u66f8\u304f\u3060\u3051\u3067AI\u306e\u63a2\u7d22\u304c\u534a\u5206\u306b\u306a\u308b\u3088",
        "\u30b9\u30bf\u30fc\u30c8! \u30a8\u30e9\u30fc\u304c\u3042\u308b\u306a\u3089\u30e1\u30c3\u30bb\u30fc\u30b8\u3054\u3068\u8cbc\u308b\u306e\u304c\u6700\u901f\u3060\u3088",
        "\u3055\u3042\u59cb\u3081\u3088\u3046! \u7b87\u6761\u66f8\u304d\u3067\u6307\u793a\u3059\u308b\u3068AI\u304c\u898b\u843d\u3068\u3057\u306b\u304f\u3044\u3088",
    ],
    'early': [
        "\u9806\u8abf\u306b\u30b9\u30bf\u30fc\u30c8\u3057\u3066\u308b\u306d!",
        "\u3044\u3044\u611f\u3058! \u3053\u306e\u8abf\u5b50\u3067\u3044\u3053\u3046",
        "\u4f5c\u696d\u304c\u4e57\u3063\u3066\u304d\u305f\u306d!",
        "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u306b\u4f59\u88d5\u304c\u3042\u308b\u3046\u3061\u306b\u3001\u96e3\u3057\u3044\u30bf\u30b9\u30af\u3092\u7247\u4ed8\u3051\u3061\u3083\u304a\u3046",
        "\u307e\u3060\u307e\u3060\u5e8f\u76e4! \u4e00\u3064\u305a\u3064\u7740\u5b9f\u306b\u9032\u3081\u3088\u3046",
        "\u8abf\u5b50\u826f\u3055\u305d\u3046! \u5b8c\u4e86\u6761\u4ef6\u3092\u66f8\u3044\u3066\u304a\u304f\u3068\u3084\u308a\u76f4\u3057\u304c\u6e1b\u308b\u3088",
    ],
    'working': [
        "\u96c6\u4e2d\u3057\u3066\u308b\u306d\u3001\u3044\u3044\u30da\u30fc\u30b9!",
        "\u4e2d\u76e4\u6226! \u30bf\u30b9\u30af\u304c\u5909\u308f\u3063\u305f\u3089 /clear \u3082\u624b\u3060\u3088",
        "\u3088\u304f\u4f7f\u3063\u3066\u308b\u306d! \u5927\u304d\u3044\u30bf\u30b9\u30af\u306f\u5206\u5272\u3059\u308b\u3068\u7cbe\u5ea6\u304c\u4e0a\u304c\u308b\u3088",
        "\u9806\u8abf\u306b\u9032\u3093\u3067\u308b\u3088! \u6b21\u306e\u6307\u793a\u3082\u5177\u4f53\u7684\u306b\u3044\u3053\u3046",
        "\u534a\u5206\u304f\u3089\u3044\u4f7f\u3063\u305f\u306d\u3002\u30bf\u30b9\u30af\u5207\u308a\u66ff\u3048\u306a\u3089\u65b0\u30bb\u30c3\u30b7\u30e7\u30f3\u3082\u691c\u8a0e\u3057\u3066\u306d",
        "\u3044\u3044\u6d41\u308c! git commit \u3057\u3066\u304b\u3089\u5927\u304d\u306a\u5909\u66f4\u3092\u983c\u3080\u3068\u5b89\u5fc3\u3060\u3088",
        "\u4f5c\u696d\u4e2d... \u540c\u3058\u30a8\u30e9\u30fc\u304c\u7d9a\u304f\u306a\u3089\u30a2\u30d7\u30ed\u30fc\u30c1\u3092\u5909\u3048\u3066\u307f\u3066",
        "\u4e2d\u76e4\u3060\u306d\u3002\u300c\u3055\u3063\u304d\u306e\u65b9\u6cd5\u3060\u3068\u30c0\u30e1\u3060\u3063\u305f\u300d\u3063\u3066\u4f1d\u3048\u308b\u3068AI\u304c\u5225\u30eb\u30fc\u30c8\u63a2\u3059\u3088",
    ],
    'busy': [
        "ctx 60%\u8d85\u3048\u3002\u30bf\u30b9\u30af\u5207\u308a\u66ff\u3048\u306a\u3089 /clear \u3082\u624b\u3060\u3088",
        "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u305d\u308d\u305d\u308d\u6ce8\u610f\u3002\u5927\u304d\u306a\u30bf\u30b9\u30af\u306a\u3089 /compact \u3092\u691c\u8a0e",
        "\u30e1\u30e2\u30ea\u98df\u3063\u3066\u304d\u305f! \u5225\u30bf\u30b9\u30af\u306a\u3089\u65b0\u30bb\u30c3\u30b7\u30e7\u30f3\u304c\u5409",
        "\u5f8c\u534a\u6226\u3060\u306d\u3002\u91cd\u8981\u306a\u5909\u66f4\u306f\u65e9\u3081\u306b\u7247\u4ed8\u3051\u3088\u3046",
        "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u6d88\u8cbb\u304c\u5897\u3048\u3066\u304d\u305f\u3002\u5fdc\u7b54\u304c\u9045\u304f\u611f\u3058\u305f\u3089 /compact \u3060\u3088",
        "\u3082\u3046\u5c11\u3057\u3067\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u4e0a\u9650\u3002\u7d42\u308f\u308b\u524d\u306b commit \u3057\u3066\u304a\u3053\u3046",
    ],
    'critical': [
        "\u26a0\ufe0f ctx 80%\u8d85\u3048! /compact \u3067\u8efd\u304f\u3057\u3088\u3046",
        "\u26a0\ufe0f \u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u5727\u8feb! \u5fdc\u7b54\u304c\u9045\u304f\u306a\u308b\u304b\u3082\u3002/compact \u63a8\u5968",
        "\u26a0\ufe0f \u3082\u3046\u3059\u3050\u4e0a\u9650! \u5927\u4e8b\u306a\u4f5c\u696d\u306f\u65b0\u30bb\u30c3\u30b7\u30e7\u30f3\u3067\u3084\u308d\u3046",
        "\u26a0\ufe0f \u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u6b8b\u308a\u308f\u305a\u304b\u3002\u4eca\u306e\u3046\u3061\u306b /compact \u304b /clear \u3092!",
    ],
}

# ──────────────────────────────────────────────
# Line 2+3: Tips（💡ヘッドライン + ❌→✅例）
#   32 tips
# ──────────────────────────────────────────────
_TIPS = [
    # ── プロンプトの書き方（基本） ──
    {
        'headline': '\u300c\u4f55\u3092\u30fb\u3069\u3053\u3092\u30fb\u3069\u3046\u306a\u308c\u3070OK\u300d\u306e3\u70b9\u30bb\u30c3\u30c8\u3067\u4e00\u767a\u3067\u901a\u308b\u78ba\u7387\u304c\u8dc3\u306d\u4e0a\u304c\u308b!',
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
        'before': '\u30e6\u30fc\u30b6\u30fc\u767b\u9332\u3068\u30e1\u30fc\u30eb\u78ba\u8a8d\u3068\u30d1\u30b9\u30ef\u30fc\u30c9\u5236\u9650\u3092\u3064\u304f\u3063\u3066',
        'after': '\u30e6\u30fc\u30b6\u30fc\u767b\u9332\u6a5f\u80fd:\n- POST /register\n- \u30d1\u30b9\u30ef\u30fc\u30c98\u6587\u5b57\u4ee5\u4e0a\n- \u30c6\u30b9\u30c8\u3082\u66f8\u304f',
    },
    {
        'headline': '\u300c\u76f4\u3057\u3066\u300d\u3060\u3051\u3060\u3068\u3001AI\u306f\u63a8\u6e2c\u304b\u3089\u30b9\u30bf\u30fc\u30c8\u3057\u3061\u3083\u3046\u3088',
        'before': '\u306a\u3093\u304b\u30a8\u30e9\u30fc\u51fa\u308b\u3001\u76f4\u3057\u3066',
        'after': 'npm run build \u3067 TypeError: Cannot read property \'name\' of undefined \u3063\u3066\u51fa\u308b',
    },
    {
        'headline': '\u300c\u301c\u3057\u306a\u3044\u3067\u300d\u3063\u3066\u5236\u7d04\u3092\u4f1d\u3048\u308b\u306e\u3082\u5927\u4e8b! AI\u306e\u4f59\u8a08\u306a\u304a\u305b\u3063\u304b\u3044\u3092\u9632\u3052\u308b',
        'before': '\u30ea\u30d5\u30a1\u30af\u30bf\u3057\u3066',
        'after': 'src/api.ts \u306e fetchUser \u3092\u30ea\u30d5\u30a1\u30af\u30bf\u3002\u4ed6\u306e\u30d5\u30a1\u30a4\u30eb\u306f\u5909\u66f4\u3057\u306a\u3044\u3053\u3068',
    },
    {
        'headline': '\u5b8c\u4e86\u6761\u4ef6\u30921\u884c\u8db3\u3059\u3060\u3051\u3067\u3001\u3084\u308a\u76f4\u3057\u7387\u304c\u6fc0\u6e1b\u3059\u308b\u3088!',
        'before': '\u691c\u7d22\u6a5f\u80fd\u3092\u8ffd\u52a0\u3057\u3066',
        'after': '\u691c\u7d22\u6a5f\u80fd\u3092\u8ffd\u52a0\u3002\u5b8c\u4e86\u6761\u4ef6: \u4e00\u81f4\u3059\u308b\u7d50\u679c\u3060\u3051\u304c\u8868\u793a\u3055\u308c\u308b\u3053\u3068',
    },
    # ── デバッグのコツ ──
    {
        'headline': '\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u305d\u306e\u307e\u307e\u8cbc\u308b\u306e\u304c\u6700\u901f\u306e\u89e3\u6c7a\u6cd5! AI\u304c\u539f\u56e0\u306b\u76f4\u884c\u3067\u304d\u308b',
        'before': '\u52d5\u304b\u306a\u3044\u3093\u3060\u3051\u3069',
        'after': '\u3053\u306e\u30a8\u30e9\u30fc\u304c\u51fa\u308b:\nTypeError: Cannot read properties of undefined (reading \'map\')\n  at UserList.tsx:15',
    },
    {
        'headline': '\u300c\u3069\u3053\u307e\u3067\u52d5\u3044\u3066\u3069\u3053\u3067\u6b62\u307e\u308b\u300d\u3092\u4f1d\u3048\u308b\u3068\u3001\u30c7\u30d0\u30c3\u30b0\u304c\u7206\u901f\u306b\u306a\u308b\u3088',
        'before': '\u30dc\u30bf\u30f3\u304c\u52d5\u304b\u306a\u3044',
        'after': '\u30dc\u30bf\u30f3\u30af\u30ea\u30c3\u30af\u3067 handleSubmit \u306f\u547c\u3070\u308c\u308b\u304c\u3001fetch \u306e\u30ec\u30b9\u30dd\u30f3\u30b9\u304c 403 \u306b\u306a\u308b',
    },
    {
        'headline': '\u540c\u3058\u6307\u793a\u3092\u7e70\u308a\u8fd4\u3057\u3066\u3082\u540c\u3058\u7d50\u679c\u306b\u306a\u308b\u3060\u3051\u3002\u524d\u56de\u306e\u5931\u6557\u3092\u4f1d\u3048\u3088\u3046',
        'before': '(\u307e\u305f) \u76f4\u3057\u3066',
        'after': '\u3055\u3063\u304dnull\u30c1\u30a7\u30c3\u30af\u3092\u8a66\u3057\u305f\u3051\u3069\u30c0\u30e1\u3060\u3063\u305f\u3002\u578b\u81ea\u4f53\u3092Optional\u306b\u3059\u308b\u65b9\u5411\u3067',
    },
    {
        'headline': '\u300c\u30ed\u30b0\u51fa\u529b\u3092\u8db3\u3057\u3066\u300d\u3068\u983c\u3080\u3068\u3001\u6b21\u306e\u30c7\u30d0\u30c3\u30b0\u304c\u3081\u3061\u3083\u697d\u306b\u306a\u308b\u3088',
        'before': '\u539f\u56e0\u304c\u308f\u304b\u3089\u306a\u3044\u3001\u76f4\u3057\u3066',
        'after': 'processOrder \u306e\u5404\u30b9\u30c6\u30c3\u30d7\u306b console.log \u3092\u8db3\u3057\u3066\u3001\u3069\u3053\u3067\u6b62\u307e\u308b\u304b\u898b\u305b\u3066',
    },
    {
        'headline': '\u30b9\u30bf\u30c3\u30af\u30c8\u30ec\u30fc\u30b9\u306f\u300c\u5207\u308a\u53d6\u308b\u300d\u3088\u308a\u300c\u305d\u306e\u307e\u307e\u8cbc\u308b\u300d\u304c\u6b63\u89e3! \u884c\u756a\u53f7\u304cAI\u306e\u30d2\u30f3\u30c8\u306b\u306a\u308b',
        'before': '\u30a8\u30e9\u30fc\u304c\u51fa\u305f\u3002UserList\u304c\u60aa\u3044\u3063\u307d\u3044',
        'after': '\u3053\u306e\u30b9\u30bf\u30c3\u30af\u30c8\u30ec\u30fc\u30b9:\nError: ...\n  at UserList (src/UserList.tsx:15:23)',
    },
    # ── コード品質 ──
    {
        'headline': '\u300c\u30c6\u30b9\u30c8\u3082\u4e00\u7dd2\u306b\u66f8\u3044\u3066\u300d\u306e\u4e00\u8a00\u3067\u3001AI\u304c\u81ea\u5206\u3067\u54c1\u8cea\u30c1\u30a7\u30c3\u30af\u3057\u3066\u304f\u308c\u308b',
        'before': '\u30bd\u30fc\u30c8\u6a5f\u80fd\u3092\u8ffd\u52a0\u3057\u3066',
        'after': 'sortByDate \u95a2\u6570\u3092\u4f5c\u3063\u3066\u3002\u30c6\u30b9\u30c8\u3082\u66f8\u3044\u3066\u3001\u6607\u9806/\u964d\u9806\u4e21\u65b9\u30ab\u30d0\u30fc\u3059\u308b\u3053\u3068',
    },
    {
        'headline': '\u578b\u3092\u3057\u3063\u304b\u308a\u6307\u5b9a\u3059\u308b\u3068\u3001AI\u306e\u30b3\u30fc\u30c9\u88dc\u5b8c\u7cbe\u5ea6\u304c\u683c\u6bb5\u306b\u4e0a\u304c\u308b\u3088',
        'before': '\u30c7\u30fc\u30bf\u3092\u53d6\u5f97\u3059\u308b\u95a2\u6570\u3092\u4f5c\u3063\u3066',
        'after': 'User\u578b\u306e\u914d\u5217\u3092\u8fd4\u3059 fetchUsers(): Promise<User[]> \u3092\u4f5c\u3063\u3066\u3002User\u578b\u306f types.ts \u306b\u5b9a\u7fa9\u6e08\u307f',
    },
    {
        'headline': '\u300c\u4fee\u6b63\u5f8c\u306b npm test \u3092\u5b9f\u884c\u3057\u3066\u300d\u3068\u8db3\u3059\u3060\u3051\u3067\u3001\u58ca\u308c\u305f\u306e\u306b\u6c17\u3065\u304b\u306a\u3044\u4e8b\u6545\u3092\u9632\u3052\u308b',
        'before': '\u30d0\u30b0\u4fee\u6b63\u3057\u3066',
        'after': '\u30d0\u30b0\u4fee\u6b63\u3057\u3066\u3001\u4fee\u6b63\u5f8c\u306b npm test \u3092\u5b9f\u884c\u3057\u3066\u7d50\u679c\u3092\u898b\u305b\u3066',
    },
    {
        'headline': '\u8907\u6570\u30d5\u30a1\u30a4\u30eb\u306e\u5909\u66f4\u306f\u3001\u5148\u306b\u5f71\u97ff\u7bc4\u56f2\u3092\u805e\u3044\u3066\u304b\u3089\u983c\u3080\u3068\u5b89\u5168\u3060\u3088',
        'before': '\u3053\u306e\u30a4\u30f3\u30bf\u30fc\u30d5\u30a7\u30fc\u30b9\u3092\u5909\u66f4\u3057\u3066',
        'after': 'UserService \u306e\u30a4\u30f3\u30bf\u30fc\u30d5\u30a7\u30fc\u30b9\u3092\u5909\u3048\u305f\u3044\u3002\u307e\u305a\u3069\u306e\u30d5\u30a1\u30a4\u30eb\u304c\u5f71\u97ff\u53d7\u3051\u308b\u304b\u30ea\u30b9\u30c8\u3057\u3066',
    },
    # ── ワークフロー最適化 ──
    {
        'headline': '/clear \u3067\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u3092\u30ea\u30bb\u30c3\u30c8\u3059\u308b\u3068\u3001AI\u306e\u5fdc\u7b54\u304c\u901f\u304f\u306a\u308b\u3088!',
        'before': None,
        'after': None,
    },
    {
        'headline': 'CLAUDE.md \u306b\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u30eb\u30fc\u30eb\u3092\u66f8\u3044\u3066\u304a\u304f\u3068\u3001\u6bce\u56de\u8aac\u660e\u3057\u306a\u304f\u3066\u6e08\u3080!',
        'before': '\u6bce\u56de\u300cTypeScript\u3067\u66f8\u3044\u3066\u300d\u3068\u8a00\u3063\u3066\u308b',
        'after': 'CLAUDE.md \u306b\u300c\u8a00\u8a9e: TypeScript, \u30c6\u30b9\u30c8: vitest, \u30b9\u30bf\u30a4\u30eb: \u30bb\u30df\u30b3\u30ed\u30f3\u306a\u3057\u300d\u3068\u66f8\u3044\u3066\u304a\u304f',
    },
    {
        'headline': '\u5927\u304d\u306a\u30bf\u30b9\u30af\u306f\u5c0f\u3055\u304f\u5206\u5272! 1\u3064\u305a\u3064\u78ba\u8a8d\u3057\u306a\u304c\u3089\u9032\u3081\u308b\u3068\u624b\u623b\u308a\u304c\u6fc0\u6e1b\u3059\u308b\u3088',
        'before': 'EC\u30b5\u30a4\u30c8\u306e\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u3092\u5168\u90e8\u4f5c\u3063\u3066',
        'after': '\u307e\u305a\u5546\u54c1\u4e00\u89a7\u306e GET /products API \u3060\u3051\u4f5c\u3063\u3066\u3002DB\u306fSQLite\u3067\u3044\u3044',
    },
    {
        'headline': 'git commit \u3057\u3066\u304b\u3089\u5927\u304d\u306a\u5909\u66f4\u3092\u983c\u3080\u3068\u3001\u3044\u3064\u3067\u3082\u5dfb\u304d\u623b\u305b\u3066\u5b89\u5fc3\u3060\u3088',
        'before': '(\u5927\u304d\u306a\u30ea\u30d5\u30a1\u30af\u30bf\u3092\u3044\u304d\u306a\u308a\u983c\u3080)',
        'after': '\u307e\u305a git commit \u3057\u3066\u3002\u305d\u306e\u5f8c\u3001src/api.ts \u3092\u30ea\u30d5\u30a1\u30af\u30bf\u3057\u3066',
    },
    {
        'headline': '/compact \u3067\u4f1a\u8a71\u3092\u5727\u7e2e\u3059\u308b\u3068\u3001\u5fdc\u7b54\u901f\u5ea6\u304c\u6539\u5584\u3059\u308b\u3088\u3002ctx 50%\u8d85\u3048\u305f\u3089\u691c\u8a0e\u3057\u3066',
        'before': None,
        'after': None,
    },
    {
        'headline': '\u30bf\u30b9\u30af\u304c\u5909\u308f\u3063\u305f\u3089\u65b0\u30bb\u30c3\u30b7\u30e7\u30f3! \u904e\u53bb\u306e\u4f1a\u8a71\u304c\u90aa\u9b54\u3057\u3066\u7cbe\u5ea6\u304c\u4e0b\u304c\u308b\u3053\u3068\u304c\u3042\u308b\u3088',
        'before': '(\u524d\u306e\u30bf\u30b9\u30af\u306e\u4f1a\u8a71\u304c\u6b8b\u3063\u305f\u307e\u307e\u5225\u4f5c\u696d)',
        'after': '/clear \u3057\u3066\u304b\u3089\u65b0\u3057\u3044\u30bf\u30b9\u30af\u3092\u59cb\u3081\u308b\u3002\u307e\u305f\u306f\u65b0\u30bf\u30fc\u30df\u30ca\u30eb\u3067 claude \u8d77\u52d5',
    },
    # ── 上級者向け ──
    {
        'headline': 'AI\u306b\u300c\u306a\u305c\u305d\u3046\u3057\u305f\u304b\u300d\u3092\u805e\u304f\u3068\u3001\u30b3\u30fc\u30c9\u306e\u7406\u89e3\u304c\u6df1\u307e\u308b\u3057\u9593\u9055\u3044\u306b\u3082\u6c17\u3065\u304d\u3084\u3059\u3044\u3088',
        'before': None,
        'after': None,
    },
    {
        'headline': '\u884c\u756a\u53f7\u3084\u95a2\u6570\u540d\u3067\u7bc4\u56f2\u3092\u7d5e\u308b\u65b9\u304c\u3001\u300c\u30d5\u30a1\u30a4\u30eb\u5168\u90e8\u898b\u3066\u300d\u3088\u308a\u52b9\u7387\u7684!',
        'before': '\u3053\u306e\u30d5\u30a1\u30a4\u30eb\u5168\u90e8\u898b\u3066',
        'after': 'src/utils.ts \u306e 42\u884c\u76ee\u3042\u305f\u308a\u306e getUser \u95a2\u6570\u3092\u898b\u3066',
    },
    {
        'headline': '\u30c6\u30b9\u30c8\u3092\u5148\u306b\u66f8\u3044\u3066\u3082\u3089\u3046\u3068\u3001\u5b9f\u88c5\u306e\u54c1\u8cea\u304c\u30b0\u30f3\u3068\u4e0a\u304c\u308b (TDD)',
        'before': '\u30bd\u30fc\u30c8\u6a5f\u80fd\u3092\u8ffd\u52a0\u3057\u3066',
        'after': 'sortByDate \u95a2\u6570\u3092\u4f5c\u3063\u3066\u3002\u5148\u306b\u30c6\u30b9\u30c8\u3092\u66f8\u3044\u3066\u304b\u3089\u5b9f\u88c5\u3057\u3066',
    },
    {
        'headline': '\u300c\u539f\u56e0\u3092\u63a8\u6e2c\u3057\u3066\u3001\u307e\u3060\u76f4\u3055\u306a\u3044\u3067\u300d\u304c\u5b89\u5168\u306a\u30c7\u30d0\u30c3\u30b0\u6d41\u3060\u3088',
        'before': '\u3053\u308c\u76f4\u3057\u3066 (\u2192AI\u304c\u63a8\u6e2c\u3067\u76f4\u3057\u3066\u5225\u30d0\u30b0\u767a\u751f)',
        'after': '\u3053\u306e\u30a8\u30e9\u30fc\u306e\u539f\u56e0\u3092\u63a8\u6e2c\u3057\u3066\u3002\u307e\u3060\u30b3\u30fc\u30c9\u306f\u5909\u3048\u306a\u3044\u3067',
    },
    {
        'headline': '\u300c\u554f\u984c\u70b9\u3092\u6307\u6458\u3057\u3066\u300d\u3067AI\u306b\u30ec\u30d3\u30e5\u30fc\u3055\u305b\u308b\u3068\u3001\u30d0\u30b0\u4e88\u9632\u306b\u306a\u308b\u3088',
        'before': '(\u66f8\u3044\u305f\u30b3\u30fc\u30c9\u3092\u305d\u306e\u307e\u307e\u4f7f\u3046)',
        'after': '\u3053\u306e\u95a2\u6570\u306e\u30a8\u30c3\u30b8\u30b1\u30fc\u30b9\u3084\u30d0\u30b0\u306e\u53ef\u80fd\u6027\u3092\u6307\u6458\u3057\u3066',
    },
    {
        'headline': '\u300c\u3053\u306e\u30b3\u30fc\u30c9\u3092\u8aac\u660e\u3057\u3066\u300d\u306f\u5b66\u7fd2\u306b\u6700\u5f37\u3002\u7406\u89e3\u3092\u6df1\u3081\u308b\u306e\u306bAI\u3092\u4f7f\u304a\u3046',
        'before': None,
        'after': None,
    },
    # ── 初心者向け・励まし ──
    {
        'headline': '\u308f\u304b\u3089\u306a\u3044\u3053\u3068\u306f\u300c\u308f\u304b\u3089\u306a\u3044\u300d\u3067OK! \u5e73\u6613\u306a\u8a00\u3044\u65b9\u3067\u3082AI\u306f\u7406\u89e3\u3067\u304d\u308b\u3088',
        'before': None,
        'after': None,
    },
    {
        'headline': '\u300c\u4eca\u3053\u3046\u306a\u3063\u3066\u308b\u3001\u3053\u3046\u3057\u305f\u3044\u3001\u3067\u3082\u3053\u308c\u304c\u90aa\u9b54\u300d\u306e3\u70b9\u3092\u66f8\u3053\u3046',
        'before': '(\u4f55\u3092\u983c\u3081\u3070\u3044\u3044\u304b\u308f\u304b\u3089\u306a\u3044)',
        'after': '\u4eca\u30ed\u30b0\u30a4\u30f3\u753b\u9762\u3092\u4f5c\u3063\u3066\u308b\u3002OAuth\u3082\u5bfe\u5fdc\u3057\u305f\u3044\u304c\u3001\u307e\u305a\u30e1\u30fc\u30eb/\u30d1\u30b9\u30ef\u30fc\u30c9\u3060\u3051\u3067\u3044\u3044',
    },
    {
        'headline': '1\u3064\u306e\u6307\u793a\u30671\u3064\u306e\u3053\u3068\u3002\u6b32\u5f35\u308b\u3068\u5168\u90e8\u4e2d\u9014\u534a\u7aef\u306b\u306a\u308a\u304c\u3061\u3060\u3088',
        'before': '\u3042\u308c\u3082\u3053\u308c\u3082\u305d\u308c\u3082\u5168\u90e8\u3084\u3063\u3066',
        'after': '\u307e\u305a\u30ed\u30b0\u30a4\u30f3API\u3060\u3051\u4f5c\u3063\u3066\u3002\u78ba\u8a8d\u3067\u304d\u305f\u3089\u6b21\u306e\u6a5f\u80fd\u3092\u983c\u3080',
    },
    {
        'headline': '\u3053\u3053\u307e\u3067\u9806\u8abf! \u3044\u3044\u6307\u793a\u306e\u51fa\u3057\u65b9\u3092\u7d9a\u3051\u3066\u3044\u3053\u3046!',
        'before': None,
        'after': None,
    },
    {
        'headline': 'AI\u306f\u30da\u30a2\u30d7\u30ed\u306e\u30d1\u30fc\u30c8\u30ca\u30fc\u3002\u300c\u3069\u3046\u601d\u3046?\u300d\u3063\u3066\u76f8\u8ac7\u3059\u308b\u3068\u826f\u3044\u63d0\u6848\u304c\u51fa\u3084\u3059\u3044\u3088',
        'before': '\u3053\u308c\u3092\u3084\u308c (\u4e00\u65b9\u7684\u306a\u547d\u4ee4)',
        'after': '\u3053\u3046\u3044\u3046\u554f\u984c\u304c\u3042\u308b\u3093\u3060\u3051\u3069\u3001\u3069\u3046\u30a2\u30d7\u30ed\u30fc\u30c1\u3059\u308b\u306e\u304c\u3044\u3044\u3068\u601d\u3046?',
    },
    # ── Claude Code 公式ベストプラクティス (docs.anthropic.com) ──
    {
        'headline': '@\u30d5\u30a1\u30a4\u30eb\u540d \u3067\u30d5\u30a1\u30a4\u30eb\u5185\u5bb9\u3092\u76f4\u63a5\u6ce8\u5165\u3067\u304d\u308b\u3088\u3002AI\u304c\u63a2\u3059\u624b\u9593\u3068\u30c8\u30fc\u30af\u30f3\u3092\u7bc0\u7d04!',
        'before': 'src/utils/auth.js \u3092\u898b\u3066',
        'after': '@src/utils/auth.js \u3053\u306e\u30d5\u30a1\u30a4\u30eb\u306e validateToken \u3092\u4fee\u6b63\u3057\u3066',
    },
    {
        'headline': '2\u56de\u4fee\u6b63\u3057\u3066\u30c0\u30e1\u306a\u3089 /clear \u3057\u3066\u6700\u521d\u304b\u3089\u3002\u5931\u6557\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u304c\u90aa\u9b54\u3057\u3066\u308b\u304b\u3082',
        'before': '(\u540c\u3058\u30d0\u30b0\u306b3\u56de\u76ee\u306e\u4fee\u6b63\u6307\u793a)',
        'after': '/clear \u3057\u3066\u3001\u300c\u3055\u3063\u304d\u25cb\u25cb\u3068\u25b3\u25b3\u3092\u8a66\u3057\u305f\u304c\u30c0\u30e1\u3060\u3063\u305f\u3002\u5225\u306e\u30a2\u30d7\u30ed\u30fc\u30c1\u3067\u300d\u3068\u65b0\u898f\u6307\u793a',
    },
    {
        'headline': '/btw \u3067\u8074\u3044\u305f\u8cea\u554f\u306f\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u306b\u6b8b\u3089\u306a\u3044\u3088\u3002\u3061\u3087\u3063\u3068\u3057\u305f\u78ba\u8a8d\u306b\u4fbf\u5229!',
        'before': None,
        'after': None,
    },
    {
        'headline': 'Esc\u00d72 \u3067\u30ea\u30ef\u30a4\u30f3\u30c9! \u4efb\u610f\u306e\u6642\u70b9\u306b\u4f1a\u8a71\u3082\u30b3\u30fc\u30c9\u3082\u5dfb\u304d\u623b\u305b\u308b\u3088',
        'before': '(\u5931\u6557\u3057\u305f\u5909\u66f4\u3092\u624b\u52d5\u3067\u623b\u3059)',
        'after': 'Esc\u00d72 \u2192 \u30ea\u30ef\u30a4\u30f3\u30c9\u30e1\u30cb\u30e5\u30fc\u3067\u597d\u304d\u306a\u6642\u70b9\u306b\u5dfb\u304d\u623b\u3057',
    },
    {
        'headline': '\u5927\u304d\u306a\u6a5f\u80fd\u306e\u524d\u306b\u300cAI\u306b\u30a4\u30f3\u30bf\u30d3\u30e5\u30fc\u3055\u305b\u3066\u30b9\u30da\u30c3\u30af\u3092\u4f5c\u308b\u300d\u3068\u8a2d\u8a08\u6f0f\u308c\u304c\u6e1b\u308b\u3088',
        'before': '\u8a8d\u8a3c\u6a5f\u80fd\u3092\u4f5c\u3063\u3066',
        'after': '\u8a8d\u8a3c\u6a5f\u80fd\u3092\u4f5c\u308a\u305f\u3044\u3002\u307e\u305a\u8981\u4ef6\u3092\u30a4\u30f3\u30bf\u30d3\u30e5\u30fc\u3057\u3066SPEC.md\u306b\u307e\u3068\u3081\u3066',
    },
    {
        'headline': '\u5b9f\u88c5\u3068\u30ec\u30d3\u30e5\u30fc\u306f\u5225\u30bb\u30c3\u30b7\u30e7\u30f3\u3067! \u81ea\u5206\u306e\u30b3\u30fc\u30c9\u3078\u306e\u30d0\u30a4\u30a2\u30b9\u306a\u3057\u306b\u30c1\u30a7\u30c3\u30af\u3067\u304d\u308b',
        'before': '(\u66f8\u3044\u305f\u76f4\u5f8c\u306b\u540c\u3058\u30bb\u30c3\u30b7\u30e7\u30f3\u3067\u30ec\u30d3\u30e5\u30fc)',
        'after': '\u5b9f\u88c5\u5f8c\u3001\u65b0\u30bb\u30c3\u30b7\u30e7\u30f3\u3067 @src/middleware/auth.ts \u3092\u30ec\u30d3\u30e5\u30fc\u3002\u30a8\u30c3\u30b8\u30b1\u30fc\u30b9\u3068\u7af6\u5408\u3092\u78ba\u8a8d',
    },
    {
        'headline': '/effort low \u3067\u7c21\u5358\u306a\u30bf\u30b9\u30af\u3092\u9ad8\u901f\u5316\u3002\u8907\u96d1\u306a\u6642\u306f ultrathink \u3067\u6df1\u304f\u8003\u3048\u3055\u305b\u3088\u3046',
        'before': None,
        'after': None,
    },
    {
        'headline': 'claude --resume \u30bb\u30c3\u30b7\u30e7\u30f3\u540d \u3067\u524d\u56de\u306e\u4f5c\u696d\u306b\u5fa9\u5e30\u3067\u304d\u308b\u3088',
        'before': '(\u524d\u56de\u306e\u4f5c\u696d\u5185\u5bb9\u3092\u6700\u521d\u304b\u3089\u8aac\u660e\u3057\u76f4\u3059)',
        'after': 'claude --resume auth-refactor \u3067\u524d\u56de\u306e\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u3054\u3068\u5fa9\u5e30',
    },
    {
        'headline': '/compact \u306b\u300c\u4f55\u3092\u6b8b\u3059\u304b\u300d\u3092\u6307\u793a\u3067\u304d\u308b\u3088\u3002\u5927\u4e8b\u306a\u60c5\u5831\u304c\u5727\u7e2e\u3067\u6d88\u3048\u308b\u306e\u3092\u9632\u3052\u308b',
        'before': '/compact',
        'after': '/compact API\u306e\u5909\u66f4\u5185\u5bb9\u3068\u30c6\u30b9\u30c8\u30b3\u30de\u30f3\u30c9\u306f\u5fc5\u305a\u4fdd\u6301\u3057\u3066',
    },
    {
        'headline': 'CLAUDE.md \u306f200\u884c\u4ee5\u4e0b\u304c\u7406\u60f3\u3002\u8a73\u7d30\u306a\u624b\u9806\u306f .claude/skills/ \u306b\u5206\u96e2\u3057\u3088\u3046',
        'before': 'CLAUDE.md \u306bPR\u30ec\u30d3\u30e5\u30fc\u624b\u9806\u3001DB\u30de\u30a4\u30b0\u30ec\u3001API\u898f\u7d04\u3092\u5168\u90e8\u66f8\u304f',
        'after': '.claude/skills/pr-review/SKILL.md \u3084 .claude/skills/db-migrate/SKILL.md \u306b\u5206\u96e2',
    },
    {
        'headline': 'Hooks \u3067\u300c\u7de8\u96c6\u5f8c\u306b\u81ea\u52d5lint\u300d\u300c\u7279\u5b9a\u30d5\u30a9\u30eb\u30c0\u3078\u306e\u66f8\u304d\u8fbc\u307f\u30d6\u30ed\u30c3\u30af\u300d\u7b49\u3092\u78ba\u5b9f\u306b\u5b9f\u884c\u3067\u304d\u308b\u3088',
        'before': 'CLAUDE.md \u306b\u300c\u7de8\u96c6\u5f8c\u306f\u5fc5\u305aeslint\u3092\u5b9f\u884c\u3057\u3066\u300d\u3068\u66f8\u304f',
        'after': 'settings.json \u306e hooks.PostToolUse \u306b eslint \u81ea\u52d5\u5b9f\u884c\u3092\u8a2d\u5b9a',
    },
    {
        'headline': '--worktree \u3067\u4e26\u5217\u4f5c\u696d\u3092\u5b89\u5168\u306b! \u30d5\u30a1\u30a4\u30eb\u5909\u66f4\u304c\u885d\u7a81\u3057\u306a\u3044\u3088',
        'before': '(\u540c\u3058\u30d6\u30e9\u30f3\u30c1\u30672\u3064\u306e\u30bf\u30b9\u30af\u3092\u540c\u6642\u9032\u884c)',
        'after': 'claude --worktree feature-auth \u3067\u72ec\u7acb\u3057\u305f\u30ef\u30fc\u30af\u30c4\u30ea\u30fc\u3092\u81ea\u52d5\u4f5c\u6210',
    },
    {
        'headline': 'Ctrl+G \u3067\u30d7\u30e9\u30f3\u3092\u5916\u90e8\u30a8\u30c7\u30a3\u30bf\u3067\u7de8\u96c6\u3067\u304d\u308b\u3088\u3002\u8907\u96d1\u306a\u8a08\u753b\u306f\u30a8\u30c7\u30a3\u30bf\u3067\u7d30\u304b\u304f\u8abf\u6574\u3057\u3088\u3046',
        'before': None,
        'after': None,
    },
    {
        'headline': 'gh, aws, gcloud \u7b49\u306eCLI\u30c4\u30fc\u30eb\u306fMCP\u3088\u308a\u30c8\u30fc\u30af\u30f3\u52b9\u7387\u304c\u826f\u3044\u3088\u3002\u65e2\u5b58CLI\u304c\u3042\u308b\u306a\u3089\u305d\u3063\u3061\u3092\u4f7f\u304a\u3046',
        'before': 'GitHub MCP \u30b5\u30fc\u30d0\u30fc\u3092\u30bb\u30c3\u30c8\u30a2\u30c3\u30d7\u3057\u3066PR\u3092\u4f5c\u308b',
        'after': 'gh pr create \u3067\u76f4\u63a5PR\u3092\u4f5c\u308b (\u30c8\u30fc\u30af\u30f3\u7bc0\u7d04)',
    },
    # \u2500\u2500 \u30b7\u30e7\u30fc\u30c8\u30ab\u30c3\u30c8\u30fb\u64cd\u4f5c\u7cfb (Qiita \u8a18\u4e8b\u7531\u6765) \u2500\u2500
    {
        'headline': '!\u30b3\u30de\u30f3\u30c9 \u3067\u5b9f\u884c\u7d50\u679c\u304c\u305d\u306e\u307e\u307e\u4f1a\u8a71\u306b\u5165\u308b\u3088\u3002!git status \u3084 !npm test \u3067\u30c8\u30fc\u30af\u30f3\u7bc0\u7d04',
        'before': 'git status \u306e\u7d50\u679c\u3092\u8cbc\u308a\u4ed8\u3051\u3066\u300c\u3053\u308c\u3092\u898b\u3066\u300d',
        'after': '!git status \u3068\u6253\u3064\u3060\u3051\u3067AI\u304c\u7d50\u679c\u3092\u898b\u3066\u5224\u65ad\u3057\u3066\u304f\u308c\u308b',
    },
    {
        'headline': 'Ctrl+S \u3067\u66f8\u304d\u304b\u3051\u306e\u30d7\u30ed\u30f3\u30d7\u30c8\u3092\u4e00\u6642\u9000\u907f\u3002\u5272\u308a\u8fbc\u307f\u5bfe\u5fdc\u5f8c\u306b\u81ea\u52d5\u5fa9\u5e30\u3059\u308b\u3088',
        'before': None,
        'after': None,
    },
    {
        'headline': 'Ctrl+B \u3067\u9577\u6642\u9593\u51e6\u7406\u3092\u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9\u5b9f\u884c\u3002\u5f85\u305f\u305a\u306b\u6b21\u306e\u4f5c\u696d\u3078\u9032\u3081\u308b\u3088',
        'before': '(\u30c6\u30b9\u30c8\u5b9f\u884c\u4e2d\u306b\u5f85\u3061\u307c\u3046\u3051)',
        'after': 'Ctrl+B \u3067\u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9\u306b\u56de\u3057\u3066\u3001\u5225\u306e\u8cea\u554f\u3092\u6295\u3052\u308b',
    },
    {
        'headline': 'Ctrl+R \u3067\u904e\u53bb\u306b\u4f7f\u3063\u305f\u30d7\u30ed\u30f3\u30d7\u30c8\u3092\u691c\u7d22\u30fb\u518d\u5229\u7528\u3067\u304d\u308b\u3088\u3002\u540c\u3058\u6307\u793a\u306e\u518d\u5165\u529b\u4e0d\u8981!',
        'before': None,
        'after': None,
    },
    # \u2500\u2500 \u30bb\u30c3\u30b7\u30e7\u30f3\u30fb\u30e1\u30e2\u30ea\u7ba1\u7406 \u2500\u2500
    {
        'headline': '# \u30d7\u30ec\u30d5\u30a3\u30c3\u30af\u30b9\u3067\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u30e1\u30e2\u30ea\u306b\u5373\u6c38\u7d9a\u5316\u3002\u300c# \u30c6\u30b9\u30c8\u306f jest \u3067\u66f8\u304f\u3053\u3068\u300d\u306e\u3088\u3046\u306b\u4f7f\u3048\u308b\u3088',
        'before': '\u300c\u3053\u306e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3067\u306f jest \u4f7f\u3063\u3066\u300d\u3068\u6bce\u56de\u4f1d\u3048\u308b',
        'after': '# \u30c6\u30b9\u30c8\u306f\u5fc5\u305a jest \u3067\u66f8\u304f\u3053\u3068 \u2192 \u6b21\u56de\u304b\u3089\u81ea\u52d5\u3067\u899a\u3048\u3066\u308b',
    },
    {
        'headline': 'claude --continue \u3067\u30af\u30e9\u30c3\u30b7\u30e5\u3084\u8aa4\u7d42\u4e86\u304b\u3089\u4f5c\u696d\u5fa9\u5143\u3067\u304d\u308b\u3088\u3002\u4f5c\u696d\u304c\u6d88\u3048\u3066\u3082\u5b89\u5fc3',
        'before': None,
        'after': None,
    },
    {
        'headline': '/color blue \u3067\u30d7\u30ed\u30f3\u30d7\u30c8\u30d0\u30fc\u3092\u8272\u5206\u3051\u3002\u8907\u6570\u30a6\u30a3\u30f3\u30c9\u30a6\u3067\u3069\u308c\u304c\u3069\u306e\u30bf\u30b9\u30af\u304b\u4e00\u76ee\u3067\u308f\u304b\u308b!',
        'before': '(\u8907\u6570\u306eClaude\u30a6\u30a3\u30f3\u30c9\u30a6\u304c\u533a\u5225\u3064\u304b\u306a\u3044)',
        'after': '/color blue \u3067\u30d5\u30ed\u30f3\u30c8\u30a8\u30f3\u30c9\u3001/color green \u3067\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u3068\u5206\u3051\u308b',
    },
    # \u2500\u2500 \u81ea\u52d5\u5316\u30fb\u52b9\u7387\u5316 \u2500\u2500
    {
        'headline': '/loop 5m npm test \u3067\u5b9a\u671f\u5b9f\u884c\u3002\u30c6\u30b9\u30c8\u76e3\u8996\u3084\u30d3\u30eb\u30c9\u30c1\u30a7\u30c3\u30af\u306b\u4fbf\u5229\u3060\u3088',
        'before': '\u624b\u52d5\u3067\u5b9a\u671f\u7684\u306b npm test \u3092\u5b9f\u884c',
        'after': '/loop 5m npm test \u3067\u81ea\u52d5\u76e3\u8996\u3002\u5931\u6557\u3057\u305f\u3089\u3059\u3050\u6c17\u3065\u3051\u308b',
    },
    {
        'headline': '--bare \u30e2\u30fc\u30c9\u3067hooks\u30b9\u30ad\u30c3\u30d7\u6700\u901f\u8d77\u52d5\u3002CI/CD\u30d1\u30a4\u30d7\u30e9\u30a4\u30f3\u3084\u30d0\u30c3\u30c1\u51e6\u7406\u306b\u6700\u9069',
        'before': 'CI\u3067\u666e\u901a\u306b claude -p \u3092\u5b9f\u884c',
        'after': 'claude --bare -p "\u3053\u306ediff\u3092\u30ec\u30d3\u30e5\u30fc" --permission-mode auto < diff.patch',
    },
    {
        'headline': '/simplify \u3067\u300c\u518d\u5229\u7528\u30fb\u54c1\u8cea\u30fb\u52b9\u7387\u300d\u306e3\u89b3\u70b9\u3067\u4e26\u5217\u30ec\u30d3\u30e5\u30fc\u3002\u30b3\u30fc\u30c9\u54c1\u8cea\u3092\u7db2\u7f85\u7684\u306b\u30c1\u30a7\u30c3\u30af',
        'before': '\u300c\u30ec\u30d3\u30e5\u30fc\u3057\u3066\u300d\u3068\u3060\u3051\u983c\u3080',
        'after': '/simplify \u3067\u81ea\u52d5\u7684\u306b3\u30a8\u30fc\u30b8\u30a7\u30f3\u30c8\u304c\u4e26\u5217\u30c1\u30a7\u30c3\u30af',
    },
    {
        'headline': '/security-review \u3067\u5909\u66f4\u5185\u5bb9\u306e\u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u30b9\u30ad\u30e3\u30f3\u3002\u30de\u30fc\u30b8\u524d\u306b\u7fd2\u6163\u3065\u3051\u3088\u3046',
        'before': None,
        'after': None,
    },
    # \u2500\u2500 PR\u30fbGit \u30ef\u30fc\u30af\u30d5\u30ed\u30fc \u2500\u2500
    {
        'headline': '/commit-push-pr \u3067\u30b3\u30df\u30c3\u30c8\u2192push\u2192PR\u4f5c\u6210\u3092\u4e00\u6c17\u901a\u8cab! \u624b\u52d5\u30b9\u30c6\u30c3\u30d7\u3092\u307e\u308b\u3054\u3068\u7701\u7565',
        'before': 'git add . && git commit && git push && gh pr create \u3092\u624b\u52d5\u3067',
        'after': '/commit-push-pr \u3067\u30e1\u30c3\u30bb\u30fc\u30b8\u81ea\u52d5\u751f\u6210\u2192push\u2192PR\u4f5c\u6210\u307e\u3067\u4e00\u767a',
    },
    {
        'headline': '/pr-comments 142 \u3067GitHub PR\u306e\u30b3\u30e1\u30f3\u30c8\u3092\u53d6\u308a\u8fbc\u3093\u3067\u5bfe\u5fdc\u3067\u304d\u308b\u3088',
        'before': 'GitHub\u3067\u30b3\u30e1\u30f3\u30c8\u3092\u8aad\u3093\u3067\u624b\u52d5\u3067\u4fee\u6b63',
        'after': '/pr-comments 142 \u2192 \u30b3\u30e1\u30f3\u30c8\u5185\u5bb9\u3092\u898b\u3066\u305d\u306e\u307e\u307e\u4fee\u6b63\u2192\u518d push',
    },
    {
        'headline': 'claude --from-pr 142 \u3067PR\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u3092\u4fdd\u6301\u3057\u305f\u307e\u307e\u7fcc\u65e5\u7d99\u7d9a\u3067\u304d\u308b\u3088',
        'before': '\u6628\u65e5\u306ePR\u30ec\u30d3\u30e5\u30fc\u306e\u7d9a\u304d\u3092\u6700\u521d\u304b\u3089\u8aac\u660e\u3057\u76f4\u3059',
        'after': 'claude --from-pr 142 \u3067\u524d\u56de\u306ePR\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u3054\u3068\u5fa9\u5e30',
    },
    # \u2500\u2500 \u30ea\u30e2\u30fc\u30c8\u30fb\u30c1\u30fc\u30e0\u30fb\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb \u2500\u2500
    {
        'headline': '/teleport \u3067\u30c7\u30d0\u30a4\u30b9\u9593\u30bb\u30c3\u30b7\u30e7\u30f3\u5f15\u304d\u7d99\u304e\u3002PC\u2192\u30ce\u30fc\u30c8PC\u306e\u79fb\u52d5\u3082\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u4fdd\u6301',
        'before': '(\u5225PC\u3067\u540c\u3058\u4f5c\u696d\u3092\u6700\u521d\u304b\u3089\u3084\u308a\u76f4\u3059)',
        'after': '/teleport \u2192 \u5225\u7aef\u672b\u3067 claude --teleport \u3067\u5fa9\u5e30',
    },
    {
        'headline': '/schedule \u3067\u30af\u30e9\u30a6\u30c9\u5b9a\u671f\u5b9f\u884c\u3002\u300c\u6bce\u671d\u30c6\u30b9\u30c8\u5b9f\u884c\u2192Slack\u901a\u77e5\u300d\u306a\u3069\u81ea\u52d5\u5316\u3067\u304d\u308b\u3088',
        'before': '\u6bce\u671d\u624b\u52d5\u3067\u30c6\u30b9\u30c8\u3092\u5b9f\u884c\u3057\u3066\u7d50\u679c\u3092\u78ba\u8a8d',
        'after': '/schedule \u6bce\u671d9\u6642\u306b npm test \u3092\u5b9f\u884c\u3057\u3066Slack\u306b\u901a\u77e5\u3057\u3066',
    },
    {
        'headline': '/remote-control (/rc) \u3067\u30d6\u30e9\u30a6\u30b6\u304b\u3089\u30ea\u30e2\u30fc\u30c8\u64cd\u4f5c\u3002\u30b9\u30de\u30db\u304b\u3089\u3067\u3082\u4f5c\u696d\u7d99\u7d9a\u3067\u304d\u308b!',
        'before': None,
        'after': None,
    },
    {
        'headline': 'Agent Teams \u3067\u72ec\u7acb\u30bf\u30b9\u30af\u3092\u4e26\u5217\u5b9f\u884c\u3002\u30d5\u30ed\u30f3\u30c8\u3068\u30d0\u30c3\u30af\u3092\u540c\u6642\u306b\u9032\u3081\u3066\u958b\u767a\u901f\u5ea6\u500d\u5897',
        'before': '\u30d5\u30ed\u30f3\u30c8\u5b8c\u4e86\u2192\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u7740\u624b \u306e\u9806\u756a\u5f85\u3061',
        'after': 'Agent Teams \u3067\u30d5\u30ed\u30f3\u30c8\u3068\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u3092\u540c\u6642\u306b\u30a2\u30b5\u30a4\u30f3\u3057\u3066\u4e26\u5217\u5b9f\u884c',
    },
    {
        'headline': '/batch \u3067\u5927\u898f\u6a21\u4e26\u5217\u5909\u66f4\u3002worktree \u3067\u5b89\u5168\u306b\u8907\u6570\u30d5\u30a1\u30a4\u30eb\u3092\u540c\u6642\u306b\u5909\u63db\u3067\u304d\u308b\u3088',
        'before': 'for\u30eb\u30fc\u30d7\u30671\u30d5\u30a1\u30a4\u30eb\u305a\u3064\u5909\u63db',
        'after': '/batch "React\u304b\u3089Vue\u306b\u79fb\u884c" \u3067\u5bfe\u8c61\u30d5\u30a1\u30a4\u30eb\u3092\u4e26\u5217\u5909\u63db',
    },
]

# ══════════════════════════════════════════════════════════════
# Data source resolution: proxy > home fallback > self-tracking
# ══════════════════════════════════════════════════════════════
_evo = None
_evo_source = None
_now_ms = time.time() * 1000

# Staleness window: 60s. Fresh data renders normally; stale-but-recent (<=60s)
# renders in dim/gray with a marker so the user still sees last-known state
# instead of EvoPet silently disappearing.
_FRESH_WINDOW_MS = 60000
for _try_path in [
    os.path.join(cwd, '.evo', 'live-state.json'),
    os.path.join(os.path.expanduser('~'), '.claude', '.evo-live.json'),
]:
    try:
        with open(_try_path, encoding='utf-8') as _f:
            _candidate = json.load(_f)
        _age_ms = _now_ms - _candidate.get('updatedAt', 0)
        if _age_ms < _FRESH_WINDOW_MS:
            _evo = _candidate
            _evo_source = 'proxy' if _age_ms < 10000 else 'proxy_stale'
            break
    except Exception:
        pass

# ── Self-tracking state ──
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
_curr_ctx = ctx if ctx is not None else 0
_prev_ctx = _self.get('ctx_pct', 0)
_session_id = data.get('session_id', '') or data.get('sessionId', '')
_prev_session_id = _self.get('session_id', '')
# Reset on: cwd change, session_id change, or large context drop (signal of /clear).
# Note: a NEW session whose id differs from the persisted one must also reset,
# even when the persisted `_prev_session_id` was empty (first-ever run inherited
# state from a same-cwd prior session that pre-dates session_id tracking).
_session_reset = (
    _self.get('cwd') != cwd
    or (_session_id and _session_id != _prev_session_id)
    or (_prev_ctx > 30 and _curr_ctx < 5)
)
if not _self or _session_reset:
    _self = {'start': _now_s, 'calls': 0, 'tip_idx': _self.get('tip_idx', 0),
             'cwd': cwd, 'session_id': _session_id, 'last_prompt_hash': ''}
# Increment `calls` only when a NEW user message arrives. Claude Code re-renders
# the statusline many times per turn (token streams, tool calls, debounced
# permission changes, etc.); a naive per-render bump inflates the counter to
# dozens within a single user message.
#
# True signal: `transcript_path` is the JSONL conversation log (documented at
# https://code.claude.com/docs/en/statusline.md). Each user message appends
# at least one `"type":"user"` (or `"role":"user"`) entry. Counting those
# entries gives the real per-session conversation count regardless of how
# many times Claude Code re-renders.
#
# Performance: transcripts are typically <1MB; a single linear scan per render
# is acceptable. We also cache by (path, size) so unchanged transcripts skip
# the scan entirely.
def _count_user_messages(transcript_path, cache):
    if not transcript_path:
        return None
    try:
        st = os.stat(transcript_path)
    except OSError:
        return None
    cache_key = f"{transcript_path}:{st.st_size}:{int(st.st_mtime)}"
    if cache.get('transcript_cache_key') == cache_key:
        return cache.get('transcript_user_count')
    try:
        n = 0
        with open(transcript_path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"type":"user"' in line or '"role":"user"' in line:
                    n += 1
        cache['transcript_cache_key'] = cache_key
        cache['transcript_user_count'] = n
        return n
    except OSError:
        return None

_transcript_path = data.get('transcript_path') or ''
_user_msg_count = _count_user_messages(_transcript_path, _self)
if _user_msg_count is not None:
    _self['calls'] = _user_msg_count
elif _self.get('calls', 0) == 0:
    # No transcript_path available (legacy Claude Code or first render) →
    # at least show "1回目" so we don't render an empty counter.
    _self['calls'] = 1
# `tip_idx` rotates on every render so cosmetic tip cycling is independent of
# the (semantic) per-prompt `calls` counter. This keeps the visual variety the
# user expects without inflating the conversation count.
_self['tip_idx'] = (_self.get('tip_idx', 0) + 1) % 10000  # wrap to keep state file small
_self['last'] = _now_s
_self['ctx_pct'] = _curr_ctx
_self['session_id'] = _session_id
_save_self(_self)

# ── Build evo display ──
_line1_bits = []
_line2 = ""

# Suppress proxy data when no user message has been graded yet. The proxy's
# `.evo-live.json` is shared across sessions and carries cumulative state
# (sessionGrade/promptScore/advice/before/after) from the previous session,
# which is meaningless until the current session has its first graded turn.
#
# Only apply this when proxy actually provides `userMessages` (newer payloads).
# For legacy proxies that don't emit the field, fall through and let the
# downstream `turns` fallback handle display — otherwise we'd lose all
# grade/advice rendering for those installations.
if (_evo and _evo_source in ('proxy', 'proxy_stale')
        and 'userMessages' in _evo and _evo.get('userMessages', 0) == 0):
    _evo = None
    _evo_source = None

if _evo and _evo_source in ('proxy', 'proxy_stale'):
    # ═══ Full proxy data ═══
    _is_stale = _evo_source == 'proxy_stale'
    _avatar = _evo.get('avatar', '\U0001f423')
    _nick = _evo.get('nickname', 'EvoPet')
    _turns = _evo.get('turns', 0)
    _user_msgs = _evo.get('userMessages', 0)
    _bond = _evo.get('bond', 0)
    _isg = _evo.get('idealStateGauge', -1)
    _combo = _evo.get('comboCount', 0)
    _grade = _evo.get('sessionGrade', '')
    _ps = _evo.get('promptScore', 0)
    _signal = _evo.get('signalKind', '')
    _advice = _evo.get('advice', '')
    _detail = _evo.get('adviceDetail', '')
    _before = _evo.get('beforeExample', '')
    _after = _evo.get('afterExample', '')

    _gc = _grade_color(_grade)
    if _is_stale:
        # Stale fallback: render last-known state with a "(待機中)" marker.
        # Use a subtle (but readable) color rather than DIM, which is hard to see.
        _line1_bits = [f"{_SUBTLE}{_avatar} {_nick} (待機中){R}"]
    else:
        _line1_bits = [f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}"]

    if _grade:
        _line1_bits.append(f"{_gc}{BOLD}{_grade_label(_grade)}{R}")
    # Counter source: per-session self-tracked calls (resets on session_id / cwd change).
    # Proxy `userMessages` is preferred only if it equals or undershoots self.calls
    # (newer proxy builds are per-session-aware). `turns` is cumulative across sessions
    # and shows wrong values on fresh start.
    _self_calls = _self.get('calls', 1)
    # `+2` slack: tolerate a small lead from the proxy (it can record a
    # `userMessages` increment a render or two before the statusline sees the
    # matching prompt). Beyond that, fall back to the local per-session count
    # — proxy is likely emitting cumulative cross-session state.
    if 'userMessages' in _evo and _user_msgs <= _self_calls + 2:
        _conv_count = _user_msgs
    else:
        _conv_count = _self_calls
    if _conv_count > 0:
        _line1_bits.append(f"{BOLD}{_EVO_INFO}{_conv_count}\u56de\u76ee\u306e\u4f1a\u8a71{R}")
    if _ps > 0:
        if _ps >= 80:
            _line1_bits.append(f"\U0001f4dd {_EVO_GREEN}{BOLD}\u6307\u793a\u306e\u8cea: \u3068\u3066\u3082\u826f\u3044!{R}")
        elif _ps >= 60:
            _line1_bits.append(f"\U0001f4dd {_EVO_INFO}{BOLD}\u6307\u793a\u306e\u8cea: \u826f\u597d{R}")
        elif _ps >= 40:
            _line1_bits.append(f"\U0001f4dd {_EVO_WARN}{BOLD}\u6307\u793a\u306e\u8cea: \u3082\u3046\u5c11\u3057\u5177\u4f53\u7684\u306b{R}")
        else:
            _line1_bits.append(f"\U0001f4dd {_EVO_RED}{BOLD}\u6307\u793a\u306e\u8cea: \u66d6\u6627\u3059\u304e\u308b\u304b\u3082{R}")
    if _combo >= 3:
        _cc = _EVO_GOLD if _combo >= 10 else _EVO_ACCENT if _combo >= 5 else _EVO_GREEN
        _line1_bits.append(f"{_cc}{BOLD}{_combo}\u9023\u7d9a\u3044\u3044\u611f\u3058!{R}")
    # \u80b2\u6210\u5ea6: prefer Ideal State Gauge (quality-based) when available; -1 = no data yet.
    # Falls back to legacy stage-EXP bond only when ISG hasn't been emitted yet.
    if _isg >= 0:
        _line1_bits.append(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_isg}%{R}")
    elif _isg == -1:
        # No ISG data yet \u2014 render "-" per design (instead of fake 100).
        # Use subtle color rather than DIM so the placeholder is still readable.
        _line1_bits.append(f"{_SUBTLE}\u80b2\u6210\u5ea6 -{R}")
    elif _bond < 100:
        _line1_bits.append(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_bond}%{R}")

    if _signal and _signal in ('prompt_too_vague', 'same_file_revisit', 'same_function_revisit',
                                'scope_creep', 'no_success_criteria', 'approval_fatigue',
                                'error_spiral', 'retry_loop', 'high_tool_ratio'):
        if _before and _after:
            _b = _before[:30] + '...' if len(_before) > 30 else _before
            _a = _after[:55] + '...' if len(_after) > 55 else _after
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_a}\"{R}"
        elif _advice:
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice}{R}"
            if _detail:
                _line2 += f"\n   {BOLD}{_EVO_WARN}{_detail[:70]}{R}"
    elif _signal in ('good_structure', 'first_pass_success', 'improving_trend'):
        _line2 = f"\u2728 {_EVO_GREEN}{BOLD}{_advice}{R}"
        if _detail:
            _line2 += f"\n   {BOLD}{_EVO_GREEN}{_detail[:70]}{R}"
    elif _signal == 'tip' and _advice:
        if _before and _after:
            _b = _before[:30] + '...' if len(_before) > 30 else _before
            _a = _after[:55] + '...' if len(_after) > 55 else _after
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_a}\"{R}"
        else:
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice}{R}"
            if _detail:
                _line2 += f"\n   {BOLD}{_EVO_INFO}{_detail[:80]}{R}"
    elif _advice:
        _line2 = f"\U0001f4a1 {BOLD}{_EVO_INFO}{_advice}{R}"

else:
    # ═══ No proxy — self-tracked fallback ═══
    _avatar = '\U0001f98a'
    _nick = 'EvoPet'
    _calls = _self.get('calls', 1)
    _line1_bits = [f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}"]

    # Pick comment based on ctx bracket + render rotation (tip_idx rotates per
    # render, so cosmetic copy varies even when the conversation count holds
    # steady within a single user turn).
    _ridx = _self.get('tip_idx', _calls)
    if _curr_ctx >= 80:
        _pool = _COMMENTS['critical']
    elif _curr_ctx >= 60:
        _pool = _COMMENTS['busy']
    elif _curr_ctx >= 30:
        _pool = _COMMENTS['working']
    elif _curr_ctx >= 10:
        _pool = _COMMENTS['early']
    else:
        _pool = _COMMENTS['start']

    _comment = _pool[_ridx % len(_pool)]

    if _curr_ctx >= 80:
        _line1_bits.append(f"{_EVO_RED}{BOLD}{_comment}{R}")
    elif _curr_ctx >= 60:
        _line1_bits.append(f"{BOLD}{_EVO_WARN}{_comment}{R}")
    else:
        _line1_bits.append(f"{BOLD}{_EVO_GREEN}{_comment}{R}")

    _line1_bits.append(f"{BOLD}{_EVO_INFO}{_calls}\u56de\u76ee{R}")

    # Tip rotation — keyed on render index so tips cycle even within a single turn
    _tip = _TIPS[_ridx % len(_TIPS)]
    _th = _tip['headline']
    _tb = _tip.get('before')
    _ta = _tip.get('after')
    if _tb and _ta:
        _tb_d = _tb[:30] + '...' if len(_tb) > 30 else _tb
        _ta_d = _ta[:55] + '...' if len(_ta) > 55 else _ta
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_tb_d}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_ta_d}\"{R}"
    else:
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}"

if _line1_bits:
    parts.append('\n' + SEP.join(_line1_bits))
if _line2:
    parts.append('\n' + _line2)

print(SEP.join(parts), end='')
