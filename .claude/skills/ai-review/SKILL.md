---
name: ai-review
description: Run a local AI review on uncommitted git diff using Codex (codex exec) and Claude Code. Use when the user types /ai-review, or asks to "ローカル差分をレビュー", "未コミットの変更をレビュー", "コミット前にAIレビュー", "Codexでレビュー", or wants a pre-commit / pre-PR review of local changes. Outputs Markdown and HTML reports under .review-reports/. Does NOT modify source code.
metadata:
  author: sinoda
---

# AI Review Skill (/ai-review)

ローカルの **未コミット差分** を Codex と Claude Code の二重レビュー + セキュリティ観点で点検し、Markdown / HTML レポートを保存する。

## 厳守事項

- **ソースコード・設定ファイル・package.json・lockfile を一切変更しない**
- **コミット・push・PR 作成・マージを一切行わない**
- 許可される書き込みは `.review-reports/` 配下の Markdown / HTML レポートのみ
- `.review-reports/` は **ローカル確認専用の生成物**。原則コミット対象にせず、`.gitignore` 未登録なら追記を **提案** する（直接書き換えない。§7.8）
- 実行環境は **macOS / Linux の bash** 前提（旧 Windows PowerShell 版から移植済み）

## 1. レビュー対象

標準では **未コミット差分のみ**。現在ブランチ全体・リポジトリ全体は対象外（ユーザーが明示指示した場合のみ拡張）。

対象差分は以下を **すべて結合** して取得する。`git diff HEAD` だけでは untracked ファイルが拾えないため、untracked を明示的に inline する必要がある。

```bash
git status --short
git diff --stat
git diff HEAD                                   # tracked の変更
git ls-files --others --exclude-standard        # untracked 一覧
# untracked は各ファイルを cat で本文取得して inline 連結
```

差分が空（tracked 変更ゼロ かつ untracked ゼロ）なら「対象なし」として終了する。

### 1.1 レビュー対象外ファイル

untracked ファイルを inline 連結する前に、以下はレビュー対象から除外する。Codex は **外部モデルに本文を送る**ため、秘密情報・巨大ファイル・バイナリを流さないことが目的。

- `.review-reports/` 配下
- `node_modules/`, `.git/`, `.next/`, `dist/`, `build/`, `coverage/`
- 画像・動画・PDF・zip・DB・その他バイナリファイル
- 1 ファイルあたり 200KB を超えるファイル
- `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.crt`, `*.cert`
- `*.log`, `*.dump`, `*.sqlite`, `*.db`

シークレット候補（`.env*` / 鍵・証明書類）は **本文を読み込まず、ファイル名のみ** をレポートに表示する。tracked diff 側にこれらの拡張子の変更が現れた場合も、本文をそのまま Codex へ送る前に同様の警戒を払う（混入していれば結論で警告する）。

除外したファイルは、レポートの「レビュー対象外ファイル」一覧に表示し、「AI が何を見て／何を見なかったか」を明確にする。

バイナリ判定の簡便法（bash）：`git` の属性に頼らず、テキストかどうかは以下で判定できる。

```bash
# NUL バイトを含めばバイナリとみなす
is_text() { ! LC_ALL=C grep -qI . "$1" 2>/dev/null && return 1 || return 0; }
# サイズ判定（200KB 超を除外）
too_big() { [ "$(wc -c < "$1")" -gt 204800 ]; }
```

## 2. 実行フロー

1. CWD が Git リポジトリかを確認（`git rev-parse --is-inside-work-tree`）。リポジトリでなければユーザーに通知して中断。
2. `git status --short` / `git diff --stat` / `git diff HEAD` を取得する。さらに `git ls-files --others --exclude-standard` で untracked ファイル一覧を取得する。ただし **§1.1 のレビュー対象外ファイルは本文を読み込まず、対象外一覧に記録する**（`.review-reports/` 配下を含む。§7.8）。レビュー対象となる untracked テキストファイルのみ `cat` で読み込み、「`=== NEW FILE: <path> ===`」見出し付きで inline 連結する。tracked 差分もレビュー対象 untracked も無ければ「未コミット変更なし」と表示して終了する。
3. **Codex 実行**（下記§3）。`codex exec` を **stdin パイプ + バックグラウンド実行 + タイムアウト** で安全に呼び出し、最終回答だけを取得する。
4. **Claude Code レビュー**（下記§4）。差分を自分で読んで独立に観点を洗う。
5. Codex と Claude Code の指摘を **統合・差分整理**（両方／Codex のみ／Claude Code のみ）。
6. High / Medium / Low に分類し、修正優先順位を決定。
7. §6 のレポートテンプレに沿って画面出力。
8. `.review-reports/ai-review-<timestamp>.md` と `.html` の **両方** を保存。
9. 対象リポジトリの `.gitignore` に `.review-reports/` が登録されているか確認し、未登録なら追記を **提案** する（§7.8。スキルは `.gitignore` を直接書き換えない）。
10. 末尾に「**コミット後、push 前に `/security-review` を実行する**」旨を必ず出す。未コミット状態のまま `/security-review` を実行するようには案内しない（§8 の 2 段ゲートと揃える）。

## 3. Codex 実行仕様

対話モードは使わず、必ず `codex exec` で呼び出す。bash（macOS / Linux）環境では以下の **注意点** があるため、サンプル実装を厳守すること。

### 3.1 bash での注意点（必読）

1. **stdin を閉じないと無限ハング** — `codex exec` は引数で prompt を渡しても stdin の EOF を待つ。Claude Code の Bash 起動だと stdin が開きっぱなしになり、「Reading additional input from stdin...」で永遠に止まる。
   - 対策: `codex exec - < "$promptFile"` のように **stdin をファイルリダイレクトで渡す**（パイプでも可だが、リダイレクトの方が EOF が確実）。末尾のハイフン `-` で「prompt は stdin から」を明示する。
2. **`--sandbox read-only` でツールが失敗することがある** — sandbox 指定が環境と噛み合わないと codex 内部ツールが失敗し、結果モデルが諦めて「貼ってください」と返してくる。
   - 対策: `--sandbox` は **指定しない**（`~/.codex/config.toml` に委ねる）か、明示するなら `--sandbox danger-full-access`。本スキルは inline 済みで codex に shell を叩かせない設計なので、sandbox 無指定で十分。
3. **プロンプトを引数で渡すと先頭 1 行しか届かないことがある** — 巨大プロンプトを引数渡しすると user ブロックに 1 行目しか入らない事例あり。
   - 対策: プロンプトは **必ず一時ファイル経由で stdin に流す**。引数渡し禁止。
4. **`timeout` コマンドが無い環境がある** — macOS には標準で `timeout` が無い（`coreutils` を入れれば `gtimeout`）。依存させず、§3.3 の **自前ポーリング方式**でタイムアウトを実装する。

### 3.2 プロンプト本体（CRITICAL CONSTRAINTS 必須）

Codex に shell を叩かせず、inline 内容だけで応答させるため、プロンプト先頭に強制制約を入れる。

```text
CRITICAL CONSTRAINTS:
- DO NOT execute ANY shell, git, or filesystem commands. Everything is inlined below.
- DO NOT modify files. Answer immediately from the inlined content.
- Output in Japanese.

TASK:
Review the following uncommitted local changes (tracked diff + untracked file bodies).
Focus on correctness, security, maintainability, and production risk.
For each finding include: severity (High/Medium/Low), file, problem, why it matters, suggested fix.
Group findings by severity. If there are no real issues, say so clearly.

QUALITY RULES:
- Do not invent issues.
- Prefer concrete, actionable findings over generic advice.
- If a finding depends on missing context, mark it as Low confidence.
- If the diff is insufficient to judge, say "判断不能" and explain what information is missing.
- Do not suggest broad rewrites unless the risk is concrete.

---CONTEXT---
<git status --short の出力>

---DIFF (tracked)---
<git diff HEAD の出力>

---NEW FILES (untracked)---
=== NEW FILE: path/to/file1 ===
<cat の本文>
=== NEW FILE: path/to/file2 ===
<...>
```

### 3.3 bash サンプル（動作確認済みの形）

`timeout` コマンドに依存しない自前ポーリング方式。`codex` をバックグラウンドで起動し、最大 300 秒待つ。期限超過なら kill して CC 単独に縮退する。

```bash
#!/usr/bin/env bash
set -uo pipefail

# --- プロンプトを一時ファイルに用意（引数渡し禁止・stdin 経由） ---
prompt_file="$(mktemp -t ai-review-prompt.XXXXXX)"
out_file="$(mktemp -t ai-review-out.XXXXXX)"
cleanup() { rm -f "$prompt_file" "$out_file"; }
trap cleanup EXIT

cat > "$prompt_file" <<EOF
CRITICAL CONSTRAINTS:
- DO NOT execute ANY shell, git, or filesystem commands. Everything is inlined below.
- DO NOT modify files. Answer immediately from the inlined content.
- Output in Japanese.

TASK:
（上記§3.2 のテンプレ）

---CONTEXT---
${status_short}

---DIFF (tracked)---
${diff_head}

---NEW FILES (untracked)---
${untracked_inlined}
EOF

# --- codex の解決（.cmd / %APPDATA% といった Windows 依存は撤廃）---
codex_bin="$(command -v codex || true)"

if [ -z "$codex_bin" ]; then
  codex_output="[Codex not found: codex が PATH にありません。CC 単独レビューに縮退]"
else
  # codex をバックグラウンドで起動。
  # --skip-git-repo-check: trusted-directory 判定で詰まらないための保険。
  #   手順1で repo 内を保証済みなので -C は常に repo を指し副作用はない。
  # --output-last-message: stdout の前置きノイズを避け最終回答のみをファイルに取る。
  "$codex_bin" exec \
      --skip-git-repo-check \
      -C "$PWD" \
      --output-last-message "$out_file" \
      - < "$prompt_file" >/dev/null 2>&1 &
  codex_pid=$!

  # --- 自前タイムアウト（300s）。timeout コマンド不要 ---
  timeout_sec=300
  elapsed=0
  while kill -0 "$codex_pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_sec" ]; then
      kill "$codex_pid" 2>/dev/null
      sleep 1
      kill -9 "$codex_pid" 2>/dev/null
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  wait "$codex_pid" 2>/dev/null
  rc=$?

  if [ "$elapsed" -ge "$timeout_sec" ]; then
    codex_output="[Codex timeout: 300s 経過。CC 単独レビューに縮退]"
  elif [ -s "$out_file" ]; then
    codex_output="$(cat "$out_file")"   # 最終回答だけ取れる
  else
    codex_output="[Codex error: 出力が空 (rc=$rc)。CC 単独レビューに縮退]"
  fi
fi
```

### 3.4 実装メモ

- `--output-last-message <file>` を使うと stdout の前置きノイズを避けて **最終回答だけ** をファイルに取れる。パース不要。
- `codex` の解決は `command -v codex` のみ。Windows 版にあった `codex.cmd` / `%APPDATA%\npm` フォールバックは Mac/Linux では不要なので撤廃した。見つからなければ Codex をスキップして CC 単独に縮退する。Mac で codex 未導入なら `npm i -g @openai/codex` で導入できる。
- `codex exec` は **git リポジトリ（trusted directory）外だと `Not inside a trusted directory and --skip-git-repo-check was not specified` で空振り**する。本スキルは手順1で repo 内を保証するため通常は問題ないが、codex 側の trusted 判定とのズレで詰まらないよう `--skip-git-repo-check` を付けておく。これは保険であってフェイルセーフではない。
- Codex がエラー・未インストール・タイムアウトの場合は **その旨をレポートに明記**し、Claude Code 単独レビューを継続する（処理は止めない）。
- diff が極端に大きい時は主要ファイルだけに絞って再試行し、レポートに「一部のみ Codex 確認」と明記する。
- **タイムアウトは自前ポーリング**（§3.3）。`timeout`/`gtimeout` が入っていればそれを使ってもよいが、依存にはしない。`coreutils` を入れている環境なら `gtimeout 300 codex exec ...` でも等価。

## 4. Claude Code レビュー観点

Codex の結果を読んだうえで、**同じ差分を自分でも独立に**レビューする。

汎用観点：

- バグの可能性
- 仕様と実装のズレ
- テスト不足
- 保守性 / 可読性
- 過剰実装 / YAGNI 違反
- 本番事故リスク（DBマイグレ、ロールバック性、リトライ性 等）

セキュリティ観点（必ず全項目を意識する）：

- 認証・認可の不備 / 権限昇格
- シークレット / API キー / 認証情報の漏洩
- XSS / HTML エスケープ漏れ
- SQL インジェクション
- コマンドインジェクション / シェル展開
- SSRF
- パストラバーサル / 任意ファイル読み書き
- 入力値検証不足 / 型チェック漏れ
- 危険なファイル操作（権限・所有者・一時ファイル race）
- 依存関係や設定ファイルの危険な変更（postinstall, lockfile 改ざん, 怪しい新規パッケージ）

## 5. 統合と差分整理

- **両方が指摘**：信頼度が高い → 優先度を一段上げて検討
- **Codex のみが指摘**：観点漏れがないか Claude Code 側で再評価
- **Claude Code のみが指摘**：Codex に見えにくい文脈的指摘として明示

## 6. 出力フォーマット

画面出力と保存レポートは同じ構成。

```markdown
# AI Review Report

## 結論

- 問題あり / 大きな問題なし
- **コミットしてよいか**（このゲートの判定対象）
- **次のステップ**: コミット可なら次に `/security-review` を実行
- `origin/HEAD` 未設定なら設定コマンドを案内

## 対象

- Git status: <git status --short の結果>
- Git diff summary: <git diff --stat の結果>
- Review datetime: <YYYY-MM-DD HH:mm:ss>

## High

| file | issue | reason | fix |
|---|---|---|---|

## Medium

| file | issue | reason | fix |
|---|---|---|---|

## Low

| file | issue | reason | fix |
|---|---|---|---|

## Codex と Claude Code の差分

### Codex だけが指摘したもの

### Claude Code だけが指摘したもの

### 両方が指摘したもの

## 修正優先順位

1.
2.
3.

## 次に実行すべきコマンド

（必要な場合のみ。プロジェクトに該当スクリプトがある場合に限る）

```bash
npm test
npm run lint
npm run typecheck
```

## 次のステップ

このレポートは **push 前の 2 段ゲートの第 1 段（コミット前レビュー）** です。

- 軽微な指摘なら修正してください
- 修正後にコミット → その後 push 前に **必ず `/security-review` を実行** してください
- `origin/HEAD` 未設定なら先に `git remote set-head origin -a` を実行
```

## 7. レポート保存仕様

- 保存先：プロジェクトルート（CWD）配下の `.review-reports/`
- ファイル名：
  - `ai-review-YYYYMMDD-HHMMSS.md`
  - `ai-review-YYYYMMDD-HHMMSS.html`

### 7.1 重要：HTML は Markdown の `<pre>` ラッパで済ませない

旧仕様では Markdown 文字列を `<pre>` で囲んだだけだったが、それでは Markdown 記法（見出し・テーブル・バッジ）がそのまま「文字」として表示され、HTML 版の意味がほぼ無い。

**Claude Code は md と html を別々に組み立てて書き出す**。html 側はセマンティック HTML + CSS で、レビュー結果がダッシュボード風に視認できる形にする（外部 CSS/JS 禁止、スタンドアロン）。

### 7.2 HTML テンプレ方針

`/work-summary` スキルと同方針：

- `<!DOCTYPE html>` から始まるスタンドアロン HTML（外部依存ゼロ）
- `<meta charset="utf-8">` `<meta name="viewport" content="width=device-width,initial-scale=1">` 必須
- フォント: system-ui / Segoe UI / Hiragino Sans / Yu Gothic、行間 1.6、最大幅 880px
- 全体に余白を取り、白カード + 淡いグレー(#f6f7f9)背景
- レスポンシブ（600px 以下は 1 カラム）、`@media print` で背景色を保持

### 7.3 構成要素

1. **ヘッダーカード**
   - タイトル「AI Review Report」
   - メタチップ: 日付 / ブランチ / HEAD short SHA / Codex セッションID
   - リード文（結論を 1〜2 文要約）

2. **サマリーダッシュボード**（auto-fit grid, minmax 160px）
   - High 件数 / Medium 件数 / Low 件数 / 変更ファイル数
   - 各カードに大きい数字 + ラベル、件数に応じて色変更（High>0 なら danger 色）

3. **結論カード**
   - コミット可否 / PR 可否 / `/security-review` 必要可否 をバッジで表示
   - 簡潔な総評

4. **対象カード**
   - Git status / diff stat / Review datetime を `<pre>` ブロックで（暗色テーマ可）

5. **指摘セクション（High / Medium / Low）**
   - 各重大度ごとに「カード + テーブル」で表示
   - テーブル列: `file:line` / issue / reason / fix
   - 重大度バッジを見出しに付ける（danger / warning / success の色分け）
   - High 0 件のときは「該当なし」と表示してテーブルは出さない

6. **Codex / CC 差分セクション**
   - 3 カラム（両方／Codex のみ／CC のみ）のミニカード
   - 600px 以下では縦並びに

7. **修正優先順位カード**
   - 番号付きタイムライン風リスト

8. **次に実行すべきコマンド**
   - 該当する場合のみ、ダーク背景のコードブロック

9. **次のステップカード**（補足）
   - 「push 前の 2 段ゲートの第 1 段」である旨を明示
   - 次のアクションを明確に指示（コミット → `/security-review`）
   - `origin/HEAD` 未設定なら設定コマンドを併記

### 7.4 配色

| 用途 | 色 |
|---|---|
| accent | #2563eb |
| success | #16a34a |
| warning | #f59e0b |
| danger | #dc2626 |
| 本文 | #111827 |
| サブ | #6b7280 |
| カード | #fff |
| 背景 | #f6f7f9 |
| ボーダー | #e5e7eb |
| code 背景 (dark) | #0f172a |
| code 文字 (dark) | #e2e8f0 |

### 7.5 実装手順（CC 用）

1. レビュー結果の構造化データ（findings 配列、結論、ファイル一覧等）を内部で組み立てる
2. **Markdown 版**を §6 のテンプレに沿って文字列で構築 → `.review-reports/ai-review-<ts>.md` に書き出し
3. **HTML 版**を別途、§7.2〜§7.4 の構成と配色で組み立てる（同じデータから 2 形式を生成）。`Write` ツールで直接 HTML 文字列を書き出す
4. テーブルセル内の `<`, `>`, `&` は適切にエスケープ
5. 重大度バッジは `<span class="badge danger">High</span>` のようなクラス指定で

### 7.6 bash ファイル名生成サンプル

```bash
ts="$(date +%Y%m%d-%H%M%S)"
report_dir=".review-reports"
mkdir -p "$report_dir"
md_path="$report_dir/ai-review-$ts.md"
html_path="$report_dir/ai-review-$ts.html"
```

md / html の中身は Claude Code 側で組み立てた文字列を **`Write` ツールで直接ファイル作成** する（`md_path` / `html_path` のパスに対して）。シェルの `cat <<EOF` で書くより Write ツールの方がエスケープ事故が無く安全。

### 7.7 HTML 骨格テンプレ（参考）

```html
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Review Report - <YYYY-MM-DD HH:mm:ss></title>
<style>
:root{--accent:#2563eb;--success:#16a34a;--warning:#f59e0b;--danger:#dc2626;--bg:#f6f7f9;--card:#fff;--text:#111827;--sub:#6b7280;--border:#e5e7eb;--code-bg:#0f172a;--code-fg:#e2e8f0;}
*{box-sizing:border-box;}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic",sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:32px 16px;}
.wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:20px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;}
.header h1{margin:0 0 12px;font-size:1.7rem;}
.lead{color:var(--sub);margin:12px 0 0;}
.meta{display:flex;flex-wrap:wrap;gap:8px;}
.chip{display:inline-block;background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:0.85rem;color:var(--sub);}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;}
.stat .num{font-size:2rem;font-weight:700;color:var(--accent);line-height:1;}
.stat.danger .num{color:var(--danger);} .stat.warning .num{color:var(--warning);} .stat.success .num{color:var(--success);}
.stat .lbl{color:var(--sub);font-size:0.85rem;margin-top:6px;}
h2{margin:0 0 16px;font-size:1.2rem;padding-left:12px;border-left:4px solid var(--accent);}
h2.danger{border-color:var(--danger);} h2.warning{border-color:var(--warning);} h2.success{border-color:var(--success);}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:0.9rem;}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top;}
th{background:var(--bg);font-weight:600;}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;color:#fff;}
.badge.danger{background:var(--danger);} .badge.warning{background:var(--warning);} .badge.success{background:var(--success);} .badge.accent{background:var(--accent);}
.threecol{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
.threecol .mini{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}
.threecol .mini h3{margin:0 0 8px;font-size:0.9rem;}
.tag{display:inline-block;background:#eef2ff;color:var(--accent);border-radius:4px;padding:1px 6px;font-size:0.8rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
code{background:var(--bg);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-size:0.85em;}
pre{background:var(--code-bg);color:var(--code-fg);padding:14px 16px;border-radius:8px;overflow-x:auto;}
pre code{background:transparent;border:0;color:inherit;padding:0;}
ol.priority{list-style:none;padding:0;counter-reset:p;}
ol.priority li{counter-increment:p;position:relative;padding:10px 0 10px 44px;border-bottom:1px dashed var(--border);}
ol.priority li:last-child{border-bottom:0;}
ol.priority li::before{content:counter(p);position:absolute;left:0;top:10px;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;}
@media (max-width:600px){.threecol{grid-template-columns:1fr;}}
@media print{body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.card{break-inside:avoid;}}
</style>
</head>
<body>
<div class="wrap">
  <!-- ヘッダーカード / サマリーダッシュボード / 結論 / 対象 / High / Medium / Low / 差分 / 修正優先順位 / 次のコマンド / 補足 -->
</div>
</body>
</html>
```

HTML 生成は **Claude Code が `Write` ツールで直接組み立てる**。セル内テキストの `<`, `>`, `&`, `"` は Claude Code 側で HTML エスケープしてから埋め込む（XSS 対策。レビュー対象のコード断片を埋め込む箇所では必須）。旧 PowerShell 版の `[System.Net.WebUtility]::HtmlEncode` に相当する処理を、CC が文字列構築時に行う。

### 7.8 `.review-reports/` の扱い（ローカル生成物・push 対象外）

`.review-reports/` 配下の md / html は **ローカル確認専用のレビュー生成物**であり、リポジトリにコミット・push する対象ではない。本スキルは以下を守る：

- **原則コミット対象にしない**。レビュー成果物であってソース変更ではないため、Git 履歴に含めない運用を既定とする。
- **`.gitignore` への追加を提案する**（自動で書き換えない）。厳守事項「設定ファイルを変更しない」に従い、スキルは `.gitignore` を直接編集せず、未登録時にユーザーへ追記を提案して許可を得る。
  ```bash
  # .gitignore に .review-reports/ が登録済みかを確認
  gi="$PWD/.gitignore"
  if [ -f "$gi" ] && grep -Eq '^\s*\.review-reports/?\s*$' "$gi"; then
    has_entry=1
  else
    has_entry=0
  fi
  ```
  未登録なら、次の 1 行を `.gitignore` 末尾に追記するよう提案する：
  ```
  .review-reports/
  ```
- **git status 確認時は別枠で扱う**。§2 でレビュー対象差分を集める際、`.review-reports/` 配下が untracked として現れても **レビュー対象に含めない**（自分の生成物をレビューしないため）。レポートの「対象」セクションに status を載せる場合も、`.review-reports/` のエントリは「レビュー生成物（push 対象外）」として区別する。
- 既に `.gitignore` 登録済み、またはユーザーが「コミットする」と明示した場合はこの限りではない。

## 8. /security-review との関係（push 前の 2 段ゲート）

このスキルは「push 前のローカル品質ゲート」として設計されており、`/security-review` と **直列に組み合わせて使う**前提。両者は対象スコープが異なるため自動連鎖はさせず、ユーザーの手動オペレーションでバトンを渡す。

### 8.1 スコープの違い（重要）

| スキル | 対象差分 | 用途 |
|---|---|---|
| `/ai-review`（本スキル） | **未コミットのローカル変更**（`git diff HEAD` + untracked） | コミットして良いかの判定 |
| `/security-review`（CC 内蔵） | **ブランチ全体**（`origin/HEAD` との差分、= コミット済み変更） | push / PR して良いかの判定 |

未コミット変更は `/security-review` から見えないので、`/ai-review` 中に `/security-review` を自動実行しても **別物を見ることになり価値が薄い**。必ず「コミット → `/security-review`」の順で回す。

### 8.2 推奨ワークフロー（push 前の 2 段ゲート）

```
ローカル変更
   ↓
[ゲート1] /ai-review        ← 未コミット差分の二重レビュー (本スキル)
   ↓ OK
git add / git commit
   ↓
[ゲート2] /security-review  ← ブランチ全体の深掘りセキュリティレビュー
   ↓ OK
git push / PR
```

両方のゲートを通過してから push する。これにより：

- **コミット前**: バグ・保守性・初期セキュリティ点検
- **コミット後 push 前**: 履歴粒度でのセキュリティ最終確認

の二重防御が成立する。

### 8.3 本スキルが必ず守ること

- レビュー観点にセキュリティ項目を **強制的に含める**（§4）— `/security-review` を呼ばなくても主要観点は本スキル単体でカバー
- 結論セクションで「**次に何をすべきか**」を 1 行で明示：
  - 問題なし → 「コミット可。コミット後に `/security-review` を実行してください。」
  - 軽微な指摘 → 「修正後コミットし、その後 `/security-review` を実行してください。」
  - 重大な指摘 → 「コミット不可。修正してから再度 `/ai-review` を実行してください。」
- レポート末尾に **必ず** 次の文言を出す：

> このレポートは **push 前の 2 段ゲートの第 1 段（コミット前レビュー）** です。
> 修正・コミット後は、push の前に必ず `/security-review` を実行してください。

### 8.4 `/security-review` 実行前の前提条件チェック

`/security-review` は `origin/HEAD` を必要とするため、未設定だと `fatal: ambiguous argument 'origin/HEAD...'` で落ちる。本スキルの結論セクションで以下を確認し、未設定なら **設定コマンドを案内** する：

```bash
# 確認
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null

# 未設定なら設定（初回のみ）
git remote set-head origin -a
```

リモートが無いローカル単独リポジトリの場合は、`/security-review` の代替として本スキル単体で完結する旨をレポートに明記する。

## 9. エラーハンドリング

- Git リポジトリでない → 中断してユーザーに通知
- 未コミット差分なし（tracked 変更 0 件 かつ untracked 0 件） → 「対象なし」と表示して終了（レポート保存しない）
- `codex` コマンドが未インストール / 失敗 / **300 秒タイムアウト** → その旨をレポートに記載し、Claude Code 単独レビューを継続
- Codex 出力が「貼ってください」「ファイルを読めません」等の **空振り応答**だった場合も Codex 失敗扱いにし、CC 単独に縮退
- レポート保存に失敗 → エラー内容を表示し、画面出力は出す

## 10. 検証履歴 (2026-05-21)

実機検証で判明した修正済み事項（PowerShell 版時点）：

- P1: `codex exec` を stdin パイプ + Start-Job + Wait-Job タイムアウトで呼び出す形に変更（§3.3）
- P1: `--sandbox read-only` 明示指定をやめて config.toml に委ねる方針へ変更
- P1: プロンプトは一時ファイル経由で stdin に流す（引数渡し禁止）
- P2: プロンプト先頭に `CRITICAL CONSTRAINTS` を追加して shell 実行を抑止
- P2: untracked ファイルを `git ls-files --others --exclude-standard` で別取得し inline 連結する処理を §1, §2 に明記
- P3: `--output-last-message` で最終回答のみを取得する形に統一
- P4 (UX): HTML 出力が `<pre>` ラッパだけで Markdown 記法が解釈されず読みづらかったため §7 を全面書き換え。CC が md と html を別々にセマンティック構築する方針へ変更（§7.1〜§7.7）
- P5 (運用設計): `/security-review` を自動連鎖させる案を検討したが、スコープ（未コミット vs ブランチ全体）が違うため価値が薄いと判断。代わりに「push 前の 2 段ゲート」として `/ai-review` → コミット → `/security-review` の直列運用を §8 で正式化。`origin/HEAD` 未設定時の対処もスキル側で案内するように変更
- P6 (運用設計): `.review-reports/` をローカル確認専用の生成物と位置づけ、push 対象外とする運用を §7.8 に追加。`.gitignore` 未登録時は追記を提案（スキルは直接書き換えない）、untracked 一覧からは除外、git status 表示時も別枠扱いとする方針を §冒頭・§2・§7.8 に明記

## 11. 改善履歴 (2026-05-26)

- P7 (安全化・堅牢化):
  - untracked を inline する前に **レビュー対象外フィルタ**（シークレット候補・バイナリ・200KB 超・ビルド生成物）を適用する方針を §1.1 に新設し、§2 手順2 に配線。Codex は外部モデルへ本文を送るため、`.env`/鍵/証明書は **本文を読まずファイル名のみ**表示する
  - Codex プロンプトに `QUALITY RULES` を追加（過剰・憶測指摘の抑止、判断不能の明示、安易な全面書き換え提案の禁止）— §3.2
  - `codex.cmd` の固定パスをやめ、`Get-Command codex.cmd` 解決 + `%APPDATA%` フォールバック + 存在チェック（無ければ CC 単独に縮退）へ変更 — §3.3 / §3.4（※ macOS 版で `command -v codex` に再変更、下記 P9）
  - `/security-review` の案内を「**コミット後・push 前**」に統一し、未コミットでの実行は案内しない旨を明記 — §2 手順10
  - 検討の結果見送った案: 冒頭の「位置づけ」節追加 / 「レビュー範囲」固定テーブル / コミット可否の数値基準明文化（既存 §8.3 と重複・硬直化のため、今回は不採用）
- P8 (実機検証 2026-05-27): codex-cli 0.130.0 で end-to-end 動作を確認。`Get-Command codex.cmd` 解決 + stdin パイプ + `--output-last-message` で最終回答のみ取得できることを実証（認証OK、model gpt-5.5）。検証中に **repo 外だと `Not inside a trusted directory` で空振りする**ことが判明したため、`codex exec` に `--skip-git-repo-check` を追加（§3.3 / §3.4）。位置づけは「trusted 判定で詰まらない保険」であり、フェイルセーフ本体は §9 のタイムアウト→CC 単独縮退である点をコメントに明記

## 12. macOS / Linux 移植 (2026-05-30)

- P9 (bash 移植): Windows → Mac 環境移行に伴い、PowerShell 前提だった本スキルを **bash（macOS / Linux）版に全面移植**。
  - 環境前提を「Windows PowerShell」→「macOS / Linux の bash」に変更（§冒頭・§3 / §3.1）
  - データ取得コマンドを PowerShell → bash に置換：`Get-Content -Raw` → `cat`、`Get-Date -Format` → `date +%Y%m%d-%H%M%S`、`New-TemporaryFile` → `mktemp`、`Test-Path`/`Select-String` → `[ -f ]`/`grep -Eq`（§1 / §2 / §7.6 / §7.8 / §8.4）
  - **Codex 起動を Start-Job/Wait-Job → bash のバックグラウンド実行（`&`）+ 自前ポーリング・タイムアウト**に置換（§3.3）。macOS には標準 `timeout` が無いため、`timeout`/`gtimeout` に**依存しない** kill ベースの 300s タイムアウトを実装。`coreutils` 導入済みなら `gtimeout 300 codex exec ...` でも等価（§3.4）
  - **codex 解決を `command -v codex` のみ**に簡素化。Windows 固有の `codex.cmd` / `%APPDATA%\npm` フォールバックを撤廃（§3.3 / §3.4）。未導入時は `npm i -g @openai/codex` を案内
  - sandbox 注意書きを Windows 固有エラー（`CreateProcessAsUserW failed: 5`）から汎用表現に修正（§3.1）
  - HTML エスケープを `[System.Net.WebUtility]::HtmlEncode` 依存から「CC が Write ツールで構築時にエスケープ」する方針に変更（§7.7）
  - レポート/サンプルのコードブロック言語を `powershell` → `bash` に統一（§1 / §3.3 / §6 / §7.6 / §7.8 / §8.4）
  - 設計・観点・出力フォーマット・2 段ゲート運用（§4〜§8）は OS 非依存のため**変更なし**
