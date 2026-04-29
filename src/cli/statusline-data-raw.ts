// Auto-extracted from base_statusline.py HEAD version. Do not edit by hand.

export const COMMENTS_DATA = {
  start: [
    "指示を待ってるよ! ファイル名と「何をしたいか」を教えてね",
    "新しいセッション! 今日も具体的な指示で効率よくいこう",
    "準備OK! 「どのファイルの何をどうしたい」が伝わるとAIが速いよ",
    "ようこそ! 最初の指示が一番大事だよ。具体的にいこう",
    "セッション開始! 「何を・どこを・どうなればOK」を意識してみて",
    "おはよう! ファイル名を1つ書くだけでAIの探索が半分になるよ",
    "スタート! エラーがあるならメッセージごと貼るのが最速だよ",
    "さあ始めよう! 箇条書きで指示するとAIが見落としにくいよ",
  ],
  early: [
    "順調にスタートしてるね!",
    "いい感じ! この調子でいこう",
    "作業が乗ってきたね!",
    "コンテキストに余裕があるうちに、難しいタスクを片付けちゃおう",
    "まだまだ序盤! 一つずつ着実に進めよう",
    "調子良さそう! 完了条件を書いておくとやり直しが減るよ",
  ],
  working: [
    "集中してるね、いいペース!",
    "中盤戦! タスクが変わったら /clear も手だよ",
    "よく使ってるね! 大きいタスクは分割すると精度が上がるよ",
    "順調に進んでるよ! 次の指示も具体的にいこう",
    "半分くらい使ったね。タスク切り替えなら新セッションも検討してね",
    "いい流れ! git commit してから大きな変更を頼むと安心だよ",
    "作業中... 同じエラーが続くならアプローチを変えてみて",
    "中盤だね。「さっきの方法だとダメだった」って伝えるとAIが別ルート探すよ",
  ],
  busy: [
    "ctx 60%超え。タスク切り替えなら /clear も手だよ",
    "コンテキストそろそろ注意。大きなタスクなら /compact を検討",
    "メモリ食ってきた! 別タスクなら新セッションが吉",
    "後半戦だね。重要な変更は早めに片付けよう",
    "コンテキスト消費が増えてきた。応答が遅く感じたら /compact だよ",
    "もう少しでコンテキスト上限。終わる前に commit しておこう",
  ],
  critical: [
    "⚠️ ctx 80%超え! /compact で軽くしよう",
    "⚠️ コンテキスト圧迫! 応答が遅くなるかも。/compact 推奨",
    "⚠️ もうすぐ上限! 大事な作業は新セッションでやろう",
    "⚠️ コンテキスト残りわずか。今のうちに /compact か /clear を!",
  ],
} as const;

export const TIPS_DATA = [
  {
    headline: "「何を・どこを・どうなればOK」の3点セットで一発で通る確率が跃ね上がる!",
    before: "ログイン画面を直して",
    after: "src/Login.tsx のフォーム送信で、空パスワードでもsubmitできるバグを修正",
  },
  {
    headline: "ファイル名を1つ書くだけで、AIの探索が半分になるよ!",
    before: "バリデーションにメールアドレスのチェックを追加して",
    after: "src/validators.ts にメールアドレスのバリデーションを追加",
  },
  {
    headline: "箇条書きで指示すると、AIが見落としにくくなるよ!",
    before: "ユーザー登録とメール確認とパスワード制限をつくって",
    after: "ユーザー登録機能:\n- POST /register\n- パスワード8文字以上\n- テストも書く",
  },
  {
    headline: "「直して」だけだと、AIは推測からスタートしちゃうよ",
    before: "なんかエラー出る、直して",
    after: "npm run build で TypeError: Cannot read property 'name' of undefined って出る",
  },
  {
    headline: "「〜しないで」って制約を伝えるのも大事! AIの余計なおせっかいを防げる",
    before: "リファクタして",
    after: "src/api.ts の fetchUser をリファクタ。他のファイルは変更しないこと",
  },
  {
    headline: "完了条件を1行足すだけで、やり直し率が激減するよ!",
    before: "検索機能を追加して",
    after: "検索機能を追加。完了条件: 一致する結果だけが表示されること",
  },
  {
    headline: "エラーメッセージをそのまま貼るのが最速の解決法! AIが原因に直行できる",
    before: "動かないんだけど",
    after: "このエラーが出る:\nTypeError: Cannot read properties of undefined (reading 'map')\n  at UserList.tsx:15",
  },
  {
    headline: "「どこまで動いてどこで止まる」を伝えると、デバッグが爆速になるよ",
    before: "ボタンが動かない",
    after: "ボタンクリックで handleSubmit は呼ばれるが、fetch のレスポンスが 403 になる",
  },
  {
    headline: "同じ指示を繰り返しても同じ結果になるだけ。前回の失敗を伝えよう",
    before: "(また) 直して",
    after: "さっきnullチェックを試したけどダメだった。型自体をOptionalにする方向で",
  },
  {
    headline: "「ログ出力を足して」と頼むと、次のデバッグがめちゃ楽になるよ",
    before: "原因がわからない、直して",
    after: "processOrder の各ステップに console.log を足して、どこで止まるか見せて",
  },
  {
    headline: "スタックトレースは「切り取る」より「そのまま貼る」が正解! 行番号がAIのヒントになる",
    before: "エラーが出た。UserListが悪いっぽい",
    after: "このスタックトレース:\nError: ...\n  at UserList (src/UserList.tsx:15:23)",
  },
  {
    headline: "「テストも一緒に書いて」の一言で、AIが自分で品質チェックしてくれる",
    before: "ソート機能を追加して",
    after: "sortByDate 関数を作って。テストも書いて、昇順/降順両方カバーすること",
  },
  {
    headline: "型をしっかり指定すると、AIのコード補完精度が格段に上がるよ",
    before: "データを取得する関数を作って",
    after: "User型の配列を返す fetchUsers(): Promise<User[]> を作って。User型は types.ts に定義済み",
  },
  {
    headline: "「修正後に npm test を実行して」と足すだけで、壊れたのに気づかない事故を防げる",
    before: "バグ修正して",
    after: "バグ修正して、修正後に npm test を実行して結果を見せて",
  },
  {
    headline: "複数ファイルの変更は、先に影響範囲を聞いてから頼むと安全だよ",
    before: "このインターフェースを変更して",
    after: "UserService のインターフェースを変えたい。まずどのファイルが影響受けるかリストして",
  },
  {
    headline: "/clear でコンテキストをリセットすると、AIの応答が速くなるよ!",
    before: null,
    after: null,
  },
  {
    headline: "CLAUDE.md にプロジェクトのルールを書いておくと、毎回説明しなくて済む!",
    before: "毎回「TypeScriptで書いて」と言ってる",
    after: "CLAUDE.md に「言語: TypeScript, テスト: vitest, スタイル: セミコロンなし」と書いておく",
  },
  {
    headline: "大きなタスクは小さく分割! 1つずつ確認しながら進めると手戻りが激減するよ",
    before: "ECサイトのバックエンドを全部作って",
    after: "まず商品一覧の GET /products API だけ作って。DBはSQLiteでいい",
  },
  {
    headline: "git commit してから大きな変更を頼むと、いつでも巻き戻せて安心だよ",
    before: "(大きなリファクタをいきなり頼む)",
    after: "まず git commit して。その後、src/api.ts をリファクタして",
  },
  {
    headline: "/compact で会話を圧縮すると、応答速度が改善するよ。ctx 50%超えたら検討して",
    before: null,
    after: null,
  },
  {
    headline: "タスクが変わったら新セッション! 過去の会話が邪魔して精度が下がることがあるよ",
    before: "(前のタスクの会話が残ったまま別作業)",
    after: "/clear してから新しいタスクを始める。または新ターミナルで claude 起動",
  },
  {
    headline: "AIに「なぜそうしたか」を聞くと、コードの理解が深まるし間違いにも気づきやすいよ",
    before: null,
    after: null,
  },
  {
    headline: "行番号や関数名で範囲を絞る方が、「ファイル全部見て」より効率的!",
    before: "このファイル全部見て",
    after: "src/utils.ts の 42行目あたりの getUser 関数を見て",
  },
  {
    headline: "テストを先に書いてもらうと、実装の品質がグンと上がる (TDD)",
    before: "ソート機能を追加して",
    after: "sortByDate 関数を作って。先にテストを書いてから実装して",
  },
  {
    headline: "「原因を推測して、まだ直さないで」が安全なデバッグ流だよ",
    before: "これ直して (→AIが推測で直して別バグ発生)",
    after: "このエラーの原因を推測して。まだコードは変えないで",
  },
  {
    headline: "「問題点を指摘して」でAIにレビューさせると、バグ予防になるよ",
    before: "(書いたコードをそのまま使う)",
    after: "この関数のエッジケースやバグの可能性を指摘して",
  },
  {
    headline: "「このコードを説明して」は学習に最強。理解を深めるのにAIを使おう",
    before: null,
    after: null,
  },
  {
    headline: "わからないことは「わからない」でOK! 平易な言い方でもAIは理解できるよ",
    before: null,
    after: null,
  },
  {
    headline: "「今こうなってる、こうしたい、でもこれが邪魔」の3点を書こう",
    before: "(何を頼めばいいかわからない)",
    after: "今ログイン画面を作ってる。OAuthも対応したいが、まずメール/パスワードだけでいい",
  },
  {
    headline: "1つの指示で1つのこと。欲張ると全部中途半端になりがちだよ",
    before: "あれもこれもそれも全部やって",
    after: "まずログインAPIだけ作って。確認できたら次の機能を頼む",
  },
  {
    headline: "ここまで順調! いい指示の出し方を続けていこう!",
    before: null,
    after: null,
  },
  {
    headline: "AIはペアプロのパートナー。「どう思う?」って相談すると良い提案が出やすいよ",
    before: "これをやれ (一方的な命令)",
    after: "こういう問題があるんだけど、どうアプローチするのがいいと思う?",
  },
  {
    headline: "@ファイル名 でファイル内容を直接注入できるよ。AIが探す手間とトークンを節約!",
    before: "src/utils/auth.js を見て",
    after: "@src/utils/auth.js このファイルの validateToken を修正して",
  },
  {
    headline: "2回修正してダメなら /clear して最初から。失敗コンテキストが邪魔してるかも",
    before: "(同じバグに3回目の修正指示)",
    after: "/clear して、「さっき○○と△△を試したがダメだった。別のアプローチで」と新規指示",
  },
  {
    headline: "/btw で聴いた質問はコンテキストに残らないよ。ちょっとした確認に便利!",
    before: null,
    after: null,
  },
  {
    headline: "Esc×2 でリワインド! 任意の時点に会話もコードも巻き戻せるよ",
    before: "(失敗した変更を手動で戻す)",
    after: "Esc×2 → リワインドメニューで好きな時点に巻き戻し",
  },
  {
    headline: "大きな機能の前に「AIにインタビューさせてスペックを作る」と設計漏れが減るよ",
    before: "認証機能を作って",
    after: "認証機能を作りたい。まず要件をインタビューしてSPEC.mdにまとめて",
  },
  {
    headline: "実装とレビューは別セッションで! 自分のコードへのバイアスなしにチェックできる",
    before: "(書いた直後に同じセッションでレビュー)",
    after: "実装後、新セッションで @src/middleware/auth.ts をレビュー。エッジケースと競合を確認",
  },
  {
    headline: "/effort low で簡単なタスクを高速化。複雑な時は ultrathink で深く考えさせよう",
    before: null,
    after: null,
  },
  {
    headline: "claude --resume セッション名 で前回の作業に復帰できるよ",
    before: "(前回の作業内容を最初から説明し直す)",
    after: "claude --resume auth-refactor で前回のコンテキストごと復帰",
  },
  {
    headline: "/compact に「何を残すか」を指示できるよ。大事な情報が圧縮で消えるのを防げる",
    before: "/compact",
    after: "/compact APIの変更内容とテストコマンドは必ず保持して",
  },
  {
    headline: "CLAUDE.md は200行以下が理想。詳細な手順は .claude/skills/ に分離しよう",
    before: "CLAUDE.md にPRレビュー手順、DBマイグレ、API規約を全部書く",
    after: ".claude/skills/pr-review/SKILL.md や .claude/skills/db-migrate/SKILL.md に分離",
  },
  {
    headline: "Hooks で「編集後に自動lint」「特定フォルダへの書き込みブロック」等を確実に実行できるよ",
    before: "CLAUDE.md に「編集後は必ずeslintを実行して」と書く",
    after: "settings.json の hooks.PostToolUse に eslint 自動実行を設定",
  },
  {
    headline: "--worktree で並列作業を安全に! ファイル変更が衝突しないよ",
    before: "(同じブランチで2つのタスクを同時進行)",
    after: "claude --worktree feature-auth で独立したワークツリーを自動作成",
  },
  {
    headline: "Ctrl+G でプランを外部エディタで編集できるよ。複雑な計画はエディタで細かく調整しよう",
    before: null,
    after: null,
  },
  {
    headline: "gh, aws, gcloud 等のCLIツールはMCPよりトークン効率が良いよ。既存CLIがあるならそっちを使おう",
    before: "GitHub MCP サーバーをセットアップしてPRを作る",
    after: "gh pr create で直接PRを作る (トークン節約)",
  },
  {
    headline: "!コマンド で実行結果がそのまま会話に入るよ。!git status や !npm test でトークン節約",
    before: "git status の結果を貼り付けて「これを見て」",
    after: "!git status と打つだけでAIが結果を見て判断してくれる",
  },
  {
    headline: "Ctrl+S で書きかけのプロンプトを一時退避。割り込み対応後に自動復帰するよ",
    before: null,
    after: null,
  },
  {
    headline: "Ctrl+B で長時間処理をバックグラウンド実行。待たずに次の作業へ進めるよ",
    before: "(テスト実行中に待ちぼうけ)",
    after: "Ctrl+B でバックグラウンドに回して、別の質問を投げる",
  },
  {
    headline: "Ctrl+R で過去に使ったプロンプトを検索・再利用できるよ。同じ指示の再入力不要!",
    before: null,
    after: null,
  },
  {
    headline: "# プレフィックスでプロジェクトメモリに即永続化。「# テストは jest で書くこと」のように使えるよ",
    before: "「このプロジェクトでは jest 使って」と毎回伝える",
    after: "# テストは必ず jest で書くこと → 次回から自動で覚えてる",
  },
  {
    headline: "claude --continue でクラッシュや誤終了から作業復元できるよ。作業が消えても安心",
    before: null,
    after: null,
  },
  {
    headline: "/loop 5m npm test で定期実行。テスト監視やビルドチェックに便利だよ",
    before: "手動で定期的に npm test を実行",
    after: "/loop 5m npm test で自動監視。失敗したらすぐ気づける",
  },
  {
    headline: "/simplify で「再利用・品質・効率」の3観点で並列レビュー。コード品質を網羅的にチェック",
    before: "「レビューして」とだけ頼む",
    after: "/simplify で自動的に3エージェントが並列チェック",
  },
  {
    headline: "/security-review で変更内容のセキュリティスキャン。マージ前に習慣づけよう",
    before: null,
    after: null,
  },
  {
    headline: "/schedule でクラウド定期実行。「毎朝テスト実行→Slack通知」など自動化できるよ",
    before: "毎朝手動でテストを実行して結果を確認",
    after: "/schedule 毎朝9時に npm test を実行してSlackに通知して",
  },
  {
    headline: "Agent Teams で独立タスクを並列実行。フロントとバックを同時に進めて開発速度倍増",
    before: "フロント完了→バックエンド着手 の順番待ち",
    after: "Agent Teams でフロントとバックエンドを同時にアサインして並列実行",
  },
] as const;