# デプロイ手順書（コピペで流せる版）

**上から順に実行すれば終わります。** 各ステップに「なぜ必要か」と「終わったことの確認方法」を付けています。

このファイルは `docs/LOCAL_SETUP.md`（状態のスナップショット）と役割が違います。**こちらは手順だけ**です。

## 前提

- **Node.js 20.12 以上**（`package.json` の `engines` と同じ。22 系を推奨）。
  `npm run db:backfill-summary-type` は `.env` の読み込みに `--env-file-if-exists` を使うため、
  20.9〜20.11 では起動時に落ちます
- 所要は 30〜40 分程度（Google の同意画面設定を除く）
- **ローカルの端末**、または**ローカルで動く Claude Code セッション**で実行してください
- クラウドセッション（claude.ai/code）からは実行できません。理由は末尾の「なぜクラウドからできないか」

## この手順で必要になる、あなたしか決められない値

先に決めておくと詰まりません。

| 値 | 例 | 用途 |
|---|---|---|
| 許可するメールドメイン | `example.co.jp` | これ以外のアカウントはログインできません（決定 D-07）。カンマ区切りで複数可。`alice@gmail.com` のようにアドレス完全一致でも指定でき、両形式を混在できます。**`gmail.com` 等の共用ドメインをドメイン指定してはいけません**（全 Gmail ユーザーに開きます） |
| Turso のリージョン | `nrt`（東京） | DB の物理配置。`turso db locations` で一覧が見られます |

> **重要**: この手順で出てくるトークン類を、**チャットや Issue に貼らないでください。** Vercel と手元の `.env.local` にだけ入れます。リポジトリは Public です。

---

## Step 0. CLI を入れる

```bash
# Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash
exec "$SHELL" -l          # PATH を通し直す
turso --version

# Vercel CLI
npm i -g vercel
vercel --version
```

ログインします。どちらもブラウザが開きます。

```bash
turso auth login
vercel login
```

**確認**: 両方ともエラーなく完了すること。

```bash
turso auth whoami
vercel whoami
```

---

## Step 1. Turso で DB を2つ作る

本番と Preview を分けます。**Preview デプロイから本番 DB を壊す事故を防ぐため**です（決定 Q-3）。

```bash
turso db locations                                   # リージョン一覧（任意）
turso db create pj-pilot --location nrt              # 本番
turso db create pj-pilot-preview --location nrt      # Preview
```

接続情報を取り出します。

```bash
turso db show pj-pilot --url                  # → TURSO_DATABASE_URL（本番）
turso db tokens create pj-pilot               # → TURSO_AUTH_TOKEN（本番）

turso db show pj-pilot-preview --url          # → TURSO_DATABASE_URL（Preview）
turso db tokens create pj-pilot-preview       # → TURSO_AUTH_TOKEN（Preview）
```

**4つの値を手元に控えてください**（次以降で使います）。

**確認**:

```bash
turso db list     # pj-pilot と pj-pilot-preview が並ぶ
```

---

## Step 2. 両方の DB にマイグレーションを当てる

テーブルを作ります。**この時点でやっておくと、あとでデプロイした瞬間に動きます。**

`drizzle-kit` はカレントディレクトリの `.env` を自動で読みます。**コマンドライン引数で秘密情報を渡さない**でください（シェル履歴に平文で残ります）。

```bash
cd /path/to/pj-pilot
npm ci

# --- 本番 ---
cat > .env <<'EOF'
TURSO_DATABASE_URL=<本番のURL>
TURSO_AUTH_TOKEN=<本番のトークン>
EOF
npm run db:migrate

# --- Preview ---
cat > .env <<'EOF'
TURSO_DATABASE_URL=<PreviewのURL>
TURSO_AUTH_TOKEN=<Previewのトークン>
EOF
npm run db:migrate

rm .env    # 必ず消す
```

**確認**:

```bash
turso db shell pj-pilot ".tables"
# projects / tasks / task_dependencies / task_assignees / project_members
# user / session / account / verification が並べば OK
```

---

## Step 3. Vercel にプロジェクトを作る

先に作るのは、**次の Step 4 で Google に登録するドメインが必要**だからです。

```bash
cd /path/to/pj-pilot
vercel link          # 既存プロジェクトに紐づけ or 新規作成
vercel git connect   # GitHub リポジトリと連携
```

ドメインを確認します。

```bash
vercel project ls
vercel domains ls
```

**Preview 用の固定ドメインを1つ決めます。** Vercel の Preview は URL が毎回変わるので、そのままだと Google の OAuth リダイレクト URI を登録しきれません（リスク R-4）。ブランチ用の固定ドメインを1つ割り当ててください。

🔗 https://vercel.com/sinoda1114/pj-pilot/settings/domains

**この時点で控える値**:

- 本番ドメイン（例 `pj-pilot.vercel.app`）
- Preview 固定ドメイン（例 `pj-pilot-preview.vercel.app`）

---

## Step 4. Google OAuth クライアントを作る

ここだけはブラウザ作業です（Google Cloud に CLI での OAuth クライアント作成 API がないため）。

🔗 https://console.cloud.google.com/apis/credentials

1. **プロジェクトを選択**（無ければ新規作成）
2. **OAuth 同意画面** を設定
   🔗 https://console.cloud.google.com/apis/credentials/consent
   - Google Workspace 組織があるなら **Internal** を選ぶと審査不要で楽です
   - ただし Internal だけでは防御になりません。アプリ側の `ALLOWED_EMAIL_DOMAINS` が本体の防御線です（決定 D-07 / リスク R-10）
3. **認証情報を作成 → OAuth クライアント ID → ウェブ アプリケーション**
4. **承認済みのリダイレクト URI** に次の3つを登録

```
http://localhost:3000/api/auth/callback/google
https://<本番ドメイン>/api/auth/callback/google
https://<Preview固定ドメイン>/api/auth/callback/google
```

**控える値**: `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET`

---

## Step 5. Vercel に環境変数を入れる

シークレットを2つ生成します。**本番と Preview で別の値にしてください**（`BETTER_AUTH_SECRET` は Better Auth が実際にセッション署名に使う鍵です）。

```bash
openssl rand -base64 32    # BETTER_AUTH_SECRET 用（本番）
openssl rand -base64 32    # BETTER_AUTH_SECRET 用（Preview）
openssl rand -base64 32    # CRON_SECRET 用
```

`vercel env add` は値を対話で聞いてくるので、**シェル履歴に残りません**。

```bash
cd /path/to/pj-pilot

# --- Production ---
for k in TURSO_DATABASE_URL TURSO_AUTH_TOKEN BETTER_AUTH_SECRET BETTER_AUTH_URL \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ALLOWED_EMAIL_DOMAINS \
         CRON_SECRET NEXT_PUBLIC_SITE_URL; do
  echo "--- $k (production) ---"
  vercel env add "$k" production
done

# --- Preview ---
for k in TURSO_DATABASE_URL TURSO_AUTH_TOKEN BETTER_AUTH_SECRET BETTER_AUTH_URL \
         GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ALLOWED_EMAIL_DOMAINS \
         NEXT_PUBLIC_SITE_URL; do
  echo "--- $k (preview) ---"
  vercel env add "$k" preview
done
```

入れる値の対応表:

| 変数 | Production | Preview |
|---|---|---|
| `TURSO_DATABASE_URL` | 本番DBのURL | Preview DBのURL |
| `TURSO_AUTH_TOKEN` | 本番DBのトークン | Preview DBのトークン |
| `BETTER_AUTH_SECRET` | 生成値①（32バイト） | 生成値②（本番と別の値） |
| `BETTER_AUTH_URL` | `https://<本番ドメイン>` | `https://<Preview固定ドメイン>` |
| `GOOGLE_CLIENT_ID` | Step 4 の値 | 同左 |
| `GOOGLE_CLIENT_SECRET` | Step 4 の値 | 同左 |
| `ALLOWED_EMAIL_DOMAINS` | 例 `example.co.jp` / `alice@gmail.com` | 同左 |
| `CRON_SECRET` | 生成値③ | 不要 |
| `NEXT_PUBLIC_SITE_URL` | `https://<本番ドメイン>` | `https://<Preview固定ドメイン>` |

> ⚠️ **`CRON_SECRET` を忘れないこと。** `app/api/cron/purge-trash/route.ts` は未設定なら fail-closed で 500 を返します。安全側の挙動ですが、**気づかず放置すると論理削除したタスクが永久に物理削除されません**。
>
> ⚠️ **`ALLOWED_EMAIL_DOMAINS` を忘れないこと。** 未設定・空文字なら**全ドメイン拒否**です（安全側デフォルト）。「ログインできない」ときはまずここを疑ってください。
>
> ⚠️ **`gmail.com` のような共用ドメインをドメイン指定しないこと。** 全 Gmail ユーザーがログインでき、`lib/auth/authz.ts` のとおり閲覧は全ログインユーザーに開いているため、全プロジェクトが読まれます。個人アカウントで運用する場合は `alice@gmail.com` のように**メールアドレス完全一致**で指定してください（ドメイン指定と混在可）。

**確認**:

```bash
vercel env ls     # 変数名だけ一覧される（値は出ません）
```

---

## Step 6. デプロイする

```bash
vercel --prod
```

**確認**:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<本番ドメイン>/sign-in    # 200
curl -sS -D - -o /dev/null https://<本番ドメイン>/projects | head -5        # 307 → /sign-in
```

ブラウザで `https://<本番ドメイン>/sign-in` を開き、「Googleでログイン」が通ることを確認してください。**許可ドメイン外のアカウントで弾かれること**も一度試しておくと安心です。

`vercel.json` の Cron（日次 UTC 18:00 = JST 3:00）はリポジトリに定義済みなので、連携すれば自動で有効になります。Vercel 側の追加設定は不要です。

---

## Step 7. バックフィルを流す（Issue #60）

**必ず Step 1〜2 のあと**に実行してください。`TURSO_DATABASE_URL` が指す DB を対象にするので、設定前に流すと手元の開発用 DB を直すだけになります。

```bash
cd /path/to/pj-pilot

cat > .env <<'EOF'
TURSO_DATABASE_URL=<本番のURL>
TURSO_AUTH_TOKEN=<本番のトークン>
EOF

npm run db:backfill-summary-type              # dry-run（DBは変更されません）
npm run db:backfill-summary-type -- --apply   # 適用
npm run db:backfill-summary-type              # 「0件」になることを確認

rm .env
```

**必ず出力の1行目を見てください。**

```
対象DB: libsql://pj-pilot-....turso.io     ← 本番を向いている
対象DB: file:local.db                      ← 手元の開発用 DB。.env が読めていない
```

`TURSO_DATABASE_URL` が読めていない状態で `--apply` を付けると、スクリプトが止めます
（本番を直したつもりで手元の DB を書き換える事故を防ぐため）。手元の DB を意図して
直したいときだけ `--apply --local` を付けてください。

**何をしているか**: 「子タスクを持つ親タスクは日付・進捗・工数を子から自動集計する」という仕様（決定 D-11）があり、その対象は `type='summary'` の行だけです。この印を付ける処理が長らく本番コードに無く、修正済みですが**修正前に作られた行には印が付いていません**。それを一括で揃えます。

新規 DB なら対象 0 件で終わります。それでも「0 件だった」ことを確認する意味はあります。

---

## Step 8. ローカル開発環境（任意）

```bash
cd /path/to/pj-pilot
cp .env.example .env.local     # 値は Vercel 側が正本。そこからコピーする
npm run db:migrate             # .env.local が空なら file:local.db を使う
npm run db:seed                # 任意。開発用ダミーデータ
npm run dev
```

`http://localhost:3000/sign-in` を開いてログインできれば完了です。

---

## 完了チェックリスト

- [ ] `turso db list` に `pj-pilot` と `pj-pilot-preview` がある
- [ ] 両方の DB で `.tables` にテーブルが並ぶ
- [ ] `vercel env ls` に 9 変数（Production）が並ぶ
- [ ] 本番 URL の `/sign-in` が 200、`/projects` が未ログインで 307
- [ ] 実際に Google ログインできる
- [ ] 許可ドメイン外のアカウントが弾かれる
- [ ] バックフィルの再実行が「0 件」

---

## なぜクラウドセッションからできないか

claude.ai/code のサンドボックスは、egress ポリシーで次のホストへの接続を遮断しています（2026-08-09 に実測。プロキシが CONNECT に 403 を返す）。

| ホスト | 用途 |
|---|---|
| `get.tur.so` | Turso CLI インストーラ |
| `api.turso.tech` | Turso Platform API |
| `turso.tech` | Turso ダッシュボード |
| `api.vercel.com` | Vercel API |
| `vercel.com` | Vercel ダッシュボード |
| `console.cloud.google.com` | Google Cloud Console |

**API トークンを渡しても解決しません。** 認証情報の不足ではなく、ホストに到達できないためです。CLI のバイナリを GitHub Releases から落とす経路も 403 です。

ローカルの Claude Code セッションにはこの制限が無いので、**この手順書をローカルセッションに渡せば、ブラウザ作業（Step 4 と Preview ドメイン割り当て）以外は代行してもらえます。**
