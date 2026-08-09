# ローカル専用作業 引き継ぎ指示書

クラウドセッション（claude.ai/code のサンドボックス）からは実行できない作業をまとめたもの。
`gh` CLI・Vercel CLI・Turso CLI・Google Cloud Console のいずれも認証情報がクラウド側に
無いため、ここに書いた作業はローカルの端末（またはローカルで動く Claude Code）から実行する。

このファイルは**今この時点でのスナップショット**（2026-08-08、実物で確認済み）。
`docs/handoff.md` と違い状態を書いているので、実施が進んだら古い記述は消して構わない。

---

## 0. 前提: 何がどこまで進んでいるか

コードベース側（GitHub 上で完結する作業）はクラウドセッションだけで **Phase 1（M0〜M6）と
Phase 2 がすべて完了**している。以下はコミット履歴の実物で確認した事実。

| マイルストーン | 状態 |
|---|---|
| M0〜M6 Phase 1（足場 / DB / CRUD / WBS / Gantt・依存伝播・Undo / 連動ON/OFF / 仕上げ） | ✅ 完了 |
| Better Auth 本実装（Google OAuth限定・ドメイン制限、PR #33） | ✅ 完了 |
| Phase 2 M7〜M9（カンバンボード / ダッシュボード / CSVエクスポート、PR #42〜#45） | ✅ 完了 |

残っているのは**このファイルに書いた外部サービス側の設定のみ**（Vercel / Turso /
Google OAuth）。クラウドセッションの egress ポリシーは vercel.com / turso.tech /
Google Cloud Console への通信を遮断しているため（実測で確認）、これらは引き続き
ローカルから実施する必要がある。

このファイルが対象とするのは、上記と並行して**GitHub/Vercel/Turso/Google 側の設定**を
進めるための作業。コードの実装状況とは独立に進めてよい。

---

## 1. GitHub リポジトリ設定（**作業不要になりました**）

> **更新: 2026-08-08。** この節に書いていた手動手順は、すべて
> [`sinoda1114/ci-standard`](https://github.com/sinoda1114/ci-standard) の `sweeper`
> （毎日 06:00 JST）が自動で揃えるようになりました。**手で実行しないでください。**
> 個別に `gh label create` 等を叩くと sweeper と二重管理になります。

sweeper が `repo-policy.yml` の宣言に従って収束させるもの:

- `type:*` ラベルの定義（`type:feat` / `type:fix` / `type:refactor` / `type:perf` /
  `type:test` / `type:docs` / `type:chore`。色・説明の差分も是正）
- Secret scanning / Push protection の有効化
- `.github/dependabot.yml` の配布（既存ファイルがあれば触らない）
- 標準CI（`.github/workflows/ci.yml`）の配置
- ブランチ保護（`ci / build` 必須・会話解決必須・admin にも適用）

反映を急ぐときは ci-standard の Actions → sweeper → Run workflow で即時実行できます。
標準そのものを変えたいときは、各リポジトリではなく `ci-standard/repo-policy.yml` を直します。

**旧記述の訂正**: 以前この節には「`type:feature` ラベルを GitHub API で確認したところ
存在しない」と書いていましたが、これは誤りです。実際のラベル名は Conventional Commits に
合わせた **`type:feat`** で、照会すると存在します（`type:chore` も確認済み）。
旧計画の命名で照会したまま「存在しない」と判断していました。

### 残る手作業: `origin/HEAD`（クローンごと）

`refs/remotes/origin/HEAD` はリモート側ではなく**手元のクローンの設定**なので、
新しく clone した端末では都度必要です（`/security-review` が要求します）。

```bash
git remote set-head origin -a
```

## 2. GitHub Project（板）の作成（§10.2、手作業）

**Project 板の作成は標準から意図的に除外されています。** 板は作れても Status カラムの
定義が Web UI 必須で冪等化できず、毎日「差分あり」と言い続ける壊れた仕組みになるためです
（`ci-standard/repo-policy.yml` の `excluded` に理由が記載されています）。
既存の板への Issue 追加も手作業です。

クラウドセッションの GitHub MCP サーバーには Projects v2 を操作するツールが無いため、
存在するかどうかもここでは確認できていない。無ければ作成する。

```bash
gh project create --owner sinoda1114 --title "pj-pilot Tasks"
```

Status フィールドを次の7つに設定（Web UI）:

```
Inbox / Ready / Waiting / Doing / PR / Prod Check / Done
```

Workflow（Project Settings → Workflows）:

- Item added to project → Status: `Inbox`
- Pull request merged → Status: `Prod Check`
- Item closed → Status: `Done`

リポジトリを Project にリンクする（Project → Settings → Manage access / linked repositories）。

## 3. Vercel 連携（§10.3、今すぐ実施できる）

M0 は既に `main` にマージ済みなので、**このタイミングで実施して問題ない**
（`package.json` が無い状態でのImport失敗は心配不要）。

1. https://vercel.com/new → `sinoda1114/pj-pilot` を Import
2. Framework Preset: **Next.js** / Root Directory: `./`
3. Settings → Git → Production Branch = `main`、Preview Deployments = 有効
4. Settings → Environment Variables（下表）
5. Preview 用に固定のブランチドメインを1つ割り当てる（後述のOAuthリダイレクトURI登録に必要）

| 変数 | Production | Preview | 備考 |
|---|---|---|---|
| `TURSO_DATABASE_URL` | 本番DB | Preview DB | §4 |
| `TURSO_AUTH_TOKEN` | 〃 | 〃 | |
| `BETTER_AUTH_SECRET` | ✓ | ✓ | `openssl rand -base64 32`。Better Auth本体が実際にこの値でセッション署名を行うため、本番/Previewとも必ず異なる値を設定する |
| `BETTER_AUTH_URL` | 本番URL | Preview固定URL | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✓ | ✓ | §5。**Better Auth本実装済みのため必須**（未設定だとログイン導線が機能しない） |
| `ALLOWED_EMAIL_DOMAINS` | 例 `example.co.jp` / `alice@gmail.com` | 〃 | 決定 D-07。カンマ区切りで複数可。**`gmail.com` 等の共用ドメインを指定しないこと**（全 Gmail ユーザーに開く）。個人アカウント運用では `alice@gmail.com` のようにアドレス完全一致で指定する（ドメイン指定と混在可） |
| `CRON_SECRET` | ✓ | 任意 | `/api/cron/purge-trash` の認証（`app/api/cron/purge-trash/route.ts` で検証済み・実装済み） |
| `NEXT_PUBLIC_SITE_URL` | 本番URL | Preview固定URL | |

`vercel.json` の Cron 定義（日次・UTC 18:00 = JST 3:00）は**リポジトリに既に追加済み**
（`vercel.json`、PR #25）。Vercel 側での追加設定は不要で、連携すれば自動的に有効になる。

> ⚠️ **`CRON_SECRET` は必ず値を設定すること。** `app/api/cron/purge-trash/route.ts` は
> 未設定なら fail-closed で 500 を返す実装になっているため、設定を忘れると物理削除の
> cron が一切動かない（安全側だが、気づかず放置すると論理削除したタスクが溜まり続ける）。

## 4. Turso（§10.4、未確認）

```bash
turso db create pj-pilot          # 本番
turso db create pj-pilot-preview  # Preview 用（決定: 分ける）

turso db show pj-pilot --url                # → TURSO_DATABASE_URL
turso db tokens create pj-pilot             # → TURSO_AUTH_TOKEN
```

取得した値は Vercel ダッシュボードにのみ入力する。リポジトリにコミットしない。

Vercel 連携後、初回のみマイグレーションを本番/Preview DBに当てる必要がある
（ローカルから対象DBを指してどちらか片方ずつ実行）。`drizzle-kit` は `dotenv` 経由で
カレントディレクトリの `.env` を自動読み込みするため、コマンドライン引数に直接
シェル変数代入で秘密情報を渡さない（シェル履歴に平文で残る。CWE-214）。

```bash
cat > .env <<'EOF'
TURSO_DATABASE_URL=<対象>
TURSO_AUTH_TOKEN=<対象>
EOF
npm run db:migrate
rm .env   # 使い終わったら必ず削除する（.gitignore済みだが残さない）
```

## 5. Google OAuth クライアント（§10.5、必須）

**Better Auth 本実装済み**（Google OAuth限定・`ALLOWED_EMAIL_DOMAINS`によるドメイン制限）。
以前はBetter Auth本体に未修正のCritical脆弱性があったため導入を保留していたが、該当CVE
（CVE-2026-53513, CVE-2026-67336）は`better-auth@1.6.11`で修正済みと確認し、`1.6.26`を
導入した（詳細は`docs/IMPLEMENTATION_PLAN.md` R-11参照）。この節の作業は先送りできない。

Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 クライアント ID
（Web）で、承認済みリダイレクトURIに以下を登録する。

```
http://localhost:3000/api/auth/callback/google
https://<本番ドメイン>/api/auth/callback/google
https://<Preview固定ドメイン>/api/auth/callback/google
```

同意画面は可能なら Internal（Google Workspace組織内）。ただし Internal だけでは防御にならず、
アプリ側の `ALLOWED_EMAIL_DOMAINS` 判定が必須（決定D-07 / R-10、`lib/auth.ts`・
`lib/auth/domain-restriction.ts` で実装済み）。

## 6. ローカル開発環境のセットアップ

```bash
git clone https://github.com/sinoda1114/pj-pilot.git
cd pj-pilot
npm ci
cp .env.example .env.local   # 値は Vercel ダッシュボードからコピー（正本はVercel側）
npm run db:migrate           # ローカルは file:local.db を使う（.env.localが空なら自動でこれになる）
npm run db:seed              # 任意。開発用ダミーデータ（seed-owner/seed-member）
npm run dev
```

起動後、`/sign-in` から「Googleでログイン」でサインインする。`GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET`が本物の値でないと（§5未実施の場合）実際のログインは完了しない。

---

## 重要な注意（見落とすと事故になる）

- **`ALLOWED_EMAIL_DOMAINS` 未設定に注意**: 未設定・空文字列の場合は安全側デフォルトで
  全ドメイン拒否になる（`lib/auth/domain-restriction.ts`）。ログインできない場合はまずこの値を疑う。
- **`ALLOWED_EMAIL_DOMAINS` に共用ドメインを指定しないこと**: `gmail.com` のように
  誰でも取得できるドメインをドメイン指定すると、**全 Gmail ユーザーがログインできる**。
  `lib/auth/authz.ts` のとおり閲覧は全ログインユーザーに開いているため、そのまま
  全プロジェクトが読まれる（リスク R-10）。個人アカウントで運用する場合は
  `alice@gmail.com` のように**メールアドレス完全一致**で指定する（ドメイン指定と混在可）。
- **`CRON_SECRET` 未設定に注意**（§3参照）。
- リポジトリは Public。Turso トークン・Google OAuth シークレットは絶対にコミットしない
  （`.env*.local` は `.gitignore` 済みだが、コミット前に毎回 `git status` で確認する）。
- `main` への直接コミットは禁止。feature ブランチ + PR 経由のみ。
- スキーマ変更（`lib/db/schema/`）はコミット前にユーザー承認を取る。
