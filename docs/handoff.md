# pj-pilot 引き継ぎ

新しいセッションを開いたら最初にこれを読む。次に [REQUIREMENTS.md](../REQUIREMENTS.md) を読む。

このファイルは**確定した決定事項**だけを書く。リポジトリの現在の状態（どのファイルがあるか、
どこまで実装されたか）はここに書かない。書くと必ず古くなるため、コミット履歴と実際のファイルで
確認すること。

---

## 現在地

pj-pilot（チーム向けの総合プロジェクト管理ツール）。**実装は Phase 2 まで完了**。

済んでいること:

- **OSS調査・ヒアリング・リポジトリ立ち上げ** — スタック・機能範囲・Gantt 依存連動の仕様を確定（再実行しない）
- **Phase 1（M0〜M6）** — 足場 / DB / プロジェクト・タスク CRUD / WBS / Gantt（依存伝播・Undo・連動ON/OFF・ピン留め）/ 仕上げ
- **Better Auth 本実装** — Google OAuth 限定・`ALLOWED_EMAIL_DOMAINS` によるドメイン制限（PR #33、`docs/IMPLEMENTATION_PLAN.md` R-11）
- **Phase 2（M7〜M9）** — カンバンボード / ダッシュボード / CSV エクスポート（PR #42〜#46、`docs/PHASE2_IMPLEMENTATION_PLAN.md`）

残っているのは**外部サービス側のセットアップのみ**（Issue #4: GitHub ラベル・Project 板・
Secret scanning、Issue #5: Vercel・Turso・Google OAuth）。いずれもローカル作業
（詳細は `docs/LOCAL_SETUP.md`）。

## 確定した仕様

すべて [REQUIREMENTS.md](../REQUIREMENTS.md) にある。**このファイルでは繰り返さない。**

REQUIREMENTS.md に入っているもの:

- 技術スタック（Next.js / Vercel / Mantine / SVAR React Gantt / Turso / Drizzle ORM / Google OAuth）
- ライブラリ選定の根拠と、不採用にした選択肢
- 機能スコープ（Phase 1 / Phase 2 の切り分け）
- 依存関係の仕様（FS のみ、ギャップ維持型の連動、連動 ON/OFF 切替の3階層）
- タスクの属性とスキーマ上の注意点
- 非機能・運用（GitHub Public、シークレット管理方針）

## 次にやること

1. **Issue #4 / #5 のローカル作業** — GitHub 初期セットアップとデプロイ基盤（Vercel / Turso /
   Google OAuth）。手順は `docs/LOCAL_SETUP.md` が正本
2. **デプロイ後の本番動作確認** — 実 Google アカウントでのログイン・ドメイン制限・Cron 物理削除
3. **Phase 3 の計画** — 着手する場合は Phase 2 と同様に実装計画書を先に作る

注意: `type:*` ラベルは **2026-08-06 時点で未作成**（`docs/handoff.md` の旧版に「作成済み」と
あったが実態と異なった。Issue #4 参照）。`origin/HEAD` はリポジトリ設定ではなく clone ごとの
ローカル参照なので、新しい clone では `git remote set-head origin -a` を都度実行する。

## 守るべき手続き

### スキーマ確定時は承認を取る

DB スキーマはコミット前にユーザーへ差分を提示して承認を得る。データが入った後の変更コストが
高いため。`task_assignees` 中間テーブルと工数カラムを含む初版スキーマを提示する際、必ず承認を挟む。

### ブランチ運用

`main` への直接コミットは禁止。`git fetch origin` してから `origin/main` 起点で feature ブランチを切る。

push 前のゲート:

1. `/ai-review`（ローカル）または `/code-review`（クラウドセッション。Codex CLI が無いため） —
   差分のレビュー
2. コミット
3. `/security-review` — ブランチ全体のセキュリティ深掘り（`origin/HEAD` が必要。
   新しい clone では先に `git remote set-head origin -a`）

## 技術上の注意点

- **リポジトリは Public。** Turso のトークンと Google OAuth のクライアントシークレットは Vercel の
  ダッシュボードが正本。絶対にコミットしない。`.env*.local` は `.gitignore` 済みだが、コミット前に毎回確認する
- **SVAR のパッケージ名は `@svar-ui/react-gantt`。** 旧パッケージ名 `wx-react-gantt` は npm 上に
  GPLv3 のまま残っている。Public リポジトリなので誤用するとライセンス事故になる
- **auto-scheduling は自前実装。** 無料の OSS Gantt ライブラリで依存連動を提供するものは存在しない。
  ギャップ維持型（移動量 Δ を依存グラフにトポロジカル順で伝播）を自分で書く。CPM 計算は不要
- **完成品 OSS は検討済み。** OpenProject / Plane / Vikunja などは全て常駐サーバ＋永続 DB 前提で
  Vercel では動かない。この結論は調査済みなので蒸し返さない
- **lockfile はコミットする。** `.gitignore` に入れない。CI では `npm ci` を使う
- **`.npmrc`** に `ignore-scripts=true` / `audit-level=high` / `save-exact=true` を設定済み。
  ネイティブビルドや `prepare` スクリプトが必要なパッケージを入れるときは `npm rebuild <pkg>` か
  `--foreground-scripts` で個別に許可する
- **LICENSE の著作権者**は `git config` の値を使用。変更したい場合はユーザーに確認する

## 推奨スキル

| タイミング | スキル | 用途 |
|---|---|---|
| 最初 | `project-bootstrap` | 残りの立ち上げ。Project 作成、Vercel 連携、プロジェクト固有 CLAUDE.md |
| 計画時 | `plan` | 実装計画。スキーマ案・画面構成・手順・リスクを固める |
| 実装時 | `tdd-workflow` | テスト先行。検証はエージェント自身が実行し PASS/FAIL を提示する |
| 実装時 | `vercel-react-best-practices` | Next.js / React のパフォーマンス指針 |
| 実装時 | `frontend-patterns` | React 状態管理・データ取得のパターン |
| UI設計時 | `frontend-design` | 汎用テンプレ然としない画面を作るための指針 |
| 設計判断で迷ったら | `council` | 複数案のトレードオフを構造化して比較する |
| コミット前 | `ai-review` | 未コミット差分の二重レビュー（ゲート1） |
| push 前 | `security-review` | ブランチ全体のセキュリティ深掘り（ゲート2） |

## クラウドセッションでの制約

claude.ai/code のセッションは隔離されたコンテナで動く。ローカルとは別のファイルシステムで、
リポジトリに push された内容しか見えない。

**できないこと:**

| 項目 | 理由 |
|---|---|
| Vercel / Turso / Google Cloud Console の操作 | egress ポリシーが該当ホストへの通信を遮断（実測で確認）。CLI・認証情報も無い |
| GitHub Project の作成 | Projects v2 の MCP ツールが無く、`gh` CLI も入っていない |
| GitHub ラベルの作成 | MCP サーバーに作成ツールが無い |
| `~/dev/claude-kit` 等ローカル資産の参照 | ファイルシステムが別 |

したがって **`/project-bootstrap` はローカルで実行する。** クラウドは PR 作成までが範囲。

**クラウドからローカルセッションへは連絡できる。** `ListAgents` には出ないが（クロスマシンのため
`SendMessage` では届かない）、`list_sessions` で対象を特定し、`persistent_session_id` を指定した
Routine を `create_trigger` → `fire_trigger` すれば、相手の会話にユーザーターンとして即時配信される。
`ListAgents` の空振りを「経路が無い」と読み違えて手動中継を頼まないこと（実際にやった）。
Vercel / Turso の実測など、クラウドで検証できない項目の依頼と結果回収はこの経路で完結する。

なお**ブラウザでの動作確認はクラウドでも可能**（Chromium 同梱。Playwright の E2E・
スクリーンショット取得とも実績あり。バージョン不一致時は
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` を指定する）。
E2E の書き方は `e2e/README.md` の規約に従う。

**前提:** スキルと `CLAUDE.md` が push 済みであること。セッション開始後にファイルを追加しても
認識されない。`kit-ping` で読み込み状態を確認できる。

---

## この文書の扱い

- **公開安全な内容のみ** を書く。このリポジトリは Public。ローカル環境固有の情報
  （絶対パス、認証まわりの調査ログ、社内ツールの構成）はここに書かず、ローカルの引き継ぎに残す
- 状態ではなく**決定**を書く。「今どうなっているか」はコミット履歴で確認する
