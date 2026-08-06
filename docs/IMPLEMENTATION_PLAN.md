# pj-pilot 実装計画

`REQUIREMENTS.md`（2026-08-06 のヒアリング確定分）を入力として作成した実装計画です。
本ドキュメントは「何を・どの順で・どう検証して作るか」を定めます。仕様そのものの正本は
`REQUIREMENTS.md` 側にあります。

- 作成日: 2026-08-06
- 対象: Phase 1（複数PJ管理 / 課題管理 / WBS / Gantt / 依存連動）
- Phase 2（カンバン・ダッシュボード）は §8 に枠だけ置き、詳細化しません

---

## 1. 現状

リポジトリは「設計フェーズの器」だけがある状態です。アプリケーションコードは 1 行もありません。

| 項目 | 状態 |
|---|---|
| `README.md` / `REQUIREMENTS.md` / `LICENSE`(MIT) / `.gitignore` / `.npmrc` | あり |
| `CLAUDE.md`（クラウドセッション向け運用ルール） | あり |
| `package.json` / Next.js アプリ | **なし** |
| `.github/`（CI ワークフロー・dependabot・PRテンプレ） | **なし** |
| GitHub の `type:*` ラベル | **なし**（`type:feature` の存在を確認 → 未作成） |
| GitHub Issues | **0 件** |
| GitHub Project（板） | **未作成** |
| `origin/HEAD` | **未設定** |
| Vercel 連携 | **未実施** |
| Turso DB / Google OAuth クライアント | **未作成** |

GitHub Project の作成と Vercel 連携はクラウドセッションから実行できません（理由と手順は §10）。

---

## 2. 調査で確定した事実

計画の前提になる部分を、npm レジストリと配布パッケージの実物で確認しました。

### 2.1 バージョン（2026-08-06 時点）

| パッケージ | 最新 | 備考 |
|---|---|---|
| `next` | 16.3.0 | peer: react ^18.2 \|\| ^19 |
| `@mantine/core` / `@mantine/hooks` / `@mantine/dates` | 9.5.1 | peer: **react ^19.2.0**（React 19 必須） |
| `mantine-datatable` | 9.4.0 | peer: `@mantine/core >=9` |
| `@svar-ui/react-gantt` | 2.7.1 | **license: MIT**（`license.txt` を実物で確認） |
| `drizzle-orm` | 0.45.2 | |
| `drizzle-kit` | 0.31.10 | |
| `@libsql/client` | 0.17.4 | |
| `@auth/drizzle-adapter` | 1.11.3 | |
| `next-auth` | latest 4.24.15 / **beta 5.0.0-beta.32** | §9 リスク R-1 |

React 19 系で全体を揃えます（Mantine 9 が React 19 を必須にしているため、選択の余地はありません）。

### 2.2 SVAR React Gantt の無料版（MIT）とPRO版の境界

`@svar-ui/react-gantt@2.7.1` の `readme.md` に記載された PRO 限定機能のうち、本件に効くもの:

- **Auto-scheduling（FS依存の自動再スケジュール）は PRO**
- Critical path / Baselines / Resource planning / Undo-Redo / WBSコード / エクスポートは PRO

**これは本件では問題になりません。** 要件のギャップ維持型連動は PRO の auto-scheduling（CPM型の
再配置）とは別物であり、どちらにせよ自前実装が必要だからです。むしろ PRO の自動再スケジュールが
無効な状態のほうが、こちらの伝播ロジックと競合せず都合が良いです。

無料コアで使えることを型定義で確認済み:

- 階層（`parent` / `type: "summary"`）とサマリー日付の集計（`setSummaryDates` / `dragSummaryKids`）
- 依存リンク（`ILink { id, type, source, target, lag? }`、`TLinkType = "s2s"|"s2e"|"e2s"|"e2e"`）
  - **FS は `"e2s"`（end-to-start）** に対応します
- ドラッグ移動 / リサイズ、グリッド列カスタマイズ、ソート、フィルター、仮想化、TypeScript

### 2.3 連動を差し込むフック（最重要）

`@svar-ui/gantt-store` の型定義から、以下が使えることを確認しました。

```ts
interface IApi {
  exec:      (action, params) => Promise<any>
  on:        (action, cb) => void   // 実行後に通知
  intercept: (action, cb) => void   // 実行前に割り込み。false を返すとキャンセル
  getState:  () => IData
  getTask:   (id) => ITask
  serialize: (config?) => ...
}
```

ドラッグ操作は `update-task` アクションとして流れ、ペイロードに以下が含まれます。

```ts
["update-task"]: {
  id: TID
  task: Partial<ITask>
  diff?: number         // 移動量
  inProgress?: boolean  // ドラッグ中は true、ドロップ確定で false
  eventSource?: string
}
```

したがって実装の勘所は次の 1 点に集約されます。

> `api.intercept("update-task", ...)` で `inProgress === false`（＝ドロップ確定）のときだけ、
> 移動量 Δ を求めてサーバへ送り、伝播後の全タスクを受け取って反映する。

`add-link` / `delete-link` / `add-task` / `delete-task` も同じ経路で拾えます。

### 2.4 Next.js App Router での組み込み

SVAR Gantt はコンテナ実寸を測ってレイアウトを決めるため SSR できません。App Router では
Server Component 内で `dynamic(..., { ssr: false })` を直接使えないので、次の二段構えにします。

```
app/projects/[id]/gantt/page.tsx        Server Component（データ取得のみ）
  └─ components/gantt/GanttLoader.tsx   "use client" + next/dynamic(..., { ssr:false })
       └─ components/gantt/GanttView.tsx  "use client" 実体
```

---

## 3. アーキテクチャ方針

### 3.1 全体構成

```
Next.js 16 App Router  ── Vercel
  ├─ Server Components   : 一覧・詳細の初期データ取得
  ├─ Server Actions      : 書き込み（タスクCRUD、依存CRUD、日付移動）
  ├─ Route Handlers      : 認証コールバックのみ（/api/auth/[...nextauth]）
  └─ Client Components   : Gantt / DataTable / フォーム
Drizzle ORM ── @libsql/client ── Turso
Auth.js (next-auth) ── Google OAuth ── @auth/drizzle-adapter
```

REST の `RestDataProvider` は使わず、**Server Actions を直接呼びます。** 伝播ロジックが
サーバ側にあり、レスポンスとして「動いたタスクの一覧」を返す必要があるためです。エンドポイントを
CRUD 単位に切るより、ユースケース単位（`moveTask`, `linkTasks`）で切るほうが素直です。

### 3.2 決めておく規約

- **日付は date-only の `TEXT`（`YYYY-MM-DD`）で保持し、タイムゾーン変換を一切しません。**
  Gantt の最小単位が「日」であるため、UTC/ローカル変換を挟むと 1 日ずれるバグの温床になります。
  DB ↔ アプリ境界で `parseISO` / `format` に閉じ込め、`Date` を跨いで持ち回りません。
- 伝播ロジックは **依存のない純粋関数**（`lib/scheduling/propagate.ts`）として切り出し、
  DB も React も触らせません。ここがテストの主戦場になります。
- クライアントは楽観更新し、サーバの確定結果で置き換えます（同時編集は要件外なので競合解決は不要）。

---

## 4. データモデル案 ⚠️ 要承認

`CLAUDE.md` の規約により、**スキーマはコミット前に承認が必要**です。以下は提案であり、
マイグレーションはまだ作成していません。

### 4.1 テーブル

| テーブル | 用途 |
|---|---|
| `users` / `accounts` / `sessions` / `verification_tokens` | Auth.js の Drizzle アダプタ標準スキーマ（改変しない） |
| `projects` | プロジェクト |
| `project_members` | PJ メンバーとロール |
| `tasks` | タスク（WBS 階層を `parent_id` の自己参照で表現） |
| `task_assignees` | 複数担当者の中間テーブル |
| `task_dependencies` | 依存関係 |

### 4.2 定義（Drizzle / SQLite 方言）

```
projects
  id                        text  PK  (cuid2)
  name                      text  NOT NULL
  description               text
  dependency_sync_enabled   integer(boolean)  NOT NULL DEFAULT 1   -- 連動ON/OFF ①PJ単位
  created_at / updated_at   integer(timestamp) NOT NULL

project_members
  project_id  text  FK→projects.id  ON DELETE CASCADE
  user_id     text  FK→users.id     ON DELETE CASCADE
  role        text  NOT NULL DEFAULT 'member'   -- 'owner' | 'member'
  PK(project_id, user_id)

tasks
  id               text  PK
  project_id       text  FK→projects.id  ON DELETE CASCADE   -- INDEX
  parent_id        text  FK→tasks.id     ON DELETE CASCADE   -- WBS階層。NULL=ルート
  title            text  NOT NULL
  start_date       text  NOT NULL   -- 'YYYY-MM-DD'
  end_date         text  NOT NULL   -- 'YYYY-MM-DD'（終了日を含む。§9 S-1 で確定）
  progress         integer NOT NULL DEFAULT 0   -- 0-100
  priority         text  NOT NULL DEFAULT 'medium'  -- 'low'|'medium'|'high'|'urgent'
  status           text  NOT NULL DEFAULT 'todo'    -- 'todo'|'in_progress'|'review'|'done'
  type             text  NOT NULL DEFAULT 'task'    -- 'task'|'summary'|'milestone'
  estimated_hours  real                          -- 見積工数
  actual_hours     real                          -- 実績工数
  is_pinned        integer(boolean) NOT NULL DEFAULT 0  -- 連動ON/OFF ②タスク単位ピン留め
  sort_order       integer NOT NULL DEFAULT 0
  created_at / updated_at  integer(timestamp) NOT NULL

task_assignees
  task_id  text  FK→tasks.id  ON DELETE CASCADE
  user_id  text  FK→users.id  ON DELETE CASCADE
  PK(task_id, user_id)

task_dependencies
  id             text  PK
  project_id     text  FK→projects.id  ON DELETE CASCADE   -- INDEX
  predecessor_id text  FK→tasks.id     ON DELETE CASCADE
  successor_id   text  FK→tasks.id     ON DELETE CASCADE
  type           text  NOT NULL DEFAULT 'FS'   -- 初版は 'FS' のみ
  UNIQUE(predecessor_id, successor_id)
```

### 4.3 判断の根拠

- **`estimated_hours` / `actual_hours` は初版から入れます**（要件の明示指定。後付けコストの回避）。
- **ラグ属性は持ちません。** ギャップ維持型の連動により、バー間の隙間が実質ラグとして機能します。
  SVAR の `ILink` には `lag` がありますが、常に未設定で送ります。
- `type` に `'FS'` カラムを残すのは、将来 SS/FF/SF を足す余地のためです（値は 'FS' 固定）。
- `sort_order` は同一 `parent_id` 内の表示順です。Gantt の行入れ替えに必要になります。
- SQLite の外部キーは既定で無効です。`PRAGMA foreign_keys = ON` を接続時に必ず投げます。
  （Turso/libSQL でも同様。これを忘れると `ON DELETE CASCADE` が効きません）

---

## 5. 依存連動の設計

要件の中核であり、実装の山場です。ここだけは設計を先に固めます。

### 5.1 アルゴリズム（ギャップ維持型）

```
移動対象タスク T が Δ 日だけ動いたとき:

1. PJ の dependency_sync_enabled が false なら → T のみ更新して終了
2. ドラッグ時に修飾キー（Shift）が押されていたら → T のみ更新して終了
3. task_dependencies を有向グラフとみなし、T から到達可能な後続を
   トポロジカル順に走査する
4. 各後続 S について:
     - S.is_pinned が true  → S を動かさない。かつ S より先へは伝播しない（枝を打ち切る）
     - S.is_pinned が false → S.start += Δ, S.end += Δ
   すでに訪問済みのノードは再度シフトしない（合流時の二重適用を防ぐ）
5. 影響を受けたタスクの祖先 summary を、子の min(start)/max(end) で再計算する（ボトムアップ）
6. 動いたタスクの一覧をまとめて返す
```

CPM 計算は行いません。単なるトポロジカル走査 + 定数シフトです。

**ピン留めで枝を打ち切る理由:** ピン留めタスクを飛び越えてその後続だけを動かすと、
ピン留めタスクとの間のギャップが壊れます。「隙間を保つ」という方式の不変条件を守るには、
ピン留めで止めるのが一貫します。この挙動は UI 上でも明示します（打ち切られた旨のトースト）。

### 5.2 循環依存

依存を追加する時点で、追加後にサイクルができるかを判定して拒否します（DFS）。
サイクルが存在しないことを伝播ロジックの事前条件とし、伝播側では**防御的に訪問済み集合で
無限ループを止めるだけ**にします。

### 5.3 テスト設計（TDD / Vitest）

`lib/scheduling/propagate.ts` に対する純粋関数テストを先に書きます。

| # | ケース | 期待 |
|---|---|---|
| T-1 | 依存なしのタスクを +3 | 本人のみ +3 |
| T-2 | 直列 A→B→C、A を +3 | B, C も +3。A-B 間・B-C 間のギャップ不変 |
| T-3 | 直列 A→B→C、A を **-2**（前倒し） | B, C も -2。ギャップ不変 |
| T-4 | 分岐 A→B, A→C、A を +5 | B, C ともに +5 |
| T-5 | 合流 A→C, B→C、A を +4 | C は **+4 が一度だけ**（二重適用しない） |
| T-6 | 直列 A→B→C、B が pinned、A を +3 | A のみ +3。B, C は不動 |
| T-7 | PJ トグル OFF、A を +3 | A のみ +3 |
| T-8 | 修飾キー押下、A を +3 | A のみ +3 |
| T-9 | 子タスクが動いた結果、親 summary の期間が伸びる | 親の start/end が再計算される |
| T-10 | サイクルを作る依存の追加 | 追加が拒否される |
| T-11 | 100 タスク / 200 依存の直列＋分岐 | 1 回の伝播が 50ms 未満（回帰検知用） |
| T-12 | バーのリサイズ（end のみ変更） | Δ = end の変化量として後続へ伝播 |

T-12 は仕様の穴です。要件は「移動量 Δ を平行伝播」としか書いていません。
**提案: リサイズで終了日が動いた場合も、その差分を Δ として後続へ伝播します**（先行の終了が
後ろへずれたのに後続が動かないのは直感に反するため）。これは §9 の未決事項 Q-1 とします。

---

## 6. 画面構成

| ルート | 内容 | 主なコンポーネント |
|---|---|---|
| `/` | ログイン / プロジェクト一覧へリダイレクト | |
| `/projects` | PJ 一覧（カード or テーブル） | Mantine `Card` / `Table` |
| `/projects/[id]/tasks` | 課題管理。一覧テーブル、フィルター、ソート | `mantine-datatable` |
| `/projects/[id]/tasks/[taskId]` | タスク詳細（Drawer で重ねる） | Mantine `Drawer` + `Form` |
| `/projects/[id]/gantt` | WBS ツリー + Gantt + 依存矢印 + ドラッグ | `@svar-ui/react-gantt` |
| `/projects/[id]/settings` | 依存連動トグル、メンバー管理 | Mantine `Switch` |
| （Phase 2）`/projects/[id]/board` | カンバン | |
| （Phase 2）`/dashboard` | 横断ダッシュボード | |

`/projects/[id]` は `/projects/[id]/tasks` へリダイレクトします。

すべての PJ 配下ルートは `project_members` による認可チェックを共通レイアウトで行います。
**Public リポジトリ・社内ツールという性質上、認可漏れが最大の事故リスク**なので、
「PJ にアクセスできるか」を返す関数を 1 つに集約し、全ルートとすべての Server Action の
先頭で必ず通します。

---

## 7. テストと CI

| 層 | ツール | 対象 |
|---|---|---|
| ユニット | Vitest | 伝播ロジック、日付ユーティリティ、認可判定 |
| 結合 | Vitest + ローカル libSQL（ファイル） | Server Actions、Drizzle クエリ |
| E2E | Playwright | ログイン → タスク作成 → 依存作成 → ドラッグ → 後続が動く |

E2E の「ドラッグしたら後続が動く」は、この製品の存在理由そのものなので必ず 1 本通します。

CI（`.github/workflows/ci.yml`）で `npm ci` → typecheck → lint → test → build →
`npm audit --audit-level=high` を回します。`.github/dependabot.yml`（npm / weekly / `/`）も置きます。

---

## 8. マイルストーンと Issue 分解

各 Issue は GitHub Project の板に載せる粒度（半日〜1日）で切っています。

### M0 — 足場（Vercel 連携の前提）

| # | Issue | type |
|---|---|---|
| 1 | Next.js 16 + TypeScript + App Router を scaffold、`package-lock.json` をコミット | ops |
| 2 | Mantine 9 セットアップ（`MantineProvider`、App Router 用 ColorScheme スクリプト） | feature |
| 3 | ESLint + Prettier + `tsconfig` strict | ops |
| 4 | Vitest 導入、サンプルテストが green | ops |
| 5 | Playwright 導入、`npm run test:e2e` を定義 | ops |
| 6 | `.github/workflows/ci.yml` と `.github/dependabot.yml` | ops |
| 7 | `.env.example`（キーは名前だけ。値は書かない） | ops |

**M0 のマージ後に Vercel を連携します**（§10.2）。`package.json` がない状態で import すると
ビルドが失敗するだけなので、順序を守ります。

### M1 — DB と認証

| # | Issue | type |
|---|---|---|
| 8 | Drizzle + `@libsql/client` 接続層。`PRAGMA foreign_keys = ON` | data |
| 9 | **スキーマ実装 + 初回マイグレーション（§4 の承認後）** | data |
| 10 | Auth.js v5 + Google OAuth + Drizzle アダプタ | feature |
| 11 | 認可ヘルパ（`requireProjectAccess`）とユニットテスト | feature |
| 12 | シードスクリプト（開発用のダミー PJ / タスク / 依存） | data |

### M2 — プロジェクトと課題管理

| # | Issue | type |
|---|---|---|
| 13 | PJ の CRUD と一覧画面 | feature |
| 14 | タスク CRUD（Server Actions） | feature |
| 15 | タスク一覧テーブル（`mantine-datatable`）+ フィルター + ソート | feature |
| 16 | タスク詳細 Drawer（ステータス・優先度・進捗・工数の編集） | feature |
| 17 | 複数担当者の割り当て UI（`MultiSelect`） | feature |

### M3 — WBS と Gantt 表示

| # | Issue | type |
|---|---|---|
| 18 | **スパイク S-1**: SVAR の `end` / `duration` 境界の挙動を実測して確定（§9） | feature |
| 19 | タスクの階層化（親子、`sort_order`、インデント操作） | feature |
| 20 | Gantt をクライアント専用で組み込む（`GanttLoader` 二段構え） | feature |
| 21 | DB ↔ SVAR のデータ変換層（`toGanttTasks` / `toGanttLinks`）とテスト | feature |
| 22 | サマリータスクの日付集計（サーバ側で計算して永続化） | feature |

### M4 — 依存関係と連動（コア）

| # | Issue | type |
|---|---|---|
| 23 | 依存の CRUD + 循環検出（T-10） | feature |
| 24 | Gantt 上での依存矢印の描画と作成 UI（`e2s`） | feature |
| 25 | **伝播ロジック `propagate.ts` を TDD で実装**（T-1〜T-5, T-9, T-11） | feature |
| 26 | `api.intercept("update-task")` でドロップを捕捉し Server Action を呼ぶ | feature |
| 27 | 楽観更新と、サーバ確定結果でのリコンサイル | feature |
| 28 | E2E: ドラッグ → 後続が動く | feature |

### M5 — 連動の ON / OFF（3階層）

| # | Issue | type |
|---|---|---|
| 29 | PJ 設定のトグル（T-7） | feature |
| 30 | タスクのピン留め（T-6）+ Gantt 上の視覚表現 | feature |
| 31 | Shift ドラッグで一時的に連動を切る（T-8） | feature |
| 32 | ピン留めで伝播が打ち切られた旨の通知 | feature |

### M6 — 仕上げ

| # | Issue | type |
|---|---|---|
| 33 | 列カスタマイズ、ズーム、ロケール（日本語） | feature |
| 34 | 空状態・エラー状態・ローディングの整備 | feature |
| 35 | アクセシビリティとレスポンシブの確認 | feature |

### Phase 2（詳細化しない）

カンバンボード / ダッシュボード・レポート。M6 完了後に別途計画します。

---

## 9. リスクと未決事項

| ID | 内容 | 影響 | 対応 |
|---|---|---|---|
| **R-1** | `next-auth` v5 が依然 beta（5.0.0-beta.32）。v4 は App Router との相性が悪い | 中 | **v5 beta を採用します。** App Router 前提では実質これ一択で、広く本番採用されています。バージョンは `save-exact=true` で固定し、更新は意図的にのみ行います。回避先は Better Auth ですが、要件の Auth.js 指定から外れるため第一候補にしません |
| **R-2** | `@libsql/client` はネイティブバイナリを持つ。`.npmrc` の `ignore-scripts=true` と衝突しうる | 中 | Vercel の serverless では **HTTP 経由の `drizzle-orm/libsql/web` + `@libsql/client/web`** を使い、ネイティブ依存を回避します。M1 の #8 で疎通を先に確認します |
| **R-3** | SVAR Gantt は SSR 不可。ハイドレーション不整合が出やすい | 中 | クライアント専用の二段構え（§2.4）で確実に切り離します |
| **R-4** | Vercel の Preview は URL が毎回変わるため、Google OAuth のリダイレクト URI を登録しきれない | 中 | Preview 用に固定のブランチドメインを 1 つ用意し、それだけを OAuth に登録します（§10.3） |
| **R-5** | Public リポジトリ。シークレット混入は不可逆 | **高** | `.env*` は gitignore 済み。`.env.example` には値を書かない。GitHub の Secret Scanning / Push Protection を有効化（§10.1） |
| **R-6** | 伝播ロジックのバグは「気づかないうちに全体の日程がずれる」形で出る | **高** | 純粋関数に隔離し、§5.3 のテストを実装より先に書きます。T-11 で性能回帰も見ます |
| **S-1** | SVAR の `end` が「終了日を含む」か「排他」か未確定。ここを取り違えると全タスクが 1 日ずれる | **高** | M3 の #18 でスパイクを立てて実測し、`toGanttTasks` の変換に閉じ込めます。計画上は「`end_date` は終了日を含む」を仮置きしています |
| **Q-1** | バーのリサイズ（期間変更）で後続へ伝播するか（§5.3 T-12） | 中 | **提案: 伝播する。** 要否の判断をお願いします |
| **Q-2** | 削除は物理削除か論理削除（`deleted_at`）か | 低 | **提案: 物理削除 + `ON DELETE CASCADE`。** 少人数・新規データのため、複雑さに見合いません |
| **Q-3** | Turso の Preview 環境用 DB を分けるか | 中 | **提案: 分ける。** 本番 DB を Preview から壊す事故を防げます（§10.4） |

---

## 10. 手作業が必要なセットアップ

以下はクラウドセッション（このサンドボックス）から実行できません。

- `gh` CLI が未インストールで、GitHub MCP サーバーにも **Projects v2 を操作するツールがありません**
  → GitHub Project の作成・ラベル作成・リポジトリ設定の変更は不可
- Vercel の CLI も認証情報もありません → Vercel 連携は不可

そのため、手順を以下に示します。所要は全体で 20〜30 分程度です。

### 10.1 GitHub リポジトリ設定

```bash
# type:* ラベル（状態は Project のカラムで持つ。status:* ラベルは作らない）
for t in bug feature content i18n legal billing data mobile ops; do
  gh label create "type:$t" --color ededed --repo sinoda1114/pj-pilot 2>/dev/null || true
done

# origin/HEAD（/security-review が必要とします。ローカル作業ディレクトリで実行）
git remote set-head origin -a
```

Web UI 側（Settings）で、Public リポジトリのため以下も有効にしてください。

- Settings → Code security → **Secret scanning** を有効化
- 同 → **Push protection** を有効化（シークレットの push を物理的に止めます）

### 10.2 GitHub Project（板）の作成

```bash
gh project create --owner sinoda1114 --title "pj-pilot Tasks"
```

作成後、Web UI で Status フィールドのオプションを次の 7 つに設定します（CLI では煩雑なため）。

```
Inbox / Ready / Waiting / Doing / PR / Prod Check / Done
```

さらに Project の Settings → Workflows で以下を有効化しておくと運用が楽になります。

- Item added to project → Status: `Inbox`
- Pull request merged → Status: `Prod Check`
- Item closed → Status: `Done`

最後に、リポジトリを Project にリンクします（Project → Settings → Manage access / linked repositories）。
§8 の Issue 一覧を板に登録すれば、そのまま Phase 1 のバックログになります。

### 10.3 Vercel 連携

**M0（scaffold）のマージ後**に実施してください。`package.json` がない状態では必ずビルドに失敗します。

1. https://vercel.com/new → `sinoda1114/pj-pilot` を Import
2. Framework Preset: **Next.js** / Root Directory: `./`
3. Settings → Git → **Production Branch = `main`**、Preview Deployments = 有効
4. Settings → Environment Variables に以下を登録（**リポジトリには絶対に書きません**）

   | 変数 | Production | Preview | 備考 |
   |---|---|---|---|
   | `TURSO_DATABASE_URL` | 本番 DB | Preview DB | §10.4 |
   | `TURSO_AUTH_TOKEN` | 〃 | 〃 | |
   | `AUTH_SECRET` | ✓ | ✓ | `openssl rand -base64 32` で生成 |
   | `AUTH_GOOGLE_ID` | ✓ | ✓ | §10.5 |
   | `AUTH_GOOGLE_SECRET` | ✓ | ✓ | |
   | `AUTH_TRUST_HOST` | `true` | `true` | Vercel 上で Auth.js v5 に必要 |
   | `NEXT_PUBLIC_SITE_URL` | 本番URL | Preview固定URL | |

5. Preview 用に**固定のブランチドメイン**を 1 つ割り当てます（Settings → Domains で
   特定ブランチにドメインを紐付け）。これがないと OAuth のリダイレクト URI を登録できません（R-4）。

### 10.4 Turso

```bash
turso db create pj-pilot          # 本番
turso db create pj-pilot-preview  # Preview 用（Q-3 の提案）

turso db show pj-pilot --url                # → TURSO_DATABASE_URL
turso db tokens create pj-pilot             # → TURSO_AUTH_TOKEN
```

取得した値は Vercel のダッシュボードにのみ入れます（ダッシュボードが正本）。

### 10.5 Google OAuth クライアント

Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 クライアント ID（Web）

承認済みのリダイレクト URI に以下を登録します。

```
http://localhost:3000/api/auth/callback/google
https://<本番ドメイン>/api/auth/callback/google
https://<Preview固定ドメイン>/api/auth/callback/google
```

社内チーム向けのため、OAuth 同意画面は可能なら **Internal**（Google Workspace 組織内）にします。
組織外の利用者がいる場合は External + テストユーザー登録が必要です。

---

## 11. 次のアクション

1. §4 のデータモデルをレビューし、**承認またはフィードバック**をください（M1 #9 のブロッカー）
2. §9 の **Q-1（リサイズ時の伝播）** を判断してください
3. §10.1 / §10.2 の GitHub セットアップを実施してください（20 分程度）
4. 承認が出たら M0（scaffold）から着手します。M0 マージ後に §10.3 の Vercel 連携を実施してください
