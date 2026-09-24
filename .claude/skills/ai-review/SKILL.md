---
name: ai-review
description: Push 前の唯一の AI レビューゲート。同梱の自前観点（own-review、Opus 5.5）と Codex 純正 review（gpt-6-sol）をブラインドで並列起動し、指摘を和集合で突合して 3 段の結論（BLOCK / MUST-ADDRESS / PASS）を出し、Markdown/HTML レポートを .review-reports/ に保存する。高リスク差分はセキュリティの深掘り（own-security）を自動で追加起動し、--deep で 5 本に増やせる。MUST-ADDRESS は 1 件ずつ「直す」か「理由を記録して別のサブエージェントが検証」して片づける。Use when the user types /ai-review, or asks to "レビューして", "push 前に見て", "ブランチをレビュー", "未コミットをレビュー". Does NOT modify source code.
metadata:
  author: sinoda
  version: 3.0.0
---

# AI Review Skill v3 (/ai-review)

push 前の**唯一のゲート**。レビュー本体は書かない。同梱の自前観点 `prompts/own-review.md`（Claude）と Codex 純正 `codex exec review` を**独立・並列**に走らせ、指摘を和集合で突合し、3 段の結論を出す。条件に該当すれば `prompts/own-security.md` によるセキュリティの深掘りを**自動で**追加起動する。設計根拠は同ディレクトリの `DESIGN-v3.md`（正本）。v2 の記録は `DESIGN-v2.md`。

## 厳守事項

- ソースコード・設定ファイル・lockfile を変更しない。コミット・push・PR 作成をしない（MUST-ADDRESS を「直す」のは、このスキルの外で作業中の AI が行う。§3.9）。
- 書き込みは `.review-reports/` 配下のみ（レポート md/html、`items.json`、`latest.json`、各実行の生出力）。
- レビュー観点をこのスキルの手順に書き足さない。観点は `prompts/` の 2 本と Codex 純正 review が持つ。自分は**突合・記録・片づけの手順**だけを行う。
- モデルと effort はスクリプト内で固定（§1.1）。セッションのモデルに関わらず固定値で走る。環境変数でも変えられない。
- 自前観点は**スラッシュコマンドとして入れない**。`run-reviews.sh` が本文を `claude -p` に直接渡す。`~/.claude/commands/` の有無やユーザーのコマンド上書きに影響されない。
- 結論は生出力から機械的に決まる下限（`gate.py summary` の `floor`）より軽くしない。指摘を落とさない（直さないものは §3.9 の手順で理由を記録する）。
- 昇格判定はスクリプトの grep 結果とレビュアーの出力の事実に従う。自分の判断で「これは低リスクだから昇格不要」としない。昇格をスキップできるのは**ユーザーが明示した場合のみ**（`latest.json` に記録）。
- 人の承認（高リスクの MUST-ADDRESS）は、**ユーザーがチャットで明示的に承認したときだけ**記録する。自分で承認しない。

## 1. 構成要素

| ファイル | 役割 |
|---|---|
| `prompts/own-review.md` | Claude 側の汎用レビューの観点（v5）。変更ファイルごとの判定表と、段つきの指摘、3 段の結論を返す |
| `prompts/own-security.md` | セキュリティの深掘りの観点。攻撃面の一覧 → 経路の確認 → 判定表・指摘・3 段の結論 |
| `scripts/escalation-check.sh` | 昇格判定（パス／追加行／規模／秘密情報）。JSON を返す。モデル不使用 |
| `scripts/run-reviews.sh` | レビュアーの並列起動、判定表の検査と 1 回の再実行。`--security` で own-security 単独、`--deep` で 5 本 |
| `scripts/gate.py` | 結論の下限（floor）・判定表の検査・記録・項目の処理の下請け（python3 標準ライブラリのみ） |
| `scripts/record-gate.sh` | `latest.json` を書く（pre-push フックが読む） |
| `scripts/resolve-item.sh` | MUST-ADDRESS の 1 件の処理（fixed / accepted / 検証結果 / 人の承認）を記録する |
| `escalation-rules.txt` | 昇格パターンの既定。path ルールは「高リスク」の判定にも使う。プロジェクト追記は `.ai-review/escalation-rules.local.txt` |
| `hooks/pre-push` | ブロック型フック（`~/.git-hooks/pre-push` に配置して使う） |
| `scripts/test-gate.sh` / `scripts/test-isolation.sh` | 回帰テスト（ダミー実行とフィクスチャのみ。実モデルを呼ばない） |
| `scripts/probe-permissions.sh` | 実機の確認（実モデルを少し呼ぶ）。レビュアーの許可・拒否・設定の隔離が CLI で効いているかを、印のファイルの有無で確かめる。CLI の更新時と起動引数の変更時に回す |

`$SKILL` = `~/.claude/skills/ai-review` として以下に記す。

### 1.1 レビュアーとモデル（固定）

| 名前（出力ファイル名） | 中身 | モデル / effort | いつ |
|---|---|---|---|
| `own-review` | `prompts/own-review.md` | claude-opus-5-5 / high | 毎回 |
| `codex-review` | `codex exec review`（純正。独自の指示は渡さない） | gpt-6-sol / high | 毎回 |
| `own-security` | `prompts/own-security.md` | claude-opus-5-5 / high | 昇格時（`--security`）と `--deep` |
| `own-review-fable` | `prompts/own-review.md` | claude-fable-5-1 / high | `--deep` |
| `codex-astra` | `codex exec review`（純正） | gpt-6-astra / high | `--deep` |

Claude 側の道具は `Read,Grep,Glob,読み取り系の git サブコマンド（diff / show / log / status / ls-files / rev-parse / blame / merge-base / cat-file）,Task,Agent,TodoWrite` に限り、`--permission-mode dontAsk` でそれ以外（書き込み・ネットワーク・git 以外のコマンド）を拒否させる。`--setting-sources "" --safe-mode --strict-mcp-config` でユーザー・プロジェクトの設定（allow ルール・フック・CLAUDE.md）と MCP を読ませない（レビュー対象に入った `.claude/settings.json` のフックや、ユーザーの allow ルールで許可リストを迂回させないため）。パッケージのインストールやネットワークへのアクセスはしない（プロンプトにも書いてある）。Codex は read-only サンドボックス。

## 2. スコープとオプション

| 呼び方 | 対象 | 用途 |
|---|---|---|
| `/ai-review`（既定） | `origin/HEAD`（merge-base）から HEAD までの**コミット済み差分** | push 前の必須ゲート |
| `/ai-review --local` | 未コミット差分（staged + unstaged + untracked） | 途中の任意チェック。何度でも。push の根拠にはならない |
| `/ai-review --deep` | 既定と同じ | 強化版。own-security（常に）・own-review × Fable 5.1・Codex × Astra を通常の 2 本と並列で足す（計 5 本）。`--local` とも併用できる |
| `/ai-review --security` | 既定と同じ | 深掘りだけを明示的に回す（通常は昇格で自動）。単独では push の根拠にならない（記録には通常の 2 本の `reviewed_sha.review` が要る） |

既定モードでは、`run-reviews.sh` が常に HEAD の clean な worktree を一時的に作り、レビュアーはそこで動く（`status.txt` に `isolated:` の行が残る）。未コミットの変更も、レビュー中に別作業が書き換えた内容も、レビュー対象に混ざらない。`.env` や `node_modules` など ignore 済みの項目は本体へのリンクで用意される。初期化済みの submodule があるリポジトリだけは隔離せず、`status.txt` に `WARN` を残して元の作業ツリーで動く。理由と経緯は `DESIGN-v2.md` §12。

未コミットの変更はレビューされず、push にも含まれない。開始時の件数が `status.txt` の `uncommitted=N` に残るので、N > 0 なら結論に「未コミット N 件はレビュー対象外で、この push にも含まれない」と書く。

`--local` のとき、自前観点は自分で `git diff --cached`・`git diff`・未追跡ファイルを読み、Codex は `--uncommitted` で全部を見る。v2 のように index へ `git add -A` する必要はない（**index に触れない**）。

## 3. 実行フロー

### 3.1 前提確認
```bash
git rev-parse --is-inside-work-tree            # 非リポジトリなら中断
git symbolic-ref -q --short refs/remotes/origin/HEAD || echo "origin/HEAD 未設定"
command -v python3 >/dev/null || echo "python3 が無い"
```
`origin/HEAD` 未設定なら `git remote set-head origin -a` を案内して中断する。リモートが無いローカル単独リポジトリでは `--local` のみ対応と伝える。python3 が無ければ中断する（記録と判定表の検査に使う）。

### 3.2 差分取得・昇格判定（機械）
```bash
ts="$(date +%Y%m%d-%H%M%S)"; run=".review-reports/run-$ts"; mkdir -p "$run"
$SKILL/scripts/escalation-check.sh > "$run/escalation.json"          # 既定
$SKILL/scripts/escalation-check.sh --local > "$run/escalation.json"  # --local のとき
cat "$run/escalation.json"
```
- `error` があれば内容を伝えて中断。
- `secret_paths` が空でなければ、`run-reviews.sh` が自分で Codex を起動しない（外部モデルに秘密情報を送らない。`UNAVAILABLE codex-review` として未取得の項目になる）。`--no-codex` を付けても同じく未取得の項目になる。ファイル名だけレポートに載せる。
- `escalate` と `reasons` を保持する（§3.6 で使う）。

### 3.3 レビュアーを並列起動（ブラインド）
```bash
$SKILL/scripts/run-reviews.sh --out "$run"                 # 既定（own-review ‖ codex-review）
$SKILL/scripts/run-reviews.sh --out "$run" --deep          # 強化版（5 本）
$SKILL/scripts/run-reviews.sh --out "$run" --local         # --local
```
- **終了を待ってから次へ進む。** Bash ツールの上限（600 秒）より長くかかることがある（通常 2 本で 5〜7 分、`--deep` で 12 分前後）。上限を超えそうならバックグラウンドで起動し、完了の通知を待つ。途中で止めない（止まった run は `reviewed_sha.*` が書かれず、記録できない）。
- `escalation.json` が run ディレクトリに無ければ、`run-reviews.sh` が自分で作る。記録（branch）はこれを必須にし、`escalate=true` を `--escalate false` で打ち消せない。
- 自前観点の出力の最後の行は `VERDICT: X`（機械が読む）。無ければ結論の節の最も重い語を採る（止める側）。
- `AI_REVIEW_DRY_RUN=1`（テスト用のダミー実行）の結果は `latest.json` に `dry_run: true` と残り、pre-push が拒む。
- 出力: `$run/<名前>.md`（§1.1 の名前）、`$run/<名前>.prompt.md`（実際に渡したプロンプト）、`$run/changed-files.txt`、`$run/status.txt`。
- 自分はこの間、**どの出力も読まない**。全部が終わってから読む（独立性の確保）。
- 判定表の検査はスクリプトが行う。自前観点の判定表に変更ファイルが欠けていれば 1 回だけ単独で回し直し、それでも欠けたファイルは `<名前>.missing.txt` に残る（`status.txt` に `TABLE-INCOMPLETE`）。これは記録時に自動で「判定なし（要確認）」の MUST-ADDRESS 項目になる。
- `status.txt` に `EMPTY` / `TIMEOUT` / `FAILED` があれば、その側を「未取得」としてレポートに明記し、残った側で続行する。二重化できていないことを結論に書く。全部未取得なら結論は `block`（下限がそうなる）。

### 3.4 機械で決まる下限を確かめる
```bash
python3 $SKILL/scripts/gate.py summary --run "$run" > "$run/summary.json"; cat "$run/summary.json"
```
- `floor`: 生出力から機械的に決まる結論の下限。own-* は結論行（BLOCK / MUST-ADDRESS / PASS）、Codex は `[P1]`（と `[P0]`）→ BLOCK 相当、`[P2]` / `[P3]` → MUST-ADDRESS 相当。結論行が読めない出力・判定表の欠けは MUST-ADDRESS。
- `sources`: レビュアーごとの段。記録時、段が MUST-ADDRESS 以上のレビュアーは、そのレビュアーを `source` に含む同じ段以上の項目が無いと記録を拒まれる（1 人分の指摘を丸ごと落とさないため）。
- `deep_recommended` / `deep_recommend_reasons`: `--deep` を回していないときの推奨（§3.10）。

### 3.5 突合（和集合）と項目の書き起こし
全出力を読み、指摘を 1 件ずつ書き起こす。**和集合をとる**: 同じ問題を複数のレビュアーが挙げていれば 1 件にまとめ、`source` に全員を `+` でつなぐ（例 `own-review+codex-review+codex-astra`）。1 人だけの指摘も落とさない。

段の対応（機械的に決める。自分で上げ下げしない）:

| 出所 | BLOCK 相当 | MUST-ADDRESS 相当 | 項目にしない |
|---|---|---|---|
| own-review / own-security / own-review-fable | 深刻度 High の「脆弱・不具合」 | Medium・Low の「脆弱・不具合」、「要確認」 | 強化提案、設計の指摘、安全、差分より前からある問題 |
| codex-review / codex-astra | `[P1]`（`[P0]`） | `[P2]` / `[P3]` | — |

同じ問題で出所ごとの段が違えば、重い方を採る。BLOCK・MUST-ADDRESS の段の指摘を `$run/items.json` に書く（Write ツール）:

```json
[
  {"id": "R1", "source": "own-review+codex-review", "file": "src/api/user.ts", "line": 42,
   "tier": "BLOCK", "severity": "High", "category": "security",
   "summary": "クエリ文字列の id がそのまま SQL に連結される（SQL インジェクション）", "high_risk": true},
  {"id": "R2", "source": "codex-review", "file": "src/lib/date.ts", "line": 10,
   "tier": "MUST-ADDRESS", "severity": "Medium", "category": "correctness",
   "summary": "日付の変わり目で前日の集計に入る", "high_risk": false}
]
```
- `id` は一意（R1, R2, …）。`tier` は `BLOCK` か `MUST-ADDRESS`。`severity` は `High` / `Medium` / `Low`（Codex は P1=High、P2=Medium、P3=Low）。`category` は `security` / `correctness` / `design`。
- `high_risk`: 外部入力がコマンド・SQL・パス・LDAP・XPath・テンプレート・リダイレクト先・デシリアライズに届く**注入型**の指摘なら `true`。記録時に、昇格ルールの path（A 区分）に当たるファイルと、注入型の語を含む指摘は自動で `true` になる（下げられない）。
- 判定表の欠けで回し直したレビュアーは、初回の出力 `<名前>.attempt1.md` も読み、その指摘も突合に含める（`gate.py summary` の下限は、初回と再実行の重い方になる）。
- 指摘の根拠を確かめるときは、コミット済みの内容（`git show HEAD:<path>`）を読む。レビュアーが見たのはそれで、作業ツリーには別作業の変更が混ざっていることがある。
- 項目にしない指摘（強化提案など）もレポートには載せる。安く直せるものは作業中の AI が直してよい（直したら再実行）。

セキュリティ分類（injection / XSS / SSRF / path traversal / auth / crypto / deserialization / secrets 等）の指摘がどれかの出力に 1 件でもあれば `escalate=true` にする（D 条件）。セキュリティの指摘で判定が割れた（一方が脆弱、他方が安全）場合も `escalate=true`（E 条件）。

### 3.6 昇格（自動）
`escalate=true` で、まだ own-security を回していなければ（`--deep` は回し済み）、**確認せずに**起動する（同期実行で終了を待つ）:
```bash
$SKILL/scripts/run-reviews.sh --out "$run" --security            # 既定
$SKILL/scripts/run-reviews.sh --out "$run" --security --local    # --local
python3 $SKILL/scripts/gate.py summary --run "$run" > "$run/summary.json"   # 下限を取り直す
```
- `own-security.md` を読み、指摘を §3.5 と同じ規則で `items.json` に足す（既存の項目と同じ問題なら `source` に `own-security` を足す）。攻撃面の一覧と攻撃の筋書きはレポートの「深掘り」節に転記する。
- ユーザーが**明示的に**「昇格スキップ」と言った場合のみ起動しない。理由を聞き、`--skipped-by-user true --reason "<理由>"` で記録する。

### 3.7 レポート生成
`$run/report.md` と `$run/report.html` を Write ツールで書く（§4）。`.review-reports/latest.md` / `latest.html` にもコピーする。

### 3.8 ゲート記録
```bash
$SKILL/scripts/record-gate.sh --verdict <pass|must-address|block> --items "$run/items.json" \
  --escalate <true|false> --escalation-done <true|false> \
  [--skipped-by-user true --reason "<ユーザーの理由>"] \
  --report "$run/report.md" --mode <branch|local>
```
- 結論は「`--verdict`」「`floor`」「項目の最も重い段」の最も重いものになる（引き上げたときは stderr に出る）。項目が無いなら `--items` は省いてよい。
- `--escalation-done true` は、run ディレクトリに `own-security.md` があるときだけ受け付ける。
- `--local` のときは必ず `--mode local`。pre-push フックは `mode=branch` の記録しか受け付けない。
- branch モードでは `--report` に run ディレクトリ内のレポートを必ず渡す（`reviewed_sha.*` と HEAD を照合する。レビュー中に HEAD が動いていれば拒まれるので、記録せず回し直す）。差分なしの記録だけは `--no-diff`。
- 前回の記録で `fixed` にした項目は、HEAD が進んだ今回の記録に「再レビュー済み」（`id` が `prev-…`、`re_reviewed_sha` 付き）として自動で引き継がれる。

### 3.9 MUST-ADDRESS の片づけ（C 案）
結論が `must-address` なら、作業中の AI（このセッション）が 1 件ずつ片づける。一覧は `$SKILL/scripts/resolve-item.sh --list`。各項目は次のどちらかにする。

**A. 直す（fixed）**
1. コードを直して commit する。
2. `$SKILL/scripts/resolve-item.sh --id <ID> --fixed --note "<何を直したか>"`
3. `/ai-review` を**新しい HEAD で再実行**する。再実行で同じ問題が出なければ `prev-<ID>` として再レビュー済みになる。出れば新しい項目として open に戻る。fixed のまま再実行しなければ push は通らない。

**B. 直さない（accepted）**
1. 理由を、コードで確かめられる形で書く（例「呼び出し元 `src/x.ts:12` で空配列を弾いている」）。「たぶん大丈夫」「今は起きない」は理由にならない（プロンプトの §3.2 と同じ基準）。
   `$SKILL/scripts/resolve-item.sh --id <ID> --accepted --reason "<理由>"`
2. **作業の文脈を持たない別のサブエージェント**を新しく起動し（Agent ツール。このセッションの会話や作業内容を渡さない）、理由がコードで成り立つかを検証させる。渡すのは項目（file・line・summary・レビュアーの根拠の原文）と理由だけ。指示は悲観的に書く: 「この理由は誤っている前提で、レビューした版のコードを読んで反証を探せ（branch モードは HEAD のコード `git show HEAD:<path>`。`--local` モードは作業ツリーのファイルと `git diff --cached` / `git diff`。未コミットの変更は HEAD に無いので、HEAD だけを読んではいけない）。反証が無く、理由がコードで示せる場合だけ upheld、それ以外は rejected と根拠を返せ。コードは変更するな」。
3. 結果を記録する。
   `$SKILL/scripts/resolve-item.sh --id <ID> --verifier upheld|rejected --note "<サブエージェントの結論の要約>"`
   rejected なら項目は open に戻る。直すか、別の理由で B をやり直す（同じ理由の出し直しはしない）。
4. `high_risk=true` の項目は、upheld の後に**ユーザーの承認**が要る。項目・理由・検証の結論をチャットで示し、承認するならユーザー自身の端末で次を実行してもらう（確認のため ID を打ち込む。Claude の Bash には端末が無いので、AI は記録できない）。**自分で承認しない。疑似端末を作って代わりに打ち込まない。1 件ごとに頼む**。
   `~/.claude/skills/ai-review/scripts/resolve-item.sh --id <ID> --approve-human --note "<承認の理由>"`

- 理由・検証・承認は、レビューした HEAD（`latest.json` の `head_sha`）に対してだけ記録できる。HEAD を動かしたら再実行から。
- **BLOCK は直すしかない**（verdict=block は pre-push が必ず止める）。誤検知だと考える場合は、根拠を添えてユーザーに判断を仰ぐ。ユーザーが明示した場合だけ `AI_REVIEW_BYPASS=1` を案内する。

### 3.10 終了時の案内
- 結論を 1 行で: 「push 可（PASS）」「MUST-ADDRESS n 件を片づければ push 可（うち人の承認が要るもの m 件）」「push 不可（BLOCK n 件）」。
- `--deep` を回していないときに `summary.json` の `deep_recommended` が true なら、次の 1 行を結論の下とレポートに必ず入れる: 「`--deep` を推奨: <理由>」（理由 = 差分が escalation-rules の max_files / max_added を超えた、BLOCK 相当の指摘がある、昇格ルールの path（A）に当たる）。`record-gate.sh` も同じ行を stderr に出す。
- `.gitignore` に `.review-reports/` が無ければ追記を**提案**する（自分では書き換えない）。
- `pre-push` フック未導入なら導入方法を一度だけ案内する（§6）。

## 4. レポート形式

### 4.1 Markdown（`report.md`）
```markdown
# AI Review Report v3

## 結論
- 判定: PASS / MUST-ADDRESS / BLOCK（下限: gate.py の floor）
- 昇格: 発動（理由: A:path:src/auth/login.ts） / 非該当 / スキップ（ユーザー指示: ...） / --deep で実施
- --deep を推奨: <理由>（該当時のみ）
- 次の一手: push 可 / MUST-ADDRESS n 件を片づける / 修正して再実行

## 対象
- Base: origin/main (merge-base abc1234) → HEAD def5678 / branch feat/xxx
- 変更: N files, +A/-D
- 実行: own-review (claude-opus-5-5/high, 1m30s) ‖ codex-review (gpt-6-sol/high, 1m20s) [‖ own-security ‖ own-review-fable ‖ codex-astra]
- 判定表: 全ファイルあり / 再実行 1 回で補完 / 判定なし（要確認）: path/a, path/b
- レビュー対象外: .env（秘密情報のため Codex 未送信）

## BLOCK
| ID | file:line | 問題 | 根拠 | 出所 | 修正案 |
## MUST-ADDRESS
| ID | file:line | 深刻度 | 問題 | 根拠 | 出所 | 高リスク | 状態 |
## 強化提案・設計（止めない）
## 判定なし（要確認）
（判定表の欠けがあれば。ファイルとレビュアー）

## 深掘り（own-security）
（発動時のみ。攻撃面の一覧・攻撃の筋書き・修正案を転記）

## 生出力
- .review-reports/run-<ts>/own-review.md ほか（プロンプトは *.prompt.md）
```

「出所」列はレビュアー名を `+` でつなぐ（和集合で、誰が見つけたかを残す）。この列を蓄積して「1 人だけが拾った本物の指摘」「深掘りだけが見つけた指摘」を後から集計する（DESIGN-v3.md §7）。

### 4.2 HTML（`report.html`）
Markdown を `<pre>` で包まない。同じデータから別途組み立てる。スタンドアロン（外部 CSS/JS なし）、`<meta charset="utf-8">` と viewport 必須、最大幅 880px、白カード + `#f6f7f9` 背景、`@media print` で背景保持。構成は §4.1 と同順で、冒頭に BLOCK / MUST-ADDRESS / 強化提案 / 変更ファイル数のサマリーカード、結論バッジ（PASS=success / MUST-ADDRESS=warning / BLOCK=danger）、昇格状態バッジを置く。セル内の `<` `>` `&` `"` は必ずエスケープする。

CSS 骨格（そのまま使ってよい）:
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
  "version": 3, "head_sha": "…", "branch": "feat/x", "mode": "branch",
  "verdict": "pass|must-address|block", "floor_verdict": "…",
  "deep": false, "deep_recommended": true, "deep_recommend_reasons": ["…"],
  "escalate": true, "escalation_done": true, "skipped_by_user": false,
  "reason": "", "report": ".review-reports/run-…/report.md", "recorded_at": "…",
  "sources": {"own-review": {"level": "must-address", "detail": "結論 MUST-ADDRESS"}},
  "must_address": [
    {"id": "R2", "source": "codex-review", "file": "src/lib/date.ts", "line": 10,
     "tier": "MUST-ADDRESS", "severity": "Medium", "category": "correctness", "summary": "…",
     "high_risk": false, "status": "accepted", "reason": "…",
     "verifier": "upheld", "verifier_note": "…", "history": [ … ]}
  ]
}
```
`status` は `open` / `fixed` / `accepted`。`verifier` は `pending` / `upheld` / `rejected`。高リスクの承認は `approved_by: "human"` と `approval_note`。

フックの拒否条件: `head_sha ≠ push 対象 SHA` / `verdict = block` / `verdict = must-address` で処理済みでない項目がある / `mode ≠ branch` / `escalate かつ 未実施かつ 未スキップ` / verdict が不正（v2 の `fix` を含む）。処理済みとは「`fixed` で再レビュー済み（`re_reviewed_sha` = レビュー済み SHA）」または「`accepted` かつ `verifier = upheld` かつ（高リスクでない、または `approved_by = human`）」。緊急回避は `AI_REVIEW_BYPASS=1 git push`、コードでないリポジトリは `git config ai-review.skip true`。

## 6. pre-push フック導入（初回のみ案内）
```bash
cp ~/.claude/skills/ai-review/hooks/pre-push ~/.git-hooks/pre-push && chmod +x ~/.git-hooks/pre-push
git config --global core.hooksPath ~/.git-hooks
```
既存の `~/.git-hooks/pre-push` がある場合は上書き前に内容を見せ、ユーザーの了解を得る。v2 のフックのままだと `must-address` を不正な verdict として拒むので、v3 に入れ替えるよう案内する。

## 7. エラーハンドリング

| 状況 | 対応 |
|---|---|
| Git リポジトリでない / python3 が無い | 中断 |
| `origin/HEAD` 未設定 | `git remote set-head origin -a` を案内して中断（`--local` は続行可） |
| 差分なし（既定モード） | レビューは走らせず、`record-gate.sh --verdict pass --escalate false --escalation-done false --no-diff --reason "no diff vs <base>"` だけ記録して終了。`--local` で差分なしなら「対象なし」で終了し何も書かない |
| 未コミット変更が残っている（既定モード） | 中断しない。常に HEAD の clean な worktree でレビューする。`uncommitted=N` が 0 でなければ、その N 件がレビュー対象外で push にも含まれないことを結論に書く |
| worktree を作れない／初期化済みの submodule がある | `status.txt` に `WARN` が残り、元の作業ツリーで続行する。未コミットの変更が混ざって二重化が崩れている可能性を結論に書く |
| `TABLE-INCOMPLETE` | 再実行でも判定表が埋まらなかった。欠けたファイルは記録時に「判定なし（要確認）」の MUST-ADDRESS 項目になる。§3.9 で片づける（そのファイルを自分で読んで理由を書き、検証を通す） |
| `record-gate.sh` が「〜の結論は … ですが、source に … を含む項目がありません」で止まる | そのレビュアーの BLOCK / MUST-ADDRESS の指摘を書き起こし忘れている。`items.json` に足して記録し直す |
| `record-gate.sh` が「レビューした SHA と HEAD が違う」「reviewed_sha.review が見つからない」で止まる | 前者はレビュー中に HEAD が動いた。後者は `--report` の渡し忘れ。記録せず、前者は回し直し、後者は `--report` を付けて記録し直す |
| `codex` 未導入・失敗・タイムアウト | その旨を明記し Claude 側だけで続行。二重化できていないことを結論に書く |
| `claude` 側が失敗・タイムアウト | 同様に Codex 側だけで続行 |
| 全部失敗 | 下限が `block` になる。そのまま記録して中断 |
| 秘密情報が差分に含まれる | `run-reviews.sh` が自分で Codex を起動しない（`UNAVAILABLE codex-review` の未取得の項目になる）。`--no-codex` は付けない。ファイル名のみレポートに載せる |
| own-security（昇格）が失敗 | `escalation_done=false` のまま記録。フックが止めるので再実行を案内 |

## 8. 位置づけ（v2 からの変更）
v2 はユーザー環境のコマンド上書きに頼った `/code-review` と Codex、昇格に公式 `/security-review` を使い、結論は pass / fix / block だった。v3 は Claude 側と昇格を同梱の自前観点に置き換え（`~/.claude/commands` に依存しない）、結論を BLOCK / MUST-ADDRESS / PASS の 3 段にし、MUST-ADDRESS を 1 件ずつ片づけるまで push を止める。判断専用モデルによる型付けと昇格トリガーは外した（別スキル `/pr-triage` には残る）。理由と測定値は `DESIGN-v3.md`。
