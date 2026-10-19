#!/usr/bin/env python3
"""Evo statusline — Always-on, self-tracking. Works with or without proxy.

LEGACY (compat only). As of C1 the TypeScript renderer is the default single
renderer: `evo install-statusline` wires Claude Code's settings.json at
`evo statusline --full` (token line + EvoPet block from one process) and no
longer deploys this file. This script stays in the package so setups installed
by older versions keep working untouched until the user re-runs
`evo install-statusline` (which migrates them to the TS wiring). It is still the
byte-for-byte parity REFERENCE for the TS renderer, and scripts/token_statusline.py
+ `evo statusline` remain the split-wrapper construction. Do not delete it, and
keep the hand-curated dictionary in sync via scripts/gen-statusline-dict.mjs.
"""
import json, sys, os, time, re
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

# STATUSLINE-DICT:START generated from src/data/statusline-dict.json — do not edit by hand.
# Single source of truth for the hand-curated EvoPet dictionary: the
# _COMMENTS mood lines and the _TIPS rotation (hand-written groups plus the
# AUTO-synced official-docs groups maintained by scripts/sync-claude-docs.mjs).
# Edit src/data/statusline-dict.json, then:
#   regenerate:  node scripts/gen-statusline-dict.mjs
#   drift check: node scripts/gen-statusline-dict.mjs --check   (CI-enforced)
# The TS renderer (src/cli/statusline-data.ts) imports the SAME JSON file, so
# the Python and TypeScript dictionaries cannot drift apart.
_STATUSLINE_DICT = json.loads(r'''
{
  "version": 1,
  "comments": {
    "start": [
      "指示を待ってるよ! ファイル名と「何をしたいか」を教えてね",
      "新しいセッション! 今日も具体的な指示で効率よくいこう",
      "準備OK! 「どのファイルの何をどうしたい」が伝わるとAIが速いよ",
      "ようこそ! 最初の指示が一番大事だよ。具体的にいこう",
      "セッション開始! 「何を・どこを・どうなればOK」を意識してみて",
      "おはよう! ファイル名を1つ書くだけでAIの探索が半分になるよ",
      "スタート! エラーがあるならメッセージごと貼るのが最速だよ",
      "さあ始めよう! 箇条書きで指示するとAIが見落としにくいよ"
    ],
    "early": [
      "順調にスタートしてるね!",
      "いい感じ! この調子でいこう",
      "作業が乗ってきたね!",
      "コンテキストに余裕があるうちに、難しいタスクを片付けちゃおう",
      "まだまだ序盤! 一つずつ着実に進めよう",
      "調子良さそう! 完了条件を書いておくとやり直しが減るよ"
    ],
    "working": [
      "集中してるね、いいペース!",
      "中盤戦! タスクが変わったら /clear も手だよ",
      "よく使ってるね! 大きいタスクは分割すると精度が上がるよ",
      "順調に進んでるよ! 次の指示も具体的にいこう",
      "半分くらい使ったね。タスク切り替えなら新セッションも検討してね",
      "いい流れ! git commit してから大きな変更を頼むと安心だよ",
      "作業中... 同じエラーが続くならアプローチを変えてみて",
      "中盤だね。「さっきの方法だとダメだった」って伝えるとAIが別ルート探すよ"
    ],
    "busy": [
      "ctx 60%超え。タスク切り替えなら /clear も手だよ",
      "コンテキストそろそろ注意。大きなタスクなら /compact を検討",
      "メモリ食ってきた! 別タスクなら新セッションが吉",
      "後半戦だね。重要な変更は早めに片付けよう",
      "コンテキスト消費が増えてきた。応答が遅く感じたら /compact だよ",
      "もう少しでコンテキスト上限。終わる前に commit しておこう"
    ],
    "critical": [
      "⚠️ ctx 80%超え! /compact で軽くしよう",
      "⚠️ コンテキスト圧迫! 応答が遅くなるかも。/compact 推奨",
      "⚠️ もうすぐ上限! 大事な作業は新セッションでやろう",
      "⚠️ コンテキスト残りわずか。今のうちに /compact か /clear を!"
    ]
  },
  "tipGroups": [
    {
      "name": "hand",
      "entries": [
        {
          "headline": "「何を・どこを・どうなればOK」の3点セットで一発で通る確率が跃ね上がる!",
          "before": "ログイン画面を直して",
          "after": "src/Login.tsx のフォーム送信で、空パスワードでもsubmitできるバグを修正"
        },
        {
          "headline": "ファイル名を1つ書くだけで、AIの探索が半分になるよ!",
          "before": "バリデーションにメールアドレスのチェックを追加して",
          "after": "src/validators.ts にメールアドレスのバリデーションを追加"
        },
        {
          "headline": "箇条書きで指示すると、AIが見落としにくくなるよ!",
          "before": "ユーザー登録とメール確認とパスワード制限をつくって",
          "after": "ユーザー登録機能:\n- POST /register\n- パスワード8文字以上\n- テストも書く"
        },
        {
          "headline": "「直して」だけだと、AIは推測からスタートしちゃうよ",
          "before": "なんかエラー出る、直して",
          "after": "npm run build で TypeError: Cannot read property 'name' of undefined って出る"
        },
        {
          "headline": "「〜しないで」って制約を伝えるのも大事! AIの余計なおせっかいを防げる",
          "before": "リファクタして",
          "after": "src/api.ts の fetchUser をリファクタ。他のファイルは変更しないこと"
        },
        {
          "headline": "完了条件を1行足すだけで、やり直し率が激減するよ!",
          "before": "検索機能を追加して",
          "after": "検索機能を追加。完了条件: 一致する結果だけが表示されること"
        },
        {
          "headline": "エラーメッセージをそのまま貼るのが最速の解決法! AIが原因に直行できる",
          "before": "動かないんだけど",
          "after": "このエラーが出る:\nTypeError: Cannot read properties of undefined (reading 'map')\n  at UserList.tsx:15"
        },
        {
          "headline": "「どこまで動いてどこで止まる」を伝えると、デバッグが爆速になるよ",
          "before": "ボタンが動かない",
          "after": "ボタンクリックで handleSubmit は呼ばれるが、fetch のレスポンスが 403 になる"
        },
        {
          "headline": "同じ指示を繰り返しても同じ結果になるだけ。前回の失敗を伝えよう",
          "before": "(また) 直して",
          "after": "さっきnullチェックを試したけどダメだった。型自体をOptionalにする方向で"
        },
        {
          "headline": "「ログ出力を足して」と頼むと、次のデバッグがめちゃ楽になるよ",
          "before": "原因がわからない、直して",
          "after": "processOrder の各ステップに console.log を足して、どこで止まるか見せて"
        },
        {
          "headline": "スタックトレースは「切り取る」より「そのまま貼る」が正解! 行番号がAIのヒントになる",
          "before": "エラーが出た。UserListが悪いっぽい",
          "after": "このスタックトレース:\nError: ...\n  at UserList (src/UserList.tsx:15:23)"
        },
        {
          "headline": "「テストも一緒に書いて」の一言で、AIが自分で品質チェックしてくれる",
          "before": "ソート機能を追加して",
          "after": "sortByDate 関数を作って。テストも書いて、昇順/降順両方カバーすること"
        },
        {
          "headline": "型をしっかり指定すると、AIのコード補完精度が格段に上がるよ",
          "before": "データを取得する関数を作って",
          "after": "User型の配列を返す fetchUsers(): Promise<User[]> を作って。User型は types.ts に定義済み"
        },
        {
          "headline": "「修正後に npm test を実行して」と足すだけで、壊れたのに気づかない事故を防げる",
          "before": "バグ修正して",
          "after": "バグ修正して、修正後に npm test を実行して結果を見せて"
        },
        {
          "headline": "複数ファイルの変更は、先に影響範囲を聞いてから頼むと安全だよ",
          "before": "このインターフェースを変更して",
          "after": "UserService のインターフェースを変えたい。まずどのファイルが影響受けるかリストして"
        },
        {
          "headline": "/clear でコンテキストをリセットすると、AIの応答が速くなるよ!",
          "before": null,
          "after": null
        },
        {
          "headline": "CLAUDE.md にプロジェクトのルールを書いておくと、毎回説明しなくて済む!",
          "before": "毎回「TypeScriptで書いて」と言ってる",
          "after": "CLAUDE.md に「言語: TypeScript, テスト: vitest, スタイル: セミコロンなし」と書いておく"
        },
        {
          "headline": "大きなタスクは小さく分割! 1つずつ確認しながら進めると手戻りが激減するよ",
          "before": "ECサイトのバックエンドを全部作って",
          "after": "まず商品一覧の GET /products API だけ作って。DBはSQLiteでいい"
        },
        {
          "headline": "git commit してから大きな変更を頼むと、いつでも巻き戻せて安心だよ",
          "before": "(大きなリファクタをいきなり頼む)",
          "after": "まず git commit して。その後、src/api.ts をリファクタして"
        },
        {
          "headline": "/compact で会話を圧縮すると、応答速度が改善するよ。ctx 50%超えたら検討して",
          "before": null,
          "after": null
        },
        {
          "headline": "タスクが変わったら新セッション! 過去の会話が邪魔して精度が下がることがあるよ",
          "before": "(前のタスクの会話が残ったまま別作業)",
          "after": "/clear してから新しいタスクを始める。または新ターミナルで claude 起動"
        },
        {
          "headline": "AIに「なぜそうしたか」を聞くと、コードの理解が深まるし間違いにも気づきやすいよ",
          "before": null,
          "after": null
        },
        {
          "headline": "行番号や関数名で範囲を絞る方が、「ファイル全部見て」より効率的!",
          "before": "このファイル全部見て",
          "after": "src/utils.ts の 42行目あたりの getUser 関数を見て"
        },
        {
          "headline": "テストを先に書いてもらうと、実装の品質がグンと上がる (TDD)",
          "before": "ソート機能を追加して",
          "after": "sortByDate 関数を作って。先にテストを書いてから実装して"
        },
        {
          "headline": "「原因を推測して、まだ直さないで」が安全なデバッグ流だよ",
          "before": "これ直して (→AIが推測で直して別バグ発生)",
          "after": "このエラーの原因を推測して。まだコードは変えないで"
        },
        {
          "headline": "「問題点を指摘して」でAIにレビューさせると、バグ予防になるよ",
          "before": "(書いたコードをそのまま使う)",
          "after": "この関数のエッジケースやバグの可能性を指摘して"
        },
        {
          "headline": "「このコードを説明して」は学習に最強。理解を深めるのにAIを使おう",
          "before": null,
          "after": null
        },
        {
          "headline": "わからないことは「わからない」でOK! 平易な言い方でもAIは理解できるよ",
          "before": null,
          "after": null
        },
        {
          "headline": "「今こうなってる、こうしたい、でもこれが邪魔」の3点を書こう",
          "before": "(何を頼めばいいかわからない)",
          "after": "今ログイン画面を作ってる。OAuthも対応したいが、まずメール/パスワードだけでいい"
        },
        {
          "headline": "1つの指示で1つのこと。欲張ると全部中途半端になりがちだよ",
          "before": "あれもこれもそれも全部やって",
          "after": "まずログインAPIだけ作って。確認できたら次の機能を頼む"
        },
        {
          "headline": "ここまで順調! いい指示の出し方を続けていこう!",
          "before": null,
          "after": null
        },
        {
          "headline": "AIはペアプロのパートナー。「どう思う?」って相談すると良い提案が出やすいよ",
          "before": "これをやれ (一方的な命令)",
          "after": "こういう問題があるんだけど、どうアプローチするのがいいと思う?"
        },
        {
          "headline": "@ファイル名 でファイル内容を直接注入できるよ。AIが探す手間とトークンを節約!",
          "before": "src/utils/auth.js を見て",
          "after": "@src/utils/auth.js このファイルの validateToken を修正して"
        },
        {
          "headline": "2回修正してダメなら /clear して最初から。失敗コンテキストが邪魔してるかも",
          "before": "(同じバグに3回目の修正指示)",
          "after": "/clear して、「さっき○○と△△を試したがダメだった。別のアプローチで」と新規指示"
        },
        {
          "headline": "/btw で聴いた質問はコンテキストに残らないよ。ちょっとした確認に便利!",
          "before": null,
          "after": null
        },
        {
          "headline": "Esc×2 でリワインド! 任意の時点に会話もコードも巻き戻せるよ",
          "before": "(失敗した変更を手動で戻す)",
          "after": "Esc×2 → リワインドメニューで好きな時点に巻き戻し"
        },
        {
          "headline": "大きな機能の前に「AIにインタビューさせてスペックを作る」と設計漏れが減るよ",
          "before": "認証機能を作って",
          "after": "認証機能を作りたい。まず要件をインタビューしてSPEC.mdにまとめて"
        },
        {
          "headline": "実装とレビューは別セッションで! 自分のコードへのバイアスなしにチェックできる",
          "before": "(書いた直後に同じセッションでレビュー)",
          "after": "実装後、新セッションで @src/middleware/auth.ts をレビュー。エッジケースと競合を確認"
        },
        {
          "headline": "/effort low で簡単なタスクを高速化。複雑な時は ultrathink で深く考えさせよう",
          "before": null,
          "after": null
        },
        {
          "headline": "claude --resume セッション名 で前回の作業に復帰できるよ",
          "before": "(前回の作業内容を最初から説明し直す)",
          "after": "claude --resume auth-refactor で前回のコンテキストごと復帰"
        },
        {
          "headline": "/compact に「何を残すか」を指示できるよ。大事な情報が圧縮で消えるのを防げる",
          "before": "/compact",
          "after": "/compact APIの変更内容とテストコマンドは必ず保持して"
        },
        {
          "headline": "CLAUDE.md は200行以下が理想。詳細な手順は .claude/skills/ に分離しよう",
          "before": "CLAUDE.md にPRレビュー手順、DBマイグレ、API規約を全部書く",
          "after": ".claude/skills/pr-review/SKILL.md や .claude/skills/db-migrate/SKILL.md に分離"
        },
        {
          "headline": "Hooks で「編集後に自動lint」「特定フォルダへの書き込みブロック」等を確実に実行できるよ",
          "before": "CLAUDE.md に「編集後は必ずeslintを実行して」と書く",
          "after": "settings.json の hooks.PostToolUse に eslint 自動実行を設定"
        },
        {
          "headline": "--worktree で並列作業を安全に! ファイル変更が衝突しないよ",
          "before": "(同じブランチで2つのタスクを同時進行)",
          "after": "claude --worktree feature-auth で独立したワークツリーを自動作成"
        },
        {
          "headline": "Ctrl+G でプランを外部エディタで編集できるよ。複雑な計画はエディタで細かく調整しよう",
          "before": null,
          "after": null
        },
        {
          "headline": "gh, aws, gcloud 等のCLIツールはMCPよりトークン効率が良いよ。既存CLIがあるならそっちを使おう",
          "before": "GitHub MCP サーバーをセットアップしてPRを作る",
          "after": "gh pr create で直接PRを作る (トークン節約)"
        },
        {
          "headline": "!コマンド で実行結果がそのまま会話に入るよ。!git status や !npm test でトークン節約",
          "before": "git status の結果を貼り付けて「これを見て」",
          "after": "!git status と打つだけでAIが結果を見て判断してくれる"
        },
        {
          "headline": "Ctrl+S で書きかけのプロンプトを一時退避。割り込み対応後に自動復帰するよ",
          "before": null,
          "after": null
        },
        {
          "headline": "Ctrl+B で長時間処理をバックグラウンド実行。待たずに次の作業へ進めるよ",
          "before": "(テスト実行中に待ちぼうけ)",
          "after": "Ctrl+B でバックグラウンドに回して、別の質問を投げる"
        },
        {
          "headline": "Ctrl+R で過去に使ったプロンプトを検索・再利用できるよ。同じ指示の再入力不要!",
          "before": null,
          "after": null
        },
        {
          "headline": "# プレフィックスでプロジェクトメモリに即永続化。「# テストは jest で書くこと」のように使えるよ",
          "before": "「このプロジェクトでは jest 使って」と毎回伝える",
          "after": "# テストは必ず jest で書くこと → 次回から自動で覚えてる"
        },
        {
          "headline": "claude --continue でクラッシュや誤終了から作業復元できるよ。作業が消えても安心",
          "before": null,
          "after": null
        },
        {
          "headline": "/color blue でプロンプトバーを色分け。複数ウィンドウでどれがどのタスクか一目でわかる!",
          "before": "(複数のClaudeウィンドウが区別つかない)",
          "after": "/color blue でフロントエンド、/color green でバックエンドと分ける"
        },
        {
          "headline": "/loop 5m npm test で定期実行。テスト監視やビルドチェックに便利だよ",
          "before": "手動で定期的に npm test を実行",
          "after": "/loop 5m npm test で自動監視。失敗したらすぐ気づける"
        },
        {
          "headline": "--bare モードでhooksスキップ最速起動。CI/CDパイプラインやバッチ処理に最適",
          "before": "CIで普通に claude -p を実行",
          "after": "claude --bare -p \"このdiffをレビュー\" --permission-mode auto < diff.patch"
        },
        {
          "headline": "/simplify で「再利用・品質・効率」の3観点で並列レビュー。コード品質を網羅的にチェック",
          "before": "「レビューして」とだけ頼む",
          "after": "/simplify で自動的に3エージェントが並列チェック"
        },
        {
          "headline": "/security-review で変更内容のセキュリティスキャン。マージ前に習慣づけよう",
          "before": null,
          "after": null
        },
        {
          "headline": "/commit-push-pr でコミット→push→PR作成を一気通貫! 手動ステップをまるごと省略",
          "before": "git add . && git commit && git push && gh pr create を手動で",
          "after": "/commit-push-pr でメッセージ自動生成→push→PR作成まで一発"
        },
        {
          "headline": "/pr-comments 142 でGitHub PRのコメントを取り込んで対応できるよ",
          "before": "GitHubでコメントを読んで手動で修正",
          "after": "/pr-comments 142 → コメント内容を見てそのまま修正→再 push"
        },
        {
          "headline": "claude --from-pr 142 でPRコンテキストを保持したまま翌日継続できるよ",
          "before": "昨日のPRレビューの続きを最初から説明し直す",
          "after": "claude --from-pr 142 で前回のPRコンテキストごと復帰"
        },
        {
          "headline": "/teleport でデバイス間セッション引き継ぎ。PC→ノートPCの移動もコンテキスト保持",
          "before": "(別PCで同じ作業を最初からやり直す)",
          "after": "/teleport → 別端末で claude --teleport で復帰"
        },
        {
          "headline": "/schedule でクラウド定期実行。「毎朝テスト実行→Slack通知」など自動化できるよ",
          "before": "毎朝手動でテストを実行して結果を確認",
          "after": "/schedule 毎朝9時に npm test を実行してSlackに通知して"
        },
        {
          "headline": "/remote-control (/rc) でブラウザからリモート操作。スマホからでも作業継続できる!",
          "before": null,
          "after": null
        },
        {
          "headline": "Agent Teams で独立タスクを並列実行。フロントとバックを同時に進めて開発速度倍増",
          "before": "フロント完了→バックエンド着手 の順番待ち",
          "after": "Agent Teams でフロントとバックエンドを同時にアサインして並列実行"
        },
        {
          "headline": "/batch で大規模並列変更。worktree で安全に複数ファイルを同時に変換できるよ",
          "before": "forループで1ファイルずつ変換",
          "after": "/batch \"ReactからVueに移行\" で対象ファイルを並列変換"
        }
      ]
    },
    {
      "name": "auto-best-practices",
      "source": "https://code.claude.com/docs/en/best-practices",
      "fetched": "2026-08-24",
      "entries": [
        {
          "headline": "Claude Code on the web",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Claude Code on desktop",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**In one prompt**: ask Claude to run the check and iterate in the same message, as in the table above.",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**Across a session**: set the check as a [`/goal` condition](/docs/en/goal). A separate evaluator re-checks it after every turn and Claude keeps working until the goal resolves. If Claude stalls, Claude Code eventually stops the run with the goal still set — see [how /goal evaluation works](/docs/en/goal#how-evaluation-works).",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**As a deterministic gate**: a [Stop hook](/docs/en/hooks#stop) runs your check as a script and blocks the turn from ending until it passes. Claude Code overrides the hook and ends the turn after 8 consecutive blocks.",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**By a second opinion**: a [verification subagent](/docs/en/sub-agents) or a [dynamic workflow](/docs/en/workflows) that checks its own findings has a fresh model try to refute the result, so the agent doing the work isn’t the one grading it.",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**Reference files with `@`** instead of describing where code lives. Claude reads the file before responding.",
          "tier": 1,
          "category": "specificity",
          "before": null,
          "after": null
        },
        {
          "headline": "**Paste images directly**. Copy/paste or drag and drop images into the prompt.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**Give URLs** for documentation and API references. Use `/permissions` to allowlist frequently-used domains.",
          "tier": 1,
          "category": "permissions",
          "before": null,
          "after": null
        },
        {
          "headline": "**Pipe in data** by running `cat error.log | claude` to send file contents directly.",
          "tier": 2,
          "category": "recovery",
          "before": null,
          "after": null
        },
        {
          "headline": "**Let Claude fetch what it needs**. Tell Claude to pull context itself using Bash commands, MCP tools, or by reading files.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "Use ES modules (import/export) syntax, not CommonJS (require)",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Destructure imports when possible (eg. import { foo } from 'bar')",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Be sure to typecheck when you're done making a series of code changes",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "Prefer running single tests, and not the whole test suite, for performance",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**Permission allowlists**: permit specific tools you know are safe, like `npm run lint` or `git commit`",
          "tier": 1,
          "category": "specificity",
          "before": null,
          "after": null
        },
        {
          "headline": "**Sandboxing**: enable OS-level isolation that restricts filesystem and network access, allowing Claude to work more freely within defined boundaries",
          "tier": 2,
          "category": "permissions",
          "before": null,
          "after": null
        },
        {
          "headline": "Use kebab-case for URL paths",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Use camelCase for JSON properties",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Always include pagination for list endpoints",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Version APIs in the URL path (/v1/, /v2/)",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Injection vulnerabilities (SQL, XSS, command injection)",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Authentication and authorization flaws",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Secrets or credentials in code",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Insecure data handling",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "How does logging work?",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "How do I make a new API endpoint?",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "What does `async move { ... }` do on line 134 of `foo.rs`?",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "What edge cases does `CustomerOnboardingFlowImpl` handle?",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "Why does this code call `foo()` instead of `bar()` on line 333?",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**`Esc`**: stop Claude mid-action with the `Esc` key. Context is preserved, so you can redirect.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "**`Esc + Esc` or `/rewind`**: press `Esc` twice or run `/rewind` to open the rewind menu and restore previous conversation and code state, or summarize from a selected message.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**`\"Undo that\"`**: have Claude revert its changes.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**`/clear`**: reset context between unrelated tasks. Long sessions with irrelevant context can reduce performance.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "Use `/clear` frequently between tasks to reset the context window entirely",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "When auto compaction triggers, Claude summarizes what matters most, including code patterns, file states, and key decisions",
          "tier": 2,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "For more control, run `/compact <instructions>`, like `/compact Focus on the API changes`",
          "tier": 2,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "To compact only part of the conversation, use `Esc + Esc` or `/rewind`, select a message checkpoint, and choose **Summarize from here** or **Summarize up to here**. The first condenses messages from that point forward while keeping earlier context intact; the second condenses earlier messages while keeping recent ones in full. See [the rewind menu’s summarize options](/docs/en/checkpointing#rewind-and-summarize).",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "Customize compaction behavior in CLAUDE.md with instructions like `\"When compacting, always preserve the full list of modified files and any test commands\"` to ensure critical context survives summarization",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "For questions that don’t need to stay in context, use [`/btw`](/docs/en/interactive-mode#side-questions-with-%2Fbtw). The answer never enters conversation history, so you can check a detail without growing context.",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "[Worktrees](/docs/en/worktrees): run separate CLI sessions in isolated git checkouts so edits don’t collide",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "[Desktop app](/docs/en/desktop#work-in-parallel-with-sessions): manage multiple local sessions visually, each in its own worktree",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "[Claude Code on the web](/docs/en/claude-code-on-the-web): run sessions in the cloud, on Anthropic-managed infrastructure by default",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "[Agent view](/docs/en/agent-view): research preview. Run `claude agents` to dispatch sessions that keep running in the background and watch them from one screen",
          "tier": 2,
          "category": "exploration",
          "before": null,
          "after": null
        },
        {
          "headline": "[Agent teams](/docs/en/agent-teams): experimental and disabled by default. Automated coordination of multiple sessions with shared tasks, messaging, and a team lead",
          "tier": 2,
          "category": "exploration",
          "before": null,
          "after": null
        },
        {
          "headline": "**The kitchen sink session.** You start with one task, then ask Claude something unrelated, then go back to the first task. Context is full of irrelevant information.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "**Correcting over and over.** Claude does something wrong, you correct it, it’s still wrong, you correct again. Context is polluted with failed approaches.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "**The over-specified CLAUDE.md.** If your CLAUDE.md is too long, Claude ignores half of it because important rules get lost in the noise.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "**The trust-then-verify gap.** Claude produces a plausible-looking implementation that doesn’t handle edge cases.",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "**The infinite exploration.** You ask Claude to “investigate” something without scoping it. Claude reads hundreds of files, filling the context.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "[How Claude Code works](/docs/en/how-claude-code-works): the agentic loop, tools, and context management",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "[Extend Claude Code](/docs/en/features-overview): skills, hooks, MCP, subagents, and plugins",
          "tier": 1,
          "category": "exploration",
          "before": null,
          "after": null
        },
        {
          "headline": "[Common workflows](/docs/en/common-workflows): step-by-step recipes for debugging, testing, PRs, and more",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "[CLAUDE.md](/docs/en/memory): store project conventions and persistent context",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        }
      ]
    },
    {
      "name": "auto-slash-commands",
      "source": "https://code.claude.com/docs/en/commands",
      "fetched": "2026-08-24",
      "entries": [
        {
          "headline": "/add-dir — Add a working directory for file access during the current session.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/advisor — Enable or disable the advisor tool, which consults a second model for guidance at key moments during a task.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/agents — As of v2.1.198, running /agents prints a reminder to ask Claude to create or manage subagents, or to edit .claude/agents/ or ~/.claude/agents/ directly.",
          "tier": 1,
          "category": "permissions",
          "before": null,
          "after": null
        },
        {
          "headline": "/artifacts — List the artifacts you own or that are shared with you, then attach one to the session, open it in your browser, or copy its link.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/auto-mode-setup — Draft autoMode.environment entries from your project and recent sessions, then review the draft and save it to your user settings.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/autocompact — Set the auto-compact window: how full the context window gets before Claude Code compacts automatically.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/autofix-pr — Spawn a Claude Code on the web session that watches the current branch’s PR and pushes fixes when CI fails or reviewers leave comments.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/background — Detach the current session to run as a background agent and free this terminal.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/batch — Orchestrate large-scale changes across a codebase in parallel.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/branch — Create a branch of the current conversation at this point, so you can try a different direction without losing the conversation as it stands.",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "/btw — Ask a side question about the current session without adding to the conversation.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/bug — Report a bug or share your conversation.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/cd — Move this session to a new working directory, keeping the conversation and its prompt cache.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/chrome — Configure Claude in Chrome settings",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/claude-api — Load Claude API and Managed Agents reference material for your project’s language.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/clear — Start a new conversation with empty context.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "/code-review — Review the current diff, or a PR number, branch, or path you pass, for correctness bugs and cleanup opportunities.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/color — Set the prompt bar color for the current session.",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/compact — Free up context by summarizing the conversation so far.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "/config — Open the Settings interface to adjust theme, model, output style, and other preferences.",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/context — Visualize current context usage as a colored grid.",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "/copy — Copy the last assistant response to clipboard.",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/cost — Alias for /usage",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/dataviz — Design guidance for charts, graphs, and dashboards.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/debug — Enable debug logging for the current session and troubleshoot issues by reading the session debug log.",
          "tier": 3,
          "category": "recovery",
          "before": null,
          "after": null
        },
        {
          "headline": "/deep-research — Fan out web searches on a question, fetch and cross-check sources, and synthesize a cited report",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/design-login — Authorize design-system access for /design-sync with your claude.ai account",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/design-sync — Convert your repo’s React design system and upload it to Claude Design, so designs it produces use your real components.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/desktop — Continue the current session in the Claude Code Desktop app.",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/diff — Open an interactive diff viewer showing uncommitted changes and per-turn diffs.",
          "tier": 2,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "/doctor — Run a setup checkup that diagnoses issues and can fix them.",
          "tier": 3,
          "category": "recovery",
          "before": null,
          "after": null
        },
        {
          "headline": "/effort — Set the effort level: low to xhigh, max, ultracode, or auto; status prints it.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/exit — Exit the CLI.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/export — Export the current conversation as plain text.",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/fast — Toggle fast mode on or off.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/feedback — Send product feedback about Claude Code.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/fewer-permission-prompts — Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlist to project .claude/settings.json to reduce permission prompts",
          "tier": 3,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/focus — Toggle the focus view, which shows only your last prompt, a one-line tool-call summary with edit diffstats, and the final response.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/fork — Copy the current conversation into a new background session and keep working here.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/goal — Set a goal: Claude keeps working across turns until the condition is met or the goal clears for another reason.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/heapdump — Write a JavaScript heap snapshot and a memory breakdown to ~/Desktop, or your home directory on Linux without a Desktop folder, for diagnosing high memory usage.",
          "tier": 3,
          "category": "recovery",
          "before": null,
          "after": null
        },
        {
          "headline": "/help — Show help and available commands",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/hooks — View hook configurations for tool events",
          "tier": 1,
          "category": "permissions",
          "before": null,
          "after": null
        },
        {
          "headline": "/ide — Manage IDE integrations and show status",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/import — Bring configuration from other coding agents on your machine, currently OpenAI Codex and Google Gemini CLI, into Claude Code, including instruction files, MCP servers, commands, subagents, and skills.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/init — Initialize project with a CLAUDE.md guide.",
          "tier": 1,
          "category": "exploration",
          "before": null,
          "after": null
        },
        {
          "headline": "/insights — Generate an HTML report analyzing your recent sessions on this machine: which projects you work in, how you use Claude Code, where things go wrong, and features to try.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/install-github-app — Install the Claude GitHub App for a repository, with an optional step to set up GitHub Actions workflows and secrets.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/install-slack-app — Install the Claude Slack app.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/keybindings — Open your keyboard shortcuts file",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/list-agents — List the subagents, agent team teammates, and other Claude Code sessions Claude can message, with the name to use for each.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/login — Sign in to your Anthropic account",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/logout — Sign out from your Anthropic account",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/loop — Run a prompt repeatedly while the session stays open.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/mcp — Manage MCP server connections and OAuth authentication.",
          "tier": 1,
          "category": "exploration",
          "before": null,
          "after": null
        },
        {
          "headline": "/memory — Edit CLAUDE.md files, enable or disable auto memory, and view auto memory entries",
          "tier": 1,
          "category": "context",
          "before": null,
          "after": null
        },
        {
          "headline": "/mobile — Show QR code to download the Claude mobile app.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/model — Switch the AI model and save it as your default for new sessions.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/passes — Share a free week of Claude Code with friends.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/permissions — Manage allow, ask, and deny rules for tool permissions.",
          "tier": 1,
          "category": "permissions",
          "before": null,
          "after": null
        },
        {
          "headline": "/plan — Enter plan mode directly from the prompt.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/plugin — Manage Claude Code plugins.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/powerup — Discover Claude Code features through quick interactive lessons with animated demos",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/pr-comments — Removed in v2.1.91.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/privacy-settings — View and update your privacy settings.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/radio — Open Claude FM lo-fi radio in your browser.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/recap — Generate a one-line summary of the current session on demand.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/release-notes — View the changelog in an interactive version picker.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/reload-plugins — Reload all active plugins to apply pending changes without restarting.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/reload-skills — Re-scan skill and command directories so skills added or changed on disk during the session become available without restarting.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/remote-control — Make this session available for Remote Control from claude.ai.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/remote-env — Choose the default environment for cloud agents",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/rename — Rename the current session and show the name on the prompt bar.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/resume — Resume a conversation by ID or name, or open the session picker.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/review — Alias of /code-review: reviews the current diff, or a PR number, branch, or path you pass, such as /review 1234, and takes the same effort levels and flags.",
          "tier": 1,
          "category": "verification",
          "before": null,
          "after": null
        },
        {
          "headline": "/rewind — Rewind the conversation and/or code to a previous point, or summarize from a selected message.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/run — Launch and drive your project’s app to see a change working, not only passing tests.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/run-skill-generator — Teach /run and /verify how to build, launch, and drive your project’s app from a clean environment by writing a per-project skill",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/sandbox — Toggle sandbox mode.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/schedule — Create, update, list, or run routines, which execute in the cloud.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/scroll-speed — Adjust mouse wheel scroll speed interactively, with a ruler you can scroll while the dialog is open to preview the change.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/security-review — Analyze the changes on your current branch for security vulnerabilities.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/setup-bedrock — Configure Amazon Bedrock authentication, region, and model pins through an interactive wizard.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/setup-vertex — Configure Google Cloud’s Agent Platform authentication, project, region, and model pins through an interactive wizard.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/simplify — Review the changed code for cleanup opportunities and apply the fixes.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/skills — List available skills.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/stats — Alias for /usage.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/status — Open the Settings interface on the Status tab, showing version, model, account, and connectivity.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/statusline — Configure Claude Code’s status line.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/stickers — Order Claude Code stickers",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/stop — Stop the current background session.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/subtask — Spawn a forked subagent: a background subagent that inherits the full conversation and works on the task while you keep working.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/tasks — View and manage background work in the current session, including subagents that have finished.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/team-onboarding — Generate a team onboarding guide from your Claude Code usage history.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/teleport — Pull a Claude Code on the web session into this terminal.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/terminal-setup — Configure terminal keybindings for Shift+Enter and other shortcuts.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/theme — Change the color theme.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/tui — Set the terminal UI renderer and relaunch into it with your conversation intact.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/ultraplan — Removed.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/ultrareview — Run a deep, multi-agent code review in a cloud sandbox with ultrareview.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/upgrade — Open the upgrade page in your browser to switch to a higher plan tier.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/usage — Show session cost, plan usage limits, and activity stats.",
          "tier": 1,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/usage-credits — Configure usage credits, or request them from your admin, when you hit a limit.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/verify — Confirm a code change does what it should by building your project’s app, running it, and observing the result, rather than relying on tests or type checks.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/vim — Removed in v2.1.92.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/voice — Toggle voice dictation, or enable it in a specific mode.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/web-setup — Connect your GitHub account to Claude Code on the web using your local gh CLI credentials.",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        },
        {
          "headline": "/workflows — Open the workflow progress view to watch, pause, resume, or save running and completed workflows",
          "tier": 2,
          "category": "general",
          "before": null,
          "after": null
        }
      ]
    }
  ]
}
''')
_COMMENTS = _STATUSLINE_DICT['comments']
_TIPS = [_t for _g in _STATUSLINE_DICT['tipGroups'] for _t in _g['entries']]
# STATUSLINE-DICT:END

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

# ──────────────────────────────────────────────
# Width-aware truncation (mirrors src/cli/statusline.ts clip()).
# East-Asian wide + emoji glyphs occupy 2 columns; the old fixed [:30] slices
# cut through multi-column characters and produced meaningless fragments.
# ──────────────────────────────────────────────
_ADVICE_POINTER = ' → 続きは `evo advice`'
_BOUNDARY_CHARS = '、。，．・:：/!?！？ \t'


def _char_width(cp):
    if (0x1100 <= cp <= 0x115f or 0x2e80 <= cp <= 0x303e or 0x3041 <= cp <= 0x33ff
            or 0x3400 <= cp <= 0x4dbf or 0x4e00 <= cp <= 0x9fff or 0xa000 <= cp <= 0xa4cf
            or 0xac00 <= cp <= 0xd7a3 or 0xf900 <= cp <= 0xfaff or 0xfe30 <= cp <= 0xfe4f
            or 0xff00 <= cp <= 0xff60 or 0xffe0 <= cp <= 0xffe6
            or 0x1f300 <= cp <= 0x1faff or 0x20000 <= cp <= 0x3fffd):
        return 2
    return 1


def _display_width(s):
    return sum(_char_width(ord(c)) for c in s)


def _basename(p):
    n = p.replace('\\', '/').rstrip('/')
    i = n.rfind('/')
    return n[i + 1:] if i >= 0 else n


def _looks_like_path(s):
    t = s.strip()
    return bool(t) and re.search(r'\s', t) is None and ('/' in t or '\\' in t)


def _truncate_to_width(s, max_cols):
    w = 0
    out = []
    for c in s:
        cw = _char_width(ord(c))
        if w + cw > max_cols:
            break
        out.append(c)
        w += cw
    return ''.join(out)


def _trim_to_boundary(s):
    idx = -1
    for i, c in enumerate(s):
        if c in _BOUNDARY_CHARS:
            idx = i
    if idx >= 0 and _display_width(s[:idx + 1]) >= _display_width(s) * 0.5:
        return s[:idx + 1].rstrip('、。，．・:： \t')
    return s


def _clip(s, max_cols, pointer=False):
    if not s:
        return s
    st = _basename(s) if _looks_like_path(s) else s
    if _display_width(st) <= max_cols:
        return st
    truncated = _trim_to_boundary(_truncate_to_width(st, max_cols))
    return truncated + (_ADVICE_POINTER if pointer else '…')


# Absolute hard total-block cap (final safety net). Even with per-field clip, an
# unclipped field (e.g. a crafted nickname) or a future code path could flood the
# statusline; this bounds the VISIBLE length of the WHOLE assembled EvoPet block
# regardless. ANSI escapes pass through uncounted; a hard cut appends reset + the
# `evo advice` pointer. The newline between line 1 and line 2 counts as 1 unit.
_EVOPET_BLOCK_MAX_CHARS = 500


def _hard_cap_visible(s, max_visible):
    if not s:
        return s
    out = []
    visible = 0
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\x1b':
            out.append(c)
            i += 1
            if i < n and s[i] == '[':
                out.append(s[i])
                i += 1
            while i < n and not s[i].isalpha():
                out.append(s[i])
                i += 1
            if i < n:
                out.append(s[i])
                i += 1
            continue
        if visible >= max_visible:
            break
        out.append(c)
        visible += 1
        i += 1
    if i < n:
        out.append(R + _ADVICE_POINTER)
    return ''.join(out)


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

# v3.6: strict per-session binding. When a session id is known (from
# session_id, else derived from the transcript_path filename stem), read ONLY
# <cwd>/.evo/sessions/<sid>.json. A miss/stale renders a quiet placeholder
# (below) — we never fall back to the shared sinks (.evo/live-state.json /
# ~/.claude/.evo-live.json) that every parallel proxy in this cwd overwrites,
# which is what made one pane render another pane's EvoPet state.
_session_id = data.get('session_id')
_transcript = data.get('transcript_path')
if not _session_id and isinstance(_transcript, str) and _transcript:
    _stem = os.path.splitext(os.path.basename(_transcript))[0]
    if _stem:
        _session_id = _stem

_sessions_dir = os.path.join(cwd, '.evo', 'sessions')

if _session_id:
    _per_session = os.path.join(_sessions_dir, f'{_session_id}.json')
    try:
        with open(_per_session, encoding='utf-8') as _f:
            _candidate = json.load(_f)
        _age_ms = _now_ms - _candidate.get('updatedAt', 0)
        if _age_ms < _FRESH_WINDOW_MS:
            _evo = _candidate
            _evo_source = 'proxy' if _age_ms < 10000 else 'proxy_stale'
    except Exception:
        pass
else:
    # Sessionless legacy path: newest per-session file by mtime, then the
    # legacy single-file dual targets (back-compat for harnesses that omit
    # session_id and pre-v3.4 proxies).
    _candidates = []
    if os.path.isdir(_sessions_dir):
        try:
            _entries = []
            for _f in os.listdir(_sessions_dir):
                if not _f.endswith('.json'):
                    continue
                _full = os.path.join(_sessions_dir, _f)
                try:
                    _entries.append((-os.path.getmtime(_full), _full))
                except OSError:
                    pass
            _entries.sort()
            for _, _p in _entries:
                _candidates.append(_p)
        except Exception:
            pass
    _candidates.append(os.path.join(cwd, '.evo', 'live-state.json'))
    _candidates.append(os.path.join(os.path.expanduser('~'), '.claude', '.evo-live.json'))
    for _try_path in _candidates:
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
# v3.6: per-session self-state under ~/.claude/.evo-self/<sid>.json when a
# session id is known, so parallel panes don't clobber each other's call
# counter (which drove cross-pane count corruption). Sessionless invocations
# keep the legacy global file.
if _session_id:
    _SELF_STATE_FILE = os.path.join(
        os.path.expanduser('~'), '.claude', '.evo-self', f'{_session_id}.json'
    )
else:
    _SELF_STATE_FILE = os.path.join(os.path.expanduser('~'), '.claude', '.evo-self-state.json')

def _load_self():
    try:
        with open(_SELF_STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_self(s):
    try:
        os.makedirs(os.path.dirname(_SELF_STATE_FILE), exist_ok=True)
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
    _nick = _clip(str(_evo.get('nickname') or 'EvoPet'), 24)
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

    # v3.5.1: in expansion mode the four essentials (grade / \u56de\u76ee / \u6307\u793a\u306e\u8cea / \u80b2\u6210\u5ea6)
    # are rendered EVERY tick, with placeholders when data isn't computed yet.
    # Rationale: users reported that the row "thinning out" early in a session
    # makes EvoPet feel inert. Always-on chips communicate that tracking is alive.
    if _grade:
        _line1_bits.append(_dim_if_stale(f"{_gc}{BOLD}{_grade_label(_grade)}{R}"))
    else:
        _line1_bits.append(f"{DIM}\u8a55\u4fa1 \u2014{R}")
    # v3.6: Line 1 essentials trimmed to grade / \u6307\u793a\u306e\u8cea / \u80b2\u6210\u5ea6 (max 3 chips).
    # \u4f1a\u8a71\u56de\u6570 and combo were dropped from the cramped statusline; see `evo stats`.
    if _ps > 0:
        if _ps >= 80:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_GREEN}{BOLD}\u6307\u793a\u306e\u8cea: \u3068\u3066\u3082\u826f\u3044!{R}"))
        elif _ps >= 60:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_INFO}{BOLD}\u6307\u793a\u306e\u8cea: \u826f\u597d{R}"))
        elif _ps >= 40:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_WARN}{BOLD}\u6307\u793a\u306e\u8cea: \u3082\u3046\u5c11\u3057\u5177\u4f53\u7684\u306b{R}"))
        else:
            _line1_bits.append(_dim_if_stale(f"\U0001f4dd {_EVO_RED}{BOLD}\u6307\u793a\u306e\u8cea: \u66d6\u6627\u3059\u304e\u308b\u304b\u3082{R}"))
    else:
        _line1_bits.append(f"{DIM}\U0001f4dd \u6307\u793a\u306e\u8cea: \u8a08\u6e2c\u4e2d{R}")
    # \u80b2\u6210\u5ea6: prefer Ideal State Gauge (quality-based) when available; -1 = no data yet.
    # Falls back to legacy stage-EXP bond only when ISG hasn't been emitted yet.
    if _isg >= 0:
        _line1_bits.append(_dim_if_stale(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_isg}%{R}"))
    elif _isg == -1:
        # No ISG data yet \u2014 render "-" per design (instead of fake 100).
        _line1_bits.append(f"{DIM}\u80b2\u6210\u5ea6 -{R}")
    elif _bond < 100:
        _line1_bits.append(_dim_if_stale(f"{BOLD}{_EVO_GREEN}\u80b2\u6210\u5ea6 {_bond}%{R}"))
    else:
        # Residual fallback (e.g. bond >= 100 with no ISG): still show placeholder
        # so the always-on essentials row is never thinned out.
        _line1_bits.append(f"{DIM}\u80b2\u6210\u5ea6 -{R}")

    # v3.3.0: append "(\u5f85\u6a5f\u4e2d)" suffix as the LAST chip on line 1 when stale,
    # so the user sees "lagging" indicator without losing any of the data.
    if _is_stale:
        _line1_bits.append(f"{DIM}(\u5f85\u6a5f\u4e2d){R}")

    # v3.6: truncate by meaning (width-aware). Headline gets the `evo advice`
    # pointer when elided; before/after collapse paths to basenames + clause
    # boundary; detail is width-clipped. Keeps the block to ~2 lines.
    _advice_c = _clip(_advice, 72, pointer=True)
    _detail_c = _clip(_detail, 76)
    _b = _clip(_before, 28)
    _a = _clip(_after, 44)
    if _signal and _signal in ('prompt_too_vague', 'same_file_revisit', 'same_function_revisit',
                                'scope_creep', 'no_success_criteria', 'approval_fatigue',
                                'error_spiral', 'retry_loop', 'high_tool_ratio'):
        if _before and _after:
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice_c}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_a}\"{R}"
        elif _advice:
            _line2 = f"\u26a0\ufe0f {_EVO_WARN}{BOLD}{_advice_c}{R}"
            if _detail:
                _line2 += f"\n   {BOLD}{_EVO_WARN}{_detail_c}{R}"
    elif _signal in ('good_structure', 'first_pass_success', 'improving_trend'):
        _line2 = f"\u2728 {_EVO_GREEN}{BOLD}{_advice_c}{R}"
        if _detail:
            _line2 += f"\n   {BOLD}{_EVO_GREEN}{_detail_c}{R}"
    elif _signal == 'tip' and _advice:
        if _before and _after:
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice_c}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_b}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_a}\"{R}"
        else:
            _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_advice_c}{R}"
            if _detail:
                _line2 += f"\n   {BOLD}{_EVO_INFO}{_detail_c}{R}"
    elif _advice:
        _line2 = f"\U0001f4a1 {BOLD}{_EVO_INFO}{_advice_c}{R}"

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

elif _session_id:
    # ═══ Known session, no fresh per-session state → quiet placeholder ═══
    # Deliberately do NOT borrow the self-tracked tip rotation or the shared
    # sinks here: a bound session with no data of its own renders only a
    # neutral marker. Child/teammate sessions (no tracked file) land here.
    _line1_bits = [f"\U0001f98a {BOLD}{_EVO_ACCENT}EvoPet{R}", f"{DIM}待機中{R}"]

else:
    # ═══ No session id — self-tracked fallback (sessionless legacy path) ═══
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
    # v3.6: static-library tips are tagged [汎用]; width-clipped by meaning.
    _tip = _pick_tip(_TIPS_ROTATION, _calls, _last_signal)
    _th = _clip('[汎用] ' + _tip['headline'], 72, pointer=True)
    _tb = _tip.get('before')
    _ta = _tip.get('after')
    if _tb and _ta:
        _tb_d = _clip(_tb, 28)
        _ta_d = _clip(_ta, 44)
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}\n   {DIM}\u274c{R} {BOLD}{_EVO_RED}\"{_tb_d}\"{R} \u2192 {DIM}\u2705{R} {BOLD}{_EVO_GREEN}\"{_ta_d}\"{R}"
    else:
        _line2 = f"\U0001f4a1 {_EVO_INFO}{BOLD}{_th}{R}"

# Assemble the EvoPet block (line 1 + optional line 2), then enforce the
# absolute hard total-block cap on the joined block as the final backstop.
_evo_block_parts = []
if _line1_bits:
    _evo_block_parts.append(SEP.join(_line1_bits))
if _line2:
    # v3.3.0: dim line2 too when proxy is stale, so the entire EvoPet block
    # consistently looks subdued rather than mixing fresh-bright advice with
    # dim-stale stats.
    _evo_block_parts.append((DIM + _line2 + R) if _evo_source == 'proxy_stale' else _line2)
if _evo_block_parts:
    parts.append('\n' + _hard_cap_visible('\n'.join(_evo_block_parts), _EVOPET_BLOCK_MAX_CHARS))

print(SEP.join(parts), end='')
