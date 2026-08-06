---
name: project-standardize
description: 既存リポジトリに標準の運用・管理ルールを当てる。プロジェクト固有値の確定、プレースホルダ穴埋め、GitHub 初期セットアップ（origin/HEAD / type ラベル / Project 板）、デプロイ連携確認までを行う。「運用ルールを当てる」「プロジェクト初期化」「standardize」「GitHub のセットアップして」等で使う。リポジトリ作成そのものはローカル専用のため対象外。
metadata:
  author: sinoda
  version: "1.0"
---

# project-standardize

既にあるリポジトリに、標準の運用・管理ルールを当てるスキル。
`project-bootstrap` のうち、**クラウドエージェントでも実行できる部分**を切り出したもの。

挙動ルール（ブランチ規律 / レビューゲート / デプロイ規律 / GitHub 正本 / Issue 管理 / 供給網）は
`~/.claude` グローバル、またはリポジトリの `CLAUDE.md` に入っている前提。このスキルは
「**プロジェクト固有値**」「**GitHub 側の初期設定**」「**デプロイ連携の確認**」を整える。

## このスキルの適用範囲

| 対象 | 可否 |
|---|---|
| 既にあるリポジトリへの適用 | ○ |
| テンプレート由来リポジトリの穴埋め | ○（`scripts/fill-placeholders.sh` がリポジトリ内にあるため） |
| GitHub の初期セットアップ | ○（`gh` が使えれば） |
| **新規リポジトリの作成そのもの** | **✗ ローカル専用** → `project-bootstrap` を使う |

新規プロジェクトの作成は Private テンプレートからの展開が必要なため、ローカルで
`project-bootstrap` を使う。このスキルは「リポジトリが既に存在する」ところから始まる。

## 0. 前提確認（最初に必ず）

```bash
gh auth status                                            # 認証済みか
pwd && git rev-parse --is-inside-work-tree 2>/dev/null    # 対象 dir / git 状態
git remote -v                                             # リモートの確認
ls scripts/fill-placeholders.sh 2>/dev/null               # テンプレ由来かの判定
```

`gh auth status` が失敗する場合、§3 の GitHub セットアップは実行できない。
その場合は §1・§2 まで進め、§3 は手順を提示してユーザーに委ねる。

## 1. プロジェクト固有値を確定する

`AskUserQuestion` 等で以下を確定する。**推測で埋めない。**

| 変数 | 意味 | 例 |
|---|---|---|
| `PROJECT_NAME` | プロジェクト/ブランド名 | MatchFav |
| `REPO_SLUG` | repo ディレクトリ名 | wc-tournament-tracker |
| `GH_OWNER_REPO` | GitHub の owner/repo | owner/wc-tournament-tracker |
| `DEPLOY_PLATFORM` | デプロイ基盤 | Vercel / Netlify / Cloudflare Pages / 手動 |
| `PROD_URL` | 本番 URL | https://example.com |
| `DOMAIN` | 独自ドメイン | example.com |
| `SITE_URL_ENV` | 絶対 URL を持つ env 名 | NEXT_PUBLIC_SITE_URL |
| `PROJECT_BOARD` | Project 名 | {PROJECT_NAME} Tasks |
| 役割境界 | 担当エージェント/領域（任意） | UI / 認証課金 / データ / 法務SEOインフラ |

あわせて次を確認する。

- **公開範囲（Private / Public）**。Public は外部公開＝不可逆寄りなので明示確認する
- **E2E テストツール**（既定推奨は Playwright）。CI テンプレは `npm run test:e2e` の存在を前提にする。
  ユーザー向け UI を持たない PJ は E2E 省略可だが、それも明示確認した上で決める
- npm/TS・JS 系なら **Fallow（コード健全性ゲート）導入の要否**。
  継続運用されるアプリ/チーム開発なら提案、単発スクリプトや使い捨てなら提案不要
- npm/TS・JS 系なら **Claude SDK（`@anthropic-ai/sdk` / `claude-agent-sdk` 等）を使うか**。
  使う場合はローカル dependency として `npm install` し、`.env.example` に
  `ANTHROPIC_API_KEY` のプレースホルダ行を追加する（実キーは書かない）。
  不要な PJ では聞くだけで追加しない（最小依存主義）

TDD をデフォルトの開発方式とする前提。実装時は `tdd-workflow` / `e2e-testing` skill を活用する。

## 2. プレースホルダ穴埋め

リポジトリに `scripts/fill-placeholders.sh` がある場合のみ実施する。

```bash
# スクリプト上部の値を §1 の確定値に書き換えてから実行
bash scripts/fill-placeholders.sh

# 残り {{...}} が無いか確認
grep -RIn "{{" AGENTS.md CLAUDE.md README.md notes/ 2>/dev/null || echo "残りなし"
```

役割境界テーブル（`AGENTS.md` のコメント）も実情に合わせて記入する。

穴埋め後は `scripts/fill-placeholders.sh` と README の「使い方」節を削除してよい（消費済みのため）。

## 3. GitHub 初期セットアップ

```bash
# origin/HEAD（/security-review が必要とする）
git remote set-head origin -a

# type:* ラベル（状態は Project カラムで持つ。status:* ラベルは作らない）
for t in bug feature content i18n legal billing data mobile ops; do \
  gh label create "type:$t" --color ededed 2>/dev/null || true; done
```

GitHub Project（板）を作成し、Status を
Inbox / Ready / Waiting / Doing / PR / Prod Check / Done にする。

```bash
gh project create --owner <owner> --title "<PROJECT_BOARD>"
```

Status のオプション編集はカラムが多いと CLI が煩雑なので、
難しければ Web UI で設定し、番号を `AGENTS.md` の `{{PROJECT_BOARD}}` 近くに反映する旨を案内する。

**Project 作成は outward-facing なので実行前に必ず確認を取る。**

## 4. デプロイ連携の確認

- git 駆動デプロイ（Vercel 等）を使うなら:
  **Production Branch = main / Preview 有効**になっているか確認する。
  これは基盤側ダッシュボードの設定で CLI で完結しないことが多いため、
  **ユーザーに設定/確認を案内**する（エージェント側では完結できない）
- git 駆動でない構成なら、`CLAUDE.md` のデプロイ原則だけ維持し、
  具体手順はプロジェクト規約に従う

## 5. 仕上げ

- 変更は **feature ブランチ → レビュー → PR → マージ**で入れる。main 直 push はしない
- 完了後、何を設定したか（labels / Project / デプロイ連携の状態）を簡潔に報告する

## 注意

- **outward-facing な操作（Project 作成・公開範囲変更・ラベル一括作成）は実行前に必ず確認**する
- シークレットを埋め込まない。`.env*` はコミットしない
- 挙動ルールはグローバル/`CLAUDE.md` にあるので、生成する `AGENTS.md` で**再説明しない**（重複・ドリフト防止）
- 既存ファイルを上書きで潰さない。追記で当てる
