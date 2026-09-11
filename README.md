# pj-pilot

チーム向けのプロジェクト管理ツール。複数プロジェクトを横断して、課題管理と
WBS / ガントチャートを扱います。

Phase 1（複数PJ管理 / 課題管理 / WBS / ガント / 依存連動）と Phase 2（カンバンボード /
ダッシュボード / CSV エクスポート）は実装済みです。**まだデプロイはしていません** —
Vercel / Turso / Google OAuth の設定が残っています（手順は
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)）。

確定済みの仕様は [REQUIREMENTS.md](REQUIREMENTS.md)、実装の進め方と決定ログは
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) にまとまっています。

## 目指しているもの

既存のガントチャートツールは、依存関係を引いた後にタスクを動かすと挙動が読めなくなりがちです。
pj-pilot はそこを重視し、バーをドラッグしたときに何がどう動くかが直感的にわかることを狙います。

- 複数プロジェクトの横断管理
- 課題管理（一覧、詳細、ステータス、フィルター、ソート）
- WBS（階層ツリー、親子タスク、サマリータスク）
- ガントチャート（依存矢印、ドラッグによる日付変更）
- 依存連動（動かした日数ぶん、後続タスクも平行移動する方式）
- 連動の ON / OFF 切替（プロジェクト単位、タスク単位のピン留め、ドラッグ時の修飾キー）
- カンバンボード（ドラッグ&ドロップでのステータス変更・列内並び替え）
- ダッシュボード（ステータス別件数、プロジェクト別進捗率、期限超過一覧）
- CSV エクスポート（タスク一覧・期限超過一覧）

## 技術スタック

| 領域 | 選定 |
|---|---|
| フレームワーク | Next.js (App Router) |
| ホスティング | Vercel |
| UI | Mantine |
| ガント | [SVAR React Gantt](https://github.com/svar-widgets/react-gantt) (`@svar-ui/react-gantt`) |
| カンバン D&D | [dnd-kit](https://dndkit.com/) |
| グラフ | Mantine Charts (Recharts) |
| DB | Turso (libSQL) |
| ORM | Drizzle ORM |
| 認証 | [Better Auth](https://www.better-auth.com/)（Google OAuth 限定・メールドメイン制限） |
| テスト | Vitest（ユニット） / Playwright（E2E） |

選定の根拠と、検討して見送った選択肢は [REQUIREMENTS.md](REQUIREMENTS.md) に記載しています。

## 開発環境の起動手順

前提: Node.js 20.12.0 以上（`package.json` の `engines`）。

- `npm ci` — 依存をインストールする（lockfile 固定。`npm install` は使わない）
- `cp .env.example .env.local` — 環境変数を用意し、値を埋める（各キーの意味と取得元は
  [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)）
- `npm run db:migrate` — マイグレーションを適用する（`TURSO_DATABASE_URL` が未設定なら
  ローカルの `file:local.db` が対象になる）
- `npm run db:seed` — 任意。開発用のダミーデータを投入する
- `npm run dev` — 開発サーバーを起動する（http://localhost:3000）

起動したら `/sign-in` から Google でログインします。`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` と `ALLOWED_EMAIL_DOMAINS` が実際の値でないとログインは完了しません
（設定手順は [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)）。

dev サーバーは同時に 1 つだけ動かします。起動したまま本番ビルド（`npm run build`）を
実行するとビルド成果物が壊れるため、先に dev サーバーを停止してください。

## 開発

| コマンド | 内容 |
|---|---|
| `npm run typecheck` | 型チェック |
| `npm run lint` | ESLint |
| `npm run test` | ユニットテスト（Vitest） |
| `npm run test:e2e` | E2E（Playwright。本番ビルドを起動して実ブラウザで実行） |
| `npm run build` | 本番ビルド |

CI（`ci / build` / `ci / e2e`）がグリーンであることを確認してからマージします。

## ライセンス

[MIT](LICENSE)
