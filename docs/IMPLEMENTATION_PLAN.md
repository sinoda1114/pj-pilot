# pj-pilot 実装計画

`REQUIREMENTS.md`（2026-08-06 のヒアリング確定分）を入力として作成した実装計画です。
本ドキュメントは「何を・どの順で・どう検証して作るか」を定めます。仕様そのものの正本は
`REQUIREMENTS.md`、決定事項の引き継ぎは [`docs/handoff.md`](handoff.md) 側にあります。

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
| GitHub の `type:*` ラベル | **なし** ⚠️ |
| GitHub Issues | **0 件** |
| GitHub Project（板） | **未作成** |
| `origin/HEAD` | **未設定** |
| Vercel 連携 | **未実施** |
| Turso DB / Google OAuth クライアント | **未作成** |

> ⚠️ **`docs/handoff.md` との差異。** handoff.md には「`type:*` ラベル・`origin/HEAD` は作成済み」と
> ありますが、GitHub API で `type:feature` / `type:bug` / `type:ops` を照会したところ **いずれも存在しません**。
> `origin/HEAD` も未設定です。handoff.md 自身が「状態はコミット履歴と実物で確認すること」と書いている
> とおり、実物を優先しています。§10.1 の手順は未実施として扱ってください。

GitHub Project の作成と Vercel 連携はクラウドセッションから実行できません（理由と手順は §10）。
これは `docs/handoff.md` の「クラウドセッションでの制約」と一致します。

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
| `better-auth` | 1.6.26 | peer に `next ^16`・`react ^19`・`drizzle-orm ^0.45.2` を明記。**安定版** |
| `@better-auth/cli` | 1.4.21 | 認証テーブルの Drizzle スキーマを生成する |

React 19 系で全体を揃えます（Mantine 9 が React 19 を必須にしているため、選択の余地はありません）。

認証は **Better Auth** を採用します（決定 D-04）。`next-auth` は v5 が依然 beta（5.0.0-beta.32）で、
v4 は App Router との相性が悪いためです。Better Auth は 1.6.26 が安定版で、peer dependencies に
Next.js 16 / React 19 / drizzle-orm 0.45.2 が明記されており、本件のスタックとそのまま噛み合います。

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
  ├─ Route Handlers      : 認証（/api/auth/[...all]）とゴミ箱の定期削除（/api/cron/purge-trash）
  └─ Client Components   : Gantt / DataTable / フォーム
Drizzle ORM ── @libsql/client ── Turso
Better Auth ── Google OAuth ── drizzleAdapter
Vercel Cron ── /api/cron/purge-trash（日次。30 日超のゴミ箱を物理削除）
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
- **`priority` / `status` の DB 値は英字**（`high` / `in_progress` 等）で保持し、**日本語は表示ラベルとしてのみ**
  持ちます（決定 D-17）。ラベルは `lib/labels.ts` の 1 箇所に集約し、DB 値を直接画面に出しません。
  語彙を変えたくなってもマイグレーションが不要で、URL のフィルター条件も壊れません。
- **`deleted_at IS NULL` の絞り込みを書き忘れられない形にします。** 素の `db.select()` を各所で
  書かず、`lib/db/queries.ts` に「生存タスクのみを返す」問い合わせ関数を用意し、そこを通します。

---

## 4. データモデル ⚠️ 要承認

`CLAUDE.md` の規約により、**スキーマはコミット前に承認が必要**です。以下は §12 の決定 19 件を
反映した確定案であり、マイグレーションはまだ作成していません。

### 4.1 テーブル

| テーブル | 用途 | 生成元 |
|---|---|---|
| `user` / `session` / `account` / `verification` | Better Auth の標準スキーマ | **`@better-auth/cli generate` で自動生成。手で書きません** |
| `projects` | プロジェクト | 手書き |
| `project_members` | PJ メンバーとロール | 手書き |
| `tasks` | タスク（WBS 階層を `parent_id` の自己参照で表現） | 手書き |
| `task_assignees` | 複数担当者の中間テーブル | 手書き |
| `task_dependencies` | 依存関係 | 手書き |

認証テーブルは Better Auth が単数形（`user` / `session` / `account` / `verification`）を使います。
Auth.js の複数形とは別物なので、アプリ側テーブルからの FK は `user.id` を参照します。

### 4.2 定義（Drizzle / SQLite 方言）

```
projects
  id                        text  PK  (cuid2)
  name                      text  NOT NULL
  description               text
  dependency_sync_enabled   integer(boolean)  NOT NULL DEFAULT 1   -- 連動ON/OFF ①PJ単位
  deleted_at                integer(timestamp)                     -- 論理削除。NULL=生存
  created_at / updated_at   integer(timestamp) NOT NULL
  INDEX(deleted_at)

project_members
  project_id  text  FK→projects.id
  user_id     text  FK→user.id
  role        text  NOT NULL DEFAULT 'member'   -- 'owner' | 'member'
  PK(project_id, user_id)

tasks
  id               text  PK
  project_id       text  FK→projects.id  NOT NULL          -- INDEX
  parent_id        text  FK→tasks.id                       -- WBS階層。NULL=ルート。INDEX
  title            text  NOT NULL
  start_date       text  NOT NULL   -- 'YYYY-MM-DD'
  end_date         text  NOT NULL   -- 'YYYY-MM-DD'（終了日を含む。§9 S-1 で確定）
  progress         integer NOT NULL DEFAULT 0   -- 0-100
  priority         text  NOT NULL DEFAULT 'medium'  -- 'low'|'medium'|'high'|'urgent'
  status           text  NOT NULL DEFAULT 'todo'    -- 'todo'|'in_progress'|'review'|'done'
  type             text  NOT NULL DEFAULT 'task'    -- 'task'|'summary'|'milestone'
  estimated_hours  real                          -- 見積工数（時間・小数）
  actual_hours     real                          -- 実績工数（時間・小数）
  is_pinned        integer(boolean) NOT NULL DEFAULT 0  -- 連動ON/OFF ②タスク単位ピン留め
  sort_order       integer NOT NULL DEFAULT 0
  deleted_at       integer(timestamp)            -- 論理削除。NULL=生存。INDEX
  created_at / updated_at  integer(timestamp) NOT NULL
  INDEX(project_id, deleted_at)

task_assignees
  task_id  text  FK→tasks.id
  user_id  text  FK→user.id
  PK(task_id, user_id)

task_dependencies
  id             text  PK
  project_id     text  FK→projects.id   -- INDEX
  predecessor_id text  FK→tasks.id
  successor_id   text  FK→tasks.id
  type           text  NOT NULL DEFAULT 'FS'   -- 初版は 'FS' 固定
  created_at     integer(timestamp) NOT NULL
  UNIQUE(predecessor_id, successor_id)
```

`ON DELETE CASCADE` は**意図的に書きません**。理由は §4.4 のとおりです。

### 4.3 判断の根拠

- **`estimated_hours` / `actual_hours` は初版から入れます**（要件の明示指定。後付けコストの回避）。
  単位は**時間を小数**で保持します（決定 D-13）。`1.5` = 1 時間 30 分。
- **ラグ属性は持ちません。** ギャップ維持型の連動により、バー間の隙間が実質ラグとして機能します。
  SVAR の `ILink` には `lag` がありますが、常に未設定で送ります。
- `type` に `'FS'` カラムを残すのは、将来 SS/FF/SF を足す余地のためです（値は `'FS'` 固定）。
- `type` の `'milestone'` は**値として許容するが Phase 1 では UI を出しません**（決定 D-12）。
  後から有効化する際にマイグレーションが不要になります。
- `sort_order` は同一 `parent_id` 内の表示順です。Gantt の行入れ替えに必要になります。
- **親（サマリー）タスクの `start_date` / `end_date` / `progress` / `estimated_hours` /
  `actual_hours` は子から計算した結果を格納します**（決定 D-11）。SVAR に渡す時点で値が必要なため、
  都度計算ではなく書き込み時に再計算して永続化します。日付は子の min/max、工数は単純合計、
  進捗は見積工数による加重平均（見積が無い子は均等重み）です。
- `project_members` は「担当者と権限」を表します。**閲覧は全ログインユーザーに開いている**ため
  （決定 D-08）、このテーブルは可視性の制御には使いません。`role='owner'` が PJ 削除権限を持ちます
  （決定 D-15）。
- **`deleted_at` は `tasks` と `projects` だけに置きます。** `task_dependencies` には置きません
  （決定 D-06 のとおり依存レコードはタスク削除時もそのまま残すため）。`task_assignees` も同様です。

### 4.4 削除の方針（論理削除）

削除は**論理削除**とし、30 日後に物理削除します（決定 D-03 / D-05）。

**(a) 論理削除の対象と手順**

| 操作 | 挙動 |
|---|---|
| タスクの削除 | `deleted_at` に現在時刻を入れる。行は残る |
| 子を持つタスクの削除 | **既定では拒否**し、UI で選択させる（決定 D-02）:「サブツリーごと削除」＝子孫全部に `deleted_at` を入れる／「子を繰り上げ」＝子の `parent_id` を祖父に付け替えて親だけ削除 |
| プロジェクトの削除 | `projects.deleted_at` を入れる。配下タスクは触らない（PJ ごと隠れるため） |
| 復元 | `deleted_at` を NULL に戻す。**祖先が削除済みなら祖先もまとめて復元します**（宙に浮いた子が生まれないため） |
| 物理削除 | Vercel Cron（日次）で `deleted_at < now - 30日` を対象に、`task_assignees` → `task_dependencies` → `tasks` の順で実削除 |

**(b) DB のカスケードには依存しません** ⚠️

libSQL は SQLite 同様に外部キーを既定で無効にしており、有効化には**接続ごと**に
`PRAGMA foreign_keys = ON` が必要です。ところが Vercel の serverless から使う HTTP クライアント
（`@libsql/client/web`）はステートレスで、リクエストごとに別の接続にあたる可能性があります。
さらにこの PRAGMA はトランザクションの内側では効きません。

つまり **「接続初期化で 1 回 PRAGMA を投げれば安全」という前提は Turso + HTTP では成立しません。**
DB 任せにすると、カスケードが**エラーも出さずに黙って効かず**、孤児レコードが残ります。

そこで `ON DELETE CASCADE` は宣言せず、**関連行の削除はすべてアプリケーション層で明示的に行います。**

論理削除を採用したことで、この危険が及ぶ範囲は**物理削除を行う cron の 1 経路だけ**に閉じ込められます。
そこは `db.batch()` で順序を固定し、結合テストで「物理削除後に孤児が 0 件であること」を毎回検証します。

`PRAGMA foreign_keys = ON` は**ローカル開発とテスト（ファイル DB）でのみ有効化**します。そこでは
実際に効くため、アプリ層の削除ロジックの取りこぼしを CI で検出できます。

**(c) 全クエリが `deleted_at IS NULL` を通ること**

論理削除の最大の事故は「絞り込みの書き忘れで削除済みが表示される／伝播対象に入る」ことです。
§3.2 のとおり `lib/db/queries.ts` に問い合わせを集約し、素の `db.select()` を画面や Server Action に
書かない規約とします。ESLint の `no-restricted-syntax` で機械的に禁止することも検討します。

## 5. 依存連動の設計

要件の中核であり、実装の山場です。ここだけは設計を先に固めます。

### 5.1 アルゴリズム（ギャップ維持型）

```
移動対象タスク T が Δ 日だけ動いたとき:

0. Δ は「暦日」で数える（決定 D-09）。土日・祝日は飛ばさない
1. PJ の dependency_sync_enabled が false なら → T のみ更新して終了
2. ドラッグ時に修飾キー（Shift）が押されていたら → T のみ更新して終了
3. task_dependencies を有向グラフとみなし、T から到達可能な後続を
   トポロジカル順に走査する。ただし deleted_at が入っているタスクは
   グラフから除外し、そこで枝を打ち切る（決定 D-06）
4. 各後続 S について:
     - S.is_pinned が true  → S を動かさない。かつ S より先へは伝播しない（枝を打ち切る）
     - S.is_pinned が false → S.start += Δ, S.end += Δ
   すでに訪問済みのノードは再度シフトしない（合流時の二重適用を防ぐ）
5. 影響を受けたタスクの祖先 summary を、子の min(start)/max(end) で再計算する（ボトムアップ）
6. 動いたタスクの一覧を、**変更前の日付とあわせて**返す（§5.4 の取り消しに使う）
```

CPM 計算は行いません。単なるトポロジカル走査 + 定数シフトです。

**Δ を暦日で数える理由（決定 D-09）:** 稼働日で数えると「ギャップを暦日と稼働日のどちらで測るか」
という問題が派生し、「Δ 日ぶん平行移動する」という不変条件が保てなくなります。SVAR の
work-time calendar は PRO 機能で無料版には無いため、稼働日計算は完全に自前実装になります。
土日は **`highlightTime` プロパティで背景をグレーにするだけ**（見た目のみ）とし、計算には
影響させません。これは無料版の標準機能で、追加コストはほぼゼロです。

**削除済みタスクで枝を打ち切る理由（決定 D-06）:** A→B→C の B を削除したとき、A を動かしても
C は動きません。B を飛ばして A→C をつなぎ直すと、B を復元したときに依存が重複するためです。
依存レコード自体は残るので、B を復元すれば元どおり鎖が復活します。

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
| T-12 | バーのリサイズ（end のみ変更） | Δ = end の変化量として後続へ伝播（決定 D-01） |
| T-13 | 直列 A→B→C、B が削除済み、A を +3 | A のみ +3。C は不動（決定 D-06） |
| T-14 | 土日を跨ぐ移動（金→月に +3） | 暦日で +3。土日は飛ばさない（決定 D-09） |
| T-15 | 伝播結果に変更前の日付が含まれる | 取り消しに必要な before/after が揃う（§5.4） |
| T-16 | 親の進捗・工数が子から集計される | 工数は合計、進捗は見積工数で加重平均（決定 D-11） |

### 5.4 伝播の取り消し（直前 1 回）

一度のドラッグで多数のタスクが動くため、取り消し手段が無いと事故が戻せません。SVAR の
Undo/Redo は PRO 機能なので自前で用意します（決定 D-16）。

**履歴テーブルは作りません。** 伝播の Server Action が「変更前の日付」もあわせて返し、
クライアントはそれをトーストに保持します。

```
[ 5 件のタスクを移動しました        元に戻す ]
```

「元に戻す」を押すと、保持していた変更前の日付をそのままサーバへ送り返して適用します。
リロードすると取り消せなくなりますが、「直前 1 回だけ」という要件には十分です。
複数回の Undo が必要になったら履歴テーブルを追加しますが、Phase 1 では持ち込みません。

ピン留めや削除済みで**枝が打ち切られた場合も、その旨をトーストに併記します**
（「2 件はピン留めのため移動しませんでした」）。黙って動かないのが一番わかりにくいためです。

---

## 6. 画面構成

| ルート | 内容 | 主なコンポーネント |
|---|---|---|
| `/` | ログイン / プロジェクト一覧へリダイレクト | |
| `/projects` | PJ 一覧（カード or テーブル） | Mantine `Card` / `Table` |
| `/projects/[id]/tasks` | 課題管理。一覧テーブル、フィルター、ソート | `mantine-datatable` |
| `/projects/[id]/tasks/[taskId]` | タスク詳細（Drawer で重ねる） | Mantine `Drawer` + `Form` |
| `/projects/[id]/gantt` | WBS ツリー + Gantt + 依存矢印 + ドラッグ | `@svar-ui/react-gantt` |
| `/projects/[id]/settings` | 依存連動トグル、メンバー管理、PJ 削除（オーナーのみ） | Mantine `Switch` |
| `/projects/[id]/trash` | ゴミ箱。削除済みタスクの一覧・復元・完全削除 | `mantine-datatable` |
| （Phase 2）`/projects/[id]/board` | カンバン | |
| （Phase 2）`/dashboard` | 横断ダッシュボード | |

`/projects/[id]` は `/projects/[id]/tasks` へリダイレクトします。

**認可の考え方**（決定 D-07 / D-08 / D-15）。閲覧は全ログインユーザーに開くので、防御線は次の 2 段だけです。

1. **ログインできるかどうか** — 許可ドメイン外のアカウントはサインイン時点で拒否します。
   Public リポジトリの社内ツールとして、ここが実質唯一の境界線です（R-10）。
2. **破壊的操作ができるかどうか** — PJ の削除は `role='owner'` のみ。タスクの編集・削除は全員可。

`requireLogin()` と `requireProjectOwner()` の 2 関数に集約し、全ルートとすべての Server Action の
先頭で必ず通します。「読めるかどうか」の判定は存在しません（全員読めるため）。この単純さ自体が
認可漏れの余地を減らします。

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
| 8 | Drizzle + `@libsql/client` 接続層。ローカル/テストでは `PRAGMA foreign_keys = ON` を有効化し、**本番 HTTP では効かない前提**でアプリ層削除を正とする（§4.4） | data |
| 9 | **スキーマ実装 + 初回マイグレーション（§4 の承認後）** | data |
| 9b | 論理削除ロジック（サブツリー削除 / 子の繰り上げ / 復元時の祖先連鎖）とテスト（§4.4） | data |
| 9c | ゴミ箱画面と、Vercel Cron による 30 日超の物理削除 + 「孤児 0 件」結合テスト | data |
| 10 | Better Auth + Google OAuth + `drizzleAdapter`。認証テーブルは CLI で生成 | feature |
| 10b | サインイン時のドメイン制限（許可ドメイン外は拒否）とユニットテスト（決定 D-07） | feature |
| 11 | 認可ヘルパ（`requireLogin` / `requireProjectOwner`）とユニットテスト | feature |
| 11b | 表示ラベル層 `lib/labels.ts`（DB 値 → 日本語）とユニットテスト（決定 D-17〜D-19） | feature |
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
| 25 | **伝播ロジック `propagate.ts` を TDD で実装**（T-1〜T-16 の純粋関数部分） | feature |
| 26 | `api.intercept("update-task")` でドロップを捕捉し Server Action を呼ぶ。リサイズも Δ として扱う（決定 D-01） | feature |
| 27 | 楽観更新と、サーバ確定結果でのリコンサイル | feature |
| 27b | 伝播結果のトースト（件数・打ち切り理由）と「元に戻す」（§5.4 / 決定 D-16） | feature |
| 28 | E2E: ドラッグ → 後続が動く → 元に戻す | feature |

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

### Phase 2

カンバンボード / ダッシュボード・レポート。本ドキュメントでは詳細化していません。
**2026-08-08 のヒアリングを経て [`docs/PHASE2_IMPLEMENTATION_PLAN.md`](PHASE2_IMPLEMENTATION_PLAN.md)
に別途詳細化しました**（Issue #36〜#51）。

---

## 9. リスクと未決事項

未決事項（Q-1〜Q-4）は §12 のヒアリングですべて決着しました。以下は残るリスクのみです。

| ID | 内容 | 影響 | 対応 |
|---|---|---|---|
| **R-1** | 認証ライブラリが `REQUIREMENTS.md` 記載の Auth.js から Better Auth へ変わった | 低 | 決定 D-04。`REQUIREMENTS.md` 側も追随して更新します（M0 で対応）。Better Auth 1.6.26 は安定版で、peer に Next 16 / React 19 / drizzle-orm 0.45.2 を明記しており噛み合わせは確認済み |
| **R-2** | `@libsql/client` はネイティブバイナリを持つ。`.npmrc` の `ignore-scripts=true` と衝突しうる | 中 | Vercel の serverless では **HTTP 経由の `drizzle-orm/libsql/web` + `@libsql/client/web`** を使い、ネイティブ依存を回避します。M1 の #8 で疎通を先に確認します |
| **R-3** | SVAR Gantt は SSR 不可。ハイドレーション不整合が出やすい | 中 | クライアント専用の二段構え（§2.4）で確実に切り離します |
| **R-4** | Vercel の Preview は URL が毎回変わるため、Google OAuth のリダイレクト URI を登録しきれない | 中 | Preview 用に固定のブランチドメインを 1 つ用意し、それだけを OAuth に登録します（§10.3） |
| **R-5** | Public リポジトリ。シークレット混入は不可逆 | **高** | `.env*` は gitignore 済み。`.env.example` には値を書かない。GitHub の Secret Scanning / Push Protection を有効化（§10.1） |
| **R-6** | 伝播ロジックのバグは「気づかないうちに全体の日程がずれる」形で出る | **高** | 純粋関数に隔離し、§5.3 のテストを実装より先に書きます。T-11 で性能回帰も見ます |
| **R-7** | Turso の HTTP 接続では `PRAGMA foreign_keys = ON` を接続ごとに担保できず、外部キー制約が**無言で効かない**。孤児レコードが残る | **高** | §4.4 のとおり `ON DELETE CASCADE` を宣言せず、関連行の削除はアプリ層で明示的に行います。論理削除の採用により、物理削除は cron の 1 経路だけに閉じました。ローカル/テストでは PRAGMA を有効化し、孤児 0 件を結合テストで検証します（M1 #8 / #9c） |
| **R-8** | 親タスク 1 件の削除がサブツリー全体の消失につながる | 中 | 既定で拒否し「サブツリー削除」か「子の繰り上げ」を選ばせます（決定 D-02）。論理削除なので 30 日以内なら復元可能で、影響度は当初想定より下がりました |
| **R-9** | 論理削除は「絞り込みの書き忘れ」で削除済みが表示・伝播される事故を生む | **高** | §3.2 / §4.4(c) のとおり問い合わせを `lib/db/queries.ts` に集約し、素の `db.select()` を画面や Server Action に書かない規約とします。T-13 で伝播側も検証します |
| **R-10** | ドメイン制限が実質唯一の防御線。実装漏れは全世界に開くことを意味する | **高** | サインインのフックで拒否し、ユニットテストで許可/拒否の両方を検証します（M1 #10b）。E2E でも対象外ドメインが弾かれることを確認します |
| **S-1** | ~~SVAR の `end` が「終了日を含む」か「排他」か未確定~~ **解決済み（2026-08-06 実測）** | ~~高~~ | `@svar-ui/gantt-store@2.7.1` の `parseTaskDates` を実際に呼び出して実測（M3 #18）。**`end` は排他（終了日を含まない）**。`start=2026-08-01, end=2026-08-03` を渡すと `duration: 2` になり、`start=2026-08-01, duration=3` を渡すと `end: 2026-08-04` になった。`start === end`（同日）は `duration: 0`（＝ゼロ幅、1日タスクではない）。DB 側の `end_date` は「終了日を含む」仕様のため、`toGanttTasks` では **`svarEnd = addDaysToDateOnly(dbEndDate, 1)`** に変換し、逆方向（ドラッグ確定等の取り込み）では **`dbEndDate = addDaysToDateOnly(svarEnd, -1)`** に変換する。加えて、SVAR は `Date` オブジェクトをローカルタイムゾーンの日付コンポーネント（`getFullYear`/`getMonth`/`getDate`）で解釈するため、`new Date(dateOnlyString)`（UTC解釈）で生成すると、UTCより西のタイムゾーン（例: 米国）で表示が前日にずれることを実測で確認した。**`toGanttTasks` は必ず `new Date(year, month - 1, day)` のローカルコンストラクタで `Date` を組み立てる**（`lib/gantt/transform.ts` に実装・テストで固定化）。 |
| **Q-3** | Turso の Preview 環境用 DB を分けるか | 中 | **提案: 分ける。** 本番 DB を Preview から壊す事故を防げます（§10.4） |
| **R-11** | ~~Better Auth 導入までの間、`lib/auth/session.ts` は Cookie の値をそのまま `userId` として信頼する暫定セッションであり、実際の認証を行わない~~ **解決済み（2026-08-07）** | ~~高（公開時のみ）~~ | Better Auth（`better-auth@1.6.26`）を導入し、Google OAuth限定・`ALLOWED_EMAIL_DOMAINS`によるドメイン制限（決定D-07/R-10）付きの実認証に置き換えた。導入保留の理由だった未修正Critical脆弱性（SSRF: CVE-2026-53513、暗号設定不備: CVE-2026-67336）はいずれも`1.6.11`で修正済みと確認した上で導入している。唯一未修正のCVE-2026-67331はSCIMプラグイン限定の認可バイパスで、本プロジェクトはSCIMを使用しないため影響を受けない。`lib/auth/session.ts`の`getSession()`シグネチャ（`Promise<AuthSession \| null>`）・`requireLogin`/`requireProjectOwner`は変更していない（呼び出し側は無変更） |

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
   | `BETTER_AUTH_SECRET` | ✓ | ✓ | `openssl rand -base64 32` で生成 |
   | `BETTER_AUTH_URL` | 本番URL | Preview固定URL | Better Auth の baseURL |
   | `GOOGLE_CLIENT_ID` | ✓ | ✓ | §10.5 |
   | `GOOGLE_CLIENT_SECRET` | ✓ | ✓ | |
   | `ALLOWED_EMAIL_DOMAINS` | 例 `example.co.jp` | 〃 | 決定 D-07。カンマ区切りで複数可 |
   | `CRON_SECRET` | ✓ | — | ゴミ箱の定期削除エンドポイントの認証 |
   | `NEXT_PUBLIC_SITE_URL` | 本番URL | Preview固定URL | |

5. Preview 用に**固定のブランチドメイン**を 1 つ割り当てます（Settings → Domains で
   特定ブランチにドメインを紐付け）。これがないと OAuth のリダイレクト URI を登録できません（R-4）。

6. `vercel.json` にゴミ箱削除の Cron を定義します（決定 D-05）。これはリポジトリ側で用意します。

   ```json
   { "crons": [{ "path": "/api/cron/purge-trash", "schedule": "0 18 * * *" }] }
   ```

   Vercel Cron は UTC で動くため、`0 18 * * *` は日本時間の毎日 3:00 にあたります。

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

Better Auth のコールバックパスは Auth.js と同じ `/api/auth/callback/google` です。

社内チーム向けのため、OAuth 同意画面は可能なら **Internal**（Google Workspace 組織内）にします。
組織外の利用者がいる場合は External + テストユーザー登録が必要です。

なお **同意画面を Internal にしても、それだけでは防御になりません**。Internal は「同意画面を出せる
範囲」の制御であり、アプリ側で `ALLOWED_EMAIL_DOMAINS` による拒否を必ず実装します（決定 D-07 / R-10）。

---

## 11. 次のアクション

1. §4 のデータモデルをレビューし、**承認またはフィードバック**をください（M1 #9 のブロッカー）
2. §10.1 / §10.2 の GitHub セットアップを実施してください（20 分程度）。
   `docs/handoff.md` のとおり `/project-bootstrap` はローカルで実行してください
3. 承認が出たら M0（scaffold）から着手します。M0 マージ後に §10.3 の Vercel 連携を実施してください

### 作業の割り振りについて

`docs/handoff.md` が指摘するとおり、**クラウドセッションに最も向いているのは M4 の伝播ロジック
（#25 `propagate.ts`）**です。UI もブラウザ確認も不要で、テストだけで正しさを検証でき、かつ設計
リスクが最も高い部分だからです。§5.3 のテストケースが揃っているので、スキーマ承認を待たずに
純粋関数として先行実装できます（DB 非依存のため M1 のブロックを受けません）。

ブラウザ確認や Vercel/Turso の疎通が要る M0・M1・M3 はローカル側が向いています。

---

## 12. 決定ログ

2026-08-06 のヒアリングで確定した 19 件です。`REQUIREMENTS.md` に書かれていない、
または書かれた内容を上書きする決定を記録します。

| ID | 論点 | 決定 |
|---|---|---|
| D-01 | リサイズ時の伝播 | **伝播する**（終了日の変化量を Δ とする） |
| D-02 | 子を持つ親の削除 | **既定は拒否**し、サブツリー削除／子の繰り上げを都度選ばせる |
| D-03 | 削除方式 | **論理削除**（ゴミ箱あり） |
| D-04 | 認証ライブラリ | **Better Auth**（`REQUIREMENTS.md` の Auth.js を上書き） |
| D-05 | ゴミ箱の保持期間 | **30 日で自動物理削除**（Vercel Cron） |
| D-06 | 論理削除タスクと依存 | **グラフから除外し伝播も切る**。依存レコードは残す |
| D-07 | ログイン制限 | **特定ドメインのみ許可** |
| D-08 | 既定の可視範囲 | **全ログインユーザーが全 PJ を閲覧可** |
| D-09 | Δ の数え方 | **暦日**。土日は `highlightTime` でグレー表示（見た目のみ） |
| D-10 | ステータス | **固定 4 値**（テーブル化しない） |
| D-11 | 親タスクの進捗・工数 | **子から自動集計**（工数は合計、進捗は見積工数で加重平均） |
| D-12 | マイルストーン | **スキーマだけ用意**し Phase 1 では UI を出さない |
| D-13 | 工数の単位 | **時間を小数で保持**（`real`） |
| D-14 | 優先度の日本語化 | **する**（英語ラベルを画面に出さない） |
| D-15 | 削除権限 | **タスクは全員・PJ は `role='owner'` のみ** |
| D-16 | 伝播の取り消し | **直前 1 回だけ**。履歴テーブルは作らない |
| D-17 | 値の持ち方 | **DB は英字・画面だけ日本語**（`lib/labels.ts` に集約） |
| D-18 | 優先度ラベル | `low`→低 / `medium`→中 / `high`→高 / `urgent`→**緊急** |
| D-19 | ステータスラベル | `todo`→未着手 / `in_progress`→**対応中** / `review`→**確認中** / `done`→完了 |
