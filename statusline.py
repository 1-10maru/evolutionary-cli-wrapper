#!/usr/bin/env python3
"""Evo v3.0 statusline — Always-on, self-tracking. Works with or without proxy."""
import json, sys, os, time
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
    # \u2500\u2500 Claude Code \u516c\u5f0f\u30d9\u30b9\u30c8\u30d7\u30e9\u30af\u30c6\u30a3\u30b9 (auto-synced from code.claude.com) \u2500\u2500
    # AUTO-GENERATED:START source=https://code.claude.com/docs/en/best-practices fetched=2026-05-01
    {'headline': 'Claude Code on the web', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Claude Code on desktop', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Reference files with `@`** instead of describing where code lives. Claude reads the file before responding.', 'tier': 1, 'category': 'specificity', 'before': None, 'after': None},
    {'headline': '**Paste images directly**. Copy/paste or drag and drop images into the prompt.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Give URLs** for documentation and API references. Use `/permissions` to allowlist frequently-used domains.', 'tier': 1, 'category': 'permissions', 'before': None, 'after': None},
    {'headline': '**Pipe in data** by running `cat error.log | claude` to send file contents directly.', 'tier': 2, 'category': 'recovery', 'before': None, 'after': None},
    {'headline': '**Let Claude fetch what it needs**. Tell Claude to pull context itself using Bash commands, MCP tools, or by reading files.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': 'Use ES modules (import/export) syntax, not CommonJS (require)', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Destructure imports when possible (eg. import { foo } from \'bar\')', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Be sure to typecheck when you\'re done making a series of code changes', 'tier': 2, 'category': 'verification', 'before': None, 'after': None},
    {'headline': 'Prefer running single tests, and not the whole test suite, for performance', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': 'Git workflow: @docs/git-instructions.md', 'tier': 1, 'category': 'specificity', 'before': None, 'after': None},
    {'headline': 'Personal overrides: @~/.claude/my-project-instructions.md', 'tier': 1, 'category': 'specificity', 'before': None, 'after': None},
    {'headline': '**Home folder (`~/.claude/CLAUDE.md`)**: applies to all Claude sessions', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Project root (`./CLAUDE.md`)**: check into git to share with your team', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '**Project root (`./CLAUDE.local.md`)**: personal project-specific notes; add this file to your `.gitignore` so it isn’t shared with your team', 'tier': 1, 'category': 'specificity', 'before': None, 'after': None},
    {'headline': '**Parent directories**: useful for monorepos where both `root/CLAUDE.md` and `root/foo/CLAUDE.md` are pulled in automatically', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Child directories**: Claude pulls in child CLAUDE.md files on demand when working with files in those directories', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Auto mode**: a separate classifier model reviews commands and blocks only what looks risky: scope escalation, unknown infrastructure, or hostile-content-driven actions. Best when you trust the general direction of a task but don’t want to click through every step', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**Permission allowlists**: permit specific tools you know are safe, like `npm run lint` or `git commit`', 'tier': 1, 'category': 'specificity', 'before': None, 'after': None},
    {'headline': '**Sandboxing**: enable OS-level isolation that restricts filesystem and network access, allowing Claude to work more freely within defined boundaries', 'tier': 2, 'category': 'permissions', 'before': None, 'after': None},
    {'headline': 'Use kebab-case for URL paths', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Use camelCase for JSON properties', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Always include pagination for list endpoints', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Version APIs in the URL path (/v1/, /v2/)', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Injection vulnerabilities (SQL, XSS, command injection)', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Authentication and authorization flaws', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Secrets or credentials in code', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Insecure data handling', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'How does logging work?', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'How do I make a new API endpoint?', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'What does `async move { ... }` do on line 134 of `foo.rs`?', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'What edge cases does `CustomerOnboardingFlowImpl` handle?', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': 'Why does this code call `foo()` instead of `bar()` on line 333?', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**`Esc`**: stop Claude mid-action with the `Esc` key. Context is preserved, so you can redirect.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '**`Esc + Esc` or `/rewind`**: press `Esc` twice or run `/rewind` to open the rewind menu and restore previous conversation and code state, or summarize from a selected message.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**`"Undo that"`**: have Claude revert its changes.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**`/clear`**: reset context between unrelated tasks. Long sessions with irrelevant context can reduce performance.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': 'Use `/clear` frequently between tasks to reset the context window entirely', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': 'When auto compaction triggers, Claude summarizes what matters most, including code patterns, file states, and key decisions', 'tier': 2, 'category': 'context', 'before': None, 'after': None},
    {'headline': 'For more control, run `/compact <instructions>`, like `/compact Focus on the API changes`', 'tier': 2, 'category': 'context', 'before': None, 'after': None},
    {'headline': 'To compact only part of the conversation, use `Esc + Esc` or `/rewind`, select a message checkpoint, and choose **Summarize from here**. This condenses messages from that point forward while keeping earlier context intact.', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': 'Customize compaction behavior in CLAUDE.md with instructions like `"When compacting, always preserve the full list of modified files and any test commands"` to ensure critical context survives summarization', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': 'For quick questions that don’t need to stay in context, use [`/btw`](/docs/en/interactive-mode#side-questions-with-%2Fbtw). The answer appears in a dismissible overlay and never enters conversation history, so you can check a detail without growing context.', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '[Claude Code desktop app](/docs/en/desktop#work-in-parallel-with-sessions): Manage multiple local sessions visually. Each session gets its own isolated worktree.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '[Claude Code on the web](/docs/en/claude-code-on-the-web): Run on Anthropic’s secure cloud infrastructure in isolated VMs.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '[Agent teams](/docs/en/agent-teams): Automated coordination of multiple sessions with shared tasks, messaging, and a team lead.', 'tier': 2, 'category': 'exploration', 'before': None, 'after': None},
    {'headline': '**The kitchen sink session.** You start with one task, then ask Claude something unrelated, then go back to the first task. Context is full of irrelevant information.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '**Correcting over and over.** Claude does something wrong, you correct it, it’s still wrong, you correct again. Context is polluted with failed approaches.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '**The over-specified CLAUDE.md.** If your CLAUDE.md is too long, Claude ignores half of it because important rules get lost in the noise.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '**The trust-then-verify gap.** Claude produces a plausible-looking implementation that doesn’t handle edge cases.', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '**The infinite exploration.** You ask Claude to “investigate” something without scoping it. Claude reads hundreds of files, filling the context.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '[How Claude Code works](/docs/en/how-claude-code-works): the agentic loop, tools, and context management', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '[Extend Claude Code](/docs/en/features-overview): skills, hooks, MCP, subagents, and plugins', 'tier': 1, 'category': 'exploration', 'before': None, 'after': None},
    {'headline': '[Common workflows](/docs/en/common-workflows): step-by-step recipes for debugging, testing, PRs, and more', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '[CLAUDE.md](/docs/en/memory): store project conventions and persistent context', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    # AUTO-GENERATED:END

    # \u2500\u2500 Claude Code \u516c\u5f0f\u30b9\u30e9\u30c3\u30b7\u30e5\u30b3\u30de\u30f3\u30c9 (auto-synced from docs.claude.com) \u2500\u2500
    # AUTO-GENERATED:START source=https://code.claude.com/docs/en/commands fetched=2026-05-01
    {'headline': '/add-dir — Add a working directory for file access during the current session.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/agents — Manage agent configurations', 'tier': 1, 'category': 'permissions', 'before': None, 'after': None},
    {'headline': '/autofix-pr — Spawn a Claude Code on the web session that watches the current branch’s PR and pushes fixes when CI fails or reviewers leave comments.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/batch — Orchestrate large-scale changes across a codebase in parallel.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/branch — Create a branch of the current conversation at this point.', 'tier': 2, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '/btw — Ask a quick side question without adding to the conversation', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/chrome — Configure Claude in Chrome settings', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/claude-api — Load Claude API reference material for your project’s language (Python, TypeScript, Java, Go, Ruby, C#, PHP, or cURL) and Managed Agents reference.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/clear — Start a new conversation with empty context.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '/color — Set the prompt bar color for the current session.', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/compact — Free up context by summarizing the conversation so far.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '/config — Open the Settings interface to adjust theme, model, output style, and other preferences.', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/context — Visualize current context usage as a colored grid.', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '/copy — Copy the last assistant response to clipboard.', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/cost — Alias for /usage', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/debug — Enable debug logging for the current session and troubleshoot issues by reading the session debug log.', 'tier': 3, 'category': 'recovery', 'before': None, 'after': None},
    {'headline': '/desktop — Continue the current session in the Claude Code Desktop app.', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/diff — Open an interactive diff viewer showing uncommitted changes and per-turn diffs.', 'tier': 2, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '/doctor — Diagnose and verify your Claude Code installation and settings.', 'tier': 3, 'category': 'recovery', 'before': None, 'after': None},
    {'headline': '/effort — Set the model effort level.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/exit — Exit the CLI.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/export — Export the current conversation as plain text.', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/extra-usage — Configure extra usage to keep working when rate limits are hit', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/fast — Toggle fast mode on or off', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/feedback — Submit feedback about Claude Code.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/fewer-permission-prompts — Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts', 'tier': 3, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/focus — Toggle the focus view, which shows only your last prompt, a one-line tool-call summary with edit diffstats, and the final response.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/heapdump — Write a JavaScript heap snapshot and a memory breakdown to ~/Desktop, or your home directory on Linux without a Desktop folder, for diagnosing high memory usage.', 'tier': 3, 'category': 'recovery', 'before': None, 'after': None},
    {'headline': '/help — Show help and available commands', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/hooks — View hook configurations for tool events', 'tier': 1, 'category': 'permissions', 'before': None, 'after': None},
    {'headline': '/ide — Manage IDE integrations and show status', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/init — Initialize project with a CLAUDE.md guide.', 'tier': 1, 'category': 'exploration', 'before': None, 'after': None},
    {'headline': '/insights — Generate a report analyzing your Claude Code sessions, including project areas, interaction patterns, and friction points', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/install-github-app — Set up the Claude GitHub Actions app for a repository.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/install-slack-app — Install the Claude Slack app.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/keybindings — Open or create your keybindings configuration file', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/login — Sign in to your Anthropic account', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/logout — Sign out from your Anthropic account', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/loop — Run a prompt repeatedly while the session stays open.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/mcp — Manage MCP server connections and OAuth authentication', 'tier': 1, 'category': 'exploration', 'before': None, 'after': None},
    {'headline': '/memory — Edit CLAUDE.md memory files, enable or disable auto-memory, and view auto-memory entries', 'tier': 1, 'category': 'context', 'before': None, 'after': None},
    {'headline': '/mobile — Show QR code to download the Claude mobile app.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/model — Select or change the AI model.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/passes — Share a free week of Claude Code with friends.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/permissions — Manage allow, ask, and deny rules for tool permissions.', 'tier': 1, 'category': 'permissions', 'before': None, 'after': None},
    {'headline': '/plan — Enter plan mode directly from the prompt.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/plugin — Manage Claude Code plugins', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/powerup — Discover Claude Code features through quick interactive lessons with animated demos', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/pr-comments — Removed in v2.1.91.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/privacy-settings — View and update your privacy settings.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/recap — Generate a one-line summary of the current session on demand.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/release-notes — View the changelog in an interactive version picker.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/reload-plugins — Reload all active plugins to apply pending changes without restarting.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/remote-control — Make this session available for remote control from claude.ai.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/remote-env — Configure the default remote environment for web sessions started with --remote', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/rename — Rename the current session and show the name on the prompt bar.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/resume — Resume a conversation by ID or name, or open the session picker.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/review — Review a pull request locally in your current session.', 'tier': 1, 'category': 'verification', 'before': None, 'after': None},
    {'headline': '/rewind — Rewind the conversation and/or code to a previous point, or summarize from a selected message.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/sandbox — Toggle sandbox mode.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/schedule — Create, update, list, or run routines.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/security-review — Analyze pending changes on the current branch for security vulnerabilities.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/setup-bedrock — Configure Amazon Bedrock authentication, region, and model pins through an interactive wizard.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/setup-vertex — Configure Google Vertex AI authentication, project, region, and model pins through an interactive wizard.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/simplify — Review your recently changed files for code reuse, quality, and efficiency issues, then fix them.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/skills — List available skills.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/stats — Alias for /usage.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/status — Open the Settings interface (Status tab) showing version, model, account, and connectivity.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/statusline — Configure Claude Code’s status line.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/stickers — Order Claude Code stickers', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/tasks — List and manage background tasks.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/team-onboarding — Generate a team onboarding guide from your Claude Code usage history.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/teleport — Pull a Claude Code on the web session into this terminal: opens a picker, then fetches the branch and conversation.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/terminal-setup — Configure terminal keybindings for Shift+Enter and other shortcuts.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/theme — Change the color theme.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/tui — Set the terminal UI renderer and relaunch into it with your conversation intact.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/ultraplan — Draft a plan in an ultraplan session, review it in your browser, then execute remotely or send it back to your terminal', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/ultrareview — Run a deep, multi-agent code review in a cloud sandbox with ultrareview.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/upgrade — Open the upgrade page to switch to a higher plan tier', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/usage — Show session cost, plan usage limits, and activity stats.', 'tier': 1, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/vim — Removed in v2.1.92.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/voice — Toggle voice dictation, or enable it in a specific mode.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    {'headline': '/web-setup — Connect your GitHub account to Claude Code on the web using your local gh CLI credentials.', 'tier': 2, 'category': 'general', 'before': None, 'after': None},
    # AUTO-GENERATED:END
]

# ─── Tier-weighted rotation (v3.0.0) ───
# Tier 1 (core daily-use) appears 5x, Tier 2 (default) 2x, Tier 3 (niche) 1x.
# Tips without an explicit 'tier' key default to Tier 2 (forward-compat for
# legacy hand-written entries above the AUTO-GENERATED blocks).
_TIER_WEIGHTS = {1: 5, 2: 2, 3: 1}


def _build_rotation(tips):
    rotation = []
    for tip in tips:
        weight = _TIER_WEIGHTS.get(tip.get('tier', 2), 2)
        rotation.extend([tip] * weight)
    return rotation


_TIPS_ROTATION = _build_rotation(_TIPS)

# v3.1: Signal-to-category mapping. When proxy emits a known signalKind, we
# filter the tip rotation down to entries with the matching category so the
# advice the user sees is contextually relevant instead of randomly rotated.
_SIGNAL_TO_CATEGORY = {
    'prompt_too_vague': 'specificity',
    'no_success_criteria': 'verification',
    'same_file_revisit': 'exploration',
    'same_function_revisit': 'exploration',
    'error_spiral': 'recovery',
    'retry_loop': 'recovery',
    'scope_creep': 'specificity',
    'approval_fatigue': 'permissions',
    'high_tool_ratio': 'exploration',
}


def _band(ctx_pct):
    """v3.1: 5-band ctx mood selector used in both proxy-active and fallback paths."""
    if ctx_pct >= 80:
        return 'critical'
    if ctx_pct >= 60:
        return 'busy'
    if ctx_pct >= 30:
        return 'working'
    if ctx_pct >= 10:
        return 'early'
    return 'start'


def _pick_tip(tips_rotation, calls, signal):
    """v3.1: filter tips by signal->category when possible; fall back to full
    rotation when no entries match (legacy hand-written tips have no category)."""
    target_cat = _SIGNAL_TO_CATEGORY.get(signal) if signal else None
    if target_cat:
        filtered = [t for t in tips_rotation if t.get('category') == target_cat]
        pool = filtered if filtered else tips_rotation
    else:
        pool = tips_rotation
    return pool[calls % len(pool)] if pool else None

# ══════════════════════════════════════════════════════════════
# Data source resolution: proxy > home fallback > self-tracking
# ══════════════════════════════════════════════════════════════
_evo = None
_evo_source = None
_now_ms = time.time() * 1000

# Staleness window: 5 minutes (v3.3.0). Proxy now heartbeats every 10s so this
# is mainly belt-and-suspenders for very long tool calls (the proxy could be
# blocked on subprocess I/O even with heartbeat). Fresh data renders normally;
# stale-but-recent (<=5min) renders in dim/gray with the full layout preserved
# so the user still sees last-known state instead of EvoPet collapsing.
_FRESH_WINDOW_MS = 300000  # 5 minutes
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
# v3.1: dropped the `_prev_ctx > 30 and _curr_ctx < 5` heuristic — it fires on
# benign auto-compact context drops and was resetting the conversation counter
# mid-session. Reset now triggers only on cwd change.
_session_reset = _self.get('cwd') != cwd
if not _self or _session_reset:
    _self = {'start': _now_s, 'calls': 0, 'tip_idx': _self.get('tip_idx', 0), 'cwd': cwd}
_self['calls'] = _self.get('calls', 0) + 1
_self['last'] = _now_s
_self['ctx_pct'] = _curr_ctx
# v3.1: signal persistence is updated below after we read _evo (proxy may
# overwrite it). Last-known signal lets the fallback path keep filtering
# tips by the most recent category for a few cycles.
_save_self(_self)

# ── Build evo display ──
_line1_bits = []
_line2 = ""

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

    # v3.3.0: stale path now preserves the FULL layout (grade / 回目 / 指示の質
    # / 育成度 / mood / line2) and only dims the colors via a DIM SGR wrapper.
    # Previously the stale branch collapsed line1 to avatar-only, which made
    # the user feel "EvoPet disappeared during long tool execution".
    def _dim_if_stale(s: str) -> str:
        return f"{DIM}{s}{R}" if _is_stale else s

    _line1_bits = [_dim_if_stale(f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}")]

    if _grade:
        _line1_bits.append(_dim_if_stale(f"{_gc}{BOLD}{_grade_label(_grade)}{R}"))
    # Counter source: userMessages (real human-sent count) when proxy provides the field,
    # else fall back to turns (legacy total-events count) for old proxy builds.
    _conv_count = _user_msgs if 'userMessages' in _evo else _turns
    if _conv_count > 0:
        _line1_bits.append(_dim_if_stale(f"{BOLD}{_EVO_INFO}{_conv_count}\u56de\u76ee\u306e\u4f1a\u8a71{R}"))
    if _ps > 0:
        if _ps >= 80:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_GREEN}{BOLD}\u6307\u793a\u306e\u8cea: \u3068\u3066\u3082\u826f\u3044!{R}"))
        elif _ps >= 60:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_INFO}{BOLD}\u6307\u793a\u306e\u8cea: \u826f\u597d{R}"))
        elif _ps >= 40:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_WARN}{BOLD}\u6307\u793a\u306e\u8cea: \u3082\u3046\u5c11\u3057\u5177\u4f53\u7684\u306b{R}"))
        else:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_RED}{BOLD}\u6307\u793a\u306e\u8cea: \u66d6\u6627\u3059\u304e\u308b\u304b\u3082{R}"))
    if _combo >= 3:
        _cc = _EVO_GOLD if _combo >= 10 else _EVO_ACCENT if _combo >= 5 else _EVO_GREEN
        _line1_bits.append(_dim_if_stale(f"{_cc}{BOLD}{_combo}\u9023\u7d9a\u3044\u3044\u611f\u3058!{R}"))
    # \u80b2\u6210\u5ea6: prefer Ideal State Gauge (quality-based) when available; -1 = no data yet.
    # Falls back to legacy stage-EXP bond only when ISG hasn't been emitted yet.
    if _isg >= 0:
        _line1_bits.append(_dim_if_stale(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_isg}%{R}"))
    elif _isg == -1:
        # No ISG data yet \u2014 render "-" per design (instead of fake 100).
        _line1_bits.append(f"{DIM}\u80b2\u6210\u5ea6 -{R}")
    elif _bond < 100:
        _line1_bits.append(_dim_if_stale(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_bond}%{R}"))

    # v3.3.0: append "(\u5f85\u6a5f\u4e2d)" suffix as the LAST chip on line 1 when stale,
    # so the user sees "lagging" indicator without losing any of the data.
    if _is_stale:
        _line1_bits.append(f"{DIM}(\u5f85\u6a5f\u4e2d){R}")

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

    # v3.1: 5-band mood comment now appears in the proxy-active path too,
    # but only when no advice line is present (avoids info overload). Dim
    # color keeps it subordinate to the grade / 回目 emphasis.
    if not _line2:
        _calls = _self.get('calls', 1)
        _mood_pool = _COMMENTS[_band(_curr_ctx)]
        _mood = _mood_pool[_calls % len(_mood_pool)]
        _line1_bits.append(f"{DIM}{_mood}{R}")

    # v3.1: persist most recent signal so the lightweight fallback can
    # prefer the same category for a few cycles after the proxy goes idle.
    if _signal:
        _self['last_signal'] = _signal
        _save_self(_self)

else:
    # ═══ No proxy — self-tracked fallback ═══
    _avatar = '\U0001f98a'
    _nick = 'EvoPet'
    _calls = _self.get('calls', 1)
    _line1_bits = [f"{_avatar} {BOLD}{_EVO_ACCENT}{_nick}{R}"]

    # Pick comment based on 5-band ctx bracket + call count rotation
    _pool = _COMMENTS[_band(_curr_ctx)]

    _comment = _pool[_calls % len(_pool)]

    if _curr_ctx >= 80:
        _line1_bits.append(f"{_EVO_RED}{BOLD}{_comment}{R}")
    elif _curr_ctx >= 60:
        _line1_bits.append(f"{BOLD}{_EVO_WARN}{_comment}{R}")
    else:
        _line1_bits.append(f"{BOLD}{_EVO_GREEN}{_comment}{R}")

    _line1_bits.append(f"{DIM}{_calls}\u56de\u76ee{R}")

    # v3.1: Tip rotation prefers entries matching the most recently observed
    # signal category (persisted across cycles). Falls back to the full
    # tier-weighted rotation when no category match exists.
    _last_signal = _self.get('last_signal', '')
    _tip = _pick_tip(_TIPS_ROTATION, _calls, _last_signal)
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
    # v3.3.0: dim line2 too when proxy is stale, so the entire EvoPet block
    # consistently looks subdued rather than mixing fresh-bright advice with
    # dim-stale stats.
    if _evo_source == 'proxy_stale':
        parts.append('\n' + DIM + _line2 + R)
    else:
        parts.append('\n' + _line2)

print(SEP.join(parts), end='')
