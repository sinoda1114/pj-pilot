---
name: ai-review
description: Push 前の唯一の AI レビューゲート。/code-review（Opus 5.5。実体は ~/.claude/commands/code-review.md の ECC 版）と Codex 純正 review（gpt-6-sol）をブラインドで並列起動し、突合して Markdown/HTML レポートを .review-reports/ に保存。高リスク差分は /security-review を自動で追加起動する。Use when the user types /ai-review, or asks to "レビューして", "push 前に見て", "ブランチをレビュー", "未コミットをレビュー". Does NOT modify source code.
metadata:
  author: sinoda
  version: 2.0.0
---

# AI Review Skill v2 (/ai-review)

push 前の**唯一のゲート**。レビュー本体は書かない。組み込み `/code-review` と Codex 純正 `codex exec review` を**独立・並列**に走らせ、結果を突合し、条件に該当すれば `/security-review` を**自動で**追加起動する。設計根拠は同ディレクトリの `DESIGN-v2.md`（正本）。v1 は `SKILL.md.v1`。

## 厳守事項

- ソースコード・設定ファイル・lockfile を変更しない。コミット・push・PR 作成をしない。
- 書き込みは `.review-reports/` 配下のみ（レポート md/html、`latest.json`、各実行の生出力）。`--local` モードで index に触れる場合だけは例外（§3.2）。ただし**ユーザーの staged 状態を壊してはならない**。
- レビュー観点をこのスキルが自前で持たない。判定は純正コマンドの出力に従い、自分は**突合と検証**だけを行う。
- モデルと effort はスクリプト内で固定（Claude: `claude-opus-5-5`/high、Codex: `gpt-6-sol`/high）。セッションのモデルに関わらず固定値で走る。
- `/code-review` はユーザー環境では ECC 版（`~/.claude/commands/code-review.md`）が組み込み版を上書きして動く。2026-09-23 のベンチでは ECC 版 × Opus 5.5 が最良（0.964）だったため、この構成を正とする。
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
| `scripts/jev-judge.py` | 任意（`--jev` 時のみ）。JEV で指摘を型付き判定（セキュリティ分類／同一指摘ペアリング）。フェイルセーフ |
| `scripts/jev-escalation.py` | 昇格トリガー F。差分の内容を JEV に見せ「認証・認可・決済・永続データの挙動を変えるか」の確率を返す。キーがあれば既定で動く。追加方向のみ・フェイルセーフ |

`$SKILL` = `~/.claude/skills/ai-review` として以下に記す。

## 2. スコープ

| 呼び方 | 対象 | 用途 |
|---|---|---|
| `/ai-review`（既定） | `origin/HEAD`（merge-base）から HEAD までの**コミット済み差分** | push 前の必須ゲート |
| `/ai-review --local` | 未コミット差分（staged + unstaged + untracked） | 途中の任意チェック。何度でも |

既定モードでは、`run-reviews.sh` が常に HEAD の clean な worktree を一時的に作り、レビュアーはそこで動く（`status.txt` に `isolated:` の行が残る）。未コミットの変更も、レビュー中に別作業が書き換えた内容も、レビュー対象に混ざらない。`.env` や `node_modules` など ignore 済みの項目は本体へのリンクで用意されるので、検証の環境は隔離前と同じ（共有の `info/exclude` には書かない）。初期化済みの submodule があるリポジトリだけは、worktree では submodule が空になるので隔離せず、`status.txt` に `WARN` を残して元の作業ツリーで動く。別作業が同居するリポジトリでは「先に commit」を守れないため、こうしている。理由と経緯は `DESIGN-v2.md` §12。

未コミットの変更はレビューされず、push にも含まれない。開始時の件数が `status.txt` の `uncommitted=N` に残るので、N > 0 なら結論に「未コミット N 件はレビュー対象外で、この push にも含まれない」と書く。自分の変更の commit し忘れだった場合は、commit してから回し直すよう案内する（HEAD が動かないので、pre-push フックでは気付けない）。

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
- **トリガー F（JEV、追加方向のみ）**: `AI_REVIEW_JEV=0` でなければ実行する。キー（`~/.config/ai-review/jev.env` または環境変数 `TYPESAFE_API_KEY` / `AI_GATEWAY_API_KEY`）が無ければスクリプトが `available=false` を返すだけで害はない。`secret_paths` の検査はスクリプト側でも行う（`--escalation` を必ず渡す）。
  ```bash
  python3 $SKILL/scripts/jev-escalation.py --base <base> --escalation "$run/escalation.json" > "$run/jev-escalation.json"   # --local のときは --base の代わりに --local
  ```
  `escalate` が true なら `reasons` に `F:jev:<確率>` を足して `escalate=true` にする。false や `available=false` のときは**何もしない**（grep の結果を下げない）。根拠は DESIGN-v2.md §10（30 PR の測定で grep の見逃し 1 件を救い、余計な昇格 0 件）。
- `--local` のとき、`/code-review` は staged 差分しか見ないため、起動前に index へ足す必要がある。**`git reset -q` で戻してはいけない**。pathspec なしの mixed reset は元の部分ステージを復元せず全て unstage するうえ、マージ・リベース・cherry-pick の進行中なら `MERGE_HEAD` 等を消して中断させる。次の手順を守る。

```bash
# 1. 進行中の操作があれば --local を使わない（index を触れないため）
git rev-parse -q --verify MERGE_HEAD >/dev/null && echo "マージ進行中のため中断"
ls "$(git rev-parse --git-dir)"/{rebase-merge,rebase-apply,CHERRY_PICK_HEAD,REVERT_HEAD} 2>/dev/null && echo "rebase/cherry-pick 進行中のため中断"

# 2. 元の index を丸ごと退避（部分ステージもそのまま保存される）。
#    初回コミット前などで index が無い場合は「無かった」ことを記録し、復元時に削除する
#    （空の mktemp ファイルで index を上書きしてはいけない）
idx="$(git rev-parse --git-path index)"; idx_backup=""
if [ -f "$idx" ]; then idx_backup="$(mktemp)"; cp "$idx" "$idx_backup" || { echo "index 退避失敗のため中断"; exit 1; }; fi
restore_index() { if [ -n "$idx_backup" ]; then cp "$idx_backup" "$idx"; rm -f "$idx_backup"; else rm -f "$idx"; fi; }
trap restore_index EXIT

# 3. レビュー用に全て stage（.review-reports/ は escalation-check.sh が exclude 済みなので混ざらない）
git add -A

# 4. 終了後、退避した index を書き戻す（reset は使わない）。trap で失敗時も必ず実行される
```

この退避と復元は必ず対で行う。途中で失敗しても復元だけは実行する（`trap` 等）。

### 3.3 純正レビューを並列起動（ブラインド）
```bash
$SKILL/scripts/run-reviews.sh --out "$run"                    # 既定
$SKILL/scripts/run-reviews.sh --out "$run" --local            # --local
$SKILL/scripts/run-reviews.sh --out "$run" --no-codex         # 秘密情報混入時
```
- **必ず同期（フォアグラウンド）で実行し、終了を待つ。** バックグラウンド起動や「完了通知を待つ」形にしない。`claude -p` 実行には次のターンが無く、そこでセッションが終わって結果が回収されない。Bash ツールのタイムアウトは 1800 秒以上を指定する。
- 出力: `$run/code-review.md`、`$run/codex-review.md`、`$run/status.txt`。
- 自分はこの間、**どちらの出力も読まない**。両方が終わってから読む（独立性の確保）。
- `status.txt` に `EMPTY` / `TIMEOUT` があれば、その側を「未取得」としてレポートに明記し、残った側だけで続行する。両方未取得なら結論を `block` にして中断。

### 3.4 突合（ここだけが自分の仕事）

#### 3.4a JEV による型付け（任意・フェイルセーフ）
**既定では行わない。** ユーザーが `/ai-review --jev` と明示したか、環境変数 `AI_REVIEW_JEV=1` のときだけ行う（2026-09-20 の効果測定で「怪しい指摘の見分け」に効かないと判明したため自動発動にしない。DESIGN-v2.md §10）。キーは `~/.config/ai-review/jev.env`（`TYPESAFE_API_KEY=` か `AI_GATEWAY_API_KEY=`）。無ければ `available=false` で素通り。`secret_paths` が空でなければ行わない（指摘文も外部に出さない）。

1. 両出力から指摘を 1 件ずつ書き起こし `$run/findings.json` に保存する（形式は `jev-judge.py` 冒頭のとおり。`text` は issue・根拠・fix をそのまま）
2. `python3 $SKILL/scripts/jev-judge.py --findings "$run/findings.json" --out "$run/jev.json" --escalation "$run/escalation.json"`（スクリプト側でも `secret_paths` があれば送信しない。指摘文に鍵やトークンらしき値があればその指摘は送らない）
3. `jev.json` の `available` が false なら「JEV 未使用（理由）」とレポートに 1 行書いて通常どおり進む。1 件でも呼び出しに失敗すると全体が false になる（部分結果は使わない）。ゲートの成否には影響させない
4. available なら次のように使う。**JEV は指摘を落とさない・裁定しない**
   - `is_security ≥ 0.5` の指摘があれば D 条件（`escalate=true`）。**追加方向にだけ**使う: JEV が 0.5 未満でも、自分がセキュリティ分類と判断した指摘の D 条件は解除しない（昇格は一方向）
   - `pairs` の `same_issue ≥ 0.7` を「両方が指摘」のペアリングに使う（一致率 96.7%）。自分の判断と食い違えば両方を記録する
   - `assumption` と `severity` は**判定にも検証順にも使わない**（本物と誤検知を区別できない: AUC 0.50 / 0.53）。レポートの「JEV 票」列に参考値として残すだけ
   - 検証順は従来どおり: 仮定に依存する文面の指摘は自分で見つけて参照先コードを Read する
   - 既定モードで指摘を検証するとき、読むのはコミット済みの内容（`git show HEAD:<path>`）にする。レビュアーが見たのはそれで、作業ツリーのファイルには別作業の変更が混ざっていることがある

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
`escalate=true` なら**確認せずに**起動する（これも同期実行で終了を待つ）:
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
`--local` のときは必ず `--mode local` を付ける。pre-push フックは `mode=branch` の記録しか受け付けないので、`--local` の結果で push が通ることはない。

branch モードでは、`--report` に run ディレクトリ内のレポートを必ず渡す。`record-gate.sh` は `run-reviews.sh` が残した `reviewed_sha.*` と記録時の HEAD を照合し、記録が無いとき・一致しないとき（レビュー中に誰かが commit した）は拒む。拒まれたら記録せず回し直す。レビューを回さない「差分なし」の記録だけは `--no-diff` を付ける（本当に差分が無いかも確かめる）。

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
- 実行: /code-review (claude-opus-5-5/high, 1m30s) ‖ codex exec review (gpt-6-sol/high, 1m20s)
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
フックの拒否条件: `head_sha ≠ push 対象 SHA` / `verdict = block` / `mode ≠ branch`（`--local` の記録は push の根拠にならない） / `escalate かつ 未実施かつ 未スキップ`。緊急回避は `AI_REVIEW_BYPASS=1 git push`、コードでないリポジトリは `git config ai-review.skip true`。

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
| 差分なし（既定モード） | レビューは走らせず、`record-gate.sh --verdict pass --escalate false --escalation-done false --no-diff --reason "no diff vs <base>"` だけ記録して終了（既に公開済みのコミットを指す新ブランチを push できるようにする）。`--local` で差分なしなら「対象なし」で終了し何も書かない |
| 未コミット変更が残っている（既定モード） | 中断しない。常に HEAD の clean な worktree でレビューする（`isolated:`）。`uncommitted=N` が 0 でなければ、その N 件がレビュー対象外で push にも含まれないことを結論に書く |
| worktree を作れない／初期化済みの submodule がある | `status.txt` に `WARN` が残り、元の作業ツリーで続行する。未コミットの変更が混ざって二重化が崩れている可能性を結論に書く |
| `status.txt` に `WARN: ignore されずに見えた項目を…外した` | HEAD の `.gitignore` と作業ツリーの規則が違う（`.gitignore` の未コミット変更など）。外した項目は隔離環境に無いので、それを要る検証が飛んだ可能性を結論に書く |
| `record-gate.sh` が「レビューした SHA と HEAD が違う」「reviewed_sha.review が見つからない」で止まる | 前者はレビュー中に HEAD が動いた（誰かが commit した）。後者は `--report` の渡し忘れ。記録せず、前者は `/ai-review` を回し直し、後者は `--report "$run/report.md"` を付けて記録し直す |
| `codex` 未導入・失敗・タイムアウト | その旨を明記し `/code-review` 単独で続行。二重化できていないことを結論に書く |
| `claude` 側が失敗・タイムアウト | 同様に Codex 単独で続行 |
| 両方失敗 | `verdict=block` で記録し中断 |
| 秘密情報が差分に含まれる | Codex を起動しない。ファイル名のみレポートに載せる |
| `/security-review` が失敗 | `escalation_done=false` のまま記録。フックが止めるので再実行を案内 |

## 8. 位置づけ（旧 2 段ゲートからの変更）
v1 では「ゲート1 `/ai-review`（未コミット）→ commit → ゲート2 `/security-review`」の 2 段だった。v2 は push 前 1 段に統合し、`/security-review` は昇格として自動起動する。人が「実行するか」を判断する場面はなく、「昇格をスキップする」と明示するときだけ手が入る。理由は `DESIGN-v2.md` §3.3・§3.5。
