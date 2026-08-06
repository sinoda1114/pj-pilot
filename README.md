# pj-pilot

チーム向けのプロジェクト管理ツール。複数プロジェクトを横断して、課題管理と
WBS / ガントチャートを扱います。

現在は設計フェーズで、実装はこれからです。確定済みの仕様は
[REQUIREMENTS.md](REQUIREMENTS.md) にまとまっています。

## 目指しているもの

既存のガントチャートツールは、依存関係を引いた後にタスクを動かすと挙動が読めなくなりがちです。
pj-pilot はそこを重視し、バーをドラッグしたときに何がどう動くかが直感的にわかることを狙います。

- 複数プロジェクトの横断管理
- 課題管理（一覧、詳細、ステータス、フィルター、ソート）
- WBS（階層ツリー、親子タスク、サマリータスク）
- ガントチャート（依存矢印、ドラッグによる日付変更）
- 依存連動（動かした日数ぶん、後続タスクも平行移動する方式）
- 連動の ON / OFF 切替（プロジェクト単位、タスク単位のピン留め、ドラッグ時の修飾キー）

カンバンボードとダッシュボードは次のフェーズで扱います。

## 技術スタック

| 領域 | 選定 |
|---|---|
| フレームワーク | Next.js (App Router) |
| ホスティング | Vercel |
| UI | Mantine |
| ガント | [SVAR React Gantt](https://github.com/svar-widgets/react-gantt) (`@svar-ui/react-gantt`) |
| DB | Turso (libSQL) |
| ORM | Drizzle ORM |
| 認証 | Google OAuth |

選定の根拠と、検討して見送った選択肢は [REQUIREMENTS.md](REQUIREMENTS.md) に記載しています。

## ライセンス

[MIT](LICENSE)
