---
name: ai-review
description: Push 前の唯一の AI レビューゲート。組み込み /code-review（Opus 5）と Codex 純正 review（gpt-5.6-sol）をブラインドで並列起動し、突合して Markdown/HTML レポートを .review-reports/ に保存。高リスク差分は /security-review を自動で追加起動する。Use when the user types /ai-review, or asks to "レビューして", "push 前に見て", "ブランチをレビュー", "未コミットをレビュー". Does NOT modify source code.
metadata:
  author: sinoda
  version: 2.0.0
---

# AI Review Skill v2 (/ai-review)

push 前の**唯一のゲート**。レビュー本体は書かない。組み込み `/code-review` と Codex 純正 `codex exec review` を**独立・並列**に走らせ、結果を突合し、条件に該当すれば `/security-review` を**自動で**追加起動する。設計根拠は同ディレクトリの `DESIGN-v2.md`（正本）。v1 は `SKILL.md.v1`。

## 厳守事項

- ソースコード・設定ファイル・lockfile を変更しない。コミット・push・PR 作成をしない。
- 書き込みは `.review-reports/` 配下のみ（レポート md/html、`latest.json`、各実行の生出力）。`--local` モードの `git add -A` だけは例外（§3.2）。
- レビュー観点をこのスキルが自前で持たない。判定は純正コマンドの出力に従い、自分は**突合と検証**だけを行う。
- モデルと effort はスクリプト内で固定（Claude: `claude-opus-5`/high、Codex: `gpt-5.6-sol`/high）。セッションのモデルに関わらず固定値で走る。
- 昇格判定はスクリプトの grep 結果に従う。自分の判断で「これは低リスクだから昇格不要」としない。
- 昇格をスキップできるのは**ユーザーが明示した場合のみ**。その場合は `latest.json` に記録する。

## 1. 構成要素

| ファイル | 役割 |
|---|---|
| `scripts/escalation-check.sh` | 昇格判定（パス／追加行／規模／秘密情報）。JSON を返す。モデル不使用 |
| `scripts/run-reviews.sh` | `/code-review` と Codex review を並列起動。`--security` で `/security-review` 単独起動 |
| `scripts/record-gate.sh` | `latest.json` を書く（pre-push フックが読む） |
| `escalation-rules.txt` | 昇格パターンの既定。プロジェクト追記は `.ai-review/escalation-rules.local.txt` |
| `hooks/pre-push` | ブロック型フック（`~/.git-hooks/pre-push` に配置して使う） |

`$SKILL` = `~/.claude/skills/ai-review` として以下に記す。

## 2. スコープ

| 呼び方 | 対象 | 用途 |
|---|---|---|
| `/ai-review`（既定） | `origin/HEAD`（merge-base）から HEAD までの**コミット済み差分** | push 前の必須ゲート |
| `/ai-review --local` | 未コミット差分（staged + unstaged + untracked） | 途中の任意チェック。何度でも |

既定モードで未コミット変更が残っていれば「先に commit してください」と伝えて中断する（ゲートは HEAD の SHA に紐づくため）。

## 3. 実行フロー

### 3.1 前提確認
```bash
git rev-parse --is-inside-work-tree            # 非リポジトリなら中断
git symbolic-ref -q --short refs/remotes/origin/HEAD || echo "origin/HEAD 未設定"
```
`origin/HEAD` 未設定なら `git remote set-head origin -a` を案内して中断（`/security-review` が `origin/HEAD...` 固定のため）。リモートが無いローカル単独リポジトリでは `--local` のみ対応と伝える。

### 3.2 差分取得・昇格判定（機械）
```bash
ts="$(date +%Y%m%d-%H%M%S)"; run=".review-reports/run-$ts"; mkdir -p "$run"
$SKILL/scripts/escalation-check.sh > "$run/escalation.json"        # 既定
$SKILL/scripts/escalation-check.sh --local > "$run/escalation.json"  # --local のとき
cat "$run/escalation.json"
```
- `error` があれば内容を伝えて中断。
- `secret_paths` が空でなければ、**Codex を起動しない**（外部モデルに秘密情報を送らない）。ファイル名だけレポートに載せ、`--no-codex` で続行する。
- `escalate` と `reasons` を保持する（⑤で使う）。
- `--local` のとき、`/code-review` は staged 差分しか見ないため、起動前に `git add -A` を実行してよい（唯一の許可された状態変更。終了後 `git reset -q` で戻す）。

### 3.3 純正レビューを並列起動（ブラインド）
```bash
$SKILL/scripts/run-reviews.sh --out "$run"                    # 既定
$SKILL/scripts/run-reviews.sh --out "$run" --local            # --local
$SKILL/scripts/run-reviews.sh --out "$run" --no-codex         # 秘密情報混入時
```
- 出力: `$run/code-review.md`、`$run/codex-review.md`、`$run/status.txt`。
- 自分はこの間、**どちらの出力も読まない**。両方が終わってから読む（独立性の確保）。
- `status.txt` に `EMPTY` / `TIMEOUT` があれば、その側を「未取得」としてレポートに明記し、残った側だけで続行する。両方未取得なら結論を `block` にして中断。

### 3.4 突合（ここだけが自分の仕事）
両出力を読み、指摘を 1 件ずつ次の 3 区分に振り分ける。

| 区分 | 扱い |
|---|---|
| 両方が指摘 | 採用。ただし根拠が「〜のはず」「〜なら」という**仮定**に依存していれば、参照先コード（呼び出し先・設定値・properties）を Read して確認する。確認できなければ Low に落とす |
| 片方だけが指摘 | **裁定しない**。指摘の根拠となる箇所を Read し、事実で検証する。検証できれば採用、否定できれば「検証の結果不採用」として理由付きで記録、どちらでもなければ Medium で残す |
| 判定が割れた | 同上。加えて**セキュリティ分類の指摘で割れた場合は `escalate=true` にする**（E 条件） |

セキュリティ分類（injection / XSS / SSRF / path traversal / auth / crypto / deserialization / secrets 等）の指摘がどちらか一方にでも 1 件あれば `escalate=true` にする（D 条件）。

重大度は High / Medium / Low。結論は次の 3 択:
- `pass`: High なし → push 可
- `fix`: Medium 以下のみ → 直すか流すかはユーザー判断。push 可
- `block`: High あり → push 不可

### 3.5 昇格（自動）
`escalate=true` なら**確認せずに**起動する:
```bash
$SKILL/scripts/run-reviews.sh --out "$run" --security
```
- 出力 `$run/security-review.md` を読み、確信度付きの指摘をレポートの「昇格レビュー」節に追記する。
- `/security-review` は確信度 8 未満を落とす設計なので、§3.4 で採用した指摘が `security-review.md` に無くても**取り下げない**（「精度優先の裁定では閾値未満」とだけ注記）。逆に `/security-review` だけが挙げた指摘は攻撃シナリオ付きなので High として採用する。
- ユーザーが**明示的に**「昇格スキップ」と言った場合のみ起動しない。理由を聞き、`latest.json` に `skipped_by_user=true` と理由を記録する。
- `--local` モードでは昇格しない（`/security-review` はコミット済み差分しか見ない）。`escalate=true` は結果に注記するだけ。

### 3.6 レポート生成
`$run/report.md` と `$run/report.html` を Write ツールで書く（§4）。`.review-reports/latest.md` / `latest.html` にもコピーする。

### 3.7 ゲート記録
```bash
$SKILL/scripts/record-gate.sh --verdict <pass|fix|block> \
  --escalate <true|false> --escalation-done <true|false> \
  [--skipped-by-user true --reason "<ユーザーの理由>"] \
  --report "$run/report.md" --mode <branch|local>
```
`--local` のときは `--mode local` を付ける（フックは `branch` の記録しか有効とみなさない設計にはしていないが、監査用に区別する）。

### 3.8 終了時の案内
- `.gitignore` に `.review-reports/` が無ければ追記を**提案**する（自分では書き換えない）。
- 結論を 1 行で: 「push 可」「修正後 push 可（Medium n 件）」「push 不可（High n 件）」。
- `pre-push` フック未導入なら導入方法を一度だけ案内する（§6）。

## 4. レポート形式

### 4.1 Markdown（`report.md`）
```markdown
# AI Review Report v2

## 結論
- 判定: pass / fix / block
- 昇格: 発動（理由: A:path:src/auth/login.ts） / 非該当 / スキップ（ユーザー指示: ...）
- 次の一手: push 可 / 修正後 push / 修正して再実行

## 対象
- Base: origin/main (merge-base abc1234) → HEAD def5678 / branch feat/xxx
- 変更: N files, +A/-D
- 実行: /code-review (claude-opus-5/high, 3m12s) ‖ codex exec review (gpt-5.6-sol/high, 2m40s)
- レビュー対象外: .env（秘密情報のため Codex 未送信）

## High
| file:line | issue | 根拠 | 出所 | fix |
## Medium
## Low

## 突合
### 両方が指摘（n 件）
### /code-review のみ（n 件）— 検証結果
### Codex のみ（n 件）— 検証結果
### 判定が割れたもの（n 件）— 検証結果

## 昇格レビュー（/security-review）
（発動時のみ。確信度・攻撃シナリオ・修正案をそのまま転記）

## 生出力
- .review-reports/run-<ts>/code-review.md
- .review-reports/run-<ts>/codex-review.md
- .review-reports/run-<ts>/security-review.md
```

「出所」列は `両方` / `code-review` / `codex` / `security-review`。この列を蓄積して「片方だけが拾った本物の指摘」を後から集計する（DESIGN-v2.md §8）。

### 4.2 HTML（`report.html`）
Markdown を `<pre>` で包まない。同じデータから別途組み立てる。スタンドアロン（外部 CSS/JS なし）、`<meta charset="utf-8">` と viewport 必須、最大幅 880px、白カード + `#f6f7f9` 背景、`@media print` で背景保持。構成は §4.1 と同順で、冒頭に High/Medium/Low/変更ファイル数のサマリーカード、結論バッジ（pass=success / fix=warning / block=danger）、昇格状態バッジを置く。セル内の `<` `>` `&` `"` は必ずエスケープする。

CSS 骨格（v1 §7.7 と同じ。そのまま使ってよい）:
```css
:root{--accent:#2563eb;--success:#16a34a;--warning:#f59e0b;--danger:#dc2626;--bg:#f6f7f9;--card:#fff;--text:#111827;--sub:#6b7280;--border:#e5e7eb;--code-bg:#0f172a;--code-fg:#e2e8f0;}
*{box-sizing:border-box;}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic",sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:32px 16px;}
.wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:20px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;}
.stat .num{font-size:2rem;font-weight:700;color:var(--accent);line-height:1;}
.stat.danger .num{color:var(--danger);} .stat.warning .num{color:var(--warning);} .stat.success .num{color:var(--success);}
h2{margin:0 0 16px;font-size:1.2rem;padding-left:12px;border-left:4px solid var(--accent);}
h2.danger{border-color:var(--danger);} h2.warning{border-color:var(--warning);} h2.success{border-color:var(--success);}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:0.9rem;}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top;}
th{background:var(--bg);font-weight:600;}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:600;color:#fff;}
.badge.danger{background:var(--danger);} .badge.warning{background:var(--warning);} .badge.success{background:var(--success);} .badge.accent{background:var(--accent);}
pre{background:var(--code-bg);color:var(--code-fg);padding:14px 16px;border-radius:8px;overflow-x:auto;}
@media print{body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}.card{break-inside:avoid;}}
```

## 5. `latest.json`（pre-push フックが読む）
```json
{
  "head_sha": "…", "branch": "feat/x", "mode": "branch",
  "verdict": "pass|fix|block",
  "escalate": true, "escalation_done": true, "skipped_by_user": false,
  "reason": "", "report": ".review-reports/run-…/report.md", "recorded_at": "…"
}
```
フックの拒否条件: `head_sha ≠ HEAD` / `verdict = block` / `escalate かつ 未実施かつ 未スキップ`。緊急回避は `AI_REVIEW_BYPASS=1 git push`。

## 6. pre-push フック導入（初回のみ案内）
```bash
cp ~/.claude/skills/ai-review/hooks/pre-push ~/.git-hooks/pre-push && chmod +x ~/.git-hooks/pre-push
git config --global core.hooksPath ~/.git-hooks
```
既存の `~/.git-hooks/pre-push` がある場合は上書き前に内容を見せ、ユーザーの了解を得る。

## 7. エラーハンドリング

| 状況 | 対応 |
|---|---|
| Git リポジトリでない | 中断 |
| `origin/HEAD` 未設定 | `git remote set-head origin -a` を案内して中断（`--local` は続行可） |
| 差分なし | 「対象なし」で終了。レポート・`latest.json` は書かない |
| 未コミット変更が残っている（既定モード） | 「先に commit」を案内して中断 |
| `codex` 未導入・失敗・タイムアウト | その旨を明記し `/code-review` 単独で続行。二重化できていないことを結論に書く |
| `claude` 側が失敗・タイムアウト | 同様に Codex 単独で続行 |
| 両方失敗 | `verdict=block` で記録し中断 |
| 秘密情報が差分に含まれる | Codex を起動しない。ファイル名のみレポートに載せる |
| `/security-review` が失敗 | `escalation_done=false` のまま記録。フックが止めるので再実行を案内 |

## 8. 位置づけ（旧 2 段ゲートからの変更）
v1 では「ゲート1 `/ai-review`（未コミット）→ commit → ゲート2 `/security-review`」の 2 段だった。v2 は push 前 1 段に統合し、`/security-review` は昇格として自動起動する。人が「実行するか」を判断する場面はなく、「昇格をスキップする」と明示するときだけ手が入る。理由は `DESIGN-v2.md` §3.3・§3.5。
