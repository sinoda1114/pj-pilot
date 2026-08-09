# pj-pilot — プロジェクト指示

pj-pilot（`pj-pilot.vercel.app`）の AI 向けプロジェクト指示。

## 運用ルール（HOW）の正本

このプロジェクトの開発フロー（worktree / PR / 2 段ゲート / デプロイ規律 / GitHub 正本 / Issue・Project タスク管理 / 供給網デフォルト）は、**本リポの `notes/`** を正本とする（リポと一緒に travel する）。
同じ挙動規律は `~/.claude` グローバルにも既定として入っているため、自分の端末の全 PJ に自動適用される。
**ここには挙動の再説明を書かない**（重複・ドリフト防止）。このファイルは**このプロジェクト固有の値だけ**を持つ。

- 開発フロー詳細: `notes/dev-workflow-multiagent.md`
- タスク管理詳細: `notes/task-management-issue-workflow.md`

## このプロジェクト固有の値

| 項目 | 値 |
|---|---|
| リポ実体 dir（統合＋デプロイ専用・ここで機能開発しない） | `~/dev/pj-pilot` |
| GitHub | `sinoda1114/pj-pilot` |
| デプロイ基盤 | Vercel（git 駆動・feature push = Preview / main マージ = Production） |
| 本番 URL | https://pj-pilot.vercel.app |
| 独自ドメイン | pj-pilot.vercel.app |
| 絶対 URL の env | `BETTER_AUTH_URL`（=`https://pj-pilot.vercel.app`・ハードコード禁止） |
| タスク正本 | GitHub Issue / Project「（未作成。Issue で管理）」 |

## 役割境界（このプロジェクト）

<!-- 担当エージェント/領域を列挙して、担当外ファイルを触らない境界にする。例:
| 領域 | 担当 |
|---|---|
| UI / 配色 / 画面 | ui-feature |
| 認証 / 課金 | auth-billing |
| データ取得 | data-squad |
| 法務 / SEO / インフラ | legal-seo-infra |
| 整合監督・レビュー（実装しない） | reviewer |
-->

## dev 規律

- dev サーバ起動中にビルド成果物を消したり本番ビルドを実行しない（壊れる）。dev は 1 つ。
- AI 検証は `tsc` / `eslint` / `test` で行う（手動確認をユーザーに丸投げしない）。
- `.env.local` は触らない・中身を出力しない（本番 env は Vercel ダッシュボードが正本）。
- シークレット（API キー・トークン）はログ / 出力に出さない。必要なら redact する。
