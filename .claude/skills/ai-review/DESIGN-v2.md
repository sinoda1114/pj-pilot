# /ai-review v2 設計メモ（2026-09-11 確定）

`ai-review-benchmark-v2`（OWASP Benchmark Java 110 件）の結果を受けて `/ai-review` スキルを刷新した記録。
v1 は `SKILL.md.v1` として保存。本メモは「なぜこの設計か」の正本。SKILL.md は「どう動くか」のみ書く。

---

## 1. ベンチが示した v1 の実力

`ai-review-opuscodex`（Opus 4.8 + Codex GPT-5.5、2026-07-04）= **Score 0.945（TP54 FP2 FN1）**。

| 方式（同世代） | Score |
|---|---|
| codex-review-isolated（GPT-5.5 単体） | 0.982 |
| cc-security-review（Opus 4.8 単体） | 0.945 |
| **ai-review v1（両者の二重）** | **0.945** |
| cc-code-review（Opus 4.8 単体） | 0.855 |

### 誤り 3 件の解剖（生レポート精読）
- **FP 00051 / 00052**: `SeparateClassRequest.getTheValue()` の実装を読まず「リクエスト由来」と仮定して High。Codex は `CRITICAL CONSTRAINTS` で FS アクセス禁止だったため参照先を追えず、CC も追わなかった。両者が同じ仮定で一致し、§5 の「両方が指摘＝信頼度高」ルールが誤りを増幅。
- **FN 00007**: Codex は Medium と指摘したが、CC が「cmdi 不成立」と再評価して Low に格下げ。唯一の不一致ケースで CC の裁定が外れた。

**二重化が誤りを救った例は 3 件中 0 件。** 一致 2 件は共倒れ、不一致 1 件は裁定ミス。

### v1 の構造的欠陥
1. **独立性がない**: CC が Codex 出力を先に読む設計（§4「Codex の結果を読んだうえで独立に」は矛盾）。
2. **差分の外を読まない**: 呼び出し先・設定値を確認する手順がない。誤り 3 件すべてここ。
3. **スコープ非決定**: untracked 100 件（460KB）を巻き込んだ回と staged 10 件のみの回が混在。
4. **重い**: 1 カテゴリ 5〜9 分、Codex → CC 直列。

---

## 2. 設計根拠の監査

v1 の設計記録（2026-05-21、`~/dev/ai-review/ai-review-overview.html`）を確認した結果:
- 二重化の理由は「もともと Codex / CC / `/security-review` を手で叩いていたから 1 コマンドに束ねた」。**精度向上の検証は当時も以後もゼロ**。
- 「異なるベンダーの AI は盲点が違う」は仮説として記述されているのみ。
- 当時の検証は自作の仕込み脆弱性 4 件のみ。組み込み `/code-review` は比較対象に入っていなかった。

---

## 3. 議論と決定

### 3.1 二重レビューは残す（ユーザー主張を採用、条件付き）
- 原理は正しい: 誤りが相関しない第二の視点があれば見逃しは減る。ベンチは狭い代理指標で、原理を否定しない。
- 条件: **独立した二人に同じ材料を渡し、不一致を調査の合図として扱う**。v1 はこの条件を満たしていなかった。
- 実運用で「片方だけが拾った本物の指摘」を記録し続け、二人目の価値をベンチではなく実データで答える。

### 3.2 モデルは Opus 5 固定（ユーザー主張を採用）
| 方式 | Opus 5 | Fable 5.1 |
|---|---|---|
| /code-review | 1.000 | 1.000 |
| /review（PR型） | 1.000 | 1.000 |
| /security-review | 0.964 | 0.891 |

- Fable 5.1 が Opus 5 を上回った項目なし。料金 2 倍（$10/$50 vs $5/$25 per 1M）。PR 型で 2.8 倍遅い。
- Fable 5.1 の昇格オプションも**落とす**。発動条件を裏付けるデータがない＝形だけになる。

### 3.3 ゲートは 2 段 → 1 段（push 前）
- v1 の 2 段の理由は「スコープ違い」と「セキュリティ深掘り」。後者は `/code-review`（1.000）が `/security-review`（0.964）を上回った時点で消えた。
- 運用は squash マージ既定なので、コミット単位の粒度に意味がない。外に出る境界は push だけ。
- 未コミット段階の早期チェックは「任意」として残す（`--local`）。

### 3.4 レビュー本体は両方とも純正コマンド
- CC 側: 自作観点リストではなく組み込み `/code-review`。1.000 を出したのは `/code-review` そのもので、自作観点で同じ性能が出る保証はない。
- Codex 側: 自作プロンプトではなく純正 `codex exec review`（sol/high、0.982）。read-only サンドボックスで参照先クラスを自分で読める。
- 自作スキルの役割は「並列起動・突合・不一致の検証・レポート・昇格判定」に縮む。

### 3.5 `/security-review` は昇格オプション（機械トリガー）
両コマンドの実体を読み比べた結果、重ならない価値は「検知できる種類」ではなく「作り方と出力の性質」:

| | /code-review | /security-review |
|---|---|---|
| 目的 | マージを止めるか決める門番 | セキュリティ監査レポート |
| 仕組み | 1 レビュアー | 洗い出し 1 体 → 偽陽性フィルタ N 体並列 → 確信度 8 未満は捨てる |
| 出力 | BLOCK/APPROVE、脆弱性、バグ、「偶然安全で脆い箇所」 | 確信度・**攻撃シナリオ（実ペイロード）**・修正案、「見たが報告しない」一覧 |
| 得意 | 再現率 | 精度（誤検知 0） |
| 苦手 | ノイズ | 閾値で本物を落とす（Opus 5 で 2 件） |

- 門番は見逃しの方が高くつくので `/code-review`。`/security-review` は「本物か嘘か」を確信度で切る精度特化なので、**門番が拾った疑いの裁定役**に使う。
- 人の記憶に頼る「任意オプション」は装飾。**スクリプトが機械的に発動**し、飛ばすには明示が要る形にする。
- 注意: `/security-review` の組み込みプロンプトは「シークレットのディスク保存」「古い依存ライブラリ」「DoS」を**明示的に除外**している。これらは別の仕組み（Dependabot 等）が担う前提。

---

## 4. v2 の設計図

```
 人間                         /ai-review（自作オーケストレータ）              純正レビュー
 ────                         ─────────────────────────────────              ──────────
 コードを書く
 git commit（何回でも）
     │
 /ai-review を打つ ─────────▶ ① 差分取得 origin/HEAD..HEAD
                              │
                              ② 昇格判定（スクリプト・grep）
                              │   パス／内容／規模 → escalate = true/false
                              │
                              ③ 並列起動 ───────────────────────▶ /code-review (Opus 5)
                              │                                   codex exec review (sol/high)
                              │◀──────────────────────────────── 両結果
                              ④ 突合
                              │   一致 → 採用
                              │   不一致 → 根拠コードを読んで検証
                              │   セキュリティ指摘あり or 不一致 → escalate = true
                              │
                              ⑤ escalate ?
                              │   ├ false → ⑦へ
                              │   └ true  → 自動起動 ─────────────▶ /security-review (Opus 5)
                              │            │◀───────────────────── 確信度付き結果
                              │            └ レポートに追記
                              │
                              ⑦ レポート生成 md/html
                              │   latest.json = {head_sha, escalate, escalation_done, reason}
     │◀────────────────────── 結論提示「push 可 / 修正後 push / push 不可」
     │
 ★ レポートを読む
   ・直す → commit → /ai-review やり直し
   ・OK   → 下へ
     │
 git push ──────────────────▶ pre-push フック
                              │   head_sha ≠ HEAD            → 拒否
                              │   escalate かつ 未実行        → 拒否
                              │   両方 OK                     → 通過
```

### スキップが入る唯一の場所（⑤）
```
escalate = true
 ├ 通常 → /security-review 自動起動（人は何もしない）
 └ 人が「昇格スキップ」と明示した場合のみ
      → 起動せず、latest.json に skipped_by_user=true と理由を記録
      → pre-push フックはこのフラグを見て通す
```
人は「やる」判断をしない。「やらない」と言うときだけ手を出し、それは記録に残る。

---

## 5. 使うスキルとモデル（確定）

| 役割 | スキル／コマンド | 提供元 | モデル | effort | 根拠スコア |
|---|---|---|---|---|---|
| 門番 A | `/code-review` | Claude Code 組み込み | claude-opus-5 | high | 1.000 |
| 門番 B | `codex exec review` | Codex CLI 純正 | gpt-5.6-sol | high | 0.982 |
| 昇格 | `/security-review` | Claude Code 組み込み | claude-opus-5 | high | 0.964・FP 0 |
| 判定ルール | `escalation-rules.txt` | 自作 | なし | – | – |
| 束ね役 | `/ai-review` | 自作 | セッション既定 | – | – |

起動コマンド:
```
claude -p --model claude-opus-5 --effort high "/code-review"
codex exec review --base <base> -m gpt-5.6-sol -c model_reasoning_effort="high" -o <file>
claude -p --model claude-opus-5 --effort high "/security-review"
```
モデルと effort はスキル内で固定。セッションが Fable で走っていてもゲートは Opus 5。

### 使わないもの
| 落とすもの | 理由 |
|---|---|
| 自作レビュー観点（v1 §4） | `/code-review` 1.000 に裏付けなしで対抗できない |
| Codex 自作プロンプト（v1 §3.2） | 純正 review が 0.982。FS 禁止で参照先を読めない欠陥 |
| Fable 5.1 | Opus 5 に勝った項目なし。料金 2 倍・2.8 倍遅い |
| Terra / Luna | Sol 0.982 > Terra 0.945 > Luna 0.855 |
| `claude-security` プラグイン | 1.000 だが 13 時間。ゲート不可、棚卸し用 |

---

## 6. 昇格トリガー（どれか 1 つで発動）

| # | 種類 | 判断者 | 条件 |
|---|---|---|---|
| A | パス | スクリプト | auth / login / session / oauth / token / payment / billing / checkout / migration / schema / *.sql / prisma / middleware / rbac / permission / policy / .github/workflows / Dockerfile / *.env.example / package.json 依存追加・lockfile |
| B | 追加行の内容 | スクリプト | exec( / spawn( / eval( / child_process / crypto / jwt / bcrypt / cipher / SQL 文字列連結 / fetch( axios( 外部 URL / fs.* に入力由来変数 / Set-Cookie / Access-Control-Allow-Origin |
| C | 規模 | スクリプト | 変更ファイル > 20 または 追加行 > 1,000 |
| D | ゲート結果 | 出力の事実 | `/code-review` か Codex のどちらかがセキュリティ分類の指摘を 1 件でも出した |
| E | 不一致 | 出力の事実 | セキュリティ指摘で両者の判定が割れた |

- A〜C をモデルに判断させない理由: `cc-review-fable5` が「意図的だから報告不要」と自己判断した事故と同じ穴が開く。grep は空気を読まない。
- D・E はモデル出力を使うが「指摘があるか」「割れたか」という事実の有無だけ。
- パターンは `escalation-rules.txt` に外出しし、プロジェクトごとに `.ai-review/escalation-rules.local.txt` で追記可能。

---

## 7. 実機で確認した仕様（2026-09-11、Claude Code 2.1.261 / codex-cli 0.153.3）

- `/code-review`: 引数は「PR 番号 / ブランチ名 / なし（現在ブランチをベースと比較）」。ベースは origin/HEAD 等から merge-base を解決。未コミット差分は staged なら対象。
- `/security-review`: `git diff origin/HEAD...` 固定。`origin/HEAD` 必須。確信度 8 未満は非報告。DoS・ディスク上のシークレット・古い依存は除外。
- `codex exec review`: `--base <branch>` / `--uncommitted` / `--commit <sha>`。`-o <file>` で最終回答のみ取得。`~/.codex/config.toml` 既定は model=gpt-5.6-sol / effort=high。

---

## 8. 既存環境との関係・残タスク

- **既存 `~/.git-hooks/pre-push`**（全リポジトリ共通）は「auth/payment/schema パスなら `/claude-security scan` を warn-only で実行」する内容。v2 のフックはこれを**置き換える**（v2 フックは latest.json 検査＝ブロック型。claude-security は棚卸し用に手動実行へ）。置き換えはユーザー確認のうえ実施。
- `~/.claude/CLAUDE.md` の「Push 前ローカル AI レビュー（2 段ゲート運用）」節を 1 段ゲートに書き換える。
- `~/.claude/skills/ai-review/` 更新後は claude-kit へ同期（`scripts/sync-from-local.sh --yes` → commit/push → `update-repos.sh`）。
- **再測定**: v2 を `ai-review-v2-opus5sol` としてベンチに追加し、v1（0.945）と比較する。Level0（中立）で実施。目的は「CC 単体 vs CC+Codex」の差を同世代で測ること。
- 実運用ログ: レポートの「片方だけが指摘」欄を蓄積し、二人目の価値を実データで評価する。

## 10. JEV（TypeSafe AI System One）の組み込み（2026-09-20 決定）

判断専用モデル JEV（文章を返さず Choice/Score/Noul を較正済み確率で即答）を、**突合の型付け**にだけ使う。レビュアーにはしない（文章生成なし）。設計根拠は `~/dev/setsumei/2026-09-18-jev.md`。

| 判断点 | 適否 | 使い方 |
|---|---|---|
| ② 昇格判定（grep） | 追加のみ | grep は残す。JEV は「セキュリティ分類の指摘あり」（D 条件）の機械化に使う |
| ③ レビュー本体 | ✗ | 文章生成なし |
| ④ 突合 | ◎ | 指摘ごとに `is_security` / `assumption` / `severity`、code-review × codex の同一ファイルペアに `same_issue` |
| ⑥ verdict | ✗ | 重大度から決定的に決まる |

<<<<<<< Updated upstream
- 原則: JEV は指摘を落とさない・裁定しない。`assumption ≥ 0.5` を検証順の先頭に回す（ベンチ FP 2 件の根本原因＝helper 未確認を機械的に検出するため）
=======
- 原則: JEV は指摘を落とさない・裁定しない。当初案は「`assumption ≥ 0.5` を検証順の先頭に回す」だったが、下記の測定で本物と誤検知を区別できないと判明し、assumption/severity は参考値のみとした（検証順にも判定にも使わない）。D 条件は追加方向にだけ使い、既存の昇格を解除しない
>>>>>>> Stashed changes
- フェイルセーフ: キー無し・API エラーは `available=false` で素通り。ゲートの成否に影響させない
- 経路（2026-09-20 実測）: **TypeSafe 直接 API** `POST https://api.typesafe.ai/v1/systemone`（model `jev-latest`、実体 jev-1.13.0）が 200 / 0.6 秒で動作。テスト用キー（ユーザー提供、後日削除予定）で 4 指摘 + ペア判定 5 呼び出し 2.9 秒。代替は Vercel AI Gateway の TypeSafe 互換 API（`POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`、model `typesafe-ai/jev`、$0.042/M 入力、出力無料）。Cloudflare Workers AI には未収載（2026-09-20 実測、setsumei の記述は誤り）。直接 API は待機リスト
- キー: `vercel ai-gateway api-keys create --name ai-review-jev --budget 5 --refresh-period monthly` で作成し `~/.config/ai-review/jev.env` に保存（2026-09-20）。**AI Gateway はクレジットカード登録が無いと 403** を返す。登録はユーザー操作
- 効果測定（2026-09-20 ヒアリングで確定・**測定前に固定**）: 110 件ベンチは使わない（単位が「ファイル」で JEV の単位「指摘」と違う。部品単体が 1.000/0.982 で天井）。
  - 土俵: 過去のベンチ生出力から「方式が vulnerable と報告したファイルの指摘文」を抽出し、ファイル正解で TP/FP ラベルを付ける（誤検知の多い方式を含む）+ pj-pilot PR #95 の Bot 指摘 26 件（正誤判定済み）
  - 基準: ①`assumption ≥ 0.5 または severity ≤ 1.0` で FP 指摘の 70% 以上を拾い、TP 指摘の巻き込み 15% 以下 ②セキュリティ分類（is_security ≥ 0.5）の正解率 95% 以上 ③同一指摘ペアリング（same_issue ≥ 0.7）が手作業と 90% 以上一致 ④レポート完成までの増加 60 秒以内
  - 判定: 全部満たす → 自動モード（指摘 4 件以上 または 2 者の判定が割れたとき発動。`--jev`/`--no-jev` で上書き）を既定 / 一部 → 手動 `--jev` のみ / 全滅 → 外す
  - 基準値測定 `ai-review-v2`（cat1・cat2 = 20/20）は JEV と独立のため保留。再開は cat3 から可
- **結果（2026-09-20 11:12、`case-110-balanced/_slash-eval/jev-eval/jev-eval-report.md`）**: OWASP 生出力 19 方式 1,017 指摘（TP 971 / FP 46）+ PR #95 26 件、1,043 呼び出し / 647 秒 / エラー 0
  - ① **不合格**: flag（assumption ≥ 0.5 or severity ≤ 1.0）は FP の 67% を拾うが TP も 64% 巻き込む。分布分析で assumption の AUC 0.499、severity 0.534 = **偶然と同じ**。どの閾値でも FP と TP は分離しない。JEV は指摘文しか見ないため、自信ありげに書かれた誤検知（例: v1 の 00051「getTheValue はリクエスト由来」）は本物と同じ文面に見える
  - ② 合格: セキュリティ分類 95.6%（997/1043） ③ 合格: 同一指摘ペアリング 96.7%（60 ペア） ④ 合格: 10 指摘 6.2 秒
  - **判定（事前ルールどおり）: 手動 `--jev` のみ。自動発動しない。** 使えるのはセキュリティ分類（D 条件の機械化）とペアリングだけで、「怪しい指摘の見分け」という本命の効果は無い。参照先コードを読む検証を代替できるものは無く、v1 の誤検知の再発防止策は引き続き「Read して確かめる」
  - 教訓: 判断専用モデルは「文面の分類」には強いが「文面の真偽」は判定できない。真偽はコードを読む側にしか分からない

## 11. 却下した案

| 案 | 却下理由 |
|---|---|
| 純正 `/code-review` 単体に置き換え（Codex を落とす） | 二重化の原理は正しい。実装不備を原理の否定と混同しない |
| Fable 5.1 を既定または昇格に使う | データ上の優位なし。根拠のないトリガーは形だけ |
| 2 段ゲート維持 | セキュリティ深掘りの根拠が消えた。squash 運用でコミット粒度に意味なし |
| 昇格を人の判断に任せる | 記憶依存＝装飾。機械トリガー＋明示スキップに変更 |
| 自作レビュー観点の温存 | 1.000 の純正に対し性能の裏付けがない |
| JEV を昇格判定の grep の代わりにする | 確率判定になりルールの監査性を失う。追加トリガーとしてのみ |
| JEV に不一致の裁定をさせる | JEV はリポジトリを読めず、参照先確認という肝心の検証を代替できない |
