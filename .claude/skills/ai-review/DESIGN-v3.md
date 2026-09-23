# /ai-review v3 設計メモ（2026-09-23 確定）

`ai-review-benchmark-v2` の確認用データでの測定を受けて `/ai-review` を刷新した記録。本メモは「なぜこの設計か」の正本。SKILL.md は「どう動くか」のみ書く。v2 の記録は `DESIGN-v2.md`（作業ツリーの隔離 §12 など、v3 でもそのまま有効な決定を含む）。

計画と測定の経緯: `~/dev/ai-review-benchmark-v2/docs/ai-review-deep-plan.md`（進捗記録以降）、観点の設計: `docs/ai-review-own-guide-design.md`。

---

## 1. 何を変えたか（v2 → v3）

| 枠 | v2 | v3 |
|---|---|---|
| Claude 側（毎回） | `/code-review`（ユーザー環境の ECC 版が組み込み版を上書き）× Opus 5.5 | 同梱の自前観点 `prompts/own-review.md`（v5）× Opus 5.5 / high。本文を `claude -p` に直接渡す |
| Codex 側（毎回） | 純正 `codex exec review` × gpt-6-sol / high | **変更なし** |
| 昇格 | 公式 `/security-review` × Opus 5.5 | 同梱の `prompts/own-security.md` × Opus 5.5 / high |
| 強化版 | なし | `--deep`: own-security（常に）＋ own-review × Fable 5.1 ＋ Codex × Astra を通常の 2 本と並列（計 5 本） |
| 結論 | pass / fix / block（fix は push 可） | BLOCK / MUST-ADDRESS / PASS。MUST-ADDRESS は 1 件ずつ片づけるまで push 不可（C 案） |
| 突合 | 片方だけの指摘は裁定せず検証し、不採用にもできた | 和集合。指摘を落とさず、直さないものは理由を記録して別のサブエージェントが検証する |
| 判定表の欠け | 検査なし | 機械で検査し 1 回だけ再実行。埋まらなければ「判定なし（要確認）」= MUST-ADDRESS |
| JEV | 昇格トリガー F（既定）と `--jev`（手動） | 外した（`/pr-triage` には残る） |
| ECC 依存 | `~/.claude/commands/code-review.md` が前提 | なし。`~/.claude/commands/` が無い環境でも同じ動き |
| `--local` | `/code-review` のため index に `git add -A` し、退避・復元していた | index に触れない（自前観点が未コミット・未追跡を自分で読む）。昇格も `--local` で動く |

## 2. ベンチの結果（確認用データ。v5 の設計に使っていないもの）

### 2.1 Claude 側: 自前観点 v5 を採用

| 確認用データ | v5 × Opus 5.5 | ECC 版 × Opus 5.5（v2 の現行） |
|---|---|---|
| 2 つ目の確認用 OWASP 110 件 | 1.000（FN0 FP0） | —（1 つ目の確認用で 0.927〜0.982） |
| バグのある変更 46 件 | 46 件すべて検出。BLOCK 28 / MUST-ADDRESS 18 / 素通り 0 | 45〜46 件を止める |
| バグのない変更 21 件 | BLOCK 4 件（4 件とも本物のバグ、止めすぎ 0）、MUST-ADDRESS 14、PASS 3 | BLOCK 10 件（止めすぎ 4） |
| 1 回のコスト・時間（バグのない 25 件） | 約 $0.53・81 秒 | 約 $0.96・79 秒 |

- 経緯: v1（誤検知 14）→ v2（0.982、止める力がやや弱い）→ v3（止めすぎ: バグのない 18 件中 15 件を BLOCK）→ v4（結論を 3 段にし深刻度基準を明文化）→ v5（付随的な指摘が「脆弱/Low」に流れる原因を分析用データで特定し 3 文を修正）。
- 採点の抜き取り: バグ 46 件から 6 件を人が判定し直し、6 件とも一致。
- v2・v3 の試作では毎回のように判定表の行が 1 件書き漏れた（v3 の 0.964 はこれ）。→ 機械検査と再実行（§5）。
- 観点には評価データ固有の知識（特定のヘルパーの戻り値、定数で分岐を固定する手口など）を書いていない（計画書の制約）。

### 2.2 Codex 側: 純正 review × GPT-6 Sol のまま

- 確認用 2 の OWASP 0.964、バグ 46 件で 41 件検出（P1 26 件）、92 秒/カテゴリ。
- GPT-5.6 Sol は同等の精度で約 2 倍遅い。Astra は P1 で止める力が弱い（19 件）。
- **自前観点を Codex に渡すと悪化する**（分析用で 0.964 → 0.800）。Codex には独自の指示を渡さない。

### 2.3 昇格: 公式 `/security-review` → own-security

- 確認用 2 の OWASP で own-security × Opus 5.5 は 1.000、公式は 0.727（確信度 8 未満を捨てる仕様で 15 件見逃し）。82 秒/カテゴリ（公式は 153 秒）。
- バグのない変更 46 件で人を止めたのは 4 件（うち 3 件は本物のバグ）。
- 未確認: 深掘りが v5 に上乗せする効果（今のデータでは v5 だけで満点）。運用で「深掘りだけが見つけた指摘」を数える（§7）。

## 3. レビュアーと固定モデル

| 名前 | 中身 | モデル / effort | 起動 |
|---|---|---|---|
| own-review | `prompts/own-review.md` | claude-opus-5-5 / high | 毎回 |
| codex-review | `codex exec review`（純正） | gpt-6-sol / high | 毎回 |
| own-security | `prompts/own-security.md` | claude-opus-5-5 / high | 昇格・`--security`・`--deep` |
| own-review-fable | `prompts/own-review.md` | claude-fable-5-1 / high | `--deep` |
| codex-astra | `codex exec review`（純正） | gpt-6-astra / high | `--deep` |

- モデルと effort は `run-reviews.sh` の定数。環境変数で上書きできない（固定が契約）。
- 自前観点はスラッシュコマンドとして入れず、`run-reviews.sh` が frontmatter を外し、「対象: $ARGUMENTS（…）」の行を具体的な対象（branch: `比較範囲: <base>...HEAD の差分`、local: `対象: 未コミットの変更（ステージ済み・未ステージ・未追跡）`）に置き換えて `claude -p` に渡す。置き換える行が無ければ起動しない（黙って `$ARGUMENTS` のまま渡さない）。実際に渡した本文は `<名前>.prompt.md` に残る。
- 道具: `--allowedTools "Read,Grep,Glob,読み取り系の git サブコマンド（diff / show / log / status / ls-files / rev-parse / blame / merge-base / cat-file）,Task,Agent,TodoWrite"`、`--disallowedTools "Write,Edit,NotebookEdit,WebFetch,WebSearch,Bash(git *--output*),Bash(git *--ext-diff*),Bash(git *--textconv*),Bash(git *--no-index*),Bash(git *--contents*)"`（git の書き込み・外部コマンドのオプションを拒む。`Bash(git:*)` は `git -c core.fsmonitor=…` で任意実行できたので使わない。2026-09-23 実測）、`--permission-mode dontAsk`。ユーザー設定の既定が `auto` なので、`dontAsk` を明示しないと許可リスト外の Bash が通りうる。
- 設定の隔離: `--setting-sources "" --safe-mode --strict-mcp-config`。ユーザーの `permissions.allow`（`Bash(bash *)` など）は dontAsk でも通って許可リストを迂回し、レビュー対象のコミットに入った `.claude/settings.json` のフックは開発者の権限で動く。どちらも従来の起動で実行されることを 2026-09-23 に実測し、隔離後は拒否されること・読み取り系の git は動くこと・CLAUDE.md とフックの注入が消えることを確かめた。v3 の初回ゲート（自分自身のレビュー）で own-review と own-security が見つけた。
- プロンプトは `-p` の直後に置く。`--allowedTools` などの可変長オプションの後ろに置くと、道具名として飲み込まれる。

### 3.1 `--deep` の中身と根拠

計画の決定（強化版 1 回 15 分・$15 程度まで）に沿って、確認用データの比較から次を選んだ。

- own-security を毎回: 深掘りの閾値の揺れは自前観点では問題にならない（確信度で捨てない設計）。v2 案の「公式 `/security-review` を 2 回実行して和集合」は、own-security への置き換えで不要になった。
- own-review × Fable 5.1: モデル起因の誤読（誤判定の約 1 割、計画 1-2）への対策として、同じ観点を別モデルで読む 2 人目の Claude。
- Codex × Astra: 2 人目の Codex。P1 で止める力は Sol より弱いが、見逃しを拾う側に和集合で足す。
- 推奨表示（強制ではない）: `--deep` を回していないとき、差分が escalation-rules の `max_files` / `max_added` を超えた、BLOCK 相当の指摘がある、昇格ルールの path（A）に当たる、のどれかで `gate.py summary` と `record-gate.sh` が推奨を出し、SKILL.md がレポートに書かせる。

## 4. 結論の 3 段と機械の下限

| 結論 | own-review / own-security（§4.4 の結論行） | Codex | その他 |
|---|---|---|---|
| BLOCK | 深刻度 High の「脆弱・不具合」がある | `[P1]`（`[P0]` も含める） | レビュー結果が 1 つも無い |
| MUST-ADDRESS | Medium・Low の「脆弱・不具合」、または「要確認」 | `[P2]` / `[P3]` | 判定表の欠け、結論行を読めない出力 |
| PASS | 強化提案と設計の指摘だけ、または指摘なし | 指摘なし | — |

- ゲートの結論 = 全レビュアーの段の最も重いもの（和集合）。
- `gate.py summary` が生出力から下限（floor）を機械で決め、`record-gate.sh` は `--verdict`・floor・項目の段の最も重いものを記録する。エージェントの突合で結論を軽くできない。
- さらに、段が MUST-ADDRESS 以上のレビュアーについて、そのレビュアーを `source` に含む同じ段以上の項目が無ければ記録を拒む。1 人分の指摘を書き起こしで丸ごと落とすのを防ぐ。
- 結論行が読めない出力を PASS 扱いにしない（黙って通さない）。MUST-ADDRESS の自動項目にし、生出力を読んで片づけさせる。

## 5. 判定表の完全性

- `run-reviews.sh` が `changed-files.txt`（削除とバイナリを除く変更ファイル。ルートからの相対）を作り、自前観点の出力の表の 1 列目と照合する（`gate.py table-check`。バッククォート・太字・`./`・`:行番号`・リンク形式を許す）。
- 欠けがあれば初回の出力を `attempt1.md` に残して 1 回だけ単独で再実行する。再実行が失敗・タイムアウト・空なら初回の出力に戻す（初回は完走しているので失敗扱いにしない）。
- それでも欠けたファイルは `<名前>.missing.txt` に残し、記録時に「判定なし（要確認）」の MUST-ADDRESS 項目（source `table-check:<名前>`）になる。
- 再実行は直列（1 本ずつ）。`--deep` で 3 本とも欠けると最悪 3 回分の時間が足される。書き漏れは 1 件程度で再実行でほぼ埋まる想定。

## 6. MUST-ADDRESS の片づけ（C 案）

2026-09-23 のヒアリングで決めた「ゲートの立ち位置」（`ai-review-own-guide-design.md`）をそのまま実装した。

- 役割: ローカルの第 1 ゲート。サブスクリプションの範囲で早く安く回し、手前で潰す。PR のレビュー Bot は第 2 ゲート。
- v5 はバグのない変更の約半分で MUST-ADDRESS を出す。止めて人を呼ぶのではなく、作業中の AI が 1 件ずつ片づける形で吸収する（ユーザーは品質重視でこれを許容）。
- 1 件ごとに次のどちらか（`resolve-item.sh`）:
  - **fixed**: 直して commit し、新しい HEAD で `/ai-review` を再実行する。record-gate が前回の fixed 項目を「再レビュー済み」（`prev-<id>`、`re_reviewed_sha`）として引き継ぐ。再実行で同じ問題が出れば新しい open の項目になる。fixed のまま再実行しなければ push は通らない（そのコードはまだ誰もレビューしていないため）。
  - **accepted**: 直さない理由をコードで確かめられる形で記録する。**作業の文脈を持たない別のサブエージェント**が、理由がコードで成り立つかを検証する（悲観的な指示で反証を探させる）。upheld で片づく。rejected なら open に戻る。
- 高リスク（ア案）は upheld に加えて**人の承認**が要る。高リスク = 昇格ルールの path（A 区分: 認証・課金・DB・権限など）に当たるファイルの指摘、または外部入力がコマンド・SQL・パス・LDAP・XPath・テンプレート・リダイレクト・デシリアライズに届く注入型の指摘。記録時に機械で `high_risk=true` を足し、エージェントの申告では下げられない（語で拾うので拾いすぎはありうるが、人に聞く回数が増える側に倒れるだけ）。
- 人の承認は `approved_by: "human"` と、ユーザーの発言をそのまま `approval_note` に残す。SKILL.md は「チャットで尋ね、明示の承認があったときだけ記録。自分で承認しない」と定める。スクリプトは承認の真偽を確かめられないので、ここは手順と記録（監査できる発言の原文）で担保する。
- 理由・検証・承認はレビューした HEAD（`head_sha`）に対してだけ記録できる。HEAD が動いたら再実行から。
- BLOCK は直すしかない（pre-push が必ず止める）。誤検知だと考えるなら人に判断を仰ぎ、明示された場合だけ `AI_REVIEW_BYPASS=1`。
- 強化提案は項目にしない（止めない）。安く直せるものは直し、それ以外はレポートに残す。

### 6.1 pre-push の判定

| 記録 | 判定 |
|---|---|
| verdict = block | 拒否 |
| verdict = must-address、項目がすべて「fixed かつ re_reviewed_sha = レビュー済み SHA」または「accepted かつ verifier = upheld かつ（高リスクでない または approved_by = human）」 | 通す |
| verdict = must-address、それ以外の項目が 1 件でもある／項目が空 | 拒否（未処理の項目と理由を出す） |
| verdict = pass | 通す |
| verdict がそれ以外（v2 の fix を含む） | 拒否（再実行を求める） |

既存の検査（head_sha と push 対象の照合、mode = branch、昇格の未実施、`AI_REVIEW_BYPASS`、`ai-review.skip`）は v2 のまま。項目の検査に python3 を使い、見つからなければ拒否する（黙って通さない）。

## 7. 運用で確かめること

- レポートの「出所」列（和集合で誰が見つけたか）を蓄積し、「1 人だけが拾った本物の指摘」「深掘りだけが見つけた指摘」「`--deep` の追加 3 本だけが見つけた指摘」を数える。深掘りの上乗せ効果と `--deep` の費用対効果はここで答える。
- MUST-ADDRESS の件数、accepted の検証が rejected になった率、人に承認を求めた回数（止まった回数と手間）。
- 成功の物差し: PR で Bot が見つける件数、ベンチのスコア、止まった回数と手間（計画書と同じ）。

## 8. 外したもの

| 外したもの | 理由 |
|---|---|
| ECC 版 `/code-review` | 自前観点 v5 が確認用データで同等以上（OWASP 1.000、止めすぎ 0 vs 4、コスト約半分）。ユーザー環境の上書きに依存する構成は再現性がない（2026-09-23、素の環境では組み込み版の値だった事実が発覚） |
| 公式 `/security-review` | own-security が確認用 2 で 1.000 vs 0.727、約半分の時間。確信度 8 未満を捨てる仕様がゲートの「見逃しの方が高くつく」と合わない |
| JEV（`--jev` の型付け、昇格トリガー F） | 型付けは「怪しい指摘の見分け」に効かないと測定済み（AUC 0.50）で既定オフだった。トリガー F は grep の見逃しを 1 件救ったが、v3 は注入型・高リスクの判定を記録時に機械で行い、深掘りの推奨も出すので、外部 API キー依存の経路を残す理由が薄い。公開版は Claude Code と Codex CLI だけで動かす（計画書の決定）。`/pr-triage` には残す |
| v2 の「片方だけの指摘を不採用にする」裁定 | 和集合＋C 案に置き換えた。不採用にする代わりに、理由を記録して文脈のない検証者に確かめさせる |
| `--local` の index 退避・復元 | 自前観点は未コミット・未追跡を自分で読み、Codex は `--uncommitted`。index に触れる理由が無くなった |
| v2 の結論 `fix`（Medium 以下は push 可） | MUST-ADDRESS に置き換え。直すか理由を記録するまで止める |

## 9. 検証

- `scripts/test-gate.sh`（ダミー実行とフィクスチャのみ。実モデルを呼ばない）: レビュアーの起動数とモデル、プロンプトの組み立て、`--deep` の 5 本、判定表の検査と 1 回の再実行、結論の読み取りと下限、`--deep` の推奨、記録の検証（下限への引き上げ、レビュアーごとの網羅、高リスクの自動付与）、pre-push の各判定（block / must-address の open・検証待ち・rejected・upheld・高リスクの承認なし・承認あり / fixed の再レビュー前後 / pass / 壊れた記録）、JEV・ECC への依存が残っていないこと。
- `scripts/test-isolation.sh`（v2 から継続。レビュアー名だけ v3 に更新）: 作業ツリーの隔離と SHA の照合。
- 未実施: 実モデルでの通し実行（テストはトークンを使わない方針）。導入後の最初の実行で、`--permission-mode dontAsk` と道具の制限の下で own-review が差分を読めること、Codex の出力の `[P1]`〜`[P3]` の形が想定どおりであることを確かめる。

- Codex がレビュー対象の `.codex/config.toml` を読む経路: 起動に `-c notify=[] -c mcp_servers={}` を付けて notify と MCP は打ち消した。信頼済みリポジトリの worktree で `model_provider`（送信先の差し替え）が読まれるかは未確認（2026-09-24、6 周目の own-security の指摘）。
- 人の承認（`--approve-human`）は、端末（/dev/tty）で項目の ID を打ち込んだときだけ記録する（2026-09-24、7 周目の own-security の指摘）。AI の Bash には端末が無いので誤って書く経路は塞げるが、疑似端末（python の pty など）を作れば AI でも通せる。技術的な強制ではなく、手順と記録で担保する前提は変わらない。
